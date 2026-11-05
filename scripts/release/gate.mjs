// Release gate of the manual Production CD (.github/workflows/release-production.yml).
//
// The exported functions are pure: they receive already fetched API results
// (`{ ok, status, data }`) and return the reasons of a refusal. They never
// read the environment, never call the network and never echo a secret.
// The command line at the bottom gathers the inputs (GitHub and Vercel REST
// API, `vercel curl`, files) and fails the workflow step on any reason.
//
// Usage: node scripts/release/gate.mjs <command> [--flag value]
//   preflight        trigger, repository, current HEAD of main, CI/Quality, Environments
//   vercel-project   project, team, root directory, Vercel Authentication, automation bypass
//   deployment       staged candidate: project, team, target, READY, releaseSha, not public
//   smoke            read-only GET / and GET /practice through `vercel curl`
//   db-url           SUPABASE_DB_URL is the session pooler of SUPABASE_PROJECT_ID with TLS
//   migrations       remote history against supabase/migrations (--phase before|after)
//   promotion        bounded read of the public alias after `vercel promote`

import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const PROJECT_REF = /^[a-z]{20}$/;
const POOLER_HOST = /^aws-\d+-[a-z]{2}-[a-z]+-\d+\.pooler\.supabase\.com$/;
const SESSION_POOLER_PORT = '5432';
const TLS_MODES = ['require', 'verify-ca', 'verify-full'];
const MIGRATION_FILE = /^(\d{14})_[a-z0-9_]+\.sql$/;
const VERSION = /^\d{14}$/;
const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
const DEPLOYMENT_HOST = /^[a-z0-9-]+\.vercel\.app$/;

export const RELEASE_BRANCH = 'main';
export const RELEASE_REF = `refs/heads/${RELEASE_BRANCH}`;
export const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
export const QUALITY_JOB = 'Quality';
export const ROOT_DIRECTORY = 'apps/web';
export const ENVIRONMENTS = ['release-prepare', 'production'];

const outcome = (reasons) => ({ ok: reasons.length === 0, reasons });

// ---------------------------------------------------------------------------
// GitHub: trigger, HEAD, CI and Environments

export const checkTrigger = (trigger, repository) => {
  const reasons = [];
  if (trigger.eventName !== 'workflow_dispatch') {
    reasons.push('trigger-not-workflow-dispatch');
  }
  if (trigger.repository !== repository) reasons.push('foreign-repository');
  if (trigger.ref !== RELEASE_REF) reasons.push('ref-not-main');
  if (!SHA.test(trigger.sha ?? '')) reasons.push('invalid-sha');
  return reasons;
};

export const checkRepository = (repoApi, repository) => {
  if (!repoApi?.ok) return ['github-api-failed:repository'];
  const reasons = [];
  if (repoApi.data?.full_name !== repository) {
    reasons.push('foreign-repository');
  }
  // Required reviewers of an Environment are not enforced for a private
  // repository on GitHub Free: refuse instead of trusting a missing rule.
  const isPublic =
    repoApi.data?.private === false && repoApi.data?.visibility === 'public';
  if (!isPublic) reasons.push('repository-not-public');
  return reasons;
};

export const checkHead = (headApi, sha) => {
  if (!headApi?.ok) return ['github-api-failed:head'];
  return headApi.data?.object?.sha === sha ? [] : ['stale-sha'];
};

const byNewest = (a, b) =>
  b.run_number - a.run_number || (b.run_attempt ?? 1) - (a.run_attempt ?? 1);

// The newest push run of the CI workflow on main for exactly this commit of
// this repository; a fork, another branch or another workflow never counts.
export const selectCiRun = (runs, { sha, repository }) => {
  const isCandidateRun = (run) =>
    run.head_sha === sha &&
    run.event === 'push' &&
    run.head_branch === RELEASE_BRANCH &&
    run.path === CI_WORKFLOW_PATH &&
    run.repository?.full_name === repository &&
    run.head_repository?.full_name === repository;
  return runs.filter(isCandidateRun).sort(byNewest)[0] ?? null;
};

export const checkCi = (runsApi, jobsApi, { sha, repository }) => {
  if (!runsApi?.ok) return ['github-api-failed:ci-runs'];
  const runs = runsApi.data?.workflow_runs ?? [];
  const run = selectCiRun(runs, { sha, repository });
  if (!run) return ['ci-run-missing'];
  if (run.status !== 'completed') return ['ci-not-completed'];
  if (run.conclusion !== 'success') return ['ci-not-successful'];
  if (!jobsApi?.ok) return ['github-api-failed:ci-jobs'];
  const quality = (jobsApi.data?.jobs ?? []).filter(
    (job) => job.name === QUALITY_JOB && job.run_id === run.id,
  );
  if (quality.length !== 1) return ['quality-job-missing'];
  return quality[0].conclusion === 'success' ? [] : ['quality-not-successful'];
};

const isOnlyMainBranch = (policiesApi) => {
  const policies = policiesApi.data?.branch_policies ?? [];
  if (policies.length !== 1) return false;
  const policy = policies[0];
  return policy.name === RELEASE_BRANCH && policy.type === 'branch';
};

const checkReviewer = (name, environment, reviewer) => {
  const rules = (environment.protection_rules ?? []).filter(
    (rule) => rule.type === 'required_reviewers',
  );
  if (rules.length !== 1) return [`required-reviewer-missing:${name}`];
  const rule = rules[0];
  const reviewers = rule.reviewers ?? [];
  const login = reviewers[0]?.reviewer?.login ?? '';
  const isOwner =
    reviewers.length === 1 &&
    reviewers[0].type === 'User' &&
    login.toLowerCase() === reviewer.toLowerCase();
  const reasons = [];
  if (!isOwner) reasons.push(`required-reviewer-mismatch:${name}`);
  // The owner dispatches the release and approves it: self-review must be
  // allowed, otherwise the only reviewer can never approve.
  if (rule.prevent_self_review !== false) {
    reasons.push(`self-review-blocked:${name}`);
  }
  return reasons;
};

// An Environment exists, is limited to the branch main alone (no protected
// branches rule, no other pattern) and, when a reviewer is given, waits for
// exactly that owner.
export const checkEnvironment = (name, envApi, policiesApi, reviewer) => {
  if (envApi?.status === 404) return [`environment-missing:${name}`];
  if (!envApi?.ok) return [`github-api-failed:environment:${name}`];
  const reasons = [];
  const policy = envApi.data?.deployment_branch_policy;
  const isCustom =
    policy?.protected_branches === false &&
    policy?.custom_branch_policies === true;
  if (!isCustom) reasons.push(`branch-policy-not-custom:${name}`);
  if (!policiesApi?.ok) {
    reasons.push(`github-api-failed:branch-policies:${name}`);
  } else if (!isOnlyMainBranch(policiesApi)) {
    reasons.push(`branch-policy-not-main-only:${name}`);
  }
  if (reviewer) reasons.push(...checkReviewer(name, envApi.data, reviewer));
  return reasons;
};

export const checkPreflight = (input) => {
  const { trigger, repository, reviewer, api } = input;
  const sha = trigger.sha;
  const reasons = [
    ...checkTrigger(trigger, repository),
    ...checkRepository(api.repository, repository),
    ...checkHead(api.head, sha),
    ...checkCi(api.ciRuns, api.ciJobs, { sha, repository }),
    ...checkEnvironment(
      'release-prepare',
      api.environments['release-prepare'],
      api.branchPolicies['release-prepare'],
      null,
    ),
    ...checkEnvironment(
      'production',
      api.environments.production,
      api.branchPolicies.production,
      reviewer,
    ),
  ];
  return outcome(reasons);
};

// ---------------------------------------------------------------------------
// Vercel: project, staged candidate, smoke and promotion

const countAutomationBypass = (project) =>
  Object.values(project.protectionBypass ?? {}).filter(
    (entry) => entry?.scope === 'automation-bypass',
  ).length;

// `vercel curl` creates a new bypass secret when the project has none. The
// owner creates it in advance; without one the gate refuses before curl.
// The secret values are counted, never returned.
export const checkVercelProject = (projectApi, { projectId, orgId }) => {
  if (!projectApi?.ok) return outcome(['vercel-api-failed:project']);
  const project = projectApi.data ?? {};
  const reasons = [];
  if (project.id !== projectId) reasons.push('vercel-project-mismatch');
  if (project.accountId !== orgId) reasons.push('vercel-project-foreign-team');
  if (project.rootDirectory !== ROOT_DIRECTORY) {
    reasons.push('vercel-root-directory-mismatch');
  }
  if (!project.ssoProtection) reasons.push('vercel-authentication-disabled');
  if (countAutomationBypass(project) < 1) {
    reasons.push('automation-bypass-missing');
  }
  return outcome(reasons);
};

// The host of a plain https://<name>.vercel.app deployment URL, else null.
export const hostOf = (deploymentUrl) => {
  let url = null;
  try {
    url = new URL(deploymentUrl);
  } catch {
    return null;
  }
  const isPlain =
    url.protocol === 'https:' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '';
  return isPlain && DEPLOYMENT_HOST.test(url.hostname) ? url.hostname : null;
};

const ownerOf = (deployment) => {
  const owners = [deployment.ownerId, deployment.team?.id].filter(Boolean);
  if (owners.length === 0) return null;
  return owners.every((id) => id === owners[0]) ? owners[0] : null;
};

const checkDeployment = (deployment, expected) => {
  const reasons = [];
  if (!DEPLOYMENT_ID.test(deployment.id ?? '')) {
    reasons.push('deployment-id-invalid');
  }
  if (expected.deploymentId && deployment.id !== expected.deploymentId) {
    reasons.push('deployment-id-mismatch');
  }
  if (deployment.url !== expected.host) reasons.push('deployment-url-mismatch');
  if (deployment.projectId !== expected.projectId) {
    reasons.push('deployment-foreign-project');
  }
  if (ownerOf(deployment) !== expected.orgId) {
    reasons.push('deployment-foreign-team');
  }
  if (deployment.target !== 'production') {
    reasons.push('deployment-not-production-target');
  }
  if (deployment.readyState !== 'READY') reasons.push('deployment-not-ready');
  if (deployment.meta?.releaseSha !== expected.sha) {
    reasons.push('deployment-sha-mismatch');
  }
  const substate = deployment.readySubstate;
  const isStaged = substate === undefined || substate === 'STAGED';
  const aliases = deployment.alias ?? [];
  if (!isStaged || aliases.includes(expected.publicAlias)) {
    reasons.push('deployment-already-public');
  }
  return reasons;
};

// The candidate is the exact staged Production build of this commit in this
// project and team, and the public alias still serves another deployment.
export const checkCandidate = (deploymentApi, aliasApi, expected) => {
  const host = hostOf(expected.deploymentUrl);
  const empty = {
    deploymentId: null,
    deploymentUrl: null,
    previousDeploymentId: null,
  };
  if (!host) return { ...outcome(['deployment-url-invalid']), ...empty };
  if (!deploymentApi?.ok) {
    return { ...outcome(['vercel-api-failed:deployment']), ...empty };
  }
  const deployment = deploymentApi.data ?? {};
  const reasons = checkDeployment(deployment, { ...expected, host });
  let previousDeploymentId = null;
  if (aliasApi?.ok) {
    previousDeploymentId = aliasApi.data?.deploymentId ?? null;
    if (aliasApi.data?.projectId !== expected.projectId) {
      reasons.push('public-alias-foreign-project');
    }
    if (previousDeploymentId === deployment.id) {
      reasons.push('deployment-already-public');
    }
  } else {
    reasons.push('vercel-api-failed:public-alias');
  }
  return {
    ...outcome([...new Set(reasons)]),
    deploymentId: deployment.id ?? null,
    deploymentUrl: `https://${host}`,
    previousDeploymentId,
  };
};

export const checkHome = (home) => {
  const reasons = [];
  const headers = home.headers ?? {};
  if (home.status !== 200) reasons.push('home-status');
  if (!(headers['content-type'] ?? '').includes('text/html')) {
    reasons.push('home-not-html');
  }
  if (!(headers['cache-control'] ?? '').includes('no-store')) {
    reasons.push('home-cacheable');
  }
  const body = home.body ?? '';
  if (!body.includes('<title>B1 Kompass</title>')) reasons.push('home-title');
  if (!body.includes('Continue as guest')) reasons.push('home-guest-entry');
  return reasons;
};

// Without a guest cookie the legacy address answers with a temporary
// redirect to the start page of the same deployment.
export const checkPracticeRedirect = (practice, baseUrl) => {
  if (practice.status !== 307) return ['practice-status'];
  let target = null;
  try {
    target = new URL(practice.headers?.location ?? '', baseUrl);
  } catch {
    return ['practice-redirect-target'];
  }
  const isStart =
    target.origin === new URL(baseUrl).origin &&
    target.pathname === '/' &&
    target.search === '';
  return isStart ? [] : ['practice-redirect-target'];
};

export const checkSmoke = ({ home, practice }, baseUrl) =>
  outcome([...checkHome(home), ...checkPracticeRedirect(practice, baseUrl)]);

// One observation of the public alias after `vercel promote`. Success only
// when Vercel reports the candidate; an exit code alone never counts, and no
// outcome asks for a second promote.
export const decidePromotion = (observation) => {
  const { aliasApi, candidateId, projectId, isFinal } = observation;
  const isCandidate =
    aliasApi?.ok === true &&
    aliasApi.data?.projectId === projectId &&
    aliasApi.data?.deploymentId === candidateId;
  if (isCandidate) return 'promoted';
  return isFinal ? 'failed' : 'wait';
};

// Bounded polling of the alias. It receives only a reader and a sleep: it
// cannot run `vercel promote` again.
export const reconcilePromotion = async (deps, expected) => {
  const { readAlias, sleep } = deps;
  const { candidateId, projectId, attempts, intervalMs } = expected;
  let decision = 'failed';
  let observed = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const aliasApi = await readAlias();
    observed = aliasApi?.ok ? (aliasApi.data?.deploymentId ?? null) : null;
    const isFinal = attempt === attempts;
    decision = decidePromotion({ aliasApi, candidateId, projectId, isFinal });
    if (decision !== 'wait') break;
    await sleep(intervalMs);
  }
  return { decision, observed };
};

// ---------------------------------------------------------------------------
// Supabase: DB target and migration history

// Only the IPv4 session pooler of the expected project, user
// postgres.<project>, database postgres and TLS. Reasons never contain the
// URL or any of its parts.
export const checkDbUrl = (dbUrl, projectId) => {
  if (!PROJECT_REF.test(projectId ?? '')) {
    return outcome(['project-id-invalid']);
  }
  let url = null;
  try {
    url = new URL(dbUrl ?? '');
  } catch {
    return outcome(['db-url-invalid']);
  }
  const reasons = [];
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    reasons.push('db-url-scheme');
  }
  let user = '';
  try {
    user = decodeURIComponent(url.username);
  } catch {
    user = '';
  }
  if (user !== `postgres.${projectId}`) reasons.push('db-url-foreign-project');
  if (url.password === '') reasons.push('db-url-password-missing');
  if (!POOLER_HOST.test(url.hostname)) reasons.push('db-url-host');
  if (url.port !== SESSION_POOLER_PORT) reasons.push('db-url-port');
  if (url.pathname !== '/postgres') reasons.push('db-url-database');
  if (!TLS_MODES.includes(url.searchParams.get('sslmode') ?? '')) {
    reasons.push('db-url-tls');
  }
  return outcome(reasons);
};

const isAscending = (versions) =>
  versions.every((version, i) => i === 0 || versions[i - 1] < version);

export const parseLocalMigrations = (fileNames) => {
  const reasons = [];
  const versions = [];
  for (const name of fileNames) {
    const match = MIGRATION_FILE.exec(name);
    if (match) versions.push(match[1]);
    else reasons.push('local-migration-name');
  }
  versions.sort();
  if (!isAscending(versions)) reasons.push('local-migration-duplicate');
  return { versions, reasons: [...new Set(reasons)] };
};

// Output of psql -At: one version per line; the BEGIN/COMMIT tags of the
// read-only transaction are ignored, anything else is a refusal.
export const parseRemoteVersions = (text) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== 'BEGIN' && line !== 'COMMIT');
  const isReadable = lines.every((line) => VERSION.test(line));
  return {
    versions: lines,
    reasons: isReadable ? [] : ['remote-history-unreadable'],
  };
};

// Before push the remote history is an ordered prefix of the files of this
// commit; after push both lists are equal. This proves the registered
// migrations only, not the absence of manual DDL.
export const checkMigrationHistory = ({ local, remote, phase }) => {
  const reasons = [];
  if (phase !== 'before' && phase !== 'after') reasons.push('phase-invalid');
  if (!isAscending(remote)) reasons.push('remote-history-unordered');
  const isPrefix =
    remote.length <= local.length &&
    remote.every((version, i) => version === local[i]);
  if (!isPrefix) reasons.push('migration-history-drift');
  if (phase === 'after' && remote.length !== local.length) {
    reasons.push('migration-history-incomplete');
  }
  const pending = isPrefix ? local.slice(remote.length) : [];
  return { ...outcome(reasons), pending };
};

// ---------------------------------------------------------------------------
// Command line (I/O only)

const GITHUB_API = 'https://api.github.com';
const VERCEL_API = 'https://api.vercel.com';
const API_TIMEOUT_MS = 20_000;
const CURL_TIMEOUT_MS = 90_000;

const fetchJson = async (url, headers) => {
  try {
    const response = await fetch(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, status: response.status, data: null };
    const data = await response.json();
    return { ok: true, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
};

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing-env:${name}`);
  return value;
};

const parseFlags = (argv) => {
  const parsed = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith('--') || value === undefined) {
      throw new Error(`invalid-argument:${key}`);
    }
    parsed[key.slice(2)] = value;
  }
  return parsed;
};

const setOutput = (name, value) => {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
};

const addSummary = (line) => {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${line}\n`);
};

const report = (name, result) => {
  if (result.ok) {
    console.log(`release gate ${name}: ok`);
    return true;
  }
  console.error(`release gate ${name}: refused`);
  for (const reason of result.reasons) console.error(`  - ${reason}`);
  process.exitCode = 1;
  return false;
};

const createGithubReader = () => {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${need('GITHUB_TOKEN')}`,
    'User-Agent': 'b1-kompass-release-gate',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  return (pathname) => fetchJson(`${GITHUB_API}${pathname}`, headers);
};

const createVercelReader = () => {
  const headers = { Authorization: `Bearer ${need('VERCEL_TOKEN')}` };
  const teamId = encodeURIComponent(need('VERCEL_ORG_ID'));
  return (pathname) =>
    fetchJson(`${VERCEL_API}${pathname}?teamId=${teamId}`, headers);
};

const readEnvironments = async (get, repo) => {
  const environments = {};
  const branchPolicies = {};
  for (const name of ENVIRONMENTS) {
    const base = `${repo}/environments/${name}`;
    environments[name] = await get(base);
    branchPolicies[name] = await get(
      `${base}/deployment-branch-policies?per_page=100`,
    );
  }
  return { environments, branchPolicies };
};

const runPreflight = async () => {
  const repository = need('EXPECTED_REPOSITORY');
  const reviewer = need('RELEASE_REVIEWER');
  const trigger = {
    eventName: process.env.GITHUB_EVENT_NAME,
    repository: process.env.GITHUB_REPOSITORY,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
  };
  const get = createGithubReader();
  const repo = `/repos/${repository}`;
  const query = new URLSearchParams({
    event: 'push',
    branch: RELEASE_BRANCH,
    head_sha: trigger.sha ?? '',
    per_page: '50',
  });
  const ciRuns = await get(`${repo}/actions/workflows/ci.yml/runs?${query}`);
  const runs = ciRuns.ok ? (ciRuns.data?.workflow_runs ?? []) : [];
  const run = selectCiRun(runs, { sha: trigger.sha, repository });
  const ciJobs = run
    ? await get(`${repo}/actions/runs/${run.id}/jobs?filter=latest`)
    : null;
  const api = {
    repository: await get(repo),
    head: await get(`${repo}/git/ref/heads/${RELEASE_BRANCH}`),
    ciRuns,
    ciJobs,
    ...(await readEnvironments(get, repo)),
  };
  const result = checkPreflight({ trigger, repository, reviewer, api });
  if (!report('preflight', result)) return;
  addSummary(
    `- Preflight: \`${trigger.sha}\` is HEAD of main, CI run ${run.id}`,
  );
};

const runVercelProject = async () => {
  const projectId = need('VERCEL_PROJECT_ID');
  const orgId = need('VERCEL_ORG_ID');
  const get = createVercelReader();
  const projectApi = await get(`/v9/projects/${encodeURIComponent(projectId)}`);
  const result = checkVercelProject(projectApi, { projectId, orgId });
  return report('vercel-project', result);
};

const runDeployment = async (flags) => {
  const deploymentUrl = flags.url ?? '';
  const host = hostOf(deploymentUrl);
  const publicAlias = need('PUBLIC_ALIAS');
  const get = createVercelReader();
  const noRead = { ok: false, status: 0, data: null };
  const deploymentApi = host ? await get(`/v13/deployments/${host}`) : noRead;
  const aliasApi = await get(`/v4/aliases/${publicAlias}`);
  const result = checkCandidate(deploymentApi, aliasApi, {
    deploymentUrl,
    deploymentId: flags['expect-id'] ?? null,
    projectId: need('VERCEL_PROJECT_ID'),
    orgId: need('VERCEL_ORG_ID'),
    sha: need('RELEASE_SHA'),
    publicAlias,
  });
  if (!report('deployment', result)) return;
  setOutput('deployment_id', result.deploymentId);
  setOutput('deployment_url', result.deploymentUrl);
  setOutput('previous_deployment_id', result.previousDeploymentId ?? '');
  addSummary(
    `- Candidate \`${result.deploymentId}\` (${result.deploymentUrl}); ` +
      `${publicAlias} still serves \`${result.previousDeploymentId}\``,
  );
};

const parseHeaders = (text) => {
  const blocks = text.split(/\r?\n\r?\n/).filter((block) => block.trim());
  const lines = (blocks.at(-1) ?? '').split(/\r?\n/);
  const statusMatch = /^HTTP\/[\d.]+ (\d{3})/.exec(lines[0] ?? '');
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      headers[name] = line.slice(colon + 1).trim();
    }
  }
  return { status: statusMatch ? Number(statusMatch[1]) : 0, headers };
};

// GET through `vercel curl`: the CLI adds x-vercel-protection-bypass from
// the owner's existing project secret. Neither its stdout nor its stderr is
// printed, because a failing CLI could echo request headers.
const curlDeployment = (dir, name, pathname, deploymentUrl) => {
  const headerFile = path.join(dir, `${name}.headers`);
  const bodyFile = path.join(dir, `${name}.body`);
  const curlArgs = ['-sS', '--max-time', '30', '-X', 'GET'];
  const args = [
    'curl',
    pathname,
    '--deployment',
    deploymentUrl,
    '--token',
    need('VERCEL_TOKEN'),
    '--',
    ...curlArgs,
    '-D',
    headerFile,
    '-o',
    bodyFile,
  ];
  const run = spawnSync('vercel', args, {
    stdio: 'ignore',
    timeout: CURL_TIMEOUT_MS,
  });
  if (run.status !== 0) {
    throw new Error(`vercel-curl-failed:${name}:${run.status ?? 'timeout'}`);
  }
  const response = parseHeaders(readFileSync(headerFile, 'utf8'));
  return { ...response, body: readFileSync(bodyFile, 'utf8') };
};

const runSmoke = async (flags) => {
  if (!(await runVercelProject())) return;
  const host = hostOf(flags.url ?? '');
  if (!host) {
    report('smoke', outcome(['deployment-url-invalid']));
    return;
  }
  const baseUrl = `https://${host}`;
  const tempRoot = process.env.RUNNER_TEMP ?? tmpdir();
  const dir = mkdtempSync(path.join(tempRoot, 'smoke-'));
  try {
    const home = curlDeployment(dir, 'home', '/', baseUrl);
    const practice = curlDeployment(dir, 'practice', '/practice', baseUrl);
    const label = flags.stage ? `smoke ${flags.stage}` : 'smoke';
    report(label, checkSmoke({ home, practice }, baseUrl));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const runDbUrl = async () => {
  const projectId = need('SUPABASE_PROJECT_ID');
  report('db-url', checkDbUrl(process.env.SUPABASE_DB_URL, projectId));
};

const runMigrations = async (flags) => {
  const phase = flags.phase;
  const local = parseLocalMigrations(readdirSync('supabase/migrations'));
  const remoteText = readFileSync(flags['remote-file'], 'utf8');
  const remote = parseRemoteVersions(remoteText);
  const history = checkMigrationHistory({
    local: local.versions,
    remote: remote.versions,
    phase,
  });
  const reasons = [...local.reasons, ...remote.reasons, ...history.reasons];
  if (!report(`migrations ${phase}`, outcome(reasons))) return;
  const pending = history.pending.join(', ') || 'none';
  const counts = `remote ${remote.versions.length} of ${local.versions.length}`;
  console.log(`${counts}, pending: ${pending}`);
  addSummary(`- Migrations ${phase}: ${counts}, pending: ${pending}`);
};

const readPublicHome = async (publicAlias) => {
  try {
    const response = await fetch(`https://${publicAlias}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const headers = Object.fromEntries(response.headers);
    return { status: response.status, headers, body: await response.text() };
  } catch {
    return { status: 0, headers: {}, body: '' };
  }
};

const runPromotion = async (flags) => {
  const publicAlias = need('PUBLIC_ALIAS');
  const candidateId = flags['deployment-id'] ?? '';
  const get = createVercelReader();
  const deps = {
    readAlias: () => get(`/v4/aliases/${publicAlias}`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const { decision, observed } = await reconcilePromotion(deps, {
    candidateId,
    projectId: need('VERCEL_PROJECT_ID'),
    attempts: Number(flags.attempts ?? 18),
    intervalMs: Number(flags['interval-ms'] ?? 10_000),
  });
  console.log(`vercel promote exit code: ${flags['promote-exit'] ?? '?'}`);
  console.log(`${publicAlias} serves: ${observed ?? 'unknown'}`);
  const reasons = decision === 'promoted' ? [] : ['promotion-not-confirmed'];
  if (!report('promotion', outcome(reasons))) return;
  addSummary(`- Promoted: ${publicAlias} serves \`${candidateId}\``);
  const home = await readPublicHome(publicAlias);
  report('public home', outcome(checkHome(home)));
};

const COMMANDS = {
  preflight: runPreflight,
  'vercel-project': runVercelProject,
  deployment: runDeployment,
  smoke: runSmoke,
  'db-url': runDbUrl,
  migrations: runMigrations,
  promotion: runPromotion,
};

const main = async (argv) => {
  const command = argv[0];
  const run = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
  if (!run) throw new Error(`unknown-command:${command}`);
  await run(parseFlags(argv.slice(1)));
};

const entry = process.argv[1];
const isEntry =
  entry !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(entry)).href;

if (isEntry) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`release gate: ${error.message}`);
    process.exitCode = 1;
  });
}
