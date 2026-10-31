-- B1 Kompass: guest session limits (#18)
--
-- Guest entry creates sessions through one function that counts and inserts
-- in the same call, so the whole site creates at most p_limit sessions per
-- minute. Only guest_sessions.created_at is counted: no IP address, user
-- agent or fingerprint is stored or read. A daily job deletes expired
-- sessions that never opened the practice; a session with an attempt is kept
-- for the accumulated statistics.

create extension if not exists pg_cron with schema pg_catalog;

-- Creation --------------------------------------------------------------------

-- The minute window is counted under a site-wide lock, so it reads an index
-- range instead of scanning every session.
create index guest_sessions_created_at_idx on public.guest_sessions (created_at);

-- The transaction-level advisory lock serialises concurrent calls, so two
-- requests cannot both see p_limit - 1 sessions and pass the limit together.
-- The window is the minute before p_now: (p_now - 60 s, p_now].
create function public.create_guest_session(
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
  return v_session;
end;
$$;

-- Purge -----------------------------------------------------------------------

-- Deletes sessions whose term has ended and that have no attempt (the
-- practice was never opened: /practice creates the attempt on opening).
-- Returns the number of deleted sessions.
create function public.purge_expired_empty_guest_sessions(p_now timestamptz)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  delete from public.guest_sessions s
  where s.expires_at <= p_now
    and not exists (
      select 1 from public.attempts a where a.guest_session_id = s.id
    );
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

select cron.schedule(
  'purge-expired-empty-guest-sessions',
  '17 3 * * *',
  $$select public.purge_expired_empty_guest_sessions(now())$$
);

-- Access ----------------------------------------------------------------------

revoke all on function public.create_guest_session(text, timestamptz, integer)
  from public, anon, authenticated;
revoke all on function public.purge_expired_empty_guest_sessions(timestamptz)
  from public, anon, authenticated;

grant execute on function public.create_guest_session(text, timestamptz, integer)
  to service_role;
grant execute on function public.purge_expired_empty_guest_sessions(timestamptz)
  to service_role;
