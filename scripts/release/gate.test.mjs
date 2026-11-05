// node --test scripts/release/gate.test.mjs
// Positive and negative cases of the release gate. Pure inputs only: no
// network, no secrets, no Vercel or Supabase project.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RELEASE_STAGES,
  buildReleaseCard,
  checkCandidate,
  checkDbUrl,
  checkMigrationHistory,
  checkPreflight,
  checkSmoke,
  checkVercelProject,
  compositionText,
  decidePromotion,
  deriveReleaseStatus,
  describeCompare,
  escapeMarkdown,
  parseCommitMessage,
  parseLabel,
  parseLocalMigrations,
  parseRemoteVersions,
  pickApprover,
  publicSha,
  reconcilePromotion,
  runComposition,
  runReleaseCard,
} from './gate.mjs';

const REPOSITORY = 'strakhovdenya/b1-kompass';
const REVIEWER = 'strakhovdenya';
const SHA = 'a'.repeat(40);
const OLD_SHA = 'b'.repeat(40);
const PROJECT_ID = 'prj_TbhAm2zqwMunQHFhF5qaSmAZnJDS';
const ORG_ID = 'team_8CIxfH6pWMGHuoWC1zyr48pt';
const PUBLIC_ALIAS = 'b1-kompass.vercel.app';
const CANDIDATE_ID = 'dpl_Candidate123';
const PREVIOUS_ID = 'dpl_5mKAg5KA84Pe915sjd4XVmjKrv5p';
const CANDIDATE_HOST = 'b1-kompass-abc123-team.vercel.app';
const CANDIDATE_URL = `https://${CANDIDATE_HOST}`;
const SUPABASE_PROJECT = 'kkhhtfgqsfrzjyznicoj';

const ok = (data) => ({ ok: true, status: 200, data });
const fail = (status) => ({ ok: false, status, data: null });
const clone = (value) => structuredClone(value);

// ---------------------------------------------------------------- preflight

const ciRun = (overrides = {}) => ({
  id: 101,
  run_number: 7,
  run_attempt: 1,
  head_sha: SHA,
  head_branch: 'main',
  event: 'push',
  path: '.github/workflows/ci.yml',
  status: 'completed',
  conclusion: 'success',
  repository: { full_name: REPOSITORY },
  head_repository: { full_name: REPOSITORY },
  ...overrides,
});

const environment = (reviewers) => ({
  name: 'env',
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
  protection_rules: [
    { type: 'branch_policy' },
    ...(reviewers
      ? [
          {
            type: 'required_reviewers',
            prevent_self_review: false,
            reviewers,
          },
        ]
      : []),
  ],
});

const ownerReviewer = [{ type: 'User', reviewer: { login: REVIEWER } }];
const onlyMain = ok({
  total_count: 1,
  branch_policies: [{ name: 'main', type: 'branch' }],
});

const validPreflight = () => ({
  trigger: {
    eventName: 'workflow_dispatch',
    repository: REPOSITORY,
    ref: 'refs/heads/main',
    sha: SHA,
  },
  repository: REPOSITORY,
  reviewer: REVIEWER,
  api: {
    repository: ok({
      full_name: REPOSITORY,
      private: false,
      visibility: 'public',
    }),
    head: ok({ ref: 'refs/heads/main', object: { sha: SHA } }),
    ciRuns: ok({ total_count: 1, workflow_runs: [ciRun()] }),
    ciJobs: ok({
      jobs: [{ name: 'Quality', run_id: 101, conclusion: 'success' }],
    }),
    environments: {
      'release-prepare': ok(environment(null)),
      production: ok(environment(ownerReviewer)),
    },
    branchPolicies: { 'release-prepare': onlyMain, production: onlyMain },
  },
});

const refusal = (input) => {
  const result = checkPreflight(input);
  assert.equal(result.ok, false);
  return result.reasons;
};

test('accepts valid manual release', () => {
  assert.deepEqual(checkPreflight(validPreflight()), { ok: true, reasons: [] });

  const reviewerInOtherCase = validPreflight();
  reviewerInOtherCase.reviewer = 'StrakhovDenya';
  assert.equal(checkPreflight(reviewerInOtherCase).ok, true);

  const rerun = validPreflight();
  rerun.api.ciRuns = ok({
    workflow_runs: [
      ciRun({ id: 90, run_number: 6, conclusion: 'failure' }),
      ciRun(),
    ],
  });
  assert.equal(checkPreflight(rerun).ok, true);
});

test('rejects untrusted CI and SHA', () => {
  const cases = [
    [
      'push trigger',
      (i) => (i.trigger.eventName = 'push'),
      'trigger-not-workflow-dispatch',
    ],
    [
      'foreign repository',
      (i) => (i.trigger.repository = 'fork/b1-kompass'),
      'foreign-repository',
    ],
    [
      'other branch',
      (i) => (i.trigger.ref = 'refs/heads/task/x'),
      'ref-not-main',
    ],
    ['tag', (i) => (i.trigger.ref = 'refs/tags/v1'), 'ref-not-main'],
    ['invalid sha', (i) => (i.trigger.sha = 'main'), 'invalid-sha'],
    [
      'stale sha',
      (i) => (i.api.head = ok({ object: { sha: OLD_SHA } })),
      'stale-sha',
    ],
    [
      'head api failure',
      (i) => (i.api.head = fail(500)),
      'github-api-failed:head',
    ],
    [
      'ci api failure',
      (i) => (i.api.ciRuns = fail(403)),
      'github-api-failed:ci-runs',
    ],
    [
      'no ci run',
      (i) => (i.api.ciRuns = ok({ workflow_runs: [] })),
      'ci-run-missing',
    ],
    [
      'ci of other sha',
      (i) =>
        (i.api.ciRuns = ok({ workflow_runs: [ciRun({ head_sha: OLD_SHA })] })),
      'ci-run-missing',
    ],
    [
      'ci of pull request',
      (i) =>
        (i.api.ciRuns = ok({
          workflow_runs: [ciRun({ event: 'pull_request' })],
        })),
      'ci-run-missing',
    ],
    [
      'ci of fork',
      (i) =>
        (i.api.ciRuns = ok({
          workflow_runs: [
            ciRun({ head_repository: { full_name: 'fork/b1-kompass' } }),
          ],
        })),
      'ci-run-missing',
    ],
    [
      'other workflow',
      (i) =>
        (i.api.ciRuns = ok({
          workflow_runs: [ciRun({ path: '.github/workflows/other.yml' })],
        })),
      'ci-run-missing',
    ],
    [
      'ci running',
      (i) =>
        (i.api.ciRuns = ok({
          workflow_runs: [ciRun({ status: 'in_progress', conclusion: null })],
        })),
      'ci-not-completed',
    ],
    [
      'ci failed',
      (i) =>
        (i.api.ciRuns = ok({
          workflow_runs: [ciRun({ conclusion: 'failure' })],
        })),
      'ci-not-successful',
    ],
    [
      'newest ci cancelled',
      (i) =>
        (i.api.ciRuns = ok({
          workflow_runs: [
            ciRun(),
            ciRun({ id: 102, run_number: 8, conclusion: 'cancelled' }),
          ],
        })),
      'ci-not-successful',
    ],
    [
      'quality missing',
      (i) =>
        (i.api.ciJobs = ok({
          jobs: [{ name: 'Other', run_id: 101, conclusion: 'success' }],
        })),
      'quality-job-missing',
    ],
    [
      'quality failed',
      (i) =>
        (i.api.ciJobs = ok({
          jobs: [{ name: 'Quality', run_id: 101, conclusion: 'failure' }],
        })),
      'quality-not-successful',
    ],
    [
      'jobs api failure',
      (i) => (i.api.ciJobs = fail(502)),
      'github-api-failed:ci-jobs',
    ],
  ];
  for (const [label, mutate, reason] of cases) {
    const input = validPreflight();
    mutate(input);
    assert.ok(refusal(input).includes(reason), `${label}: ${reason}`);
  }
});

test('rejects unsafe GitHub environments', () => {
  const production = (i) => i.api.environments.production.data;
  const cases = [
    [
      'missing production',
      (i) => (i.api.environments.production = fail(404)),
      'environment-missing:production',
    ],
    [
      'missing release-prepare',
      (i) => (i.api.environments['release-prepare'] = fail(404)),
      'environment-missing:release-prepare',
    ],
    [
      'environment api failure',
      (i) => (i.api.environments.production = fail(500)),
      'github-api-failed:environment:production',
    ],
    [
      'network failure',
      (i) => (i.api.environments['release-prepare'] = fail(0)),
      'github-api-failed:environment:release-prepare',
    ],
    [
      'all branches',
      (i) => (production(i).deployment_branch_policy = null),
      'branch-policy-not-custom:production',
    ],
    [
      'protected branches',
      (i) =>
        (production(i).deployment_branch_policy = {
          protected_branches: true,
          custom_branch_policies: false,
        }),
      'branch-policy-not-custom:production',
    ],
    [
      'extra branch',
      (i) =>
        (i.api.branchPolicies.production = ok({
          branch_policies: [
            { name: 'main', type: 'branch' },
            { name: 'task/*', type: 'branch' },
          ],
        })),
      'branch-policy-not-main-only:production',
    ],
    [
      'wildcard branch',
      (i) =>
        (i.api.branchPolicies['release-prepare'] = ok({
          branch_policies: [{ name: '*', type: 'branch' }],
        })),
      'branch-policy-not-main-only:release-prepare',
    ],
    [
      'tag policy',
      (i) =>
        (i.api.branchPolicies.production = ok({
          branch_policies: [{ name: 'main', type: 'tag' }],
        })),
      'branch-policy-not-main-only:production',
    ],
    [
      'policies api failure',
      (i) => (i.api.branchPolicies.production = fail(500)),
      'github-api-failed:branch-policies:production',
    ],
    [
      'no reviewer',
      (i) => (i.api.environments.production = ok(environment(null))),
      'required-reviewer-missing:production',
    ],
    [
      'wrong reviewer',
      (i) =>
        (i.api.environments.production = ok(
          environment([{ type: 'User', reviewer: { login: 'someone' } }]),
        )),
      'required-reviewer-mismatch:production',
    ],
    [
      'extra reviewer',
      (i) =>
        (i.api.environments.production = ok(
          environment([
            ...ownerReviewer,
            { type: 'User', reviewer: { login: 'someone' } },
          ]),
        )),
      'required-reviewer-mismatch:production',
    ],
    [
      'team reviewer',
      (i) =>
        (i.api.environments.production = ok(
          environment([{ type: 'Team', reviewer: { slug: REVIEWER } }]),
        )),
      'required-reviewer-mismatch:production',
    ],
    [
      'self review blocked',
      (i) => (production(i).protection_rules[1].prevent_self_review = true),
      'self-review-blocked:production',
    ],
    [
      'private repository',
      (i) =>
        (i.api.repository = ok({
          full_name: REPOSITORY,
          private: true,
          visibility: 'private',
        })),
      'repository-not-public',
    ],
    [
      'repository api failure',
      (i) => (i.api.repository = fail(500)),
      'github-api-failed:repository',
    ],
  ];
  for (const [label, mutate, reason] of cases) {
    const input = validPreflight();
    mutate(input);
    assert.ok(refusal(input).includes(reason), `${label}: ${reason}`);
  }
});

// ---------------------------------------------------------- staged candidate

const stagedDeployment = (overrides = {}) => ({
  id: CANDIDATE_ID,
  url: CANDIDATE_HOST,
  projectId: PROJECT_ID,
  ownerId: ORG_ID,
  team: { id: ORG_ID, name: 'team', slug: 'team' },
  target: 'production',
  readyState: 'READY',
  readySubstate: 'STAGED',
  meta: { releaseSha: SHA, githubCommitSha: SHA },
  alias: [],
  aliasAssigned: false,
  ...overrides,
});

const publicAlias = (deploymentId = PREVIOUS_ID) =>
  ok({ alias: PUBLIC_ALIAS, deploymentId, projectId: PROJECT_ID, uid: 'a' });

const expectedCandidate = (overrides = {}) => ({
  deploymentUrl: CANDIDATE_URL,
  deploymentId: null,
  projectId: PROJECT_ID,
  orgId: ORG_ID,
  sha: SHA,
  publicAlias: PUBLIC_ALIAS,
  ...overrides,
});

test('accepts trusted staged deployment', () => {
  const result = checkCandidate(
    ok(stagedDeployment()),
    publicAlias(),
    expectedCandidate(),
  );
  assert.deepEqual(result, {
    ok: true,
    reasons: [],
    deploymentId: CANDIDATE_ID,
    deploymentUrl: CANDIDATE_URL,
    previousDeploymentId: PREVIOUS_ID,
  });

  const recheck = checkCandidate(
    ok(stagedDeployment()),
    publicAlias(),
    expectedCandidate({ deploymentId: CANDIDATE_ID }),
  );
  assert.equal(recheck.ok, true);

  const project = {
    id: PROJECT_ID,
    accountId: ORG_ID,
    rootDirectory: 'apps/web',
    ssoProtection: { deploymentType: 'all_except_custom_domains' },
    protectionBypass: {
      'owner-secret-value': { scope: 'automation-bypass', createdAt: 1 },
    },
  };
  const projectResult = checkVercelProject(ok(project), {
    projectId: PROJECT_ID,
    orgId: ORG_ID,
  });
  assert.deepEqual(projectResult, { ok: true, reasons: [] });
  assert.ok(!JSON.stringify(projectResult).includes('owner-secret-value'));

  const protectedTypes = [
    'all',
    'all_except_custom_domains',
    'prod_deployment_urls_and_all_previews',
  ];
  for (const deploymentType of protectedTypes) {
    const enabled = {
      ...project,
      ssoProtection: { enabled: true, deploymentType },
    };
    const result = checkVercelProject(ok(enabled), {
      projectId: PROJECT_ID,
      orgId: ORG_ID,
    });
    assert.deepEqual(result, { ok: true, reasons: [] }, deploymentType);
  }
});

test('rejects invalid staged deployment', () => {
  const cases = [
    [
      'foreign project',
      stagedDeployment({ projectId: 'prj_other' }),
      'deployment-foreign-project',
    ],
    [
      'foreign team',
      stagedDeployment({ ownerId: 'team_other', team: { id: 'team_other' } }),
      'deployment-foreign-team',
    ],
    [
      'mixed owners',
      stagedDeployment({ team: { id: 'team_other' } }),
      'deployment-foreign-team',
    ],
    [
      'not ready',
      stagedDeployment({ readyState: 'BUILDING' }),
      'deployment-not-ready',
    ],
    [
      'error state',
      stagedDeployment({ readyState: 'ERROR' }),
      'deployment-not-ready',
    ],
    [
      'preview target',
      stagedDeployment({ target: null }),
      'deployment-not-production-target',
    ],
    [
      'foreign sha',
      stagedDeployment({ meta: { releaseSha: OLD_SHA } }),
      'deployment-sha-mismatch',
    ],
    ['no sha', stagedDeployment({ meta: {} }), 'deployment-sha-mismatch'],
    [
      'already promoted',
      stagedDeployment({ readySubstate: 'PROMOTED' }),
      'deployment-already-public',
    ],
    [
      'has public alias',
      stagedDeployment({ alias: [PUBLIC_ALIAS] }),
      'deployment-already-public',
    ],
    [
      'other url',
      stagedDeployment({ url: 'other-abc.vercel.app' }),
      'deployment-url-mismatch',
    ],
    ['invalid id', stagedDeployment({ id: 'x' }), 'deployment-id-invalid'],
  ];
  for (const [label, deployment, reason] of cases) {
    const result = checkCandidate(
      ok(deployment),
      publicAlias(),
      expectedCandidate(),
    );
    assert.equal(result.ok, false, label);
    assert.ok(result.reasons.includes(reason), `${label}: ${reason}`);
  }

  const reject = (deploymentApi, aliasApi, expected, reason) => {
    const result = checkCandidate(deploymentApi, aliasApi, expected);
    assert.equal(result.ok, false, reason);
    assert.ok(result.reasons.includes(reason), reason);
  };
  const deployment = ok(stagedDeployment());
  reject(
    deployment,
    publicAlias(CANDIDATE_ID),
    expectedCandidate(),
    'deployment-already-public',
  );
  reject(
    deployment,
    ok({ deploymentId: PREVIOUS_ID, projectId: 'prj_other' }),
    expectedCandidate(),
    'public-alias-foreign-project',
  );
  reject(
    deployment,
    fail(500),
    expectedCandidate(),
    'vercel-api-failed:public-alias',
  );
  reject(
    fail(404),
    publicAlias(),
    expectedCandidate(),
    'vercel-api-failed:deployment',
  );
  reject(
    deployment,
    publicAlias(),
    expectedCandidate({ deploymentId: 'dpl_Other' }),
    'deployment-id-mismatch',
  );
  for (const url of [
    'http://x.vercel.app',
    'https://evil.example.com',
    `${CANDIDATE_URL}/?x=1`,
    '',
  ]) {
    reject(
      deployment,
      publicAlias(),
      expectedCandidate({ deploymentUrl: url }),
      'deployment-url-invalid',
    );
  }

  const project = {
    id: PROJECT_ID,
    accountId: ORG_ID,
    rootDirectory: 'apps/web',
    ssoProtection: { deploymentType: 'prod_deployment_urls_and_all_previews' },
    protectionBypass: { s: { scope: 'automation-bypass' } },
  };
  const { ssoProtection: _sso, ...withoutSso } = project;
  const projectCases = [
    ['auth missing', withoutSso, 'vercel-authentication-disabled'],
    [
      'auth enabled false',
      {
        ...project,
        ssoProtection: {
          enabled: false,
          deploymentType: 'prod_deployment_urls_and_all_previews',
        },
      },
      'vercel-authentication-disabled',
    ],
    [
      'auth previews only',
      { ...project, ssoProtection: { deploymentType: 'preview' } },
      'vercel-authentication-disabled',
    ],
    [
      'auth unknown type',
      { ...project, ssoProtection: { deploymentType: 'none' } },
      'vercel-authentication-disabled',
    ],
    [
      'auth not an object',
      { ...project, ssoProtection: 'on' },
      'vercel-authentication-disabled',
    ],
    [
      'no bypass',
      { ...project, protectionBypass: {} },
      'automation-bypass-missing',
    ],
    [
      'other bypass scope',
      { ...project, protectionBypass: { s: { scope: 'shareable-link' } } },
      'automation-bypass-missing',
    ],
    [
      'auth disabled',
      { ...project, ssoProtection: null },
      'vercel-authentication-disabled',
    ],
    [
      'root directory',
      { ...project, rootDirectory: null },
      'vercel-root-directory-mismatch',
    ],
    [
      'foreign team',
      { ...project, accountId: 'team_other' },
      'vercel-project-foreign-team',
    ],
    [
      'other project',
      { ...project, id: 'prj_other' },
      'vercel-project-mismatch',
    ],
  ];
  for (const [label, data, reason] of projectCases) {
    const result = checkVercelProject(ok(data), {
      projectId: PROJECT_ID,
      orgId: ORG_ID,
    });
    assert.ok(result.reasons.includes(reason), `${label}: ${reason}`);
  }
  const apiFailure = checkVercelProject(fail(403), {
    projectId: PROJECT_ID,
    orgId: ORG_ID,
  });
  assert.deepEqual(apiFailure.reasons, ['vercel-api-failed:project']);
});

test('checks read-only smoke of the candidate', () => {
  const home = {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, no-store',
    },
    body: '<html><head><title>B1 Kompass</title></head><body>Continue as guest</body></html>',
  };
  const practice = { status: 307, headers: { location: '/' } };
  assert.deepEqual(checkSmoke({ home, practice }, CANDIDATE_URL), {
    ok: true,
    reasons: [],
  });
  const absolute = { status: 307, headers: { location: `${CANDIDATE_URL}/` } };
  assert.equal(
    checkSmoke({ home, practice: absolute }, CANDIDATE_URL).ok,
    true,
  );

  const login = {
    status: 401,
    headers: { 'content-type': 'text/html' },
    body: 'Vercel Authentication',
  };
  assert.equal(checkSmoke({ home: login, practice }, CANDIDATE_URL).ok, false);
  const sso = {
    status: 307,
    headers: { location: 'https://vercel.com/sso-api?url=x' },
  };
  assert.ok(
    checkSmoke({ home, practice: sso }, CANDIDATE_URL).reasons.includes(
      'practice-redirect-target',
    ),
  );
  const crashed = { ...home, status: 500 };
  assert.ok(
    checkSmoke({ home: crashed, practice }, CANDIDATE_URL).reasons.includes(
      'home-status',
    ),
  );
  const cacheable = {
    ...home,
    headers: { ...home.headers, 'cache-control': 'public, max-age=60' },
  };
  assert.ok(
    checkSmoke({ home: cacheable, practice }, CANDIDATE_URL).reasons.includes(
      'home-cacheable',
    ),
  );
  const otherApp = { ...home, body: '<title>Cards</title>' };
  assert.ok(
    checkSmoke({ home: otherApp, practice }, CANDIDATE_URL).reasons.includes(
      'home-title',
    ),
  );
  const rendered = { status: 200, headers: {} };
  assert.ok(
    checkSmoke({ home, practice: rendered }, CANDIDATE_URL).reasons.includes(
      'practice-status',
    ),
  );
});

// ------------------------------------------------------------------ Supabase

const DB_URL = `postgresql://postgres.${SUPABASE_PROJECT}:p%40ss@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require`;
const LOCAL = [
  '20261031000000',
  '20261101000000',
  '20261102000000',
  '20261108000000',
];

test('accepts migration history', () => {
  assert.deepEqual(checkDbUrl(DB_URL, SUPABASE_PROJECT), {
    ok: true,
    reasons: [],
  });
  const newerPooler = DB_URL.replace('aws-0-', 'aws-1-').replace(
    'require',
    'verify-full',
  );
  assert.equal(checkDbUrl(newerPooler, SUPABASE_PROJECT).ok, true);

  const files = [
    '20261108000000_m2_submission.sql',
    '20261031000000_guest_attempts.sql',
    '20261102000000_guest_session_limits.sql',
    '20261101000000_short_practice.sql',
  ];
  assert.deepEqual(parseLocalMigrations(files), {
    versions: LOCAL,
    reasons: [],
  });

  const psql = 'BEGIN\n20261031000000\n20261101000000\nCOMMIT\n';
  const remote = parseRemoteVersions(psql);
  assert.deepEqual(remote, { versions: LOCAL.slice(0, 2), reasons: [] });

  assert.deepEqual(
    checkMigrationHistory({
      local: LOCAL,
      remote: remote.versions,
      phase: 'before',
    }),
    { ok: true, reasons: [], pending: LOCAL.slice(2) },
  );
  assert.deepEqual(
    checkMigrationHistory({ local: LOCAL, remote: LOCAL, phase: 'before' }),
    { ok: true, reasons: [], pending: [] },
  );
  assert.deepEqual(
    checkMigrationHistory({
      local: LOCAL,
      remote: clone(LOCAL),
      phase: 'after',
    }),
    { ok: true, reasons: [], pending: [] },
  );
});

test('rejects unsafe DB target and migration drift', () => {
  const dbCases = [
    [
      'foreign project',
      DB_URL.replace(SUPABASE_PROJECT, 'abcdefghijklmnopqrst'),
      'db-url-foreign-project',
    ],
    [
      'plain postgres user',
      DB_URL.replace(`postgres.${SUPABASE_PROJECT}`, 'postgres'),
      'db-url-foreign-project',
    ],
    [
      'direct host',
      DB_URL.replace(
        'aws-0-eu-central-1.pooler.supabase.com',
        `db.${SUPABASE_PROJECT}.supabase.co`,
      ),
      'db-url-host',
    ],
    [
      'foreign host',
      DB_URL.replace('pooler.supabase.com', 'pooler.evil.com'),
      'db-url-host',
    ],
    ['transaction pooler', DB_URL.replace(':5432/', ':6543/'), 'db-url-port'],
    ['no tls', DB_URL.replace('?sslmode=require', ''), 'db-url-tls'],
    [
      'tls disabled',
      DB_URL.replace('sslmode=require', 'sslmode=disable'),
      'db-url-tls',
    ],
    [
      'tls preferred',
      DB_URL.replace('sslmode=require', 'sslmode=prefer'),
      'db-url-tls',
    ],
    [
      'other database',
      DB_URL.replace('/postgres?', '/other?'),
      'db-url-database',
    ],
    ['no password', DB_URL.replace(':p%40ss@', '@'), 'db-url-password-missing'],
    ['http scheme', DB_URL.replace('postgresql:', 'https:'), 'db-url-scheme'],
  ];
  for (const [label, url, reason] of dbCases) {
    const result = checkDbUrl(url, SUPABASE_PROJECT);
    assert.equal(result.ok, false, label);
    assert.ok(result.reasons.includes(reason), `${label}: ${reason}`);
    assert.ok(
      !JSON.stringify(result).includes('p%40ss'),
      `${label}: no secret`,
    );
  }
  assert.deepEqual(checkDbUrl('not a url', SUPABASE_PROJECT).reasons, [
    'db-url-invalid',
  ]);
  assert.deepEqual(checkDbUrl(undefined, SUPABASE_PROJECT).reasons, [
    'db-url-invalid',
  ]);
  assert.deepEqual(checkDbUrl(DB_URL, 'bad').reasons, ['project-id-invalid']);

  const drift = (remote, phase, reason) => {
    const result = checkMigrationHistory({ local: LOCAL, remote, phase });
    assert.equal(result.ok, false, reason);
    assert.ok(result.reasons.includes(reason), reason);
  };
  drift(
    ['20261031000000', '20261102000000'],
    'before',
    'migration-history-drift',
  );
  drift(['20261101000000'], 'before', 'migration-history-drift');
  drift([...LOCAL, '20261109000000'], 'before', 'migration-history-drift');
  drift([...LOCAL, '20261109000000'], 'after', 'migration-history-drift');
  drift(
    ['20261031000000', '20260101000000'],
    'before',
    'remote-history-unordered',
  );
  drift(
    ['20261031000000', '20261031000000'],
    'before',
    'remote-history-unordered',
  );
  drift(LOCAL.slice(0, 3), 'after', 'migration-history-incomplete');
  drift(LOCAL, 'during', 'phase-invalid');

  assert.deepEqual(parseRemoteVersions('20261031000000\nERROR: x\n').reasons, [
    'remote-history-unreadable',
  ]);
  assert.deepEqual(
    parseLocalMigrations(['20261031000000_a.sql', 'notes.md']).reasons,
    ['local-migration-name'],
  );
  assert.deepEqual(
    parseLocalMigrations(['20261031000000_a.sql', '20261031000000_b.sql'])
      .reasons,
    ['local-migration-duplicate'],
  );
});

// ------------------------------------------------------------------ promotion

test('accepts already promoted alias', async () => {
  for (const promoteExitCode of [0, 1]) {
    const decision = decidePromotion({
      aliasApi: publicAlias(CANDIDATE_ID),
      candidateId: CANDIDATE_ID,
      projectId: PROJECT_ID,
      isFinal: false,
      promoteExitCode,
    });
    assert.equal(decision, 'promoted');
  }

  const observations = [
    fail(0),
    publicAlias(PREVIOUS_ID),
    publicAlias(CANDIDATE_ID),
  ];
  let reads = 0;
  let sleeps = 0;
  const result = await reconcilePromotion(
    {
      readAlias: async () => observations[reads++],
      sleep: async () => sleeps++,
    },
    {
      candidateId: CANDIDATE_ID,
      projectId: PROJECT_ID,
      attempts: 5,
      intervalMs: 1,
    },
  );
  assert.deepEqual(result, { decision: 'promoted', observed: CANDIDATE_ID });
  assert.equal(reads, 3);
  assert.equal(sleeps, 2);
});

test('rejects uncertain promotion', async () => {
  const final = (aliasApi) =>
    decidePromotion({
      aliasApi,
      candidateId: CANDIDATE_ID,
      projectId: PROJECT_ID,
      isFinal: true,
    });
  assert.equal(final(publicAlias(PREVIOUS_ID)), 'failed');
  assert.equal(final(fail(0)), 'failed');
  assert.equal(final(fail(500)), 'failed');
  assert.equal(
    final(ok({ deploymentId: CANDIDATE_ID, projectId: 'prj_other' })),
    'failed',
  );
  assert.equal(
    final(ok({ deploymentId: null, projectId: PROJECT_ID })),
    'failed',
  );
  const early = decidePromotion({
    aliasApi: publicAlias(PREVIOUS_ID),
    candidateId: CANDIDATE_ID,
    projectId: PROJECT_ID,
    isFinal: false,
  });
  assert.equal(early, 'wait');

  // Timeout of `vercel promote` and an alias that never moves: bounded reads,
  // failure, and the reconciler has no way to promote again.
  let reads = 0;
  const result = await reconcilePromotion(
    {
      readAlias: async () => (reads++, publicAlias(PREVIOUS_ID)),
      sleep: async () => {},
    },
    {
      candidateId: CANDIDATE_ID,
      projectId: PROJECT_ID,
      attempts: 4,
      intervalMs: 1,
    },
  );
  assert.deepEqual(result, { decision: 'failed', observed: PREVIOUS_ID });
  assert.equal(reads, 4);
  assert.ok(!['promote', 'retry'].includes(result.decision));
});

// ------------------------------------------------- label, composition, card (#58)

const label = (value) => parseLabel(value);

test('label: accepts Cyrillic and allowed punctuation', () => {
  for (const value of ['ISSUE-12 таймеры', 'Ёжик #5: v1.2_final', 'a-b.c']) {
    assert.deepEqual(label(value), { ok: true, reasons: [], label: value });
  }
});

test('label: rejects command substitution, backtick, semicolon and newline', () => {
  const rejected = [
    '$(id)',
    'a`id`',
    'a;b',
    'a\nb',
    'a/b',
    "a'b",
    'a"b',
    'a&b',
    'a|b',
    'a<b',
    'rocket 🚀',
    '${{ secrets.X }}',
  ];
  for (const value of rejected) {
    assert.deepEqual(label(value).reasons, ['release-label-invalid'], value);
    assert.equal(label(value).label, '');
  }
});

test('label: rejects 81 characters, accepts 80 and empty', () => {
  assert.equal(label('a'.repeat(80)).ok, true);
  assert.equal(label('я'.repeat(80)).ok, true);
  assert.equal(label('a'.repeat(81)).ok, false);
  assert.equal(label('').ok, true);
  assert.equal(label(undefined).ok, true);
  assert.equal(label(null).label, '');
});

test('preflight: invalid label is refused', () => {
  const bad = validPreflight();
  bad.trigger.label = 'x; rm -rf /';
  assert.deepEqual(refusal(bad), ['release-label-invalid']);

  const good = validPreflight();
  good.trigger.label = 'ISSUE-12 таймеры';
  assert.equal(checkPreflight(good).ok, true);
});

const mergeMessage = (pr, branch, title) =>
  `Merge pull request #${pr} from strakhovdenya/${branch}\n\n${title}`;
const commit = (message) => ({ sha: SHA, commit: { message } });

test('composition: several merge commits give issues and PRs without duplicates', () => {
  const commits = [
    commit('feat: ISSUE-44 timers'),
    commit('test: ISSUE-44 timers again'),
    commit(mergeMessage(57, 'task/ISSUE-56-manual-cd', 'Manual CD')),
    commit(mergeMessage(55, 'task/ISSUE-41-free-blocks', 'Free blocks')),
    commit('fix: other work (#60)'),
    commit(mergeMessage(55, 'task/ISSUE-41-free-blocks', 'ISSUE-7 title')),
  ];
  assert.deepEqual(describeCompare(ok({ commits, total_commits: 6 })), {
    determined: true,
    count: 6,
    issues: [7, 41, 44, 56],
    prs: [55, 57, 60],
    truncated: false,
  });
  const cut = describeCompare(ok({ commits, total_commits: 250 }));
  assert.equal(cut.count, 250);
  assert.match(compositionText(cut), /списки неполные/);
  assert.deepEqual(parseCommitMessage('ISSUE-12 x\nISSUE-99 in body'), {
    issues: [12],
    prs: [],
  });
});

test('composition: commits without ISSUE or PR are counted only', () => {
  const commits = [commit('chore: tidy'), commit('docs: notes\n\nISSUE-5')];
  assert.deepEqual(describeCompare(ok({ commits })), {
    determined: true,
    count: 2,
    issues: [],
    prs: [],
    truncated: false,
  });
  assert.deepEqual(parseCommitMessage(undefined), { issues: [], prs: [] });
});

test('composition: empty compare is not determined', () => {
  for (const data of [{ commits: [] }, {}, { commits: 'x' }]) {
    assert.deepEqual(describeCompare(ok(data)), {
      determined: false,
      reason: 'compare-empty',
    });
  }
});

test('composition: unavailable API is not determined', () => {
  for (const api of [fail(0), fail(403), fail(500)]) {
    assert.deepEqual(describeCompare(api), {
      determined: false,
      reason: 'github-api-unavailable',
    });
  }
  assert.equal(describeCompare(undefined).reason, 'github-api-unavailable');
});

test('composition: unknown previous SHA is not determined', () => {
  assert.deepEqual(describeCompare(fail(404)), {
    determined: false,
    reason: 'previous-sha-unknown',
  });
});

test('composition: public SHA from releaseSha or githubCommitSha', () => {
  const both = { meta: { releaseSha: SHA, githubCommitSha: OLD_SHA } };
  assert.deepEqual(publicSha(both), { sha: SHA });
  assert.deepEqual(publicSha({ meta: { githubCommitSha: OLD_SHA } }), {
    sha: OLD_SHA,
  });
  const badRelease = { meta: { releaseSha: 'zz', githubCommitSha: OLD_SHA } };
  assert.deepEqual(publicSha(badRelease), { sha: OLD_SHA });
});

test('composition: alias without SHA is not determined', async () => {
  const withoutSha = [
    {},
    { meta: {} },
    { meta: { releaseSha: 'short' } },
    null,
  ];
  for (const deployment of withoutSha) {
    assert.deepEqual(publicSha(deployment), {
      sha: null,
      determined: false,
      reason: 'public-sha-missing',
    });
  }
  const reader = (deploymentApi) => ({
    previousId: PREVIOUS_ID,
    candidateSha: SHA,
    readDeployment: async () => deploymentApi,
    readCompare: async () => ok({ commits: [commit('x')] }),
  });
  const expected = { determined: false, reason: 'public-sha-missing' };
  assert.deepEqual(await runComposition(reader(ok({ meta: {} }))), expected);
  assert.deepEqual(await runComposition(reader(fail(404))), expected);
  const noPrevious = { ...reader(ok({})), previousId: '' };
  assert.deepEqual(await runComposition(noPrevious), expected);
});

test('composition: throwing reader does not fail', async () => {
  process.exitCode = undefined;
  const boom = async () => {
    throw new Error('boom');
  };
  const composition = await runComposition({
    previousId: PREVIOUS_ID,
    candidateSha: SHA,
    readDeployment: boom,
    readCompare: boom,
  });
  assert.equal(composition.determined, false);
  const card = await runReleaseCard(
    { readApprovals: boom, readAlias: boom },
    { phase: 'final', sha: SHA, repository: REPOSITORY, composition },
  );
  assert.match(card, /Карточка выпуска/);
  assert.match(card, /\| Подтвердил \| не определено \|/);
  const broken = await runReleaseCard({}, null);
  assert.match(broken, /карточка не собрана/);
  assert.equal(process.exitCode, undefined);
});

test('composition: summary lines for determined and unknown', () => {
  const found = { determined: true, count: 3, issues: [41, 44], prs: [55] };
  assert.equal(
    compositionText(found),
    'коммитов: 3; задачи: ISSUE-41, ISSUE-44; PR: #55',
  );
  assert.equal(
    compositionText({ determined: true, count: 1, issues: [], prs: [] }),
    'коммитов: 1; задачи: нет; PR: нет',
  );
  const reasons = [
    'compare-empty',
    'github-api-unavailable',
    'previous-sha-unknown',
    'public-sha-missing',
  ];
  for (const reason of reasons) {
    assert.equal(
      compositionText({ determined: false, reason }),
      `состав не определён: ${reason}`,
    );
  }
});

const approval = (overrides = {}) => ({
  state: 'approved',
  comment: 'ship it',
  user: { login: REVIEWER },
  environments: [{ name: 'production' }],
  ...overrides,
});

test('approvals: picks production approver and survives denied API', () => {
  const prepare = approval({
    environments: [{ name: 'release-prepare' }],
    user: { login: 'someone' },
  });
  const rejected = approval({ state: 'rejected', comment: 'no' });
  assert.deepEqual(pickApprover(ok([rejected, prepare, approval()])), {
    determined: true,
    login: REVIEWER,
    comment: 'ship it',
  });
  const unknown = { determined: false };
  assert.deepEqual(pickApprover(fail(403)), unknown);
  assert.deepEqual(pickApprover(ok([])), unknown);
  assert.deepEqual(pickApprover(ok([rejected])), unknown);
  assert.deepEqual(pickApprover(ok([prepare])), unknown);
  assert.deepEqual(pickApprover(ok({ not: 'a list' })), unknown);
});

const allSteps = () => ({
  recheck: { outcome: 'success' },
  install_deps: { outcome: 'success' },
  install_vercel: { outcome: 'success' },
  candidate_recheck: { outcome: 'success' },
  db_target: { outcome: 'success' },
  history_before: {
    outcome: 'success',
    outputs: {
      remote_count: '3',
      local_count: '5',
      pending: '20260101000000,20260102000000',
    },
  },
  dry_run: { outcome: 'success' },
  apply: { outcome: 'success' },
  history_after: {
    outcome: 'success',
    outputs: { remote_count: '5', local_count: '5', pending: '' },
  },
  smoke_after: { outcome: 'success' },
  candidate_final: { outcome: 'success' },
  promote: { outcome: 'success', outputs: { exit_code: '0' } },
  confirm: { outcome: 'success' },
});

test('status: derives stop stage from step outcomes', () => {
  assert.deepEqual(deriveReleaseStatus(allSteps()), {
    status: 'released',
    stage: null,
  });
  const failedApply = allSteps();
  failedApply.apply = { outcome: 'failure' };
  failedApply.history_after = { outcome: 'skipped' };
  failedApply.confirm = { outcome: 'skipped' };
  assert.deepEqual(deriveReleaseStatus(failedApply), {
    status: 'not-released',
    stage: 'применение миграций',
  });
  const cancelled = allSteps();
  cancelled.smoke_after = { outcome: 'cancelled' };
  assert.equal(deriveReleaseStatus(cancelled).stage, 'smoke после SQL');
  for (const unreadable of [null, undefined, 'x', {}]) {
    assert.deepEqual(deriveReleaseStatus(unreadable), {
      status: 'unknown',
      stage: null,
    });
  }
  const skippedAll = allSteps();
  skippedAll.confirm = { outcome: 'skipped' };
  assert.equal(deriveReleaseStatus(skippedAll).status, 'unknown');
});

const known = { determined: true, count: 3, issues: [41, 44], prs: [55] };
const finalCard = (overrides = {}) => ({
  phase: 'final',
  repository: REPOSITORY,
  runId: '123',
  label: 'ISSUE-12 таймеры',
  sha: SHA,
  actor: REVIEWER,
  composition: known,
  approver: { determined: true, login: REVIEWER, comment: 'ok' },
  candidateId: 'dpl_Candidate123',
  candidateUrl: CANDIDATE_URL,
  previousId: 'dpl_Prev1',
  preflight: 'success',
  smokeBefore: 'success',
  steps: allSteps(),
  aliasId: 'dpl_Candidate123',
  ...overrides,
});

const rowOf = (card, name) =>
  card.split('\n').find((line) => line.startsWith(`| ${name} |`));

test('card: full successful release snapshot', () => {
  const repo = `https://github.com/${REPOSITORY}`;
  assert.equal(
    buildReleaseCard(finalCard()),
    [
      `### Карточка выпуска (итоговая) ([запуск](${repo}/actions/runs/123))`,
      '',
      '| Поле | Значение |',
      '| --- | --- |',
      '| Название | ISSUE-12 таймеры |',
      `| Коммит | [aaaaaaa](${repo}/commit/${SHA}) \`${SHA}\` |`,
      `| Состав | коммитов: 3; задачи: [ISSUE-41](${repo}/issues/41), [ISSUE-44](${repo}/issues/44); PR: [#55](${repo}/pull/55) |`,
      `| Запустил | ${REVIEWER} |`,
      `| Подтвердил | ${REVIEWER}: «ok» |`,
      `| Кандидат | \`dpl_Candidate123\` ${CANDIDATE_URL} |`,
      '| Предыдущий deployment | `dpl_Prev1` |',
      '| Preflight | успешно |',
      '| Smoke до SQL | успешно |',
      '| Повторный preflight | успешно |',
      '| Миграции remote до → после | 3 → 5 (файлов: 5) |',
      '| Применённые миграции | `20260101000000`, `20260102000000` |',
      '| Smoke после SQL | успешно |',
      '| Promote | успешно; код выхода CLI: 0 |',
      '| Alias сейчас | кандидат (`dpl_Candidate123`) |',
      '| Откат | `vercel rollback dpl_Prev1` — только при совместимом SQL |',
      '| Итог | выпущен |',
    ].join('\n'),
  );
});

test('card: release without migrations snapshot', () => {
  const steps = allSteps();
  steps.history_before.outputs = {
    remote_count: '5',
    local_count: '5',
    pending: '',
  };
  const card = buildReleaseCard(finalCard({ steps }));
  assert.equal(
    rowOf(card, 'Применённые миграции'),
    '| Применённые миграции | нет |',
  );
  assert.equal(
    rowOf(card, 'Миграции remote до → после'),
    '| Миграции remote до → после | 5 → 5 (файлов: 5) |',
  );
  const unread = allSteps();
  delete unread.history_before;
  const unreadCard = buildReleaseCard(finalCard({ steps: unread }));
  assert.equal(
    rowOf(unreadCard, 'Применённые миграции'),
    '| Применённые миграции | не определено |',
  );
});

test('card: failed release shows stop stage and alias state', () => {
  const steps = allSteps();
  steps.promote = { outcome: 'success', outputs: { exit_code: '1' } };
  steps.confirm = { outcome: 'failure' };
  const card = buildReleaseCard(finalCard({ steps, aliasId: 'dpl_Prev1' }));
  assert.equal(
    rowOf(card, 'Итог'),
    '| Итог | не выпущен: остановка на этапе «подтверждение alias и публичной главной» |',
  );
  assert.equal(
    rowOf(card, 'Alias сейчас'),
    '| Alias сейчас | предыдущий (`dpl_Prev1`) |',
  );
  assert.equal(
    rowOf(card, 'Promote'),
    '| Promote | успешно; код выхода CLI: 1 |',
  );
  assert.equal(
    rowOf(card, 'Откат'),
    '| Откат | `vercel rollback dpl_Prev1` — только при совместимом SQL |',
  );
  const other = buildReleaseCard(finalCard({ steps, aliasId: 'dpl_Other9' }));
  assert.match(rowOf(other, 'Alias сейчас'), /другой deployment/);
  const noAlias = buildReleaseCard(finalCard({ steps, aliasId: null }));
  assert.equal(
    rowOf(noAlias, 'Alias сейчас'),
    '| Alias сейчас | не определено |',
  );
});

test('card: unknown approver is not determined', async () => {
  for (const approvalsApi of [fail(403), ok([]), ok(null)]) {
    const card = await runReleaseCard(
      {
        readApprovals: async () => approvalsApi,
        readAlias: async () => ok({ deploymentId: 'dpl_Candidate123' }),
      },
      finalCard({ approver: undefined, aliasId: undefined }),
    );
    assert.equal(rowOf(card, 'Подтвердил'), '| Подтвердил | не определено |');
    assert.match(rowOf(card, 'Alias сейчас'), /кандидат/);
  }
});

test('card: escapes pipes, html, newlines and backticks', () => {
  const evil = 'a|b <script>x</script>\nline `tick` [l](u) *b* _i_ &amp;';
  const card = buildReleaseCard(
    finalCard({
      label: evil,
      actor: evil,
      approver: { determined: true, login: evil, comment: evil },
    }),
  );
  const cells = card.split('\n').filter((line) => line.startsWith('| '));
  for (const line of cells) {
    assert.equal(line.split(/(?<!\\)\|/).length, 4, line);
    assert.doesNotMatch(line, /<|\r/);
  }
  const name = rowOf(card, 'Название');
  assert.match(name, /a&#124;b &lt;script&gt;/);
  assert.match(
    name,
    /line \\`tick\\` \\\[l\\\]\(u\) \\\*b\\\* \\_i\\_ &amp;amp;/,
  );
  assert.equal(escapeMarkdown('x'.repeat(300)).length, 200);
  assert.equal(escapeMarkdown(undefined), '');
  assert.equal(escapeMarkdown('a\\b'), 'a\\\\b');
});

test('card: preliminary card before approval', () => {
  const card = buildReleaseCard(finalCard({ phase: 'preliminary' }));
  assert.match(card, /^### Карточка выпуска \(предварительная\)/);
  assert.equal(rowOf(card, 'Итог'), '| Итог | ожидает подтверждения |');
  assert.equal(rowOf(card, 'Smoke до SQL'), '| Smoke до SQL | успешно |');
  assert.ok(rowOf(card, 'Состав'));
  assert.ok(rowOf(card, 'Кандидат'));
  const finalOnly = [
    'Подтвердил',
    'Применённые миграции',
    'Smoke после SQL',
    'Promote',
    'Alias сейчас',
    'Откат',
  ];
  for (const name of finalOnly)
    assert.equal(rowOf(card, name), undefined, name);
});

test('card: preliminary card with unknown composition', () => {
  const unknown = { determined: false, reason: 'previous-sha-unknown' };
  const card = buildReleaseCard(
    finalCard({ phase: 'preliminary', composition: unknown, steps: null }),
  );
  assert.equal(
    rowOf(card, 'Состав'),
    '| Состав | состав не определён: previous-sha-unknown |',
  );
  assert.equal(rowOf(card, 'Итог'), '| Итог | ожидает подтверждения |');
  assert.equal(rowOf(card, 'Promote'), undefined);
  const garbage = buildReleaseCard(
    finalCard({ phase: 'preliminary', composition: 'not json' }),
  );
  assert.match(rowOf(garbage, 'Состав'), /состав не определён/);
});

test('card: ignores unknown input fields', () => {
  const secret =
    'postgresql://postgres.x:S3CRET@aws-0-eu-west-1.pooler.supabase.com:5432/postgres';
  const card = buildReleaseCard(
    finalCard({
      SUPABASE_DB_URL: secret,
      bypass: 'BYPASS-VALUE',
      VERCEL_TOKEN: 'TOKEN-VALUE',
      body: '<html>response body</html>',
      steps: {
        ...allSteps(),
        db_target: { outcome: 'success', outputs: { url: secret } },
      },
    }),
  );
  const forbidden = [
    'S3CRET',
    'BYPASS-VALUE',
    'TOKEN-VALUE',
    'response body',
    'postgresql://',
  ];
  for (const value of forbidden)
    assert.equal(card.includes(value), false, value);
  assert.equal(card, buildReleaseCard(finalCard()));
});

// ------------------------------------------------------------ workflow text

const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/release-production.yml', import.meta.url),
  'utf8',
);

// Every `run:` value of a workflow: an inline value or a block scalar.
const runBlocks = (yaml) => {
  const lines = yaml.split(/\r?\n/);
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const keyIndent = match[1].length + (match[2]?.length ?? 0);
    const body = [match[3]];
    const isBlock = /^[|>][+-]?\d*$/.test(match[3]);
    for (let j = i + 1; isBlock && j < lines.length; j += 1) {
      const indent = /^\s*/.exec(lines[j])[0].length;
      if (lines[j].trim() !== '' && indent <= keyIndent) break;
      body.push(lines[j]);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
};

const jobSection = (yaml, job) => {
  const start = yaml.indexOf(`\n  ${job}:\n`);
  const next = yaml.slice(start + 1).search(/\n  [a-z-]+:\n/);
  return next === -1 ? yaml.slice(start) : yaml.slice(start, start + 1 + next);
};

test('workflow: no expression inside run blocks', () => {
  const blocks = runBlocks(WORKFLOW);
  assert.ok(blocks.length >= 10);
  for (const block of blocks) assert.equal(block.includes('${{'), false, block);

  const synthetic = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - run: echo "${{ github.event.inputs.label }}"',
    '      - name: x',
    '        run: |',
    '          echo ok',
    '          echo "${{ github.event.inputs.label }}"',
    '      - name: y',
    '        run: >-',
    '          node x',
    '            "${{ github.event.inputs.label }}"',
    '      - name: z',
    '        env:',
    '          L: ${{ github.event.inputs.label }}',
    '        run: echo "$L"',
  ].join('\n');
  const all = runBlocks(synthetic);
  assert.equal(all.length, 4);
  assert.equal(all.filter((block) => block.includes('${{')).length, 3);
});

test('workflow: label wiring, environment urls and card steps', () => {
  const header = WORKFLOW.slice(0, WORKFLOW.indexOf('\njobs:'));
  const runName =
    /run-name: .*github\.run_number.*github\.event\.inputs\.label/;
  assert.match(header, runName);
  assert.match(
    header,
    /RELEASE_LABEL: \$\{\{ github\.event\.inputs\.label \}\}/,
  );
  assert.match(header, /inputs:\n\s+label:\n(\s+.*\n)*?\s+required: false/);
  assert.equal(WORKFLOW.includes('${{ inputs.label }}'), false);
  assert.match(WORKFLOW, /--meta "releaseLabel=\$\{RELEASE_LABEL\}"/);

  const stage = jobSection(WORKFLOW, 'stage');
  const release = jobSection(WORKFLOW, 'release');
  const stageUrl =
    /environment:\n\s+name: release-prepare\n\s+url: \$\{\{ steps\.candidate\.outputs\.deployment_url \}\}/;
  assert.match(stage, stageUrl);
  const releaseUrl =
    /environment:\n\s+name: production\n\s+url: https:\/\/b1-kompass\.vercel\.app\n/;
  assert.match(release, releaseUrl);
  assert.match(stage, /id: composition/);
  assert.match(stage, /gate\.mjs composition/);
  assert.doesNotMatch(release, /gate\.mjs composition/);
  assert.match(stage, /CARD_PHASE: preliminary/);
  const cardStep = release.slice(release.indexOf('Write final release card'));
  assert.match(cardStep, /if: always\(\)/);
  assert.match(cardStep, /CARD_PHASE: final/);
  assert.match(cardStep, /STEPS_JSON: \$\{\{ toJSON\(steps\) \}\}/);
  assert.match(cardStep, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  assert.match(cardStep, /gate\.mjs release-card/);
  const order = [
    'id: candidate',
    'id: composition',
    'id: smoke',
    'write preliminary release card',
  ].map((token) => stage.toLowerCase().indexOf(token));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  for (const [id] of RELEASE_STAGES) {
    assert.match(release, new RegExp(`id: ${id}\\n`), id);
  }
});
