-- M2 P3-T1: trusted timing profiles of a published exam version and their
-- confirmation by the owner. A profile lives outside the published material:
-- append-only revisions bound to the version, to the SHA-256 of its one
-- recording and to the durations. The database computes the fingerprint of
-- a revision itself; the owner confirms exactly the current revision with
-- that fingerprint. A new draft makes the current head unconfirmed: nothing
-- falls back to an older confirmed revision. attempt_runs gets a nullable,
-- immutable pin of the revision and its snapshot for the timed start of #43;
-- training and legacy runs keep both null. The production start is not
-- changed here.
-- Access: tables and kernels in m2_private (no API role has USAGE), owner
-- entry points in m2_owner (no API role has USAGE or EXECUTE, service_role
-- included). service_role only reads the confirmed profile through one
-- SECURITY DEFINER function.

-- Owner schema -------------------------------------------------------------------

-- Entry points of scripts/manage-timing-profile.ts. They run only for the
-- owner/DDL database role that owns them; no API role may call them.
create schema m2_owner;
revoke all on schema m2_owner from public, anon, authenticated, service_role;

-- Profiles -----------------------------------------------------------------------

-- One head row per version: the number of its current revision. Creation
-- and confirmation lock this row FOR UPDATE; the gate locks it FOR SHARE.
create table m2_private.timing_profiles (
  exam_version_id uuid primary key references public.exam_versions (id),
  head_revision integer not null check (head_revision > 0)
);

-- Revisions are append-only: only the current head moves once from draft to
-- confirmed. The fingerprint covers the revision id and number, the version,
-- the recording and every duration, all in seconds.
create table m2_private.timing_profile_revisions (
  id uuid primary key,
  exam_version_id uuid not null
    references m2_private.timing_profiles (exam_version_id),
  revision integer not null check (revision > 0),
  track_id text not null,
  audio_sha256 text not null check (audio_sha256 ~ '^[0-9a-f]{64}$'),
  recording_seconds integer not null
    check (recording_seconds between 1 and 14400),
  hoeren_seconds integer not null check (hoeren_seconds between 1 and 14400),
  transition_seconds integer not null
    check (transition_seconds between 1 and 3600),
  lesen_seconds integer not null check (lesen_seconds between 1 and 14400),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('draft', 'confirmed')),
  created_at timestamptz not null,
  confirmed_at timestamptz,
  constraint timing_profile_revisions_confirmed_at
    check ((status = 'confirmed') = (confirmed_at is not null)),
  constraint timing_profile_revisions_number_key
    unique (exam_version_id, revision),
  constraint timing_profile_revisions_track
    foreign key (exam_version_id, track_id)
    references public.exam_version_audio (exam_version_id, track_id)
);

-- The head always names an existing revision of its own version; checked at
-- commit, because the first head and its revision are written together.
alter table m2_private.timing_profiles
  add constraint timing_profiles_head_revision
  foreign key (exam_version_id, head_revision)
  references m2_private.timing_profile_revisions (exam_version_id, revision)
  deferrable initially deferred;

-- Canonical fingerprint: sha256 of the jsonb array text. jsonb renders the
-- same values the same way, so the digest depends only on the stored data.
create function m2_private.timing_profile_fingerprint(
  p_revision_id uuid,
  p_exam_version_id uuid,
  p_revision integer,
  p_track_id text,
  p_audio_sha256 text,
  p_recording_seconds integer,
  p_hoeren_seconds integer,
  p_transition_seconds integer,
  p_lesen_seconds integer
)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(
      'b1k-timing-profile-v1', p_revision_id, p_exam_version_id, p_revision,
      p_track_id, p_audio_sha256, p_recording_seconds, p_hoeren_seconds,
      p_transition_seconds, p_lesen_seconds
    )::text, 'UTF8')), 'hex')
$$;

create function m2_private.timing_profile_fingerprint_of(
  p_row m2_private.timing_profile_revisions
)
returns text
language sql
immutable
set search_path = ''
as $$
  select m2_private.timing_profile_fingerprint(
    p_row.id, p_row.exam_version_id, p_row.revision, p_row.track_id,
    p_row.audio_sha256, p_row.recording_seconds, p_row.hoeren_seconds,
    p_row.transition_seconds, p_row.lesen_seconds
  )
$$;

-- A moment as UTC text, independent of the TimeZone of the session.
create function m2_private.utc_text(p_at timestamptz)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.to_char(
    pg_catalog.timezone('UTC', p_at), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )
$$;

-- The document of a revision: what the owner tool shows and what a timed
-- run pins as its snapshot. The same row gives the same document in every
-- session.
create function m2_private.timing_profile_document(
  p_row m2_private.timing_profile_revisions
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'revisionId', p_row.id,
    'examVersionId', p_row.exam_version_id,
    'revision', p_row.revision,
    'trackId', p_row.track_id,
    'audioSha256', p_row.audio_sha256,
    'recordingSeconds', p_row.recording_seconds,
    'hoerenSeconds', p_row.hoeren_seconds,
    'transitionSeconds', p_row.transition_seconds,
    'lesenSeconds', p_row.lesen_seconds,
    'fingerprint', p_row.fingerprint,
    'status', p_row.status,
    'createdAt', m2_private.utc_text(p_row.created_at),
    'confirmedAt', m2_private.utc_text(p_row.confirmed_at)
  )
$$;

-- The tracks the published content of the version plays in Hören: those of
-- its Hören questions and examples and of its groups (Teil 3 pairs and the
-- Teil 4 set). Sorted and distinct.
create function m2_private.hoeren_track_ids(p_version_id uuid)
returns text[]
language sql
stable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.array_agg(distinct t.track_id order by t.track_id), '{}'
  )
  from public.exam_versions v,
    lateral (
      select q.item ->> 'trackId'
      from pg_catalog.jsonb_array_elements(v.content -> 'questions') q (item)
      where q.item ->> 'skill' = 'hoeren'
      union all
      select e.item ->> 'trackId'
      from pg_catalog.jsonb_array_elements(
        coalesce(v.content -> 'examples', '[]'::jsonb)) e (item)
      where e.item ->> 'skill' = 'hoeren'
      union all
      select g.item ->> 'trackId'
      from pg_catalog.jsonb_array_elements(
        coalesce(v.content -> 'groups', '[]'::jsonb)) g (item)
    ) t (track_id)
  where v.id = p_version_id and t.track_id is not null
$$;

-- A revision still describes its version: the stored fingerprint equals the
-- recomputed one; the version has exactly one recording, the same track
-- with the same SHA-256; and its Hören content plays exactly that one track.
-- Several or no recordings, or Hören tracks that disagree, fail closed.
create function m2_private.timing_profile_matches(
  p_row m2_private.timing_profile_revisions
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_row.fingerprint = m2_private.timing_profile_fingerprint_of(p_row)
    and coalesce((
      select pg_catalog.count(*) = 1
        and pg_catalog.bool_and(
          a.track_id = p_row.track_id and a.sha256 = p_row.audio_sha256)
      from public.exam_version_audio a
      where a.exam_version_id = p_row.exam_version_id
    ), false)
    and m2_private.hoeren_track_ids(p_row.exam_version_id)
      = array[p_row.track_id]
$$;

-- Database guards ------------------------------------------------------------------

-- A new revision is the next number of its version, a draft, and carries
-- the fingerprint the database computes for it and the recording of its
-- version. This holds for any role, the owner included.
create function m2_private.guard_new_timing_profile_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status <> 'draft'
    or new.confirmed_at is not null
    or new.revision <> coalesce((
      select pg_catalog.max(r.revision)
      from m2_private.timing_profile_revisions r
      where r.exam_version_id = new.exam_version_id
    ), 0) + 1
    or not m2_private.timing_profile_matches(new)
  then
    raise exception 'a new timing profile revision is not valid'
      using errcode = 'P0001', hint = 'timing_profile_invalid';
  end if;
  return new;
end;
$$;

create trigger timing_profile_revisions_new
  before insert on m2_private.timing_profile_revisions
  for each row execute function m2_private.guard_new_timing_profile_revision();

-- At commit every new revision is reached by the head of its version: a
-- revision written without moving the head is refused, so no orphan above
-- the head can block later revisions.
create function m2_private.check_timing_profile_head()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not exists (
    select 1 from m2_private.timing_profiles h
    where h.exam_version_id = new.exam_version_id
      and h.head_revision >= new.revision
  ) then
    raise exception 'a new revision becomes the head in its transaction'
      using errcode = 'P0001', hint = 'timing_profile_invalid';
  end if;
  return null;
end;
$$;

create constraint trigger timing_profile_revisions_reach_head
  after insert on m2_private.timing_profile_revisions
  deferrable initially deferred
  for each row execute function m2_private.check_timing_profile_head();

-- Data of a revision never changes. The only update is the confirmation of
-- the current head: draft to confirmed, once, with its moment.
create function m2_private.guard_timing_profile_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'UPDATE'
    or new.id <> old.id
    or new.exam_version_id <> old.exam_version_id
    or new.revision <> old.revision
    or new.track_id <> old.track_id
    or new.audio_sha256 <> old.audio_sha256
    or new.recording_seconds <> old.recording_seconds
    or new.hoeren_seconds <> old.hoeren_seconds
    or new.transition_seconds <> old.transition_seconds
    or new.lesen_seconds <> old.lesen_seconds
    or new.fingerprint <> old.fingerprint
    or new.created_at <> old.created_at
    or old.status <> 'draft'
    or new.status <> 'confirmed'
  then
    raise exception 'timing profile revisions are append-only'
      using errcode = 'P0001', hint = 'timing_profile_append_only';
  end if;
  if not exists (
    select 1 from m2_private.timing_profiles h
    where h.exam_version_id = new.exam_version_id
      and h.head_revision = new.revision
  ) then
    raise exception 'only the current revision is confirmed'
      using errcode = 'P0001', hint = 'timing_profile_not_current';
  end if;
  return new;
end;
$$;

create trigger timing_profile_revisions_append_only
  before update or delete on m2_private.timing_profile_revisions
  for each row execute function m2_private.guard_timing_profile_revision();

-- The head only moves forward by one revision of the same version.
create function m2_private.guard_timing_profile_head()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'UPDATE'
    or new.exam_version_id <> old.exam_version_id
    or new.head_revision <> old.head_revision + 1
  then
    raise exception 'a timing profile head only moves to the next revision'
      using errcode = 'P0001', hint = 'timing_profile_append_only';
  end if;
  return new;
end;
$$;

create trigger timing_profiles_forward_only
  before update or delete on m2_private.timing_profiles
  for each row execute function m2_private.guard_timing_profile_head();

create function m2_private.reject_timing_profile_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'timing profiles are append-only'
    using errcode = 'P0001', hint = 'timing_profile_append_only';
end;
$$;

create trigger timing_profiles_no_truncate
  before truncate on m2_private.timing_profiles
  for each statement execute function m2_private.reject_timing_profile_truncate();
create trigger timing_profile_revisions_no_truncate
  before truncate on m2_private.timing_profile_revisions
  for each statement execute function m2_private.reject_timing_profile_truncate();

-- Gate -----------------------------------------------------------------------------

-- The current head of the version when it is confirmed and still matches
-- its version and recording; otherwise no row. Reads without a lock.
create function m2_private.confirmed_head(p_version_id uuid)
returns table (revision_id uuid, snapshot jsonb)
language sql
stable
set search_path = ''
as $$
  select r.id, m2_private.timing_profile_document(r)
  from m2_private.timing_profiles h
  join m2_private.timing_profile_revisions r
    on r.exam_version_id = h.exam_version_id
    and r.revision = h.head_revision
  where h.exam_version_id = p_version_id
    and r.status = 'confirmed'
    and m2_private.timing_profile_matches(r)
$$;

-- The trusted gate of a timed start. It returns the current head of the
-- version only when that head is confirmed and still matches the version and
-- its recording; a draft head, a missing profile or a mismatch return no
-- row, never an older confirmed revision. It reads under FOR SHARE of the
-- head row, so a revision created or confirmed concurrently waits for the
-- caller's transaction and the reverse. #43 calls it inside the SQL start
-- after the slot lock and pins the returned revision and snapshot in the
-- same transaction. No API role may call it directly.
create function m2_private.current_confirmed_profile(p_version_id uuid)
returns table (revision_id uuid, snapshot jsonb)
language plpgsql
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform 1 from m2_private.timing_profiles h
  where h.exam_version_id = p_version_id
  for share;
  return query select * from m2_private.confirmed_head(p_version_id);
end;
$$;

-- The read-only runtime view for the trusted server
-- (apps/web/src/server/attempts/profiles.ts): the confirmed snapshot or
-- null, by the same rule as the gate but without a row lock, so a runtime
-- read never waits for or blocks the owner. It only informs; the timed
-- start pins through the gate. SECURITY DEFINER keeps tables, kernels and
-- owner functions out of reach of service_role.
create function public.m2_confirmed_timing_profile(p_version_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select g.snapshot from m2_private.confirmed_head(p_version_id) g
$$;

-- Owner entry points ------------------------------------------------------------------

-- The version, its recordings, the current head and what the gate returns.
create function m2_owner.timing_profile_state(p_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.exam_versions;
  v_slug text;
  v_head m2_private.timing_profiles;
  v_row m2_private.timing_profile_revisions;
begin
  select * into v_version from public.exam_versions v
  where v.id = p_version_id;
  if not found then
    raise exception 'exam version not found'
      using errcode = 'P0001', hint = 'timing_profile_version_missing';
  end if;
  select e.slug into v_slug from public.exams e where e.id = v_version.exam_id;
  select * into v_head from m2_private.timing_profiles h
  where h.exam_version_id = p_version_id;
  if found then
    select * into v_row from m2_private.timing_profile_revisions r
    where r.exam_version_id = p_version_id
      and r.revision = v_head.head_revision;
  end if;
  return pg_catalog.jsonb_build_object(
    'examSlug', v_slug,
    'examVersionId', v_version.id,
    'version', v_version.version,
    'recordings', (
      select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'trackId', a.track_id, 'sha256', a.sha256) order by a.track_id), '[]')
      from public.exam_version_audio a
      where a.exam_version_id = p_version_id
    ),
    'head', case when v_row.id is null then null
      else m2_private.timing_profile_document(v_row) end,
    'headMatches', case when v_row.id is null then false
      else m2_private.timing_profile_matches(v_row) end,
    'confirmedRevisionId', (
      select g.revision_id from m2_private.confirmed_head(p_version_id) g
    )
  );
end;
$$;

-- Creates the next draft revision of the version from the stored recording
-- and the given durations. The same settings as the current head change
-- nothing and keep its status. Never confirms.
create function m2_owner.create_timing_profile_revision(
  p_version_id uuid,
  p_recording_seconds integer,
  p_hoeren_seconds integer,
  p_transition_seconds integer,
  p_lesen_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tracks integer;
  v_track text;
  v_sha text;
  v_head m2_private.timing_profiles;
  v_row m2_private.timing_profile_revisions;
  v_next integer;
  v_id uuid;
begin
  if not exists (
    select 1 from public.exam_versions v where v.id = p_version_id
  ) then
    raise exception 'exam version not found'
      using errcode = 'P0001', hint = 'timing_profile_version_missing';
  end if;
  if p_recording_seconds is null or p_recording_seconds not between 1 and 14400
    or p_hoeren_seconds is null or p_hoeren_seconds not between 1 and 14400
    or p_transition_seconds is null
    or p_transition_seconds not between 1 and 3600
    or p_lesen_seconds is null or p_lesen_seconds not between 1 and 14400
  then
    raise exception 'timing profile durations are not valid'
      using errcode = 'P0001', hint = 'timing_profile_invalid';
  end if;
  select pg_catalog.count(*)::integer, pg_catalog.min(a.track_id),
    pg_catalog.min(a.sha256)
  into v_tracks, v_track, v_sha
  from public.exam_version_audio a
  where a.exam_version_id = p_version_id;
  if v_tracks <> 1 then
    raise exception 'the version needs exactly one recording'
      using errcode = 'P0001', hint = 'timing_profile_audio_ambiguous';
  end if;
  if m2_private.hoeren_track_ids(p_version_id) <> array[v_track] then
    raise exception 'the Hören content does not play exactly this recording'
      using errcode = 'P0001', hint = 'timing_profile_track_mismatch';
  end if;

  insert into m2_private.timing_profiles (exam_version_id, head_revision)
  values (p_version_id, 1)
  on conflict (exam_version_id) do nothing
  returning * into v_head;
  if found then
    v_next := 1;
  else
    select * into v_head from m2_private.timing_profiles h
    where h.exam_version_id = p_version_id
    for update;
    select * into v_row from m2_private.timing_profile_revisions r
    where r.exam_version_id = p_version_id
      and r.revision = v_head.head_revision;
    if v_row.track_id = v_track
      and v_row.audio_sha256 = v_sha
      and v_row.recording_seconds = p_recording_seconds
      and v_row.hoeren_seconds = p_hoeren_seconds
      and v_row.transition_seconds = p_transition_seconds
      and v_row.lesen_seconds = p_lesen_seconds
      and m2_private.timing_profile_matches(v_row)
    then
      return pg_catalog.jsonb_build_object(
        'outcome', 'unchanged',
        'revision', m2_private.timing_profile_document(v_row)
      );
    end if;
    v_next := v_head.head_revision + 1;
  end if;

  v_id := pg_catalog.gen_random_uuid();
  insert into m2_private.timing_profile_revisions (
    id, exam_version_id, revision, track_id, audio_sha256, recording_seconds,
    hoeren_seconds, transition_seconds, lesen_seconds, fingerprint, status,
    created_at
  )
  values (
    v_id, p_version_id, v_next, v_track, v_sha, p_recording_seconds,
    p_hoeren_seconds, p_transition_seconds, p_lesen_seconds,
    m2_private.timing_profile_fingerprint(
      v_id, p_version_id, v_next, v_track, v_sha, p_recording_seconds,
      p_hoeren_seconds, p_transition_seconds, p_lesen_seconds
    ),
    'draft', pg_catalog.clock_timestamp()
  )
  returning * into v_row;
  if v_next > 1 then
    update m2_private.timing_profiles set head_revision = v_next
    where exam_version_id = p_version_id;
  end if;
  return pg_catalog.jsonb_build_object(
    'outcome', 'created',
    'revision', m2_private.timing_profile_document(v_row)
  );
end;
$$;

-- Confirms the named revision with the fingerprint the owner checked. Under
-- FOR UPDATE of the head row it requires that the revision is still the
-- current head, recomputes the fingerprint, checks the recording of the
-- version and compares the given fingerprint with the recomputed one.
create function m2_owner.confirm_timing_profile_revision(
  p_revision_id uuid,
  p_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version_id uuid;
  v_head m2_private.timing_profiles;
  v_row m2_private.timing_profile_revisions;
begin
  select r.exam_version_id into v_version_id
  from m2_private.timing_profile_revisions r
  where r.id = p_revision_id;
  if not found then
    raise exception 'timing profile revision not found'
      using errcode = 'P0001', hint = 'timing_profile_revision_missing';
  end if;
  select * into v_head from m2_private.timing_profiles h
  where h.exam_version_id = v_version_id
  for update;
  select * into v_row from m2_private.timing_profile_revisions r
  where r.id = p_revision_id;
  if v_row.revision <> v_head.head_revision then
    raise exception 'the revision is not the current one'
      using errcode = 'P0001', hint = 'timing_profile_not_current';
  end if;
  if not m2_private.timing_profile_matches(v_row) then
    raise exception 'the revision no longer matches its version and recording'
      using errcode = 'P0001', hint = 'timing_profile_mismatch';
  end if;
  if p_fingerprint is null
    or p_fingerprint <> m2_private.timing_profile_fingerprint_of(v_row)
  then
    raise exception 'the fingerprint is not the one of this revision'
      using errcode = 'P0001', hint = 'timing_profile_fingerprint_mismatch';
  end if;
  if v_row.status = 'confirmed' then
    return pg_catalog.jsonb_build_object(
      'outcome', 'already-confirmed',
      'revision', m2_private.timing_profile_document(v_row)
    );
  end if;
  update m2_private.timing_profile_revisions
  set status = 'confirmed', confirmed_at = pg_catalog.clock_timestamp()
  where id = p_revision_id
  returning * into v_row;
  return pg_catalog.jsonb_build_object(
    'outcome', 'confirmed',
    'revision', m2_private.timing_profile_document(v_row)
  );
end;
$$;

-- Pin of a run -----------------------------------------------------------------------

-- A timed run of #43 pins the confirmed revision and its snapshot at the
-- start. Training and legacy runs keep both null; a training run never pins.
alter table public.attempt_runs
  add column timing_profile_revision_id uuid
    references m2_private.timing_profile_revisions (id),
  add column timing_profile_snapshot jsonb,
  add constraint attempt_runs_timing_profile_together check (
    (timing_profile_revision_id is null) = (timing_profile_snapshot is null)
  ),
  add constraint attempt_runs_training_unpinned
    check (mode <> 'training' or timing_profile_revision_id is null),
  add constraint attempt_runs_timing_snapshot_of_revision check (
    timing_profile_snapshot is null
    or (jsonb_typeof(timing_profile_snapshot) = 'object'
      and timing_profile_snapshot ->> 'revisionId'
        = timing_profile_revision_id::text)
  );

-- The run is fixed at the start, its timing pin included. The cancel reason
-- and the submission snapshot are written once, the snapshot only while the
-- attempt is active. The legacy mark goes only from false to true, for a
-- completed attempt with a stored result and no snapshot.
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
    or new.timing_profile_revision_id
      is distinct from old.timing_profile_revision_id
    or new.timing_profile_snapshot is distinct from old.timing_profile_snapshot
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

-- A new run starts without a snapshot and is never legacy. A pinned run
-- names the current confirmed head of its own version, still matching the
-- version and its recording, and carries exactly its document: a superseded
-- confirmed revision is never pinned.
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

-- Access -----------------------------------------------------------------------------

alter table m2_private.timing_profiles enable row level security;
alter table m2_private.timing_profile_revisions enable row level security;

revoke all on m2_private.timing_profiles
  from public, anon, authenticated, service_role;
revoke all on m2_private.timing_profile_revisions
  from public, anon, authenticated, service_role;

revoke all on function m2_private.timing_profile_fingerprint(uuid, uuid, integer, text, text, integer, integer, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.timing_profile_fingerprint_of(m2_private.timing_profile_revisions)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.utc_text(timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.timing_profile_document(m2_private.timing_profile_revisions)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.hoeren_track_ids(uuid)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.timing_profile_matches(m2_private.timing_profile_revisions)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.guard_new_timing_profile_revision()
  from public, anon, authenticated, service_role;
revoke all on function m2_private.check_timing_profile_head()
  from public, anon, authenticated, service_role;
revoke all on function m2_private.guard_timing_profile_revision()
  from public, anon, authenticated, service_role;
revoke all on function m2_private.guard_timing_profile_head()
  from public, anon, authenticated, service_role;
revoke all on function m2_private.reject_timing_profile_truncate()
  from public, anon, authenticated, service_role;
revoke all on function m2_private.confirmed_head(uuid)
  from public, anon, authenticated, service_role;
revoke all on function m2_private.current_confirmed_profile(uuid)
  from public, anon, authenticated, service_role;

revoke all on function m2_owner.timing_profile_state(uuid)
  from public, anon, authenticated, service_role;
revoke all on function m2_owner.create_timing_profile_revision(uuid, integer, integer, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function m2_owner.confirm_timing_profile_revision(uuid, text)
  from public, anon, authenticated, service_role;

revoke all on function public.m2_confirmed_timing_profile(uuid)
  from public, anon, authenticated;
grant execute on function public.m2_confirmed_timing_profile(uuid)
  to service_role;
