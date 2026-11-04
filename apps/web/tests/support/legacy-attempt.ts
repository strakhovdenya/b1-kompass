import { quote } from './sql';

// Synthetic M1 rows in the real shape before the M2 migration: no exam_id and
// no attempt_runs row. They are written only inside a transaction that first
// lifts the NOT NULL of exam_id and the active index, and that is always
// rolled back.

export const LIFT_M2_CONSTRAINTS = `
alter table public.attempts alter column exam_id drop not null;
drop index public.attempts_one_active_per_exam;
`;

export const RESTORE_M2_CONSTRAINTS = `
alter table public.attempts alter column exam_id set not null;
create unique index attempts_one_active_per_exam
  on public.attempts (guest_session_id, exam_id)
  where status = 'active';
`;

export interface LegacyResult {
  score: number;
  maxScore: number;
  correct: number;
  incorrect: number;
  skipped: number;
}

export interface LegacyAttempt {
  id: string;
  sessionId: string;
  versionId: string;
  status: 'active' | 'completed';
  createdAt: string;
  scope: 'short-set' | 'full-exam';
  answers: Readonly<Record<string, string>>;
  progress: unknown;
  result: LegacyResult | null;
}

const answerRows = (attempt: LegacyAttempt): string =>
  Object.entries(attempt.answers)
    .map(
      ([questionId, optionId], index) =>
        `(${quote(attempt.id)}, ${quote(questionId)}, ${quote(optionId)}, ` +
        `${index + 2}, ${quote(attempt.createdAt)})`,
    )
    .join(',\n');

// An attempt is inserted active with its answers and then completed, the
// order the M1 functions used: answers of a completed attempt are frozen.
export const legacyAttemptSql = (attempt: LegacyAttempt): string => {
  const progress =
    attempt.progress === null
      ? 'null'
      : `${quote(JSON.stringify(attempt.progress))}::jsonb`;
  const parts = [
    `insert into public.attempts (
      id, guest_session_id, exam_version_id, exam_id, scope, status,
      progress, created_at, updated_at
    ) values (
      ${quote(attempt.id)}, ${quote(attempt.sessionId)},
      ${quote(attempt.versionId)}, null, ${quote(attempt.scope)}, 'active',
      ${progress}, ${quote(attempt.createdAt)}, ${quote(attempt.createdAt)}
    );`,
  ];
  if (Object.keys(attempt.answers).length > 0) {
    parts.push(`insert into public.attempt_answers (
      attempt_id, question_id, option_id, revision, updated_at
    ) values ${answerRows(attempt)};`);
  }
  if (attempt.status === 'completed') {
    const result = attempt.result;
    if (!result) throw new Error('a completed legacy attempt needs a result');
    // Since the submission migration an active attempt completes only
    // through a frozen submission and a result needs one: the historical
    // completion is written with both guards lifted inside the same
    // rolled-back transaction.
    parts.push(
      `alter table public.attempts disable trigger attempts_guard_lifecycle;`,
      `alter table public.attempt_results
        disable trigger attempt_results_checked;`,
      `update public.attempts set status = 'completed'
        where id = ${quote(attempt.id)};`,
      `insert into public.attempt_results (
        attempt_id, scope, score, max_score, correct_count, incorrect_count,
        skipped_count, computed_at, percent
      ) values (
        ${quote(attempt.id)}, ${quote(attempt.scope)}, ${result.score},
        ${result.maxScore}, ${result.correct}, ${result.incorrect},
        ${result.skipped}, ${quote(attempt.createdAt)},
        round(${result.score} * 100.0 / ${result.maxScore})
      );`,
      `alter table public.attempts enable trigger attempts_guard_lifecycle;`,
      `alter table public.attempt_results
        enable trigger attempt_results_checked;`,
    );
  }
  return parts.join('\n');
};

// Every stored field of the given attempts as one JSON value, for an exact
// before/after comparison: attempt, run, answers, result and events.
export const snapshotSql = (attemptIds: readonly string[]): string => {
  const ids = attemptIds.map(quote).join(', ');
  return `select coalesce(jsonb_object_agg(a.id, jsonb_build_object(
    'attempt', to_jsonb(a),
    'run', (select to_jsonb(r) from public.attempt_runs r
      where r.attempt_id = a.id),
    'answers', (select coalesce(jsonb_agg(to_jsonb(x) order by x.question_id),
      '[]') from public.attempt_answers x where x.attempt_id = a.id),
    'result', (select to_jsonb(res) from public.attempt_results res
      where res.attempt_id = a.id),
    'events', (select coalesce(jsonb_agg(e.kind order by e.id), '[]')
      from public.guest_events e where e.attempt_id = a.id)
  )), '{}') from public.attempts a where a.id in (${ids})`;
};

export interface HistoricalCompletion {
  id: string;
  sessionId: string;
  examId: string;
  versionId: string;
  scope: 'short-set' | 'full-exam';
  createdAt: string;
  completedAt: string;
  answers: Readonly<Record<string, string>>;
  // null for a broken history: a completion whose result is missing.
  result: LegacyResult | null;
}

// A completion stored before the submission snapshot existed, in the shape
// it has after the transfer of M1 or after the old finish of #39: exam_id,
// a free training run over the whole version, answers, start and finish
// events and the stored result, but no frozen answers. The completion and
// its result are written with both guards lifted inside the transaction of
// the caller, which must not see the tables until it ends.
export const historicalCompletionSql = (
  completion: HistoricalCompletion,
): string => {
  const id = quote(completion.id);
  const answers = Object.entries(completion.answers)
    .map(
      ([questionId, optionId]) =>
        `(${id}, ${quote(questionId)}, ${quote(optionId)}, 1, ` +
        `${quote(completion.createdAt)})`,
    )
    .join(',\n');
  const parts = [
    `insert into public.attempts (
      id, guest_session_id, exam_id, exam_version_id, scope, status,
      created_at, updated_at
    ) values (
      ${id}, ${quote(completion.sessionId)}, ${quote(completion.examId)},
      ${quote(completion.versionId)}, ${quote(completion.scope)}, 'active',
      ${quote(completion.createdAt)}, ${quote(completion.createdAt)}
    );`,
    `select * from m2_private.backfill_m1_attempts(${id});`,
    `insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
      select 'start', s.visitor_id, ${id}, ${quote(completion.createdAt)}
      from public.guest_sessions s where s.id = ${quote(completion.sessionId)};`,
  ];
  if (answers) {
    parts.push(`insert into public.attempt_answers (
      attempt_id, question_id, option_id, revision, updated_at
    ) values ${answers};`);
  }
  parts.push(
    `alter table public.attempts disable trigger attempts_guard_lifecycle;`,
    `update public.attempts
      set status = 'completed', updated_at = ${quote(completion.completedAt)}
      where id = ${id};`,
    `alter table public.attempts enable trigger attempts_guard_lifecycle;`,
  );
  const { result } = completion;
  if (result) {
    parts.push(
      `alter table public.attempt_results
        disable trigger attempt_results_checked;`,
      `insert into public.attempt_results (
        attempt_id, scope, score, max_score, correct_count, incorrect_count,
        skipped_count, computed_at, percent
      ) values (
        ${id}, ${quote(completion.scope)}, ${result.score}, ${result.maxScore},
        ${result.correct}, ${result.incorrect}, ${result.skipped},
        ${quote(completion.completedAt)},
        round(${result.score} * 1000.0 / ${result.maxScore}) / 10
      );`,
      `alter table public.attempt_results
        enable trigger attempt_results_checked;`,
      `insert into public.guest_events (kind, visitor_id, attempt_id,
        occurred_at)
        select 'finish', s.visitor_id, ${id}, ${quote(completion.completedAt)}
        from public.guest_sessions s
        where s.id = ${quote(completion.sessionId)};`,
    );
  }
  return parts.join('\n');
};

export interface HistoricalActive {
  id: string;
  sessionId: string;
  examId: string;
  versionId: string;
  scope: 'short-set' | 'full-exam';
  createdAt: string;
  // The stored revision of each answer: the next choice continues above it.
  answers: Readonly<Record<string, { optionId: string; revision: number }>>;
  progress: unknown;
}

// An open M1 attempt in the shape it has after the transfer: exam_id, a free
// training run over the whole version from the scoped backfill, the answers
// with their revisions, the stored place and the start event. Written in the
// transaction of the caller, committed before the browser reads it. Without
// a run the attempt stays as the transfer found it, for a neighbour check.
export const historicalActiveSql = (
  active: HistoricalActive,
  options: { hasRun: boolean } = { hasRun: true },
): string => {
  const id = quote(active.id);
  const answers = Object.entries(active.answers)
    .map(
      ([questionId, answer]) =>
        `(${id}, ${quote(questionId)}, ${quote(answer.optionId)}, ` +
        `${answer.revision}, ${quote(active.createdAt)})`,
    )
    .join(', ');
  const progress =
    active.progress === null
      ? 'null'
      : `${quote(JSON.stringify(active.progress))}::jsonb`;
  const parts = [
    `insert into public.attempts (
      id, guest_session_id, exam_id, exam_version_id, scope, status,
      progress, created_at, updated_at
    ) values (
      ${id}, ${quote(active.sessionId)}, ${quote(active.examId)},
      ${quote(active.versionId)}, ${quote(active.scope)}, 'active',
      ${progress}, ${quote(active.createdAt)}, ${quote(active.createdAt)}
    );`,
    ...(options.hasRun
      ? [`select * from m2_private.backfill_m1_attempts(${id});`]
      : []),
    `insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
      select 'start', s.visitor_id, ${id}, ${quote(active.createdAt)}
      from public.guest_sessions s where s.id = ${quote(active.sessionId)};`,
  ];
  if (answers) {
    parts.push(`insert into public.attempt_answers (
      attempt_id, question_id, option_id, revision, updated_at
    ) values ${answers};`);
  }
  return parts.join(' ');
};
