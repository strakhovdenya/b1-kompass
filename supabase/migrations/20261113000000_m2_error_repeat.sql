-- M2 P5-T1: the free repeat of the guest's own errors. The source is an own
-- completed attempt of the same exam (same guest session); the repeat runs on
-- the pinned version of the source, even after a newer version is published,
-- and assigns exactly the wrong and skipped tasks of the source assignment.
-- The answers are the frozen snapshot of a new completion, or the stored
-- answers of a legacy completion; a new completion without its snapshot is
-- refused, never read as all tasks skipped. A repeat is always a free
-- training of the selection of the source: no timer, no profile, no level.
-- Order: a known command, the request, the source (not found before the
-- slot is looked at, so an invalid source never names the active attempt),
-- the slot, the version, the assignment. Every timed and exam branch of
-- #42-#45 is kept as it was. Lock order and access are kept: slot, attempt
-- row, profile head; the new helper is owner-only.

-- Repeat source ------------------------------------------------------------------

-- The tasks a repeat of the source must assign, in the order of the source
-- assignment. Refuses (repeat_source_invalid) a source that is not the
-- guest's own completed attempt of this exam on p_version_id, whose
-- assignment, key or answers are not usable; refuses (start_invalid) another
-- selection than the source's. May return an empty array.
create function m2_private.repeat_expected(
  p_session_id uuid,
  p_exam_id uuid,
  p_source_attempt_id uuid,
  p_selection text,
  p_version_id uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_source public.attempts;
  v_run public.attempt_runs;
  v_ids jsonb;
  v_total integer;
  v_distinct integer;
  v_unusable integer;
  v_expected jsonb;
begin
  select * into v_source from public.attempts a
  where a.id = p_source_attempt_id
    and a.guest_session_id = p_session_id
    and a.exam_id = p_exam_id
  for share;
  if not found
    or v_source.status <> 'completed'
    or v_source.exam_version_id <> p_version_id
  then
    raise exception 'repeat source is not an own completed attempt'
      using errcode = 'P0001', hint = 'repeat_source_invalid';
  end if;

  select * into v_run from public.attempt_runs r
  where r.attempt_id = v_source.id;
  v_ids := v_run.assignment -> 'questionIds';
  if v_run.attempt_id is null
    or v_run.assignment ->> 'versionId' is distinct from v_source.exam_version_id::text
    or pg_catalog.jsonb_typeof(v_ids) is distinct from 'array'
    or (v_run.frozen_answers is null and not v_run.legacy_completed)
  then
    raise exception 'repeat source has no usable assignment or answers'
      using errcode = 'P0001', hint = 'repeat_source_invalid';
  end if;
  if v_run.selection <> p_selection then
    raise exception 'a repeat keeps the selection of its source'
      using errcode = 'P0001', hint = 'start_invalid';
  end if;

  with assigned as (
    select e.id, e.position
    from pg_catalog.jsonb_array_elements_text(v_ids)
      with ordinality as e (id, position)
  ),
  known as materialized (
    select item ->> 'id' as id
    from public.exam_versions v,
      pg_catalog.jsonb_array_elements(v.content -> 'questions') item
    where v.id = v_source.exam_version_id
  ),
  judged as (
    select s.id, s.position, k.correct_option_id as correct,
      exists (select 1 from known n where n.id = s.id) as is_known,
      case
        when v_run.frozen_answers is not null then
          v_run.frozen_answers -> s.id ->> 'optionId'
        else (
          select aa.option_id from public.attempt_answers aa
          where aa.attempt_id = v_source.id and aa.question_id = s.id
        )
      end as chosen
    from assigned s
    left join public.answer_keys k
      on k.exam_version_id = v_source.exam_version_id
      and k.question_id = s.id
  )
  select count(*), count(distinct j.id),
    count(*) filter (where j.correct is null or not j.is_known),
    coalesce(
      pg_catalog.jsonb_agg(pg_catalog.to_jsonb(j.id) order by j.position)
        filter (where j.chosen is distinct from j.correct),
      '[]'::jsonb
    )
  into v_total, v_distinct, v_unusable, v_expected
  from judged j;

  if v_total = 0 or v_distinct <> v_total or v_unusable > 0 then
    raise exception 'repeat source assignment is not usable'
      using errcode = 'P0001', hint = 'repeat_source_invalid';
  end if;
  return v_expected;
end;
$$;

-- Start --------------------------------------------------------------------------

-- As before (#45), plus the repeat of errors: a free training of short-set
-- scope whose source is checked before the slot, on the pinned version of
-- the source, assigning exactly the tasks of m2_private.repeat_expected.
-- The latest version is still required of every normal start.
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
    or (p_purpose = 'error-repeat'
      and (p_mode <> 'training' or p_scope <> 'short-set'))
  then
    raise exception 'start request is not valid'
      using errcode = 'P0001', hint = 'start_invalid';
  end if;

  -- A repeat checks its source before the slot: a foreign, missing, active,
  -- submitted or cancelled source is refused without naming the active
  -- attempt of the guest. The source is of this guest and exam, so the slot
  -- lock already held covers it.
  if p_purpose = 'error-repeat' then
    v_expected := m2_private.repeat_expected(
      p_session_id, p_exam_id, p_source_attempt_id, p_selection, p_version_id
    );
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

  -- A normal start runs on the latest published version of the exam, a
  -- repeat on the pinned version of its source.
  if p_purpose = 'normal' then
    select * into v_version from public.exam_versions v
    where v.exam_id = p_exam_id
    order by v.version desc
    limit 1;
    if not found or v_version.id <> p_version_id then
      raise exception 'version is not the latest of this exam'
        using errcode = 'P0001', hint = 'version_changed';
    end if;
  else
    select * into v_version from public.exam_versions v
    where v.exam_id = p_exam_id and v.id = p_version_id;
    if not found then
      raise exception 'repeat source version is not of this exam'
        using errcode = 'P0001', hint = 'repeat_source_invalid';
    end if;
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
    -- Exactly the wrong and skipped tasks of the source, in its order; an
    -- empty repeat starts nothing.
    if pg_catalog.jsonb_array_length(v_expected) = 0
      or p_question_ids is distinct from v_expected
    then
      raise exception 'assignment is not the errors of the source'
        using errcode = 'P0001', hint = 'assignment_invalid';
    end if;
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

-- Access ---------------------------------------------------------------------------

-- admit_start keeps its signature and so its owner-only access; the
-- production start m2_start_attempt is unchanged.
revoke all on function m2_private.repeat_expected(uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
