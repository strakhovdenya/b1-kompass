-- M2 P2-T1: an explicit start of one attempt of one exam. Opening a page no
-- longer creates an attempt; a start is a separate command with a commandId.
-- One active attempt per guest session and exam (any version), launch
-- metadata in attempt_runs, a journal of successful commands, and the
-- transfer of M1 attempts: exam_id and metadata are filled, duplicate active
-- attempts are cancelled. The old open/start/restart functions are removed.
-- The access model is kept: only service_role reaches tables and runtime
-- functions; the migration helpers are owner-only.

-- Private schema ---------------------------------------------------------------

-- Not exposed by the Data API (supabase/config.toml lists only public) and
-- not usable by any API role: it holds the owner-only migration helpers and
-- the admission kernel that takes an explicit time.
create schema m2_private;
revoke all on schema m2_private from public, anon, authenticated, service_role;

-- Attempts ---------------------------------------------------------------------

alter table public.attempts drop constraint attempts_status_check;
alter table public.attempts add constraint attempts_status_check
  check (status in ('active', 'submitted', 'completed', 'cancelled'));

alter table public.attempts add column exam_id uuid;

-- The exam of an attempt is always the exam of its pinned version.
alter table public.exam_versions
  add constraint exam_versions_id_exam_key unique (id, exam_id);
alter table public.attempts
  add constraint attempts_version_of_exam
  foreign key (exam_version_id, exam_id)
  references public.exam_versions (id, exam_id);

-- Launch metadata, one row per attempt. The canonical scope and version stay
-- in attempts; the assignment snapshot repeats the version id only so the
-- reader can check that both agree.
create table public.attempt_runs (
  attempt_id uuid primary key
    references public.attempts (id) on delete cascade,
  mode text not null check (mode in ('training', 'timed-block', 'exam')),
  purpose text not null check (purpose in ('normal', 'error-repeat')),
  selection text not null check (selection in ('all', 'hoeren', 'lesen')),
  source_attempt_id uuid references public.attempts (id),
  assignment jsonb not null
    check (jsonb_typeof(assignment -> 'questionIds') = 'array'),
  accepted_at timestamptz not null,
  cancel_reason text check (cancel_reason in ('duplicate-m1', 'user')),
  constraint attempt_runs_source_purpose
    check ((purpose = 'error-repeat') = (source_attempt_id is not null))
);

-- Successful commands of a guest session. A repeated commandId returns the
-- same attempt; another payload under the same id is refused.
create table public.attempt_commands (
  guest_session_id uuid not null
    references public.guest_sessions (id) on delete cascade,
  command_id uuid not null,
  kind text not null check (kind in ('start')),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  attempt_id uuid not null references public.attempts (id) on delete cascade,
  accepted_at timestamptz not null,
  primary key (guest_session_id, command_id)
);

-- Journal ----------------------------------------------------------------------

-- A cancel is recorded once per attempt, like start and finish.
alter table public.guest_events drop constraint guest_events_kind_check;
alter table public.guest_events add constraint guest_events_kind_check
  check (kind in ('entry', 'start', 'finish', 'cancel'));

-- Database guards --------------------------------------------------------------

-- Identity, version and scope never change; exam_id is written once, by the
-- transfer of M1. Completed and cancelled attempts are final; a submitted one
-- only completes. Deletes stay possible for the purge of guest sessions.
create function public.guard_attempt_lifecycle()
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
  return new;
end;
$$;

create trigger attempts_guard_lifecycle
  before update on public.attempts
  for each row execute function public.guard_attempt_lifecycle();

-- Answers are written only while the attempt is active.
create or replace function public.reject_completed_answer_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.attempts
    where id = new.attempt_id and status <> 'active'
  ) then
    raise exception 'answers of a closed attempt are frozen'
      using errcode = 'P0001', hint = 'attempt_completed';
  end if;
  return new;
end;
$$;

-- The run is fixed at the start; only the cancel reason is written, once.
create function public.guard_attempt_run()
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
  then
    raise exception 'an attempt run is fixed'
      using errcode = 'P0001', hint = 'attempt_run_fixed';
  end if;
  return new;
end;
$$;

create trigger attempt_runs_fixed
  before update on public.attempt_runs
  for each row execute function public.guard_attempt_run();

create function public.reject_command_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'an accepted command is final'
    using errcode = 'P0001', hint = 'command_final';
end;
$$;

create trigger attempt_commands_final
  before update on public.attempt_commands
  for each row execute function public.reject_command_change();

-- Transfer of M1 -----------------------------------------------------------------

-- Fills what an M1 attempt lacks: its exam_id and a free training run over
-- every task of its own version. Scope, version, answers, revisions, progress
-- and results stay as they are. Idempotent; with p_attempt_id only that
-- attempt is transferred, an unknown id changes nothing.
create function m2_private.backfill_m1_attempts(p_attempt_id uuid default null)
returns table (filled_exams integer, created_runs integer)
language plpgsql
set search_path = ''
as $$
begin
  update public.attempts a set exam_id = v.exam_id
  from public.exam_versions v
  where v.id = a.exam_version_id
    and a.exam_id is null
    and (p_attempt_id is null or a.id = p_attempt_id);
  get diagnostics filled_exams = row_count;

  insert into public.attempt_runs (
    attempt_id, mode, purpose, selection, source_attempt_id, assignment,
    accepted_at
  )
  select a.id, 'training', 'normal', 'all', null,
    jsonb_build_object(
      'versionId', a.exam_version_id,
      'questionIds', (
        select coalesce(jsonb_agg(q.item ->> 'id' order by q.position), '[]')
        from jsonb_array_elements(v.content -> 'questions')
          with ordinality as q (item, position)
      )
    ),
    a.created_at
  from public.attempts a
  join public.exam_versions v on v.id = a.exam_version_id
  where (p_attempt_id is null or a.id = p_attempt_id)
    and not exists (
      select 1 from public.attempt_runs r where r.attempt_id = a.id
    )
  on conflict (attempt_id) do nothing;
  get diagnostics created_runs = row_count;
  return next;
end;
$$;

-- Leaves one active attempt per guest session and exam: the latest created,
-- the highest id on a tie. The others are cancelled with the reason
-- duplicate-m1 and one cancel event; their answers stay, no result is made.
create function m2_private.cancel_m1_duplicates()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_row record;
  v_cancelled integer := 0;
begin
  for v_row in
    select ranked.id, s.visitor_id
    from (
      select a.id, a.guest_session_id,
        row_number() over (
          partition by a.guest_session_id, a.exam_id
          order by a.created_at desc, a.id desc
        ) as position
      from public.attempts a
      where a.status = 'active'
    ) ranked
    join public.guest_sessions s on s.id = ranked.guest_session_id
    where ranked.position > 1
    order by ranked.id
  loop
    update public.attempts
    set status = 'cancelled', updated_at = pg_catalog.clock_timestamp()
    where id = v_row.id;
    update public.attempt_runs set cancel_reason = 'duplicate-m1'
    where attempt_id = v_row.id;
    insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
    values ('cancel', v_row.visitor_id, v_row.id, pg_catalog.clock_timestamp())
    on conflict do nothing;
    v_cancelled := v_cancelled + 1;
  end loop;
  return v_cancelled;
end;
$$;

select * from m2_private.backfill_m1_attempts();
select m2_private.cancel_m1_duplicates();

alter table public.attempts alter column exam_id set not null;

-- The slot: one active attempt per guest session and exam, on any version.
-- Submitted, completed and cancelled attempts do not hold it.
drop index public.attempts_one_active_per_session;
create unique index attempts_one_active_per_exam
  on public.attempts (guest_session_id, exam_id)
  where status = 'active';

-- Start --------------------------------------------------------------------------

-- The advisory lock key of the slot (guest_session_id, exam_id). Every start
-- of the same pair waits on it; another pair is independent.
create function m2_private.slot_key(p_session_id uuid, p_exam_id uuid)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.hashtextextended(
    'attempt-slot:' || p_session_id::text || ':' || p_exam_id::text, 0
  )
$$;

-- The admission kernel. It runs under the slot lock taken by its caller and
-- receives the moment of acceptance explicitly: the production function
-- passes clock_timestamp() read after the lock; test-only wrappers of the
-- isolated test database pass their own. No API role may call it.
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
returns table (attempt_id uuid, outcome text, status text, accepted_at timestamptz)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_visitor_id uuid;
  v_fingerprint text;
  v_command public.attempt_commands;
  v_active public.attempts;
  v_version public.exam_versions;
  v_expected jsonb;
  v_attempt public.attempts;
begin
  select s.visitor_id into v_visitor_id from public.guest_sessions s
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

  -- A known command answers before any check of the current state.
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
      v_command.accepted_at;
    return;
  end if;

  if p_mode not in ('training', 'timed-block', 'exam')
    or p_purpose not in ('normal', 'error-repeat')
    or p_selection not in ('all', 'hoeren', 'lesen')
    or (p_purpose = 'error-repeat') <> (p_source_attempt_id is not null)
    or p_scope not in ('short-set', 'full-exam')
    or (p_selection <> 'all' and p_scope <> 'short-set')
  then
    raise exception 'start request is not valid'
      using errcode = 'P0001', hint = 'start_invalid';
  end if;

  select * into v_active from public.attempts a
  where a.guest_session_id = p_session_id
    and a.exam_id = p_exam_id
    and a.status = 'active';
  if found then
    return query select v_active.id, 'conflict'::text, v_active.status,
      null::timestamptz;
    return;
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
    accepted_at
  )
  values (
    v_attempt.id, p_mode, p_purpose, p_selection, p_source_attempt_id,
    pg_catalog.jsonb_build_object(
      'versionId', p_version_id, 'questionIds', p_question_ids
    ),
    p_at
  );

  insert into public.attempt_commands (
    guest_session_id, command_id, kind, fingerprint, attempt_id, accepted_at
  )
  values (p_session_id, p_command_id, 'start', v_fingerprint, v_attempt.id, p_at);

  insert into public.guest_events (kind, visitor_id, attempt_id, occurred_at)
  values ('start', v_visitor_id, v_attempt.id, p_at)
  on conflict do nothing;

  return query select v_attempt.id, 'accepted'::text, v_attempt.status, p_at;
end;
$$;

-- The production start. It takes the slot lock, then reads the database
-- clock, so a start that waited is judged at the moment it really proceeds.
-- No parameter carries a time. SECURITY DEFINER keeps the kernel, which
-- takes a time, out of reach of service_role.
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
returns table (attempt_id uuid, outcome text, status text, accepted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform pg_catalog.pg_advisory_xact_lock(
    m2_private.slot_key(p_session_id, p_exam_id)
  );
  return query select * from m2_private.admit_start(
    p_session_id, p_exam_id, p_command_id, p_mode, p_purpose, p_selection,
    p_source_attempt_id, p_version_id, p_scope, p_question_ids,
    pg_catalog.clock_timestamp()
  );
end;
$$;

-- Old entry points -----------------------------------------------------------------

-- Opening no longer starts, and "start again" only opens the choice.
drop function public.restart_attempt(uuid, uuid, uuid, timestamptz, text);
drop function public.open_attempt(uuid, uuid, timestamptz, text);
drop function public.start_attempt(uuid, uuid, timestamptz, text);

-- Access ---------------------------------------------------------------------------

alter table public.attempt_runs enable row level security;
alter table public.attempt_commands enable row level security;

-- The server only reads metadata and commands; they are written by the start.
revoke all on public.attempt_runs
  from public, anon, authenticated, service_role;
revoke all on public.attempt_commands
  from public, anon, authenticated, service_role;
grant select on public.attempt_runs to service_role;
grant select on public.attempt_commands to service_role;

revoke all on function public.guard_attempt_lifecycle()
  from public, anon, authenticated;
revoke all on function public.guard_attempt_run()
  from public, anon, authenticated;
revoke all on function public.reject_command_change()
  from public, anon, authenticated;
revoke all on function m2_private.backfill_m1_attempts(uuid)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.cancel_m1_duplicates()
  from public, anon, authenticated, service_role;
revoke all on function m2_private.slot_key(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.admit_start(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb, timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function public.m2_start_attempt(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.m2_start_attempt(uuid, uuid, uuid, text, text, text, uuid, uuid, text, jsonb)
  to service_role;
