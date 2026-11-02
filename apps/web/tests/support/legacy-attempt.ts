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
    parts.push(
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
