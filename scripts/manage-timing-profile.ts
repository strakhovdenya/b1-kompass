// Trusted owner tool: timing profiles of a published exam version. It shows
// the current settings and fingerprint, creates a new draft revision, and
// confirms one exact revision in a separate, explicit command. Creating a
// draft never confirms it.
//
//   TIMING_PROFILE_OWNER_DB_URL='postgresql://postgres:<password>@<host>:5432/postgres' \
//   npx tsx scripts/manage-timing-profile.ts show --exam <slug>
//   ... draft --exam <slug> --recording-seconds 1494 --hoeren-seconds 1500 \
//       --transition-seconds 60 --lesen-seconds 2700
//   ... confirm --revision-id <uuid> --fingerprint <sha256 hex>
//
// It connects with psql as the owner/DDL database role: the m2_owner
// functions are not executable by service_role, so the runtime
// SUPABASE_SECRET_KEY cannot confirm a profile, and the owner URL is never
// configured in Vercel. Every value reaches SQL as a psql variable, quoted by
// psql; the database computes and checks the fingerprint itself.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';

// Runs one SQL script with psql variables and returns its trimmed output.
// A failing statement throws with the psql error text.
export type SqlRunner = (
  sql: string,
  vars: Readonly<Record<string, string>>,
) => string;

export interface TimingSettings {
  recordingSeconds: number;
  hoerenSeconds: number;
  transitionSeconds: number;
  lesenSeconds: number;
}

const HEX_64 = /^[0-9a-f]{64}$/;

const seconds = (max: number) => z.number().int().min(1).max(max);

const settingsSchema = z.strictObject({
  recordingSeconds: seconds(14400),
  hoerenSeconds: seconds(14400),
  transitionSeconds: seconds(3600),
  lesenSeconds: seconds(14400),
});

const revisionSchema = z.object({
  revisionId: z.uuid(),
  examVersionId: z.uuid(),
  revision: z.number().int().positive(),
  trackId: z.string(),
  audioSha256: z.string().regex(HEX_64),
  recordingSeconds: z.number().int(),
  hoerenSeconds: z.number().int(),
  transitionSeconds: z.number().int(),
  lesenSeconds: z.number().int(),
  fingerprint: z.string().regex(HEX_64),
  status: z.enum(['draft', 'confirmed']),
  createdAt: z.string(),
  confirmedAt: z.string().nullable(),
});

export type TimingRevision = z.infer<typeof revisionSchema>;

const stateSchema = z.object({
  examSlug: z.string(),
  examVersionId: z.uuid(),
  version: z.number().int(),
  recordings: z.array(z.object({ trackId: z.string(), sha256: z.string() })),
  head: revisionSchema.nullable(),
  headMatches: z.boolean(),
  confirmedRevisionId: z.uuid().nullable(),
});

export type TimingProfileState = z.infer<typeof stateSchema>;

const draftSchema = z.object({
  outcome: z.enum(['created', 'unchanged']),
  revision: revisionSchema,
});

export type DraftOutcome = z.infer<typeof draftSchema>;

const confirmSchema = z.object({
  outcome: z.enum(['confirmed', 'already-confirmed']),
  revision: revisionSchema,
});

export type ConfirmOutcome = z.infer<typeof confirmSchema>;

// A refusal of the database: the stable hint of a rule, or missing rights.
export class TimingProfileRefusal extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(`Timing profile refused: ${code}`, options);
    this.name = 'TimingProfileRefusal';
    this.code = code;
  }
}

// psql runs with VERBOSITY=verbose and English client messages, so an error
// carries its SQLSTATE: "ERROR:  P0001: ..." with "HINT:  <rule>", or
// "ERROR:  42501: permission denied ...". Only the error output of psql is
// read, never the command line, which holds the values.
const RULE = /ERROR:\s+P0001:[\s\S]*?HINT:\s+([a-z_]+)/;
const NO_RIGHTS = /ERROR:\s+42501:/;

const stderrOf = (error: unknown): string => {
  if (typeof error !== 'object' || error === null) return '';
  const { stderr } = error as { stderr?: unknown };
  if (typeof stderr === 'string') return stderr;
  if (stderr instanceof Uint8Array) return Buffer.from(stderr).toString();
  return '';
};

const toRefusal = (error: unknown): unknown => {
  const text = stderrOf(error);
  const rule = RULE.exec(text)?.[1];
  if (rule) return new TimingProfileRefusal(rule, { cause: error });
  if (NO_RIGHTS.test(text)) {
    return new TimingProfileRefusal('permission_denied', { cause: error });
  }
  return error;
};

// The psql flags of every runner: no psqlrc, quiet, unaligned tuples, stop
// on the first error, verbose errors with their SQLSTATE.
export const PSQL_FLAGS: readonly string[] = [
  '-X',
  '-q',
  '-tA',
  '-v',
  'ON_ERROR_STOP=1',
  '-v',
  'VERBOSITY=verbose',
];

export const psqlVarArgs = (vars: Readonly<Record<string, string>>): string[] =>
  Object.entries(vars).flatMap(([name, value]) => ['-v', `${name}=${value}`]);

const lastLine = (output: string): string => {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1);
  if (!last) throw new Error('The database returned no row');
  return last;
};

const runJson = <T>(
  run: SqlRunner,
  schema: z.ZodType<T>,
  sql: string,
  vars: Readonly<Record<string, string>>,
): T => {
  let output: string;
  try {
    output = run(sql, vars);
  } catch (error) {
    throw toRefusal(error);
  }
  return schema.parse(JSON.parse(lastLine(output)));
};

export type VersionTarget = { versionId: string } | { examSlug: string };

const VERSION_OF_SLUG = `select v.id from public.exam_versions v
  join public.exams e on e.id = v.exam_id
  where e.slug = :'exam_slug'
  order by v.version desc limit 1`;

const versionSql = (target: VersionTarget): string =>
  'versionId' in target ? `:'version_id'::uuid` : `(${VERSION_OF_SLUG})`;

const versionVars = (target: VersionTarget): Record<string, string> =>
  'versionId' in target
    ? { version_id: z.uuid().parse(target.versionId) }
    : { exam_slug: z.string().min(1).max(100).parse(target.examSlug) };

export const showTimingProfile = (
  run: SqlRunner,
  target: VersionTarget,
): TimingProfileState =>
  runJson(
    run,
    stateSchema,
    `select m2_owner.timing_profile_state(${versionSql(target)});`,
    versionVars(target),
  );

export const createTimingProfileRevision = (
  run: SqlRunner,
  target: VersionTarget,
  settings: TimingSettings,
): DraftOutcome => {
  const valid = settingsSchema.parse(settings);
  return runJson(
    run,
    draftSchema,
    `select m2_owner.create_timing_profile_revision(
      ${versionSql(target)},
      :'recording_seconds'::integer, :'hoeren_seconds'::integer,
      :'transition_seconds'::integer, :'lesen_seconds'::integer);`,
    {
      ...versionVars(target),
      recording_seconds: String(valid.recordingSeconds),
      hoeren_seconds: String(valid.hoerenSeconds),
      transition_seconds: String(valid.transitionSeconds),
      lesen_seconds: String(valid.lesenSeconds),
    },
  );
};

export interface ConfirmInput {
  revisionId: string;
  fingerprint: string;
}

export const confirmTimingProfileRevision = (
  run: SqlRunner,
  input: ConfirmInput,
): ConfirmOutcome =>
  runJson(
    run,
    confirmSchema,
    `select m2_owner.confirm_timing_profile_revision(
      :'revision_id'::uuid, :'fingerprint');`,
    {
      revision_id: z.uuid().parse(input.revisionId),
      fingerprint: z.string().regex(HEX_64).parse(input.fingerprint),
    },
  );

// Command line ---------------------------------------------------------------

export const USAGE = `Usage:
  show    (--exam <slug> | --version-id <uuid>)
  draft   (--exam <slug> | --version-id <uuid>) --recording-seconds <n>
          --hoeren-seconds <n> --transition-seconds <n> --lesen-seconds <n>
  confirm --revision-id <uuid> --fingerprint <sha256 hex>`;

const OPTIONS = {
  exam: { type: 'string' },
  'version-id': { type: 'string' },
  'recording-seconds': { type: 'string' },
  'hoeren-seconds': { type: 'string' },
  'transition-seconds': { type: 'string' },
  'lesen-seconds': { type: 'string' },
  'revision-id': { type: 'string' },
  fingerprint: { type: 'string' },
} as const;

type OptionName = keyof typeof OPTIONS;
type Values = Partial<Record<OptionName, string>>;

const targetOf = (values: Values): VersionTarget => {
  const { exam } = values;
  const versionId = values['version-id'];
  if ((exam === undefined) === (versionId === undefined)) {
    throw new Error(`Give exactly one of --exam or --version-id\n${USAGE}`);
  }
  return versionId === undefined ? { examSlug: exam ?? '' } : { versionId };
};

const integerOf = (values: Values, name: OptionName): number => {
  const raw = values[name];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new Error(`--${name} must be a whole number of seconds\n${USAGE}`);
  }
  return Number(raw);
};

const requiredOf = (values: Values, name: OptionName): string => {
  const raw = values[name];
  if (raw === undefined) throw new Error(`--${name} is required\n${USAGE}`);
  return raw;
};

const draftCommand = (run: SqlRunner, values: Values) => {
  const drafted = createTimingProfileRevision(run, targetOf(values), {
    recordingSeconds: integerOf(values, 'recording-seconds'),
    hoerenSeconds: integerOf(values, 'hoeren-seconds'),
    transitionSeconds: integerOf(values, 'transition-seconds'),
    lesenSeconds: integerOf(values, 'lesen-seconds'),
  });
  const { revisionId, fingerprint, status } = drafted.revision;
  const next =
    status === 'confirmed'
      ? 'This revision is already confirmed.'
      : 'Check the recording and the settings, then confirm explicitly: ' +
        `confirm --revision-id ${revisionId} --fingerprint ${fingerprint}`;
  return { ...drafted, next };
};

// Runs one command and returns what it prints. A draft names the explicit
// confirm command; it is never run automatically.
export const runTimingProfileCommand = (
  run: SqlRunner,
  argv: readonly string[],
): unknown => {
  const { positionals, values } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  });
  const [command, ...rest] = positionals;
  if (rest.length > 0) throw new Error(`Unexpected arguments\n${USAGE}`);
  if (command === 'show') return showTimingProfile(run, targetOf(values));
  if (command === 'draft') return draftCommand(run, values);
  if (command === 'confirm') {
    return confirmTimingProfileRevision(run, {
      revisionId: requiredOf(values, 'revision-id'),
      fingerprint: requiredOf(values, 'fingerprint'),
    });
  }
  throw new Error(USAGE);
};

// Owner connection -------------------------------------------------------------

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];

// libpq settings from the owner URL, passed in the environment of psql so
// that the password never appears in a process argument.
export const ownerConnectionEnv = (url: string): Record<string, string> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('TIMING_PROFILE_OWNER_DB_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('TIMING_PROFILE_OWNER_DB_URL must be a postgresql:// URL');
  }
  const user = decodeURIComponent(parsed.username);
  if (!user || !parsed.hostname) {
    throw new Error('TIMING_PROFILE_OWNER_DB_URL needs a user and a host');
  }
  const extra = [...parsed.searchParams.keys()].filter(
    (key) => key !== 'sslmode',
  );
  if (extra.length > 0) {
    throw new Error(
      `TIMING_PROFILE_OWNER_DB_URL supports only sslmode, not ${extra.join(', ')}`,
    );
  }
  const isLocal = LOCAL_HOSTS.includes(parsed.hostname);
  const sslMode = parsed.searchParams.get('sslmode');
  const env: Record<string, string> = {
    PGHOST: parsed.hostname.replace(/^\[(.*)\]$/, '$1'),
    PGPORT: parsed.port || '5432',
    PGUSER: user,
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)) || 'postgres',
    PGSSLMODE: sslMode ?? (isLocal ? 'prefer' : 'require'),
  };
  if (parsed.password) env.PGPASSWORD = decodeURIComponent(parsed.password);
  return env;
};

export const readOwnerDatabaseUrl = (
  env: Readonly<Record<string, string | undefined>>,
): string => {
  if (env.VERCEL) {
    throw new Error('The timing profile owner tool never runs in Vercel');
  }
  const url = env.TIMING_PROFILE_OWNER_DB_URL;
  if (!url) {
    throw new Error(
      'TIMING_PROFILE_OWNER_DB_URL must be set: the owner database ' +
        'connection, not the runtime SUPABASE_SECRET_KEY',
    );
  }
  return url;
};

// The environment of psql: the inherited one without any libpq setting
// (PGHOSTADDR, PGSERVICE, PGPASSWORD of another project…) and without a
// locale override of messages, plus exactly the owner connection.
export const psqlEnv = (
  inherited: Readonly<Record<string, string | undefined>>,
  connection: Readonly<Record<string, string>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    const isLibpq = name.startsWith('PG');
    const isLocale = name === 'LC_ALL' || name === 'LC_MESSAGES';
    if (value !== undefined && !isLibpq && !isLocale) env[name] = value;
  }
  return { ...env, LC_MESSAGES: 'C', ...connection };
};

export const createPsqlRunner = (url: string): SqlRunner => {
  const env = psqlEnv(process.env, ownerConnectionEnv(url));
  return (sql, vars) =>
    execFileSync('psql', [...PSQL_FLAGS, ...psqlVarArgs(vars), '-f', '-'], {
      input: sql,
      // Next.js types require NODE_ENV; psql needs no Node settings.
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
};

const main = () => {
  const run = createPsqlRunner(readOwnerDatabaseUrl(process.env));
  const output = runTimingProfileCommand(run, process.argv.slice(2));
  console.log(JSON.stringify(output, null, 2));
};

const samePath = (left: string, right: string): boolean => {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
};

const isEntryPoint =
  process.argv[1] !== undefined &&
  samePath(fileURLToPath(import.meta.url), process.argv[1]);

if (isEntryPoint) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
