-- Test-only fixtures of the isolated local test database. Installed by
-- tests/support/sql.ts (installM2Fixtures), never by supabase/migrations and
-- never by the build. They call the same private admission kernel as the
-- production start; only the moment of acceptance is given explicitly.
-- No API role can reach the schema.

create schema if not exists m2_test;
revoke all on schema m2_test from public, anon, authenticated, service_role;

-- The start at an explicit moment: the same slot lock, then the same kernel.
create or replace function m2_test.start_attempt_at(
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
returns table (attempt_id uuid, outcome text, status text, accepted_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform pg_catalog.pg_advisory_xact_lock(
    m2_private.slot_key(p_session_id, p_exam_id)
  );
  return query select * from m2_private.admit_start(
    p_session_id, p_exam_id, p_command_id, p_mode, p_purpose, p_selection,
    p_source_attempt_id, p_version_id, p_scope, p_question_ids, p_at
  );
end;
$$;

-- A guest session whose fixed term ends p_seconds after the database clock:
-- created 720 hours before that, as a trusted historical row. Its entry
-- event is not written.
create or replace function m2_test.insert_guest_ending_in(
  p_token_hash text,
  p_seconds numeric
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_ends timestamptz :=
    pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_seconds);
  v_id uuid;
begin
  insert into public.guest_sessions (token_hash, locale, created_at, expires_at)
  values (p_token_hash, 'en', v_ends - interval '720 hours', v_ends)
  returning id into v_id;
  return v_id;
end;
$$;

-- The saves, the submission and the cancel at an explicit moment: the same
-- row lock of the attempt, then the same private kernel as production.
create or replace function m2_test.save_answer_at(
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
begin
  perform 1 from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  return m2_private.save_answer(
    p_session_id, p_attempt_id, p_question_id, p_option_id, p_revision, p_at
  );
end;
$$;

create or replace function m2_test.save_progress_at(
  p_session_id uuid,
  p_attempt_id uuid,
  p_progress jsonb,
  p_at timestamptz
)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  perform 1 from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  return m2_private.save_progress(p_session_id, p_attempt_id, p_progress, p_at);
end;
$$;

create or replace function m2_test.accept_submission_at(
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
begin
  perform 1 from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  return query select * from m2_private.accept_submission(
    p_session_id, p_attempt_id, p_command_id, p_answers,
    p_expected_phase_revision, p_expected_skipped, p_at
  );
end;
$$;

create or replace function m2_test.cancel_attempt_at(
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
begin
  perform 1 from public.attempts a
  where a.id = p_attempt_id and a.guest_session_id = p_session_id
  for update;
  return query select * from m2_private.cancel_attempt(
    p_session_id, p_attempt_id, p_command_id, p_expected_phase_revision,
    p_expected_skipped, p_at
  );
end;
$$;

-- A timed run pinned to the current confirmed timing profile of its
-- version, as the SQL start of #43 will write it: under the slot lock, the
-- gate m2_private.current_confirmed_profile, then attempt and run with the
-- returned revision and snapshot. Only for the isolated test database: the
-- production start does not pin profiles yet. No command or event is
-- written.
create or replace function m2_test.insert_pinned_run_at(
  p_session_id uuid,
  p_version_id uuid,
  p_selection text,
  p_question_ids jsonb,
  p_at timestamptz
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_exam_id uuid;
  v_revision_id uuid;
  v_snapshot jsonb;
  v_attempt_id uuid;
begin
  select v.exam_id into v_exam_id from public.exam_versions v
  where v.id = p_version_id;
  perform pg_catalog.pg_advisory_xact_lock(
    m2_private.slot_key(p_session_id, v_exam_id)
  );
  select g.revision_id, g.snapshot into v_revision_id, v_snapshot
  from m2_private.current_confirmed_profile(p_version_id) g;
  if v_revision_id is null then
    raise exception 'no confirmed timing profile'
      using errcode = 'P0001', hint = 'timing_profile_unconfirmed';
  end if;
  insert into public.attempts (
    guest_session_id, exam_id, exam_version_id, scope, status,
    created_at, updated_at
  )
  values (
    p_session_id, v_exam_id, p_version_id, 'short-set', 'active', p_at, p_at
  )
  returning id into v_attempt_id;
  insert into public.attempt_runs (
    attempt_id, mode, purpose, selection, source_attempt_id, assignment,
    accepted_at, timing_profile_revision_id, timing_profile_snapshot
  )
  values (
    v_attempt_id, 'timed-block', 'normal', p_selection, null,
    pg_catalog.jsonb_build_object(
      'versionId', p_version_id, 'questionIds', p_question_ids
    ),
    p_at, v_revision_id, v_snapshot
  );
  return v_attempt_id;
end;
$$;

revoke all on all functions in schema m2_test
  from public, anon, authenticated, service_role;
