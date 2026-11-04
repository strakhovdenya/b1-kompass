-- M2 P2-T2: the final submission is accepted before the result is computed.
-- A submit freezes the effective answers of the assigned tasks, records the
-- moment of acceptance and its commandId, and moves the attempt to submitted:
-- the active slot is free at once. The result is written by a separate
-- finalize that the database checks against the frozen snapshot and the
-- closed key. A cancel closes an active attempt without a result. Saves of
-- answers and of the place get new functions without a time parameter; the
-- old save, progress and finish functions are removed. Completed attempts of
-- M1 and of the old finish keep their stored result and are marked legacy.
-- The access model is kept: only service_role reaches tables and runtime
-- functions; kernels and the migration helper are owner-only.

-- Submission snapshot ---------------------------------------------------------

-- frozen_answers maps each answered assigned task to its option and
-- revision: {"<questionId>": {"optionId": "...", "revision": n}}. It is
-- written once, together with the moment and the command of the submission.
-- legacy_completed marks a completion stored before this snapshot existed;
-- only the owner migration helper sets it.
alter table public.attempt_runs
  add column frozen_answers jsonb
    check (frozen_answers is null or jsonb_typeof(frozen_answers) = 'object'),
  add column submission_accepted_at timestamptz,
  add column submit_command_id uuid,
  add column legacy_completed boolean not null default false,
  add constraint attempt_runs_submission_together check (
    (frozen_answers is null) = (submission_accepted_at is null)
    and (frozen_answers is null) = (submit_command_id is null)
  ),
  add constraint attempt_runs_legacy_unfrozen
    check (not legacy_completed or frozen_answers is null);

alter table public.attempt_commands drop constraint attempt_commands_kind_check;
alter table public.attempt_commands add constraint attempt_commands_kind_check
  check (kind in ('start', 'submit', 'cancel'));

-- Database guards -------------------------------------------------------------

-- Identity is fixed; active only moves to submitted or cancelled. A submitted
-- attempt needs its frozen snapshot and completes only once its result is
-- stored; completed and cancelled are final. Deletes stay possible for the
-- purge of guest sessions.
create or replace function public.guard_attempt_lifecycle()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
    or new.guest_session_id <> old.guest_session_id
    or new.exam_version_id <> old.exam_version_id
    or new.scope <> old.scope
    or new.created_at <> old.created_at
    or (old.exam_id is not null and new.exam_id is distinct from old.exam_id)
  then
    raise exception 'attempt identity is fixed'
      using errcode = 'P0001', hint = 'attempt_identity_fixed';
  end if;
  if old.status = 'cancelled' then
    raise exception 'a cancelled attempt is final'
      using errcode = 'P0001', hint = 'attempt_cancelled';
  end if;
  if old.status = 'completed' and new.status <> 'completed' then
    raise exception 'a completed attempt cannot be reopened'
      using errcode = 'P0001', hint = 'attempt_completed';
  end if;
  if old.status = 'submitted' and new.status not in ('submitted', 'completed')
  then
    raise exception 'a submitted attempt only completes'
      using errcode = 'P0001', hint = 'attempt_submitted';
  end if;
  if old.status = 'active' and new.status = 'completed' then
    raise exception 'an active attempt completes only through a submission'
      using errcode = 'P0001', hint = 'attempt_not_submitted';
  end if;
  if new.status = 'submitted' and old.status <> 'submitted'
    and not exists (
      select 1 from public.attempt_runs r
      where r.attempt_id = new.id and r.frozen_answers is not null
    )
  then
    raise exception 'a submission needs its frozen answers'
      using errcode = 'P0001', hint = 'submission_not_frozen';
  end if;
  if new.status = 'completed' and old.status = 'submitted'
    and not exists (
      select 1 from public.attempt_results res where res.attempt_id = new.id
    )
  then
    raise exception 'a submission completes only with its result'
      using errcode = 'P0001', hint = 'result_missing';
  end if;
  return new;
end;
$$;

-- The run is fixed at the start. The cancel reason and the submission
-- snapshot are written once, the snapshot only while the attempt is active.
-- The legacy mark goes only from false to true, for a completed attempt with
-- a stored result and no snapshot.
create or replace function public.guard_attempt_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.attempt_id <> old.attempt_id
    or new.mode <> old.mode
    or new.purpose <> old.purpose
    or new.selection <> old.selection
    or new.source_attempt_id is distinct from old.source_attempt_id
    or new.assignment <> old.assignment
    or new.accepted_at <> old.accepted_at
    or (old.cancel_reason is not null
      and new.cancel_reason is distinct from old.cancel_reason)
    or (old.frozen_answers is not null and (
      new.frozen_answers is distinct from old.frozen_answers
      or new.submission_accepted_at is distinct from old.submission_accepted_at
      or new.submit_command_id is distinct from old.submit_command_id))
  then
    raise exception 'an attempt run is fixed'
      using errcode = 'P0001', hint = 'attempt_run_fixed';
  end if;
  if old.frozen_answers is null and new.frozen_answers is not null
    and not exists (
      select 1 from public.attempts a
      where a.id = new.attempt_id and a.status = 'active'
    )
  then
    raise exception 'only an active attempt is frozen'
      using errcode = 'P0001', hint = 'attempt_run_fixed';
  end if;
  if new.legacy_completed <> old.legacy_completed then
    if old.legacy_completed then
      raise exception 'a legacy mark is final'
        using errcode = 'P0001', hint = 'legacy_mark_fixed';
    end if;
    if new.frozen_answers is not null
      or not exists (
        select 1 from public.attempts a
        where a.id = new.attempt_id and a.status = 'completed'
      )
      or not exists (
        select 1 from public.attempt_results res
        where res.attempt_id = new.attempt_id
      )
    then
      raise exception 'only a stored completion without a snapshot is legacy'
        using errcode = 'P0001', hint = 'legacy_not_eligible';
    end if;
  end if;
  return new;
end;
$$;

-- A new run starts without a snapshot and is never legacy.
create function public.guard_new_attempt_run()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.legacy_completed
    or new.frozen_answers is not null
    or new.cancel_reason is not null
  then
    raise exception 'a new run starts open'
      using errcode = 'P0001', hint = 'attempt_run_fixed';
  end if;
  return new;
end;
$$;

create trigger attempt_runs_new_open
  before insert on public.attempt_runs
  for each row execute function public.guard_new_attempt_run();

-- A result is stored only for a submitted attempt and only when it agrees
-- with its frozen snapshot: the maximum and the counts of the assigned tasks
-- against the closed key, the percentage, the totals of the skills and the
-- presence of a level. The value of the level is computed by @b1k/domain;
-- its scale is not repeated here.
create function public.check_attempt_result()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.attempts;
  v_run public.attempt_runs;
  v_max integer;
  v_unknown integer;
  v_correct integer;
  v_incorrect integer;
  v_skipped integer;
  v_hoeren_max integer;
  v_hoeren_score integer;
  v_lesen_max integer;
  v_lesen_score integer;
  v_is_full boolean;
begin
  select * into v_attempt from public.attempts a where a.id = new.attempt_id;
  select * into v_run from public.attempt_runs r
  where r.attempt_id = new.attempt_id;
  if v_attempt.id is null or v_attempt.status <> 'submitted'
    or v_run.frozen_answers is null
  then
    raise exception 'a result belongs to a submitted attempt'
      using errcode = 'P0001', hint = 'attempt_not_submitted';
  end if;

  select
    count(*),
    count(*) filter (where k.correct_option_id is null or q.skill is null),
    count(*) filter (where c.chosen = k.correct_option_id),
    count(*) filter (where c.chosen <> k.correct_option_id),
    count(*) filter (where c.chosen is null),
    count(*) filter (where q.skill = 'hoeren'),
    count(*) filter (where q.skill = 'hoeren'
      and c.chosen = k.correct_option_id),
    count(*) filter (where q.skill = 'lesen'),
    count(*) filter (where q.skill = 'lesen'
      and c.chosen = k.correct_option_id)
  into v_max, v_unknown, v_correct, v_incorrect, v_skipped,
    v_hoeren_max, v_hoeren_score, v_lesen_max, v_lesen_score
  from pg_catalog.jsonb_array_elements_text(v_run.assignment -> 'questionIds')
    as assigned (id)
  cross join lateral (
    select v_run.frozen_answers -> assigned.id ->> 'optionId' as chosen
  ) c
  left join public.answer_keys k
    on k.exam_version_id = v_attempt.exam_version_id
    and k.question_id = assigned.id
  left join lateral (
    select item ->> 'skill' as skill
    from public.exam_versions v,
      pg_catalog.jsonb_array_elements(v.content -> 'questions') item
    where v.id = v_attempt.exam_version_id and item ->> 'id' = assigned.id
    limit 1
  ) q on true;

  if v_max = 0 or v_unknown > 0 then
    raise exception 'the key does not cover the assigned tasks'
      using errcode = 'P0001', hint = 'key_missing';
  end if;

  v_is_full := v_attempt.scope = 'full-exam';
  if new.scope <> v_attempt.scope
    or new.max_score <> v_max
    or new.score <> v_correct
    or new.correct_count <> v_correct
    or new.incorrect_count <> v_incorrect
    or new.skipped_count <> v_skipped
    or new.percent is distinct from
      pg_catalog.round(v_correct * 1000.0 / v_max) / 10
    or (v_is_full and (
      v_run.selection <> 'all' or v_run.purpose <> 'normal'
      or new.hoeren_max is distinct from v_hoeren_max
      or new.hoeren_score is distinct from v_hoeren_score
      or new.lesen_max is distinct from v_lesen_max
      or new.lesen_score is distinct from v_lesen_score
      or new.level is null))
    or (not v_is_full and (
      new.hoeren_max is not null or new.hoeren_score is not null
      or new.lesen_max is not null or new.lesen_score is not null
      or new.level is not null))
  then
    raise exception 'the result does not match the frozen answers'
      using errcode = 'P0001', hint = 'result_inconsistent';
  end if;
  return new;
end;
$$;

create trigger attempt_results_checked
  before insert on public.attempt_results
  for each row execute function public.check_attempt_result();

-- Shared helpers of the kernels --------------------------------------------------

-- The visitor of a guest session that is still active at p_at.
create function m2_private.active_visitor(p_session_id uuid, p_at timestamptz)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_visitor_id uuid;
begin
  select s.visitor_id into v_visitor_id from public.guest_sessions s
  where s.id = p_session_id and p_at < s.expires_at;
  if not found then
    raise exception 'guest session is not active'
      using errcode = 'P0001', hint = 'guest_session_invalid';
  end if;
  return v_visitor_id;
end;
$$;

-- The guest's own attempt, already locked by the caller.
create function m2_private.owned_attempt(p_session_id uuid, p_attempt_id uuid)
returns public.attempts
language plpgsql
stable
set search_path = ''
as $$
declare
  v_attempt public.attempts;
begin
  select * into v_attempt from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id;
  if not found then
    raise exception 'attempt not found for this session'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;
  return v_attempt;
end;
$$;

-- A task is answerable when its run assigns it and the option belongs to that
-- task in the pinned version; membership of the whole version is not enough.
create function m2_private.check_answerable(
  p_attempt public.attempts,
  p_run public.attempt_runs,
  p_question_id text,
  p_option_id text
)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not (p_run.assignment -> 'questionIds') ? p_question_id then
    raise exception 'task is not assigned to this attempt'
      using errcode = 'P0001', hint = 'question_not_assigned';
  end if;
  if not exists (
    select 1
    from public.exam_versions v,
      pg_catalog.jsonb_array_elements(v.content -> 'questions') q,
      pg_catalog.jsonb_array_elements(q -> 'options') o
    where v.id = p_attempt.exam_version_id
      and q ->> 'id' = p_question_id
      and o ->> 'id' = p_option_id
  ) then
    raise exception 'option is not allowed for this question'
      using errcode = 'P0001', hint = 'option_not_allowed';
  end if;
end;
$$;

-- The final answers of a submission as {"<questionId>": {"optionId",
-- "revision"}}. The batch is an array of exactly these objects, each task
-- once; anything else is refused before a check of the attempt.
create function m2_private.answer_batch(p_answers jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item jsonb;
  v_batch jsonb := '{}'::jsonb;
  v_question_id text;
  v_revision numeric;
begin
  if pg_catalog.jsonb_typeof(p_answers) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_answers) > 500
  then
    raise exception 'answers are not a valid batch'
      using errcode = 'P0001', hint = 'submission_invalid';
  end if;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_answers)
  loop
    if pg_catalog.jsonb_typeof(v_item) is distinct from 'object'
      or (select count(*) from pg_catalog.jsonb_object_keys(v_item)) <> 3
      or pg_catalog.jsonb_typeof(v_item -> 'questionId')
        is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item -> 'optionId') is distinct from 'string'
      or pg_catalog.jsonb_typeof(v_item -> 'revision') is distinct from 'number'
    then
      raise exception 'answers are not a valid batch'
        using errcode = 'P0001', hint = 'submission_invalid';
    end if;
    v_question_id := v_item ->> 'questionId';
    v_revision := (v_item ->> 'revision')::numeric;
    if v_batch ? v_question_id
      or v_revision <> pg_catalog.trunc(v_revision)
      or v_revision < 1 or v_revision > 2147483647
    then
      raise exception 'answers are not a valid batch'
        using errcode = 'P0001', hint = 'submission_invalid';
    end if;
    v_batch := v_batch || pg_catalog.jsonb_build_object(
      v_question_id,
      pg_catalog.jsonb_build_object(
        'optionId', v_item ->> 'optionId',
        'revision', v_revision::integer
      )
    );
  end loop;
  return v_batch;
end;
$$;

-- Assigned tasks without an answer in the given map.
create function m2_private.skipped_in(
  p_run public.attempt_runs,
  p_answers jsonb
)
returns integer
language sql
immutable
set search_path = ''
as $$
  select count(*)::integer
  from pg_catalog.jsonb_array_elements_text(p_run.assignment -> 'questionIds')
    as assigned (id)
  where not p_answers ? assigned.id
$$;

-- The stored answers of the assigned tasks, in the shape of a snapshot.
create function m2_private.stored_answers(p_run public.attempt_runs)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(pg_catalog.jsonb_object_agg(
    s.question_id,
    pg_catalog.jsonb_build_object('optionId', s.option_id,
      'revision', s.revision)
  ), '{}'::jsonb)
  from public.attempt_answers s
  where s.attempt_id = p_run.attempt_id
    and (p_run.assignment -> 'questionIds') ? s.question_id
$$;

create function m2_private.fingerprint(p_command jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(p_command::text, 'UTF8')), 'hex')
$$;

-- Save of one answer ------------------------------------------------------------

-- The kernel runs under the row lock of the attempt taken by its caller and
-- receives the moment explicitly: the production function passes
-- clock_timestamp() read after the lock. The order of the changes of one
-- answer is kept: only a higher revision is written; an equal or lower one
-- returns the stored answer.
create function m2_private.save_answer(
  p_session_id uuid,
  p_attempt_id uuid,
  p_question_id text,
  p_option_id text,
  p_revision integer,
  p_at timestamptz
)
returns public.attempt_answers
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.attempts;
  v_run public.attempt_runs;
  v_answer public.attempt_answers;
begin
  perform m2_private.active_visitor(p_session_id, p_at);
  if p_revision is null or p_revision < 1 then
    raise exception 'answer revision must be positive'
      using errcode = 'P0001', hint = 'revision_invalid';
  end if;
  v_attempt := m2_private.owned_attempt(p_session_id, p_attempt_id);
  if v_attempt.status <> 'active' then
    raise exception 'attempt is not open for answers'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;
  select * into v_run from public.attempt_runs r
  where r.attempt_id = p_attempt_id;
  if not found then
    raise exception 'attempt has no run'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;
  perform m2_private.check_answerable(v_attempt, v_run, p_question_id,
    p_option_id);

  select * into v_answer from public.attempt_answers s
  where s.attempt_id = p_attempt_id and s.question_id = p_question_id;
  if found and p_revision <= v_answer.revision then
    return v_answer;
  end if;

  insert into public.attempt_answers (
    attempt_id, question_id, option_id, revision, updated_at
  )
  values (p_attempt_id, p_question_id, p_option_id, p_revision, p_at)
  on conflict (attempt_id, question_id)
  do update set
    option_id = excluded.option_id,
    revision = excluded.revision,
    updated_at = excluded.updated_at
  returning * into v_answer;

  update public.attempts set updated_at = p_at where id = p_attempt_id;
  return v_answer;
end;
$$;

create function public.m2_save_answer(
  p_session_id uuid,
  p_attempt_id uuid,
  p_question_id text,
  p_option_id text,
  p_revision integer
)
returns public.attempt_answers
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  return m2_private.save_answer(
    p_session_id, p_attempt_id, p_question_id, p_option_id, p_revision,
    pg_catalog.clock_timestamp()
  );
end;
$$;

-- Save of the place ----------------------------------------------------------------

create function m2_private.save_progress(
  p_session_id uuid,
  p_attempt_id uuid,
  p_progress jsonb,
  p_at timestamptz
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.attempts;
  v_items text[] := pg_catalog.array_remove(
    array[p_progress #>> '{hoeren,itemId}', p_progress #>> '{lesen,itemId}'],
    null
  );
  v_texts text[] :=
    pg_catalog.array_remove(array[p_progress #>> '{lesen,textId}'], null);
begin
  perform m2_private.active_visitor(p_session_id, p_at);
  v_attempt := m2_private.owned_attempt(p_session_id, p_attempt_id);
  if v_attempt.status <> 'active' then
    raise exception 'attempt is not open'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;

  if pg_catalog.jsonb_typeof(p_progress) is distinct from 'object'
    or pg_catalog.length(p_progress::text) > 2048
    or exists (
      select 1 from pg_catalog.unnest(v_items) as item
      where not exists (
        select 1 from public.exam_versions v,
          pg_catalog.jsonb_array_elements(v.content -> 'questions') q
        where v.id = v_attempt.exam_version_id and q ->> 'id' = item
      )
      and not exists (
        select 1 from public.exam_versions v,
          pg_catalog.jsonb_array_elements(
            coalesce(v.content -> 'groups', '[]'::jsonb)) g
        where v.id = v_attempt.exam_version_id and g ->> 'id' = item
      )
    )
    or exists (
      select 1 from pg_catalog.unnest(v_texts) as text_id
      where not exists (
        select 1 from public.exam_versions v,
          pg_catalog.jsonb_array_elements(
            coalesce(v.content -> 'texts', '[]'::jsonb)) t
        where v.id = v_attempt.exam_version_id and t ->> 'id' = text_id
      )
    )
  then
    raise exception 'progress does not fit this attempt'
      using errcode = 'P0001', hint = 'progress_not_allowed';
  end if;

  update public.attempts
  set progress = p_progress, updated_at = p_at
  where id = p_attempt_id;
  return p_progress;
end;
$$;

create function public.m2_save_progress(
  p_session_id uuid,
  p_attempt_id uuid,
  p_progress jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform 1 from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  return m2_private.save_progress(
    p_session_id, p_attempt_id, p_progress, pg_catalog.clock_timestamp()
  );
end;
$$;

-- Submission -----------------------------------------------------------------------

-- Accepts the final answers of an active free training. After the guest and
-- the owner, a known commandId answers before any check of the state. The
-- batch is checked whole against the assignment and the pinned version; the
-- effective answers keep a newer stored revision. When the confirmed phase
-- revision or number of skipped tasks differs, nothing is written. Otherwise
-- the winning answers are written, the effective set is frozen with the
-- moment and the command, and the attempt becomes submitted.
create function m2_private.accept_submission(
  p_session_id uuid,
  p_attempt_id uuid,
  p_command_id uuid,
  p_answers jsonb,
  p_expected_phase_revision integer,
  p_expected_skipped integer,
  p_at timestamptz
)
returns table (
  outcome text,
  attempt_status text,
  accepted_at timestamptz,
  skipped integer,
  frozen jsonb
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_attempt public.attempts;
  v_run public.attempt_runs;
  v_command public.attempt_commands;
  v_batch jsonb;
  v_fingerprint text;
  v_effective jsonb;
  v_skipped integer;
begin
  perform m2_private.active_visitor(p_session_id, p_at);
  v_attempt := m2_private.owned_attempt(p_session_id, p_attempt_id);
  v_batch := m2_private.answer_batch(p_answers);
  if p_command_id is null
    or p_expected_phase_revision is null or p_expected_skipped is null
  then
    raise exception 'submission is not valid'
      using errcode = 'P0001', hint = 'submission_invalid';
  end if;
  v_fingerprint := m2_private.fingerprint(pg_catalog.jsonb_build_array(
    'submit', p_attempt_id, v_batch, p_expected_phase_revision,
    p_expected_skipped
  ));
  select * into v_run from public.attempt_runs r
  where r.attempt_id = p_attempt_id;
  if not found then
    raise exception 'attempt has no run'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;

  select * into v_command from public.attempt_commands c
  where c.guest_session_id = p_session_id and c.command_id = p_command_id;
  if found then
    if v_command.kind <> 'submit' or v_command.attempt_id <> p_attempt_id
      or v_command.fingerprint <> v_fingerprint
    then
      raise exception 'command id was used for another command'
        using errcode = 'P0001', hint = 'command_mismatch';
    end if;
    return query select 'replayed'::text, v_attempt.status,
      v_command.accepted_at,
      m2_private.skipped_in(v_run, v_run.frozen_answers),
      v_run.frozen_answers;
    return;
  end if;

  if v_attempt.status <> 'active' then
    return query select 'conflict'::text, v_attempt.status,
      null::timestamptz, null::integer, null::jsonb;
    return;
  end if;
  if v_run.mode <> 'training' then
    raise exception 'this mode is not enabled'
      using errcode = 'P0001', hint = 'mode_not_enabled';
  end if;

  perform m2_private.check_answerable(v_attempt, v_run, b.key,
    b.value ->> 'optionId')
  from pg_catalog.jsonb_each(v_batch) b;

  select coalesce(pg_catalog.jsonb_object_agg(assigned.id,
    case
      when b.value is not null
        and (s.revision is null or (b.value ->> 'revision')::integer > s.revision)
      then b.value
      else pg_catalog.jsonb_build_object('optionId', s.option_id,
        'revision', s.revision)
    end
  ) filter (where b.value is not null or s.question_id is not null),
  '{}'::jsonb)
  into v_effective
  from pg_catalog.jsonb_array_elements_text(v_run.assignment -> 'questionIds')
    as assigned (id)
  left join public.attempt_answers s
    on s.attempt_id = p_attempt_id and s.question_id = assigned.id
  left join pg_catalog.jsonb_each(v_batch) b on b.key = assigned.id;
  v_skipped := m2_private.skipped_in(v_run, v_effective);

  -- A free training stays in phase revision 0 while it is active.
  if p_expected_phase_revision <> 0 or p_expected_skipped <> v_skipped then
    return query select 'stale-confirmation'::text, v_attempt.status,
      null::timestamptz, v_skipped, null::jsonb;
    return;
  end if;

  insert into public.attempt_answers as s (
    attempt_id, question_id, option_id, revision, updated_at
  )
  select p_attempt_id, b.key, b.value ->> 'optionId',
    (b.value ->> 'revision')::integer, p_at
  from pg_catalog.jsonb_each(v_batch) b
  on conflict (attempt_id, question_id)
  do update set
    option_id = excluded.option_id,
    revision = excluded.revision,
    updated_at = excluded.updated_at
  where s.revision < excluded.revision;

  update public.attempt_runs
  set frozen_answers = v_effective,
    submission_accepted_at = p_at,
    submit_command_id = p_command_id
  where attempt_id = p_attempt_id;
  update public.attempts set status = 'submitted', updated_at = p_at
  where id = p_attempt_id;
  insert into public.attempt_commands (
    guest_session_id, command_id, kind, fingerprint, attempt_id, accepted_at
  )
  values (p_session_id, p_command_id, 'submit', v_fingerprint, p_attempt_id,
    p_at);

  return query select 'accepted'::text, 'submitted'::text, p_at, v_skipped,
    v_effective;
end;
$$;

create function public.m2_accept_submission(
  p_session_id uuid,
  p_attempt_id uuid,
  p_command_id uuid,
  p_answers jsonb,
  p_expected_phase_revision integer,
  p_expected_skipped integer
)
returns table (
  outcome text,
  attempt_status text,
  accepted_at timestamptz,
  skipped integer,
  frozen jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform 1 from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  return query select * from m2_private.accept_submission(
    p_session_id, p_attempt_id, p_command_id, p_answers,
    p_expected_phase_revision, p_expected_skipped,
    pg_catalog.clock_timestamp()
  );
end;
$$;

-- Cancel -------------------------------------------------------------------------

-- Closes an active attempt without a result. Answers that the server holds
-- stay; nothing sent with the cancel is saved. The confirmation names the
-- phase revision and the skipped tasks of the stored answers. One cancel
-- event, no finish.
create function m2_private.cancel_attempt(
  p_session_id uuid,
  p_attempt_id uuid,
  p_command_id uuid,
  p_expected_phase_revision integer,
  p_expected_skipped integer,
  p_at timestamptz
)
returns table (
  outcome text,
  attempt_status text,
  accepted_at timestamptz,
  skipped integer
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_visitor_id uuid;
  v_attempt public.attempts;
  v_run public.attempt_runs;
  v_command public.attempt_commands;
  v_fingerprint text;
  v_skipped integer;
begin
  v_visitor_id := m2_private.active_visitor(p_session_id, p_at);
  v_attempt := m2_private.owned_attempt(p_session_id, p_attempt_id);
  if p_command_id is null
    or p_expected_phase_revision is null or p_expected_skipped is null
  then
    raise exception 'cancel is not valid'
      using errcode = 'P0001', hint = 'cancel_invalid';
  end if;
  v_fingerprint := m2_private.fingerprint(pg_catalog.jsonb_build_array(
    'cancel', p_attempt_id, p_expected_phase_revision, p_expected_skipped
  ));
  select * into v_run from public.attempt_runs r
  where r.attempt_id = p_attempt_id;
  if not found then
    raise exception 'attempt has no run'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;

  select * into v_command from public.attempt_commands c
  where c.guest_session_id = p_session_id and c.command_id = p_command_id;
  if found then
    if v_command.kind <> 'cancel' or v_command.attempt_id <> p_attempt_id
      or v_command.fingerprint <> v_fingerprint
    then
      raise exception 'command id was used for another command'
        using errcode = 'P0001', hint = 'command_mismatch';
    end if;
    return query select 'replayed'::text, v_attempt.status,
      v_command.accepted_at, p_expected_skipped;
    return;
  end if;

  if v_attempt.status <> 'active' then
    return query select 'conflict'::text, v_attempt.status,
      null::timestamptz, null::integer;
    return;
  end if;
  if v_run.mode <> 'training' then
    raise exception 'this mode is not enabled'
      using errcode = 'P0001', hint = 'mode_not_enabled';
  end if;

  v_skipped := m2_private.skipped_in(v_run, m2_private.stored_answers(v_run));
  if p_expected_phase_revision <> 0 or p_expected_skipped <> v_skipped then
    return query select 'stale-confirmation'::text, v_attempt.status,
      null::timestamptz, v_skipped;
    return;
  end if;

  update public.attempts set status = 'cancelled', updated_at = p_at
  where id = p_attempt_id;
  update public.attempt_runs set cancel_reason = 'user'
  where attempt_id = p_attempt_id;
  insert into public.attempt_commands (
    guest_session_id, command_id, kind, fingerprint, attempt_id, accepted_at
  )
  values (p_session_id, p_command_id, 'cancel', v_fingerprint, p_attempt_id,
    p_at);
  insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
  values ('cancel', v_visitor_id, p_attempt_id, p_at)
  on conflict do nothing;

  return query select 'accepted'::text, 'cancelled'::text, p_at, v_skipped;
end;
$$;

create function public.m2_cancel_attempt(
  p_session_id uuid,
  p_attempt_id uuid,
  p_command_id uuid,
  p_expected_phase_revision integer,
  p_expected_skipped integer
)
returns table (
  outcome text,
  attempt_status text,
  accepted_at timestamptz,
  skipped integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform 1 from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  return query select * from m2_private.cancel_attempt(
    p_session_id, p_attempt_id, p_command_id, p_expected_phase_revision,
    p_expected_skipped, pg_catalog.clock_timestamp()
  );
end;
$$;

-- Finalize -----------------------------------------------------------------------

-- Stores the result of the guest's own submitted attempt and completes it.
-- The result is checked by attempt_results_checked against the frozen
-- snapshot. A completed attempt returns its stored result unchanged. The
-- term of the guest is not checked: the trusted server may complete an
-- accepted submission after it, without giving access to anyone.
create function public.m2_finalize_attempt(
  p_session_id uuid,
  p_attempt_id uuid,
  p_scope text,
  p_score integer,
  p_max_score integer,
  p_correct integer,
  p_incorrect integer,
  p_skipped integer,
  p_percent numeric,
  p_hoeren_score integer,
  p_hoeren_max integer,
  p_lesen_score integer,
  p_lesen_max integer,
  p_level text
)
returns public.attempt_results
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.attempts;
  v_visitor_id uuid;
  v_result public.attempt_results;
  v_at timestamptz;
begin
  select * into v_attempt from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  if not found then
    raise exception 'attempt not found for this session'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;

  if v_attempt.status = 'completed' then
    select * into v_result from public.attempt_results res
    where res.attempt_id = p_attempt_id;
    if not found then
      raise exception 'a completed attempt has no result'
        using errcode = 'P0001', hint = 'result_missing';
    end if;
    return v_result;
  end if;
  if v_attempt.status <> 'submitted' then
    raise exception 'only a submitted attempt is finalized'
      using errcode = 'P0001', hint = 'attempt_not_submitted';
  end if;

  v_at := pg_catalog.clock_timestamp();
  insert into public.attempt_results (
    attempt_id, scope, score, max_score,
    correct_count, incorrect_count, skipped_count, computed_at,
    percent, hoeren_score, hoeren_max, lesen_score, lesen_max, level
  )
  values (
    p_attempt_id, p_scope, p_score, p_max_score,
    p_correct, p_incorrect, p_skipped, v_at,
    p_percent, p_hoeren_score, p_hoeren_max, p_lesen_score, p_lesen_max,
    p_level
  )
  returning * into v_result;

  update public.attempts set status = 'completed', updated_at = v_at
  where id = p_attempt_id;

  select s.visitor_id into v_visitor_id from public.guest_sessions s
  where s.id = p_session_id;
  insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
  values ('finish', v_visitor_id, p_attempt_id, v_at)
  on conflict do nothing;
  return v_result;
end;
$$;

-- Legacy completions -------------------------------------------------------------

-- Marks completed attempts that have a stored result but no frozen snapshot:
-- those of M1 and those of the old finish. Nothing else changes: no attempt,
-- start, result or event is written. Idempotent; with p_attempt_id only that
-- attempt is considered. Active, submitted, cancelled and frozen attempts are
-- never marked.
create function m2_private.mark_legacy_completed(p_attempt_id uuid default null)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_marked integer;
begin
  update public.attempt_runs r set legacy_completed = true
  from public.attempts a
  where a.id = r.attempt_id
    and a.status = 'completed'
    and r.frozen_answers is null
    and not r.legacy_completed
    and exists (
      select 1 from public.attempt_results res where res.attempt_id = a.id
    )
    and (p_attempt_id is null or a.id = p_attempt_id);
  get diagnostics v_marked = row_count;
  return v_marked;
end;
$$;

select m2_private.mark_legacy_completed();

-- Old entry points -----------------------------------------------------------------

-- Saves with a caller time and the finish that scored in one step are gone;
-- no overload keeps them reachable.
drop function public.save_attempt_answer(uuid, uuid, text, text, integer, timestamptz);
drop function public.save_attempt_progress(uuid, uuid, jsonb, timestamptz);
drop function public.finish_attempt(uuid, uuid, timestamptz, text, jsonb, integer, integer, integer, integer, integer, numeric, integer, integer, integer, integer, text);

-- Access ---------------------------------------------------------------------------

revoke all on function public.guard_new_attempt_run()
  from public, anon, authenticated;
revoke all on function public.check_attempt_result()
  from public, anon, authenticated;

revoke all on function m2_private.active_visitor(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.owned_attempt(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.check_answerable(public.attempts, public.attempt_runs, text, text)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.answer_batch(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.skipped_in(public.attempt_runs, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.stored_answers(public.attempt_runs)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.fingerprint(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.save_answer(uuid, uuid, text, text, integer, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.save_progress(uuid, uuid, jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.accept_submission(uuid, uuid, uuid, jsonb, integer, integer, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.cancel_attempt(uuid, uuid, uuid, integer, integer, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.mark_legacy_completed(uuid)
  from public, anon, authenticated, service_role;

revoke all on function public.m2_save_answer(uuid, uuid, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.m2_save_progress(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.m2_accept_submission(uuid, uuid, uuid, jsonb, integer, integer)
  from public, anon, authenticated;
revoke all on function public.m2_cancel_attempt(uuid, uuid, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.m2_finalize_attempt(uuid, uuid, text, integer, integer, integer, integer, integer, numeric, integer, integer, integer, integer, text)
  from public, anon, authenticated;

grant execute on function public.m2_save_answer(uuid, uuid, text, text, integer)
  to service_role;
grant execute on function public.m2_save_progress(uuid, uuid, jsonb)
  to service_role;
grant execute on function public.m2_accept_submission(uuid, uuid, uuid, jsonb, integer, integer)
  to service_role;
grant execute on function public.m2_cancel_attempt(uuid, uuid, uuid, integer, integer)
  to service_role;
grant execute on function public.m2_finalize_attempt(uuid, uuid, text, integer, integer, integer, integer, integer, numeric, integer, integer, integer, integer, text)
  to service_role;
