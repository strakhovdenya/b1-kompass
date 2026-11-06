-- M2 P4-T1: the full exam. Hören, a transition of at most the pinned
-- transition seconds, then Lesen with its full pinned duration, all judged
-- by the database clock after the row lock. The start pins the confirmed
-- profile like a timed block and checks that the guest session outlives the
-- whole timeline (Hören + transition + Lesen) by 300 seconds. Lesen starts
-- at the end of the transition or earlier by an explicit begin-lesen, whose
-- moment is written once. Every write is admitted only for the skill of the
-- phase open at its moment: Hören answers are final at the Hören deadline,
-- Lesen answers are refused before Lesen starts. A submission writes only
-- answers of the open phase; answers of a closed or unopened phase in its
-- batch are ignored and the stored ones count. The confirmation names the
-- phase revision of the moment: Hören 0, transition 1, Lesen 2.
-- Lock order and access are kept: slot, attempt row, profile head; kernels
-- are owner-only, runtime functions executable only by service_role, and no
-- runtime function takes a time from the caller.

-- Runs --------------------------------------------------------------------------

-- The explicit early start of Lesen; null while Lesen starts at the end of
-- the transition. Only an exam run has one; an exam run is always pinned.
alter table public.attempt_runs
  add column lesen_started_at timestamptz,
  add constraint attempt_runs_lesen_start_exam
    check (lesen_started_at is null or mode = 'exam'),
  add constraint attempt_runs_exam_pinned
    check (mode <> 'exam' or timing_profile_revision_id is not null);

-- Phases ------------------------------------------------------------------------

-- One pinned duration of the run as an interval.
create function m2_private.pinned_interval(
  p_run public.attempt_runs,
  p_key text
)
returns interval
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.make_interval(
    secs => (p_run.timing_profile_snapshot ->> p_key)::integer
  )
$$;

-- The start of Lesen of an exam run: the recorded early start, otherwise the
-- end of the transition. Null for any other mode.
create function m2_private.lesen_start(p_run public.attempt_runs)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select case when p_run.mode = 'exam' then coalesce(
    p_run.lesen_started_at,
    p_run.accepted_at
      + m2_private.pinned_interval(p_run, 'hoerenSeconds')
      + m2_private.pinned_interval(p_run, 'transitionSeconds')
  ) end
$$;

-- The end of a timed run: of its block, or of Lesen for an exam. Null for a
-- free training.
create or replace function m2_private.run_deadline(p_run public.attempt_runs)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case p_run.mode
    when 'timed-block' then
      p_run.accepted_at + m2_private.pinned_interval(p_run,
        case p_run.selection when 'hoeren' then 'hoerenSeconds'
          else 'lesenSeconds' end)
    when 'exam' then
      m2_private.lesen_start(p_run)
        + m2_private.pinned_interval(p_run, 'lesenSeconds')
  end
$$;

-- The phase of an open run at p_at, by the same rule as resolveLifecycle of
-- @b1k/domain: 'open' for a free training; the skill of a timed block until
-- its deadline; 'hoeren', 'transition', 'lesen' for an exam; 'closed' after
-- the end. A recorded early start of Lesen keeps Lesen whatever the moment.
-- The caller checks that the attempt is active.
create function m2_private.run_phase(
  p_run public.attempt_runs,
  p_at timestamptz
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_run.mode = 'training' then 'open'
    when p_at >= m2_private.run_deadline(p_run) then 'closed'
    when p_run.mode = 'timed-block' then p_run.selection
    when p_run.lesen_started_at is not null then 'lesen'
    when p_at < p_run.accepted_at
      + m2_private.pinned_interval(p_run, 'hoerenSeconds') then 'hoeren'
    when p_at < m2_private.lesen_start(p_run) then 'transition'
    else 'lesen'
  end
$$;

-- The phase revision a confirmation names: 0 while a free training or a
-- timed block is open; Hören 0, transition 1, Lesen 2 for an exam.
create function m2_private.phase_revision(
  p_run public.attempt_runs,
  p_at timestamptz
)
returns integer
language sql
stable
set search_path = ''
as $$
  select case m2_private.run_phase(p_run, p_at)
    when 'transition' then 1
    when 'lesen' then case when p_run.mode = 'exam' then 2 else 0 end
    when 'closed' then case when p_run.mode = 'exam' then 3 else 1 end
    else 0
  end
$$;

-- The skill of a task in the pinned version.
create function m2_private.question_skill(
  p_version_id uuid,
  p_question_id text
)
returns text
language sql
stable
set search_path = ''
as $$
  select q ->> 'skill'
  from public.exam_versions v,
    pg_catalog.jsonb_array_elements(v.content -> 'questions') q
  where v.id = p_version_id and q ->> 'id' = p_question_id
  limit 1
$$;

-- Whether a task of the run may be written at p_at: any assigned task of a
-- free training or an open timed block, only the open skill of an exam.
create function m2_private.is_open_task(
  p_attempt public.attempts,
  p_run public.attempt_runs,
  p_question_id text,
  p_at timestamptz
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_run.mode <> 'exam'
    or m2_private.question_skill(p_attempt.exam_version_id, p_question_id)
      = m2_private.run_phase(p_run, p_at)
$$;

-- Database guards ------------------------------------------------------------------

-- As before, plus the early start of Lesen: written once, only for an active
-- exam and only inside its transition window; never changed afterwards.
create or replace function public.guard_attempt_run()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_hoeren_end timestamptz;
begin
  if new.attempt_id <> old.attempt_id
    or new.mode <> old.mode
    or new.purpose <> old.purpose
    or new.selection <> old.selection
    or new.source_attempt_id is distinct from old.source_attempt_id
    or new.assignment <> old.assignment
    or new.accepted_at <> old.accepted_at
    or new.timing_profile_revision_id
      is distinct from old.timing_profile_revision_id
    or new.timing_profile_snapshot is distinct from old.timing_profile_snapshot
    or (old.lesen_started_at is not null
      and new.lesen_started_at is distinct from old.lesen_started_at)
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
  if old.lesen_started_at is null and new.lesen_started_at is not null then
    v_hoeren_end := new.accepted_at
      + m2_private.pinned_interval(new, 'hoerenSeconds');
    if new.mode <> 'exam'
      or new.frozen_answers is not null
      or new.lesen_started_at < v_hoeren_end
      or new.lesen_started_at > v_hoeren_end
        + m2_private.pinned_interval(new, 'transitionSeconds')
      or not exists (
        select 1 from public.attempts a
        where a.id = new.attempt_id and a.status = 'active'
      )
    then
      raise exception 'Lesen starts once, inside the transition'
        using errcode = 'P0001', hint = 'lesen_start_invalid';
    end if;
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

-- As before, plus: a new run has not started Lesen yet.
create or replace function public.guard_new_attempt_run()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_row m2_private.timing_profile_revisions;
begin
  if new.legacy_completed
    or new.frozen_answers is not null
    or new.cancel_reason is not null
    or new.lesen_started_at is not null
  then
    raise exception 'a new run starts open'
      using errcode = 'P0001', hint = 'attempt_run_fixed';
  end if;
  if new.timing_profile_revision_id is not null then
    select * into v_row from m2_private.timing_profile_revisions r
    where r.id = new.timing_profile_revision_id;
    if not found
      or v_row.status <> 'confirmed'
      or not exists (
        select 1 from m2_private.timing_profiles h
        where h.exam_version_id = v_row.exam_version_id
          and h.head_revision = v_row.revision
      )
      or not m2_private.timing_profile_matches(v_row)
      or new.timing_profile_snapshot
        is distinct from m2_private.timing_profile_document(v_row)
      or not exists (
        select 1 from public.attempts a
        where a.id = new.attempt_id
          and a.exam_version_id = v_row.exam_version_id
      )
    then
      raise exception 'a run pins only a confirmed profile of its version'
        using errcode = 'P0001', hint = 'timing_profile_pin_invalid';
    end if;
  end if;
  return new;
end;
$$;

-- Start --------------------------------------------------------------------------

-- As before, with the exam enabled: the whole set (selection all, scope
-- full-exam), the pinned confirmed profile (one recording, one Hören track,
-- checked by its gate) and a guest session that outlives Hören, the
-- transition and Lesen by 300 seconds.
create or replace function m2_private.admit_start(
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
    or (p_mode = 'exam' and (p_selection <> 'all' or p_scope <> 'full-exam'))
  then
    raise exception 'start request is not valid'
      using errcode = 'P0001', hint = 'start_invalid';
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

  -- A timed block and the exam pin the current confirmed head through the
  -- gate of #42, under FOR SHARE of the head. The durations come only from
  -- the pinned snapshot: the guest session must outlive the block, or the
  -- whole timeline of the exam, by 300 seconds.
  if p_mode <> 'training' then
    select g.revision_id, g.snapshot into v_revision_id, v_snapshot
    from m2_private.current_confirmed_profile(p_version_id) g;
    if v_revision_id is null then
      raise exception 'the timing profile of this version is not confirmed'
        using errcode = 'P0001', hint = 'timing_profile_unavailable';
    end if;
    if p_mode = 'exam' then
      v_seconds := (v_snapshot ->> 'hoerenSeconds')::integer
        + (v_snapshot ->> 'transitionSeconds')::integer
        + (v_snapshot ->> 'lesenSeconds')::integer;
    else
      v_seconds := (v_snapshot ->> case p_selection
        when 'hoeren' then 'hoerenSeconds' else 'lesenSeconds' end)::integer;
    end if;
    if v_expires_at
      < p_at + pg_catalog.make_interval(secs => v_seconds + 300)
    then
      raise exception 'the guest session ends before the timed run'
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

-- The production start, unchanged but for the profile lock, which an exam
-- takes like a timed block.
create or replace function public.m2_start_attempt(
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
  if p_mode <> 'training' then
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

-- As before, plus the phase of an exam: only a task of the open skill is
-- written. A Hören answer at or after the Hören deadline and a Lesen answer
-- before Lesen starts are refused like a write after the deadline.
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
  if not m2_private.is_open_task(v_attempt, v_run, p_question_id, p_at) then
    raise exception 'the phase of this task is not open'
      using errcode = 'P0001', hint = 'phase_closed';
  end if;

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

-- Submission -----------------------------------------------------------------------

-- As before, for every mode. The confirmed phase revision is the one of the
-- moment of acceptance. For an exam only answers of the open skill are
-- taken from the batch: a closed Hören keeps its stored answers and
-- revisions, an unopened Lesen gets nothing; the skipped tasks are counted
-- over the whole assignment, Lesen not yet opened included.
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
  v_open jsonb;
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

  -- The part of the batch this submission may write.
  select coalesce(pg_catalog.jsonb_object_agg(b.key, b.value), '{}'::jsonb)
  into v_open
  from pg_catalog.jsonb_each(v_batch) b
  where m2_private.is_open_task(v_attempt, v_run, b.key, p_at);

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
  left join pg_catalog.jsonb_each(v_open) b on b.key = assigned.id;
  v_skipped := m2_private.skipped_in(v_run, v_effective);

  if p_expected_phase_revision <> m2_private.phase_revision(v_run, p_at)
    or p_expected_skipped <> v_skipped
  then
    return query select 'stale-confirmation'::text, v_attempt.status,
      null::timestamptz, v_skipped, null::jsonb;
    return;
  end if;

  insert into public.attempt_answers as s (
    attempt_id, question_id, option_id, revision, updated_at
  )
  select p_attempt_id, b.key, b.value ->> 'optionId',
    (b.value ->> 'revision')::integer, p_at
  from pg_catalog.jsonb_each(v_open) b
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

-- As before, for every mode; the confirmed phase revision is the one of the
-- moment of the cancel.
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

  if m2_private.close_expired(p_attempt_id, p_at) then
    select * into v_run from public.attempt_runs r
    where r.attempt_id = p_attempt_id;
    return query select 'closed-phase'::text, 'submitted'::text,
      null::timestamptz, m2_private.skipped_in(v_run, v_run.frozen_answers);
    return;
  end if;

  v_skipped := m2_private.skipped_in(v_run, m2_private.stored_answers(v_run));
  if p_expected_phase_revision <> m2_private.phase_revision(v_run, p_at)
    or p_expected_skipped <> v_skipped
  then
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

-- Begin Lesen -----------------------------------------------------------------------

-- The early start of Lesen of the guest's own exam at p_at. In the
-- transition the moment is written once and Lesen gets its full pinned
-- duration from it; in Lesen it changes nothing; in Hören it is refused
-- (phase-not-open); at or after the end it closes the run (closed-phase).
-- Without the command Lesen starts at the end of the transition by itself.
-- The caller holds the row lock and passes the clock read after it.
create function m2_private.begin_lesen(
  p_session_id uuid,
  p_attempt_id uuid,
  p_at timestamptz
)
returns table (outcome text, attempt_status text, changed boolean)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_attempt public.attempts;
  v_run public.attempt_runs;
  v_phase text;
begin
  perform m2_private.active_visitor(p_session_id, p_at);
  v_attempt := m2_private.owned_attempt(p_session_id, p_attempt_id);
  select * into v_run from public.attempt_runs r
  where r.attempt_id = p_attempt_id;
  if not found then
    raise exception 'attempt has no run'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;
  if v_attempt.status <> 'active' then
    return query select 'closed-phase'::text, v_attempt.status, false;
    return;
  end if;
  if v_run.mode <> 'exam' then
    return query select 'phase-not-open'::text, v_attempt.status, false;
    return;
  end if;
  if m2_private.close_expired(p_attempt_id, p_at) then
    return query select 'closed-phase'::text, 'submitted'::text, false;
    return;
  end if;
  v_phase := m2_private.run_phase(v_run, p_at);
  if v_phase = 'hoeren' then
    return query select 'phase-not-open'::text, v_attempt.status, false;
    return;
  end if;
  if v_phase = 'lesen' then
    return query select 'accepted'::text, v_attempt.status, false;
    return;
  end if;
  update public.attempt_runs set lesen_started_at = p_at
  where attempt_id = p_attempt_id;
  return query select 'accepted'::text, v_attempt.status, true;
end;
$$;

-- The production begin-lesen: the row lock of the attempt, then the database
-- clock rounded down to whole milliseconds, as the start, so the deadline of
-- Lesen is the same in SQL and in the browser. No parameter carries a time.
create function public.m2_begin_lesen(
  p_session_id uuid,
  p_attempt_id uuid
)
returns table (outcome text, attempt_status text, changed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform 1 from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  return query select * from m2_private.begin_lesen(
    p_session_id, p_attempt_id,
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())
  );
end;
$$;

-- Access ---------------------------------------------------------------------------

revoke all on function m2_private.pinned_interval(public.attempt_runs, text)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.lesen_start(public.attempt_runs)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.run_phase(public.attempt_runs, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.phase_revision(public.attempt_runs, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.question_skill(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.is_open_task(public.attempts, public.attempt_runs, text, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.begin_lesen(uuid, uuid, timestamptz)
  from public, anon, authenticated, service_role;

revoke all on function public.m2_begin_lesen(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.m2_begin_lesen(uuid, uuid)
  to service_role;
