-- M2 P3-T2: one timed block, Hören or Lesen, against a deadline set by the
-- database. The SQL start pins the current confirmed timing profile (#42)
-- under the slot lock and checks that the guest session outlives the block
-- by 300 seconds. The deadline is accepted_at of the run plus the pinned
-- duration of its skill; every write is judged by clock_timestamp() read
-- after its lock: at or after the deadline it is refused. An expired run is
-- closed without a worker by the next dependent operation of its attempt
-- (status, submit, cancel, a new start): the answers the server accepted
-- before the deadline are frozen, the attempt becomes submitted and frees
-- its slot; the result is computed afterwards by the trusted server, like
-- any submission. The exam mode stays refused until P4.
-- Lock order of every path: the advisory slot lock of (guest, exam), then
-- the row lock of an attempt, then FOR SHARE of the profile head; never the
-- reverse. Production entry points read the clock after their last lock and
-- take no time from the caller; only the private kernels take one.
-- Access: as before, kernels are owner-only and the runtime functions are
-- executable only by service_role.

-- Runs --------------------------------------------------------------------------

-- A run closed by its deadline has a frozen snapshot and its moment but no
-- submit command; only a timed run can be closed that way.
alter table public.attempt_runs
  drop constraint attempt_runs_submission_together;
alter table public.attempt_runs
  add constraint attempt_runs_submission_together check (
    (frozen_answers is null) = (submission_accepted_at is null)
    and (submit_command_id is null or frozen_answers is not null)
  ),
  add constraint attempt_runs_deadline_close_timed check (
    frozen_answers is null or submit_command_id is not null
    or mode <> 'training'
  ),
  -- A timed run always carries its pinned profile: its deadline exists.
  add constraint attempt_runs_timed_pinned check (
    mode <> 'timed-block' or timing_profile_revision_id is not null
  );

-- Deadline ----------------------------------------------------------------------

-- The end of a timed run: its accepted moment plus the pinned duration of
-- its skill. Null for a free training and for the not yet enabled exam.
create function m2_private.run_deadline(p_run public.attempt_runs)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case when p_run.mode = 'timed-block' then
    p_run.accepted_at + pg_catalog.make_interval(secs => (
      p_run.timing_profile_snapshot ->> case p_run.selection
        when 'hoeren' then 'hoerenSeconds' else 'lesenSeconds' end
    )::integer)
  end
$$;

-- The stored answers of the assigned tasks written before the deadline, in
-- the shape of a snapshot. Writes at or after it are refused anyway; the
-- filter keeps the snapshot honest even so.
create function m2_private.timely_answers(
  p_run public.attempt_runs,
  p_deadline timestamptz
)
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
    and s.updated_at < p_deadline
$$;

-- Closes the active timed attempt whose deadline is reached at p_at: the
-- timely answers are frozen with the deadline as the moment of acceptance
-- and no command, and the attempt becomes submitted, which frees its slot.
-- The caller holds the row lock of the attempt and passes the clock read
-- after it. True when this call closed it.
create function m2_private.close_expired(p_attempt_id uuid, p_at timestamptz)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.attempts;
  v_run public.attempt_runs;
  v_deadline timestamptz;
begin
  select * into v_attempt from public.attempts a where a.id = p_attempt_id;
  select * into v_run from public.attempt_runs r
  where r.attempt_id = p_attempt_id;
  if v_attempt.id is null or v_run.attempt_id is null
    or v_attempt.status <> 'active'
  then
    return false;
  end if;
  v_deadline := m2_private.run_deadline(v_run);
  if v_deadline is null or p_at < v_deadline then
    return false;
  end if;
  update public.attempt_runs
  set frozen_answers = m2_private.timely_answers(v_run, v_deadline),
    submission_accepted_at = v_deadline
  where attempt_id = p_attempt_id;
  update public.attempts set status = 'submitted', updated_at = p_at
  where id = p_attempt_id;
  return true;
end;
$$;

-- Start --------------------------------------------------------------------------

-- The OUT form of the start gains closed_attempt_id: the expired attempt this
-- start closed, so the trusted server computes its result after the commit.
-- RETURNS TABLE cannot change with CREATE OR REPLACE: both functions are
-- dropped and created again with their unchanged input signatures, owner,
-- revokes and grants. No database object depends on them (plpgsql bodies are
-- not tracked); the test-only wrappers are installed again by the tests.
drop function public.m2_start_attempt(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb);
drop function m2_private.admit_start(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb, timestamptz);

-- The admission kernel. It runs under the locks taken by its caller (slot,
-- the active attempt of the slot, the profile head of a timed start) and
-- receives the moment read after them. Order of the answers: the guest, a
-- known commandId, the request, an active attempt (a conflict unless its
-- deadline is reached), the version and assignment, the confirmed profile,
-- the reserve of the guest. Only then is an expired attempt closed and the
-- new one written; a refusal writes nothing.
create function m2_private.admit_start(
  p_session_id uuid,
  p_exam_id uuid,
  p_command_id uuid,
  p_mode text,
  p_purpose text,
  p_selection text,
  p_source_attempt_id uuid,
  p_version_id uuid,
  p_scope text,
  p_question_ids jsonb,
  p_at timestamptz
)
returns table (
  attempt_id uuid,
  outcome text,
  status text,
  accepted_at timestamptz,
  closed_attempt_id uuid
)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_visitor_id uuid;
  v_expires_at timestamptz;
  v_fingerprint text;
  v_command public.attempt_commands;
  v_active public.attempts;
  v_active_run public.attempt_runs;
  v_closes_active boolean := false;
  v_version public.exam_versions;
  v_expected jsonb;
  v_revision_id uuid;
  v_snapshot jsonb;
  v_seconds integer;
  v_attempt public.attempts;
begin
  select s.visitor_id, s.expires_at into v_visitor_id, v_expires_at
  from public.guest_sessions s
  where s.id = p_session_id and p_at < s.expires_at;
  if not found then
    raise exception 'guest session is not active'
      using errcode = 'P0001', hint = 'guest_session_invalid';
  end if;

  v_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(
      'start', p_exam_id, p_mode, p_purpose, p_selection,
      p_source_attempt_id, p_version_id
    )::text, 'UTF8')), 'hex');

  -- A known command answers before any check of the current state: its
  -- attempt and deadline stay as they were.
  select * into v_command from public.attempt_commands c
  where c.guest_session_id = p_session_id and c.command_id = p_command_id;
  if found then
    if v_command.kind <> 'start' or v_command.fingerprint <> v_fingerprint then
      raise exception 'command id was used for another command'
        using errcode = 'P0001', hint = 'command_mismatch';
    end if;
    select * into v_attempt from public.attempts a
    where a.id = v_command.attempt_id;
    return query select v_attempt.id, 'replayed'::text, v_attempt.status,
      v_command.accepted_at, null::uuid;
    return;
  end if;

  if p_mode not in ('training', 'timed-block', 'exam')
    or p_purpose not in ('normal', 'error-repeat')
    or p_selection not in ('all', 'hoeren', 'lesen')
    or (p_purpose = 'error-repeat') <> (p_source_attempt_id is not null)
    or p_scope not in ('short-set', 'full-exam')
    or (p_selection <> 'all' and p_scope <> 'short-set')
    or (p_mode = 'timed-block' and p_selection = 'all')
  then
    raise exception 'start request is not valid'
      using errcode = 'P0001', hint = 'start_invalid';
  end if;
  -- The full exam needs the protection of P4 first.
  if p_mode = 'exam' then
    raise exception 'this mode is not enabled'
      using errcode = 'P0001', hint = 'mode_not_enabled';
  end if;

  select * into v_active from public.attempts a
  where a.guest_session_id = p_session_id
    and a.exam_id = p_exam_id
    and a.status = 'active';
  if found then
    select * into v_active_run from public.attempt_runs r
    where r.attempt_id = v_active.id;
    v_closes_active := v_active_run.attempt_id is not null
      and p_at >= coalesce(m2_private.run_deadline(v_active_run), 'infinity');
    if not v_closes_active then
      return query select v_active.id, 'conflict'::text, v_active.status,
        null::timestamptz, null::uuid;
      return;
    end if;
  end if;

  -- A normal start runs on the latest published version of the exam.
  select * into v_version from public.exam_versions v
  where v.exam_id = p_exam_id
  order by v.version desc
  limit 1;
  if not found or v_version.id <> p_version_id then
    raise exception 'version is not the latest of this exam'
      using errcode = 'P0001', hint = 'version_changed';
  end if;

  if p_purpose = 'normal' then
    select coalesce(jsonb_agg(q.item -> 'id' order by q.position), '[]')
    into v_expected
    from jsonb_array_elements(v_version.content -> 'questions')
      with ordinality as q (item, position)
    where p_selection = 'all' or q.item ->> 'skill' = p_selection;
    if pg_catalog.jsonb_array_length(v_expected) = 0
      or p_question_ids is distinct from v_expected
    then
      raise exception 'assignment does not match the selection'
        using errcode = 'P0001', hint = 'assignment_invalid';
    end if;
  else
    raise exception 'repeat starts are not enabled'
      using errcode = 'P0001', hint = 'start_invalid';
  end if;

  -- A timed start pins the current confirmed head through the gate of #42,
  -- in this transaction and under FOR SHARE of the head: a draft head, a
  -- missing profile or a mismatch refuse it, never an older revision. The
  -- duration comes only from the pinned snapshot.
  if p_mode = 'timed-block' then
    select g.revision_id, g.snapshot into v_revision_id, v_snapshot
    from m2_private.current_confirmed_profile(p_version_id) g;
    if v_revision_id is null then
      raise exception 'the timing profile of this version is not confirmed'
        using errcode = 'P0001', hint = 'timing_profile_unavailable';
    end if;
    v_seconds := (v_snapshot ->> case p_selection
      when 'hoeren' then 'hoerenSeconds' else 'lesenSeconds' end)::integer;
    -- The guest session must outlive the block by 300 seconds.
    if v_expires_at
      < p_at + pg_catalog.make_interval(secs => v_seconds + 300)
    then
      raise exception 'the guest session ends before the timed block'
        using errcode = 'P0001', hint = 'guest_too_short';
    end if;
  end if;

  if v_closes_active then
    perform m2_private.close_expired(v_active.id, p_at);
  end if;

  insert into public.attempts (
    guest_session_id, exam_id, exam_version_id, scope, status,
    created_at, updated_at
  )
  values (
    p_session_id, p_exam_id, p_version_id, p_scope, 'active', p_at, p_at
  )
  returning * into v_attempt;

  insert into public.attempt_runs (
    attempt_id, mode, purpose, selection, source_attempt_id, assignment,
    accepted_at, timing_profile_revision_id, timing_profile_snapshot
  )
  values (
    v_attempt.id, p_mode, p_purpose, p_selection, p_source_attempt_id,
    pg_catalog.jsonb_build_object(
      'versionId', p_version_id, 'questionIds', p_question_ids
    ),
    p_at, v_revision_id, v_snapshot
  );

  insert into public.attempt_commands (
    guest_session_id, command_id, kind, fingerprint, attempt_id, accepted_at
  )
  values (p_session_id, p_command_id, 'start', v_fingerprint, v_attempt.id, p_at);

  insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
  values ('start', v_visitor_id, v_attempt.id, p_at)
  on conflict do nothing;

  return query select v_attempt.id, 'accepted'::text, v_attempt.status, p_at,
    case when v_closes_active then v_active.id end;
end;
$$;

-- The production start. Locks in the fixed order: the slot, the active
-- attempt of the slot (a save, submit or status of it finishes first), the
-- profile head of a timed start. Then it reads the database clock, rounded
-- down to whole milliseconds so the deadline is the same in SQL and in the
-- browser, and runs the kernel. No parameter carries a time.
create function public.m2_start_attempt(
  p_session_id uuid,
  p_exam_id uuid,
  p_command_id uuid,
  p_mode text,
  p_purpose text,
  p_selection text,
  p_source_attempt_id uuid,
  p_version_id uuid,
  p_scope text,
  p_question_ids jsonb
)
returns table (
  attempt_id uuid,
  outcome text,
  status text,
  accepted_at timestamptz,
  closed_attempt_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform pg_catalog.pg_advisory_xact_lock(
    m2_private.slot_key(p_session_id, p_exam_id)
  );
  perform 1 from public.attempts a
  where a.guest_session_id = p_session_id
    and a.exam_id = p_exam_id
    and a.status = 'active'
  for update;
  if p_mode = 'timed-block' then
    perform 1 from m2_private.timing_profiles h
    where h.exam_version_id = p_version_id
    for share;
  end if;
  return query select * from m2_private.admit_start(
    p_session_id, p_exam_id, p_command_id, p_mode, p_purpose, p_selection,
    p_source_attempt_id, p_version_id, p_scope, p_question_ids,
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())
  );
end;
$$;

-- Save of one answer ----------------------------------------------------------------

-- As before, plus the deadline: at or after it nothing is written and the
-- stored answer and its revision stay as they are.
create or replace function m2_private.save_answer(
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
  if p_at >= coalesce(m2_private.run_deadline(v_run), 'infinity') then
    raise exception 'the time of this attempt is over'
      using errcode = 'P0001', hint = 'phase_closed';
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

-- Save of the place ----------------------------------------------------------------

-- As before, plus the deadline: the place of an expired run is not written.
create or replace function m2_private.save_progress(
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
  v_run public.attempt_runs;
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
  select * into v_run from public.attempt_runs r
  where r.attempt_id = p_attempt_id;
  if found
    and p_at >= coalesce(m2_private.run_deadline(v_run), 'infinity')
  then
    raise exception 'the time of this attempt is over'
      using errcode = 'P0001', hint = 'phase_closed';
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

-- Submission -----------------------------------------------------------------------

-- As before, for a free training and a timed block. A timed block is
-- accepted only before its deadline; at or after it the submission closes
-- the run with its timely answers (nothing of the batch is written) and
-- answers closed-phase. A known commandId still answers first: a submission
-- accepted in time replays after the deadline.
create or replace function m2_private.accept_submission(
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
  if v_run.mode not in ('training', 'timed-block') then
    raise exception 'this mode is not enabled'
      using errcode = 'P0001', hint = 'mode_not_enabled';
  end if;

  if m2_private.close_expired(p_attempt_id, p_at) then
    select * into v_run from public.attempt_runs r
    where r.attempt_id = p_attempt_id;
    return query select 'closed-phase'::text, 'submitted'::text,
      null::timestamptz,
      m2_private.skipped_in(v_run, v_run.frozen_answers),
      v_run.frozen_answers;
    return;
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

  -- An open free training and an open timed block are in phase revision 0.
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

-- Cancel -------------------------------------------------------------------------

-- As before, for a free training and a timed block. At or after the deadline
-- a cancel is refused: it closes the run with its timely answers, which then
-- get their result, and answers closed-phase.
create or replace function m2_private.cancel_attempt(
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
  if v_run.mode not in ('training', 'timed-block') then
    raise exception 'this mode is not enabled'
      using errcode = 'P0001', hint = 'mode_not_enabled';
  end if;

  if m2_private.close_expired(p_attempt_id, p_at) then
    select * into v_run from public.attempt_runs r
    where r.attempt_id = p_attempt_id;
    return query select 'closed-phase'::text, 'submitted'::text,
      null::timestamptz, m2_private.skipped_in(v_run, v_run.frozen_answers);
    return;
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

-- Status and reconciliation ----------------------------------------------------------

-- The state of the guest's own attempt at p_at, after closing it when its
-- deadline is reached. The caller holds the row lock of an open timed
-- attempt and passes the clock read after it. server_now is that moment:
-- the browser shows the remaining time from it, never from its own clock.
create function m2_private.reconcile_attempt(
  p_session_id uuid,
  p_attempt_id uuid,
  p_at timestamptz
)
returns table (attempt_status text, closed boolean, server_now timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_closed boolean;
  v_status text;
begin
  perform m2_private.active_visitor(p_session_id, p_at);
  perform m2_private.owned_attempt(p_session_id, p_attempt_id);
  v_closed := m2_private.close_expired(p_attempt_id, p_at);
  select a.status into v_status from public.attempts a
  where a.id = p_attempt_id;
  return query select v_status, v_closed, p_at;
end;
$$;

-- The production status read. Only an open timed attempt is locked: it may
-- have to be closed, after any save or command of it that holds the row.
-- The clock is read after that lock. A free training or a closed attempt is
-- read without a lock and never waits.
create function public.m2_reconcile_attempt(
  p_session_id uuid,
  p_attempt_id uuid
)
returns table (attempt_status text, closed boolean, server_now timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if exists (
    select 1 from public.attempts a
    join public.attempt_runs r on r.attempt_id = a.id
    where a.id = p_attempt_id and a.guest_session_id = p_session_id
      and a.status = 'active' and r.mode <> 'training'
  ) then
    perform 1 from public.attempts a
    where a.id = p_attempt_id and a.guest_session_id = p_session_id
    for update;
  end if;
  return query select * from m2_private.reconcile_attempt(
    p_session_id, p_attempt_id, pg_catalog.clock_timestamp()
  );
end;
$$;

-- Access ---------------------------------------------------------------------------

revoke all on function m2_private.run_deadline(public.attempt_runs)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.timely_answers(public.attempt_runs, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.close_expired(uuid, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.admit_start(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.reconcile_attempt(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.m2_start_attempt(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.m2_start_attempt(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb)
  to service_role;
revoke all on function public.m2_reconcile_attempt(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.m2_reconcile_attempt(uuid, uuid)
  to service_role;
