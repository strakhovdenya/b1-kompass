import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import net from 'node:net';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import {
  E2E_DB_URL,
  E2E_STACK,
  EXCLUDED_SERVICES,
  MARKER_KEY,
  MARKER_SCHEMA,
  MARKER_VALUE,
  SYSTEM_SCHEMAS,
} from './constants';
import type { StackProfile } from './constants';
import { readLock } from './lock';
import type {
  AppliedMigration,
  MigrationCli,
  StackDb,
  StackStorage,
} from './stack';
import type {
  AttestDeps,
  AttestedTarget,
  ContainerInfo,
  PortBinding,
} from './target';

// The real ports of the E2E tooling: Docker, the Supabase CLI, psql inside
// the container, Storage. The only module of scripts/e2e that spawns
// processes; every write goes through an AttestedTarget.

export const REPO_ROOT = path.join(import.meta.dirname, '..', '..');
export const LOCK_FILE = path.join(REPO_ROOT, '.e2e', 'run.lock');
export const REPORT_FILE = path.join(REPO_ROOT, '.e2e', 'last-run.json');

const IS_WINDOWS = process.platform === 'win32';
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const workdirOf = (profile: StackProfile): string =>
  path.join(REPO_ROOT, profile.workdir);

// Child processes get only what they need to run. SUPABASE_*, DOCKER_HOST,
// DOCKER_CONTEXT, PG* and the like could point the CLI or Docker at another
// stack, so nothing of the caller's environment is passed on.
const PASSED_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'TEMP',
  'TMP',
  'TMPDIR',
  'XDG_RUNTIME_DIR',
  'LANG',
];

export const cleanEnv = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  // NODE_ENV is typed as required by Next; it is deliberately not passed.
  const env = {} as NodeJS.ProcessEnv;
  for (const name of PASSED_ENV) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

// A path handed to cmd.exe through a shell must not carry its metacharacters.
const quoteForShell = (value: string): string => {
  if (!IS_WINDOWS) return value;
  if (/["&^%|<>!]/.test(value)) {
    throw new Error(`the path ${value} contains characters cmd.exe interprets`);
  }
  return `"${value}"`;
};

// The CLI runs through npx; on Windows that is a .cmd file, which Node runs
// only through a shell. The arguments are constants of this module.
const supabaseCli = (
  profile: StackProfile,
  args: readonly string[],
  stdio: 'pipe' | 'inherit' = 'pipe',
): string => {
  const output = execFileSync(
    IS_WINDOWS ? 'npx.cmd' : 'npx',
    ['supabase', ...args, '--workdir', quoteForShell(workdirOf(profile))],
    {
      cwd: REPO_ROOT,
      env: cleanEnv(),
      encoding: 'utf8',
      shell: IS_WINDOWS,
      stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'ignore'] : 'inherit',
      maxBuffer: MAX_BUFFER_BYTES,
    },
  );
  return output ?? '';
};

export const parseStatusEnv = (output: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const line of output.split(/\r?\n/)) {
    const match = /^([A-Z_0-9]+)="?(.*?)"?$/.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) values[match[1]] = match[2];
  }
  return values;
};

const readConfigProjectId = (profile: StackProfile): string | null => {
  const file = path.join(workdirOf(profile), 'supabase', 'config.toml');
  try {
    const text = readFileSync(file, 'utf8');
    return /^project_id\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
};

const inspectContainer = (name: string): ContainerInfo | null => {
  let raw: string;
  try {
    raw = execFileSync('docker', ['inspect', '--type', 'container', name], {
      env: cleanEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const [entry] = JSON.parse(raw) as {
    Created?: string;
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> };
    NetworkSettings?: {
      Ports?: Record<string, { HostIp?: string; HostPort: string }[] | null>;
    };
  }[];
  if (!entry) return null;
  const bindings: Record<string, PortBinding[]> = {};
  for (const [port, published] of Object.entries(
    entry.NetworkSettings?.Ports ?? {},
  )) {
    bindings[port] = (published ?? []).map((binding) => ({
      ip: binding.HostIp ?? '',
      port: binding.HostPort,
    }));
  }
  return {
    running: entry.State?.Running === true,
    labels: entry.Config?.Labels ?? {},
    bindings,
    createdAt: entry.Created ?? '',
  };
};

const PSQL_ARGS = [
  'psql',
  '-U',
  'postgres',
  '-tA',
  '-q',
  '-v',
  'ON_ERROR_STOP=1',
];

// One script through psql inside the given container. Callers pass only the
// container of an attested target.
const psqlIn = (container: string, sql: string): string =>
  execFileSync('docker', ['exec', '-i', container, ...PSQL_ARGS, '-f', '-'], {
    input: sql,
    env: cleanEnv(),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: MAX_BUFFER_BYTES,
  }).trim();

export const realAttestDeps = (): AttestDeps => ({
  readConfigProjectId,
  readStatus: (profile) =>
    parseStatusEnv(supabaseCli(profile, ['status', '-o', 'env'])),
  inspect: inspectContainer,
  psql: psqlIn,
  readRunLock: () => {
    const info = readLock(LOCK_FILE);
    return info ? { token: info.token } : null;
  },
  env: process.env,
  host: {
    platform: process.platform,
    username: userInfo().username,
    home: homedir(),
  },
  now: Date.now,
  repoRoot: REPO_ROOT,
  isWorker: process.env.TEST_WORKER_INDEX !== undefined,
});

const quoteIdent = (qualified: string): string =>
  qualified
    .split('.')
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join('.');

const sqlList = (values: readonly string[]): string =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');

const assertE2eTarget = (target: AttestedTarget): void => {
  if (
    target.mode !== 'e2e' ||
    target.container !== E2E_STACK.dbContainer ||
    target.profile.projectId !== E2E_STACK.projectId
  ) {
    throw new Error('destructive operations run only on the E2E stack');
  }
};

const TRIGGER_STATES = `select c.oid::regclass::text as rel, t.tgname, t.tgenabled
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal`;

export const buildWipeSql = (tables: readonly string[]): string => {
  const quoted = tables.map(quoteIdent);
  return [
    'begin;',
    "set local lock_timeout = '30s';",
    `create temp table trigger_states on commit drop as ${TRIGGER_STATES};`,
    ...quoted.map((table) => `alter table ${table} disable trigger user;`),
    `truncate table ${quoted.join(', ')} restart identity;`,
    ...quoted.map((table) => `alter table ${table} enable trigger user;`),
    `do $$ begin
      if exists (
        select 1 from trigger_states b
        full join (${TRIGGER_STATES}) a using (rel, tgname)
        where b.tgenabled is distinct from a.tgenabled
      ) then
        raise exception 'trigger state changed by the cleanup';
      end if;
    end $$;`,
    'commit;',
  ].join('\n');
};

// The PostgreSQL side of the E2E stack, bound to one attested target. The
// target is checked again here: a cleanup of anything but the E2E stack is
// impossible, whatever the caller does.
export const createStackDb = (target: AttestedTarget): StackDb => {
  const run = (sql: string): string => {
    assertE2eTarget(target);
    return psqlIn(target.container, sql);
  };
  return {
    tables: () =>
      run(
        `select n.nspname || '.' || c.relname
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p')
            and n.nspname <> all (array[${sqlList(SYSTEM_SCHEMAS)}])
            and n.nspname not like 'pg\\_%'
          order by 1`,
      )
        .split(/\r?\n/)
        .filter(Boolean),
    wipe: (tables) => {
      run(buildWipeSql(tables));
    },
    appliedMigrations: () =>
      run(
        `select version || '|' || name
          from supabase_migrations.schema_migrations order by version`,
      )
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const [version = '', name = ''] = line.split('|');
          return { version, name };
        }),
  };
};

export const readLocalMigrations = (): AppliedMigration[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => {
      const stem = file.slice(0, -'.sql'.length);
      const split = stem.indexOf('_');
      return { version: stem.slice(0, split), name: stem.slice(split + 1) };
    });

export const createMigrationCli = (target: AttestedTarget): MigrationCli => ({
  up: () => {
    assertE2eTarget(target);
    supabaseCli(
      E2E_STACK,
      ['migration', 'up', '--db-url', E2E_DB_URL],
      'inherit',
    );
  },
});

const REMOVE_BATCH = 100;
const LIST_PAGE = 1000;

export const createStackStorage = (target: AttestedTarget): StackStorage => {
  const client = createClient(target.url, target.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const listFiles = async (
    bucket: string,
    prefix: string,
  ): Promise<string[]> => {
    const files: string[] = [];
    for (let offset = 0; ; offset += LIST_PAGE) {
      const { data, error } = await client.storage
        .from(bucket)
        .list(prefix, { limit: LIST_PAGE, offset });
      if (error) throw error;
      for (const item of data) {
        const full = prefix ? `${prefix}/${item.name}` : item.name;
        // A folder has no id: its objects are listed under its prefix.
        if (item.id === null) files.push(...(await listFiles(bucket, full)));
        else files.push(full);
      }
      if (data.length < LIST_PAGE) return files;
    }
  };

  return {
    buckets: async () => {
      assertE2eTarget(target);
      const { data, error } = await client.storage.listBuckets();
      if (error) throw error;
      return data.map((bucket) => bucket.id);
    },
    emptyBucket: async (bucket) => {
      assertE2eTarget(target);
      // The endpoint behind the API port must serve the attested database:
      // every object it lists is also a row of that database, or nothing is
      // deleted.
      const known = new Set(
        psqlIn(
          target.container,
          `select name from storage.objects where bucket_id = '${bucket.replaceAll("'", "''")}'`,
        )
          .split(/\r?\n/)
          .filter(Boolean),
      );
      const files = await listFiles(bucket, '');
      const foreign = files.filter((file) => !known.has(file));
      if (foreign.length > 0) {
        throw new Error(
          `Storage lists ${foreign.length} objects that the attested database does not know: nothing was deleted`,
        );
      }
      // The REST endpoint of the attested stack, with names the attested
      // database listed: the owner tools of scripts/ never delete objects
      // (scripts/manage-exam-library.test.ts), this isolated-stack cleanup
      // is the one place that does.
      for (let i = 0; i < files.length; i += REMOVE_BATCH) {
        const response = await fetch(
          `${target.url}/storage/v1/object/${encodeURIComponent(bucket)}`,
          {
            method: 'DELETE',
            headers: {
              apikey: target.secretKey,
              Authorization: `Bearer ${target.secretKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              prefixes: files.slice(i, i + REMOVE_BATCH),
            }),
          },
        );
        if (!response.ok) {
          throw new Error(
            `Storage deletion failed with HTTP ${response.status}`,
          );
        }
      }
    },
    objectCount: (bucket) => {
      assertE2eTarget(target);
      const count = psqlIn(
        target.container,
        `select count(*) from storage.objects where bucket_id = '${bucket.replaceAll("'", "''")}'`,
      );
      return Promise.resolve(Number(count));
    },
  };
};

const probe = (port: number, host: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });

export const findBusyPorts = async (
  ports: readonly number[],
): Promise<number[]> => {
  const busy: number[] = [];
  for (const port of ports) {
    const [v4, v6] = await Promise.all([
      probe(port, '127.0.0.1'),
      probe(port, '::1'),
    ]);
    if (v4 || v6) busy.push(port);
  }
  return busy;
};

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

// Windows paths differ in the case of the drive letter between shells.
const isSamePath = (a: string, b: string): boolean =>
  IS_WINDOWS ? a.toLowerCase() === b.toLowerCase() : a === b;

// supabase/e2e/supabase/migrations is a link to the canonical supabase/migrations,
// never a copy. A real directory or a link elsewhere stops the tooling.
export const ensureMigrationLink = (): void => {
  const link = path.join(workdirOf(E2E_STACK), 'supabase', 'migrations');
  if (existsSync(link) || isDanglingLink(link)) {
    if (!isSamePath(realpathSync(link), realpathSync(MIGRATIONS_DIR))) {
      throw new Error(
        `${link} is not a link to supabase/migrations: remove it by hand`,
      );
    }
    return;
  }
  symlinkSync(MIGRATIONS_DIR, link, 'junction');
};

const isDanglingLink = (file: string): boolean => {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
};

export const bootstrapSql = `create schema if not exists ${MARKER_SCHEMA};
create table if not exists ${MARKER_SCHEMA}.marker (
  key text primary key,
  value text not null
);
revoke all on schema ${MARKER_SCHEMA} from public, anon, authenticated, service_role;
revoke all on table ${MARKER_SCHEMA}.marker from public, anon, authenticated, service_role;
insert into ${MARKER_SCHEMA}.marker (key, value)
  values ('${MARKER_KEY}', '${MARKER_VALUE}') on conflict (key) do nothing;`;

export const startStack = (): void => {
  supabaseCli(
    E2E_STACK,
    ['start', '-x', EXCLUDED_SERVICES.join(',')],
    'inherit',
  );
};

export const stopStack = (): void => {
  supabaseCli(E2E_STACK, ['stop'], 'inherit');
};

// Only the bootstrap writes the marker, and only into the container of a
// target whose other proofs have passed.
export const writeMarker = (target: AttestedTarget): void => {
  assertE2eTarget(target);
  psqlIn(target.container, bootstrapSql);
};
