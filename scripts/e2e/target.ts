import {
  CLEANUP_TABLES,
  DEV_STACK,
  E2E_STACK,
  MARKER_KEY,
  MARKER_SCHEMA,
  MARKER_VALUE,
  RUN_TOKEN_ENV,
} from './constants';
import type { StackProfile } from './constants';

// Target attestation (#96). Before the first write or the first fixture of an
// E2E run, several independent proofs must agree that the database in front
// of us is the intended one. A missing or mismatching proof fails closed.
// Nothing here reads a URL, container name or key from the environment.

export interface PortBinding {
  ip: string;
  port: string;
}

export interface ContainerInfo {
  running: boolean;
  labels: Readonly<Record<string, string>>;
  // Container port ("5432/tcp") to its published host address and port.
  bindings: Readonly<Record<string, readonly PortBinding[]>>;
  // ISO time of the creation of the container.
  createdAt: string;
}

// Facts about the machine the process runs on. Unlike environment variables,
// a caller cannot simply set them.
export interface HostFacts {
  platform: string;
  username: string;
  home: string;
}

export interface AttestDeps {
  // Project id of the config.toml the CLI is pointed at, or null.
  readConfigProjectId: (profile: StackProfile) => string | null;
  // `supabase status -o env` of that config; throws when the stack is down.
  readStatus: (profile: StackProfile) => Record<string, string>;
  inspect: (container: string) => ContainerInfo | null;
  // Runs one SQL statement through psql inside the container.
  psql: (container: string, sql: string) => string;
  // The token of the run lock held by the orchestrator, or null.
  readRunLock: () => { token: string } | null;
  env: Readonly<Record<string, string | undefined>>;
  host: HostFacts;
  now: () => number;
  repoRoot: string;
  // Playwright worker processes load the config again after the fixtures.
  isWorker: boolean;
}

export type AttestMode = 'e2e' | 'ci';

export interface AttestedTarget {
  mode: AttestMode;
  profile: StackProfile;
  container: string;
  url: string;
  publishableKey: string;
  secretKey: string;
}

export interface AttestOptions {
  // The orchestrator itself (it holds the lock): no token is asked for.
  // Everything else on a developer machine must run under the orchestrator.
  requireRunLock: boolean;
  // Only the bootstrap may attest a stack that has no marker yet.
  allowMissingMarker?: boolean;
}

export class TargetRefused extends Error {
  constructor(reason: string) {
    super(`E2E target refused: ${reason}`);
    this.name = 'TargetRefused';
  }
}

// Whether the process runs on a GitHub Actions runner. Spoofable by a
// determined developer, so it is only one proof among several.
export const isCiContext = (
  env: Readonly<Record<string, string | undefined>>,
): boolean =>
  env.CI === 'true' &&
  env.GITHUB_ACTIONS === 'true' &&
  Boolean(env.GITHUB_RUN_ID) &&
  Boolean(env.GITHUB_WORKSPACE) &&
  Boolean(env.RUNNER_OS) &&
  env.RUNNER_ENVIRONMENT === 'github-hosted';

// Docker reports the wildcard address for a port published on every
// interface; both it and the loopback address answer on 127.0.0.1.
const LOOPBACK_BINDINGS: readonly string[] = ['127.0.0.1', '0.0.0.0', '::'];

// A GitHub Actions job lives at most six hours, so a database container older
// than that was not started by this job.
const CI_CONTAINER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const isHostedRunnerHost = (host: HostFacts): boolean =>
  host.platform === 'linux' &&
  host.username === 'runner' &&
  host.home.startsWith('/home/runner');

const normalizePath = (value: string): string =>
  value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();

// The API URL must be exactly the loopback address and port of the profile:
// no credentials, no other host (`localhost.evil.test`, `127.0.0.1.evil`),
// no other port, no path.
export const checkApiUrl = (raw: string, profile: StackProfile): void => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TargetRefused('the API URL cannot be parsed');
  }
  const ok =
    url.protocol === 'http:' &&
    url.hostname === '127.0.0.1' &&
    url.port === String(profile.apiPort) &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '';
  if (!ok) {
    throw new TargetRefused(
      `the API URL ${raw} is not ${profile.apiUrl} (loopback only)`,
    );
  }
};

const checkContainer = (
  info: ContainerInfo | null,
  name: string,
  inner: { portKey: string; hostPort: number },
  profile: StackProfile,
  mode: AttestMode,
  env: AttestDeps['env'],
  repoRoot: string,
): void => {
  if (!info) throw new TargetRefused(`container ${name} does not exist`);
  if (!info.running)
    throw new TargetRefused(`container ${name} is not running`);
  if (info.labels['com.supabase.cli.project'] !== profile.projectId) {
    throw new TargetRefused(
      `container ${name} belongs to another Supabase project`,
    );
  }
  const published = (info.bindings[inner.portKey] ?? []).filter(
    (binding) => binding.port === String(inner.hostPort),
  );
  if (published.length === 0) {
    throw new TargetRefused(
      `container ${name} does not publish the port ${inner.hostPort}`,
    );
  }
  if (!published.some((binding) => LOOPBACK_BINDINGS.includes(binding.ip))) {
    throw new TargetRefused(
      `container ${name} publishes the port ${inner.hostPort} only on a non-loopback address`,
    );
  }
  const workdir = info.labels['com.supabase.cli.workdir'] ?? '';
  const expected =
    mode === 'ci'
      ? (env.GITHUB_WORKSPACE ?? '')
      : `${normalizePath(repoRoot)}/${profile.workdir}`;
  if (normalizePath(workdir) !== normalizePath(expected)) {
    throw new TargetRefused(
      `container ${name} was started from another directory`,
    );
  }
};

const checkRunLock = (deps: AttestDeps): void => {
  const token = deps.env[RUN_TOKEN_ENV];
  const held = deps.readRunLock();
  if (!token || !held || held.token !== token) {
    throw new TargetRefused(
      'run through `npm run e2e:test`: no run lock is held for this process',
    );
  }
};

const readMarker = (deps: AttestDeps, profile: StackProfile): string | null => {
  const sql = `select value from ${MARKER_SCHEMA}.marker where key = '${MARKER_KEY}'`;
  try {
    return deps.psql(profile.dbContainer, sql).trim() || null;
  } catch {
    return null;
  }
};

export const attestTarget = (
  deps: AttestDeps,
  options: AttestOptions,
): AttestedTarget => {
  const mode: AttestMode = isCiContext(deps.env) ? 'ci' : 'e2e';
  const profile = mode === 'ci' ? DEV_STACK : E2E_STACK;

  // Proof 1: the config the CLI is pointed at names the expected project.
  const configured = deps.readConfigProjectId(profile);
  if (configured !== profile.projectId) {
    throw new TargetRefused(
      `config project_id is ${String(configured)}, expected ${profile.projectId}`,
    );
  }

  // Proof 2: the address of the API, checked before anything is spawned that
  // could write.
  const status = deps.readStatus(profile);
  const apiUrl = status.API_URL ?? '';
  checkApiUrl(apiUrl, profile);
  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
  const secretKey = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;
  if (!publishableKey || !secretKey) {
    throw new TargetRefused('the stack status carries no API keys');
  }

  // Proof 3: the container behind it.
  const dbInfo = deps.inspect(profile.dbContainer);
  checkContainer(
    dbInfo,
    profile.dbContainer,
    { portKey: '5432/tcp', hostPort: profile.dbPort },
    profile,
    mode,
    deps.env,
    deps.repoRoot,
  );
  // The API gateway too: Storage is reached through it, so the endpoint that
  // answers on the API port must belong to this very project.
  checkContainer(
    deps.inspect(profile.gatewayContainer),
    profile.gatewayContainer,
    { portKey: '8000/tcp', hostPort: profile.apiPort },
    profile,
    mode,
    deps.env,
    deps.repoRoot,
  );

  // Proof 4: the content of that exact database.
  if (mode === 'e2e') {
    if (!options.allowMissingMarker) {
      const marker = readMarker(deps, profile);
      if (marker !== MARKER_VALUE) {
        throw new TargetRefused(
          `the database carries no E2E marker (${String(marker)}): run npm run e2e:up`,
        );
      }
    }
    if (options.requireRunLock) checkRunLock(deps);
  } else {
    // CI: the stack must be the one this job started, not a developer
    // database that happens to have the same project id. The variables are
    // only a claim: the machine and the container must agree with it.
    if (!isHostedRunnerHost(deps.host)) {
      throw new TargetRefused(
        'CI variables are set, but this is not a GitHub-hosted Linux runner',
      );
    }
    const ageMs = deps.now() - Date.parse(dbInfo?.createdAt ?? '');
    if (!(ageMs >= 0 && ageMs <= CI_CONTAINER_MAX_AGE_MS)) {
      throw new TargetRefused(
        'CI context, but the database container was not created during this job',
      );
    }
    if (!deps.isWorker) {
      const counts = CLEANUP_TABLES.map(
        (table) => `(select count(*) from ${table})`,
      ).join(' + ');
      const used = deps.psql(profile.dbContainer, `select ${counts}`);
      if (used.trim() !== '0') {
        throw new TargetRefused(
          'CI context, but the database is not fresh: it holds test or user rows',
        );
      }
    }
  }

  return {
    mode,
    profile,
    container: profile.dbContainer,
    url: apiUrl,
    publishableKey,
    secretKey,
  };
};
