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

revoke all on all functions in schema m2_test
  from public, anon, authenticated, service_role;
