-- M1 P4-T3: an append-only journal of guest events and a new run of the
-- training from the result screen. The journal counts entries, starts and
-- first completions of browser guests by visitor_id only: no IP address,
-- user agent or fingerprint. It references neither guest_sessions nor
-- attempts, so the daily purge of expired empty sessions never shrinks it.
-- The access model is kept: only service_role reaches tables and functions.

-- Journal -----------------------------------------------------------------------

create table public.guest_events (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('entry', 'start', 'finish')),
  visitor_id uuid not null,
  attempt_id uuid,
  occurred_at timestamptz not null,
  constraint guest_events_attempt_kind
    check ((kind = 'entry') = (attempt_id is null))
);

-- A repeated request finds the event already written: one entry per guest
-- session (its visitor_id is unique), one start and one finish per attempt.
create unique index guest_events_one_entry
  on public.guest_events (visitor_id) where kind = 'entry';
create unique index guest_events_one_per_attempt
  on public.guest_events (attempt_id, kind) where attempt_id is not null;

create function public.reject_guest_event_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'guest events are append-only'
    using errcode = 'P0001', hint = 'guest_event_final';
end;
$$;

create trigger guest_events_append_only
  before update or delete on public.guest_events
  for each row execute function public.reject_guest_event_change();

create trigger guest_events_no_truncate
  before truncate on public.guest_events
  for each statement execute function public.reject_guest_event_change();

-- Entry -------------------------------------------------------------------------

-- Same lock, window and term as before; the entry event is written in the
-- same transaction as the session.
create or replace function public.create_guest_session(
  p_token_hash text,
  p_now timestamptz,
  p_limit integer
)
returns public.guest_sessions
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
  v_session public.guest_sessions;
begin
  if p_limit is null or p_limit < 1 then
    raise exception 'guest session limit must be positive'
      using errcode = 'P0001', hint = 'invalid_limit';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.create_guest_session')
  );

  select count(*) into v_count from public.guest_sessions
  where created_at > p_now - interval '60 seconds'
    and created_at <= p_now;
  if v_count >= p_limit then
    raise exception 'too many guest sessions in the last minute'
      using errcode = 'P0001', hint = 'guest_rate_limited';
  end if;

  insert into public.guest_sessions (token_hash, locale, created_at, expires_at)
  values (p_token_hash, 'en', p_now, p_now + interval '720 hours')
  returning * into v_session;

  insert into public.guest_events (kind, visitor_id, occurred_at)
  values ('entry', v_session.visitor_id, p_now)
  on conflict do nothing;
  return v_session;
end;
$$;

-- Start -------------------------------------------------------------------------

-- The start event is written only when this call created the attempt; an
-- existing active attempt is returned without a second event.
create or replace function public.start_attempt(
  p_session_id uuid,
  p_exam_version_id uuid,
  p_now timestamptz,
  p_scope text
)
returns public.attempts
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.attempts;
  v_visitor_id uuid;
begin
  select visitor_id into v_visitor_id from public.guest_sessions
  where id = p_session_id and p_now < expires_at;
  if not found then
    raise exception 'guest session is not active'
      using errcode = 'P0001', hint = 'guest_session_invalid';
  end if;

  insert into public.attempts (guest_session_id, exam_version_id, scope)
  values (p_session_id, p_exam_version_id, p_scope)
  on conflict (guest_session_id, exam_version_id) where status = 'active'
  do nothing
  returning * into v_attempt;

  if found then
    insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
    values ('start', v_visitor_id, v_attempt.id, p_now)
    on conflict do nothing;
    return v_attempt;
  end if;

  select * into v_attempt from public.attempts
  where guest_session_id = p_session_id
    and exam_version_id = p_exam_version_id
    and status = 'active';
  return v_attempt;
end;
$$;

-- Completion --------------------------------------------------------------------

-- Same lock, idempotence and answers check as before; the first completion
-- also writes the finish event.
create or replace function public.finish_attempt(
  p_session_id uuid,
  p_attempt_id uuid,
  p_now timestamptz,
  p_scope text,
  p_scored_answers jsonb,
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
  v_answers jsonb;
  v_result public.attempt_results;
begin
  select visitor_id into v_visitor_id from public.guest_sessions
  where id = p_session_id and p_now < expires_at;
  if not found then
    raise exception 'guest session is not active'
      using errcode = 'P0001', hint = 'guest_session_invalid';
  end if;

  select * into v_attempt from public.attempts
  where id = p_attempt_id and guest_session_id = p_session_id
  for update;
  if not found then
    raise exception 'attempt not found for this session'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;

  if v_attempt.status = 'completed' then
    select * into v_result from public.attempt_results
    where attempt_id = p_attempt_id;
    return v_result;
  end if;

  if v_attempt.scope <> p_scope then
    raise exception 'attempt scope does not match the scoring'
      using errcode = 'P0001', hint = 'scope_mismatch';
  end if;

  select coalesce(jsonb_object_agg(question_id, option_id), '{}'::jsonb)
  into v_answers
  from public.attempt_answers where attempt_id = p_attempt_id;
  if v_answers <> p_scored_answers then
    raise exception 'answers changed while scoring'
      using errcode = 'P0001', hint = 'answers_changed';
  end if;

  update public.attempts set status = 'completed', updated_at = p_now
  where id = p_attempt_id;

  insert into public.attempt_results (
    attempt_id, scope, score, max_score,
    correct_count, incorrect_count, skipped_count, computed_at,
    percent, hoeren_score, hoeren_max, lesen_score, lesen_max, level
  )
  values (
    p_attempt_id, p_scope, p_score, p_max_score,
    p_correct, p_incorrect, p_skipped, p_now,
    p_percent, p_hoeren_score, p_hoeren_max, p_lesen_score, p_lesen_max,
    p_level
  )
  returning * into v_result;

  insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
  values ('finish', v_visitor_id, p_attempt_id, p_now)
  on conflict do nothing;
  return v_result;
end;
$$;

-- Restart -----------------------------------------------------------------------

-- A new run starts only from the guest's own completed attempt, on a version
-- of the same exam chosen by the trusted server. When the session already
-- has an active attempt of that exam, it is returned and nothing is created,
-- so a repeated request is idempotent. Another session's attempts are never
-- read or changed.
create function public.restart_attempt(
  p_session_id uuid,
  p_attempt_id uuid,
  p_exam_version_id uuid,
  p_now timestamptz,
  p_scope text
)
returns public.attempts
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.attempts;
begin
  perform 1 from public.guest_sessions
  where id = p_session_id and p_now < expires_at;
  if not found then
    raise exception 'guest session is not active'
      using errcode = 'P0001', hint = 'guest_session_invalid';
  end if;

  select * into v_attempt from public.attempts
  where id = p_attempt_id and guest_session_id = p_session_id;
  if not found then
    raise exception 'attempt not found for this session'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;

  if v_attempt.status <> 'completed' then
    raise exception 'only a completed attempt is run again'
      using errcode = 'P0001', hint = 'attempt_not_completed';
  end if;

  perform 1 from public.exam_versions next_version
  join public.exam_versions done_version
    on done_version.exam_id = next_version.exam_id
  where next_version.id = p_exam_version_id
    and done_version.id = v_attempt.exam_version_id;
  if not found then
    raise exception 'version belongs to another exam'
      using errcode = 'P0001', hint = 'version_not_allowed';
  end if;

  -- An active attempt of the same exam on any version (one started from
  -- another tab, before a correction) is continued, not left behind.
  select active.* into v_attempt from public.attempts active
  join public.exam_versions active_version
    on active_version.id = active.exam_version_id
  join public.exam_versions done_version
    on done_version.exam_id = active_version.exam_id
  where active.guest_session_id = p_session_id
    and active.status = 'active'
    and done_version.id = v_attempt.exam_version_id
  order by active.created_at desc, active.id desc
  limit 1;
  if found then
    return v_attempt;
  end if;

  return public.start_attempt(p_session_id, p_exam_version_id, p_now, p_scope);
end;
$$;

-- Access ------------------------------------------------------------------------

alter table public.guest_events enable row level security;

-- Even the server only reads and appends.
revoke all on public.guest_events
  from public, anon, authenticated, service_role;
grant select, insert on public.guest_events to service_role;

revoke all on function public.reject_guest_event_change()
  from public, anon, authenticated;
revoke all on function public.restart_attempt(uuid, uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.restart_attempt(uuid, uuid, uuid, timestamptz, text)
  to service_role;
