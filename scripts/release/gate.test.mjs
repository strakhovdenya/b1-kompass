// node --test scripts/release/gate.test.mjs
// Positive and negative cases of the release gate. Pure inputs only: no
// network, no secrets, no Vercel or Supabase project.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkCandidate,
  checkDbUrl,
  checkMigrationHistory,
  checkPreflight,
  checkSmoke,
  checkVercelProject,
  decidePromotion,
  parseLocalMigrations,
  parseRemoteVersions,
  reconcilePromotion,
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
