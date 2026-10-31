-- M1 P1-T2: original audio of a published version, the scope of an attempt
-- and its atomic, idempotent completion. The access model of the first
-- migration is kept: only service_role reaches tables and functions.

-- Audio of a version ----------------------------------------------------------

-- One row per track of a version. kind names the audio source; the first and
-- only source is a file in the private bucket exam-sources. The object path
-- is content-addressed and never reaches the browser.
create table public.exam_version_audio (
  exam_version_id uuid not null references public.exam_versions (id),
  track_id text not null check (track_id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  kind text not null check (kind in ('file')),
  object_path text not null
    check (object_path ~ '^audio/[0-9a-f]{64}\.(mp3|wav|m4a|ogg)$'),
  content_type text not null
    check (content_type in ('audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/ogg')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  primary key (exam_version_id, track_id)
);

create trigger exam_version_audio_immutable
  before update or delete on public.exam_version_audio
  for each row execute function public.reject_published_change();

-- Scope and result of an attempt ----------------------------------------------

alter table public.attempts
  add column scope text not null default 'short-set'
    check (scope in ('short-set', 'full-exam'));

alter table public.attempt_results
  add column scope text not null default 'short-set'
    check (scope in ('short-set', 'full-exam')),
  add column correct_count integer not null default 0
    check (correct_count >= 0),
  add column incorrect_count integer not null default 0
    check (incorrect_count >= 0),
  add column skipped_count integer not null default 0
    check (skipped_count >= 0),
  add constraint attempt_results_counts_cover_tasks
    check (correct_count + incorrect_count + skipped_count = max_score);

-- A completed attempt stays completed, its answers and its result are frozen.
-- Deletes stay possible so that removing a guest session still cascades.
create function public.keep_attempt_completed()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'completed' and new.status <> 'completed' then
    raise exception 'a completed attempt cannot be reopened'
      using errcode = 'P0001', hint = 'attempt_completed';
  end if;
  return new;
end;
$$;

create trigger attempts_keep_completed
  before update on public.attempts
  for each row execute function public.keep_attempt_completed();

create function public.reject_completed_answer_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.attempts
    where id = new.attempt_id and status = 'completed'
  ) then
    raise exception 'answers of a completed attempt are frozen'
      using errcode = 'P0001', hint = 'attempt_completed';
  end if;
  return new;
end;
$$;

create trigger attempt_answers_frozen
  before insert or update on public.attempt_answers
  for each row execute function public.reject_completed_answer_change();

create function public.reject_result_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'an attempt result is final'
    using errcode = 'P0001', hint = 'result_final';
end;
$$;

create trigger attempt_results_final
  before update on public.attempt_results
  for each row execute function public.reject_result_change();

-- Publication with audio ------------------------------------------------------

-- Replaces the publication of P1-T1: version, keys and audio tracks are
-- written in one transaction, and every track must already exist as an
-- object of the private bucket.
drop function public.publish_exam_version(text, text, text, jsonb, jsonb);

create function public.publish_exam_version(
  p_slug text,
  p_title text,
  p_format text,
  p_content jsonb,
  p_keys jsonb,
  p_audio jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_exam_id uuid;
  v_version_id uuid;
  v_next integer;
  v_question jsonb;
  v_track jsonb;
  v_key text;
begin
  for v_question in select * from jsonb_array_elements(p_content -> 'questions')
  loop
    v_key := p_keys ->> (v_question ->> 'id');
    if v_key is null then
      raise exception 'missing key for question %', v_question ->> 'id'
        using errcode = 'P0001', hint = 'material_invalid';
    end if;
    if not exists (
      select 1 from jsonb_array_elements(v_question -> 'options') o
      where o ->> 'id' = v_key
    ) then
      raise exception 'key of question % is not one of its options',
        v_question ->> 'id'
        using errcode = 'P0001', hint = 'material_invalid';
    end if;
  end loop;

  if (select count(*) from jsonb_object_keys(p_keys))
    <> jsonb_array_length(p_content -> 'questions') then
    raise exception 'keys do not match questions'
      using errcode = 'P0001', hint = 'material_invalid';
  end if;

  if jsonb_typeof(p_audio) <> 'array' then
    raise exception 'audio must be a list of tracks'
      using errcode = 'P0001', hint = 'material_invalid';
  end if;

  for v_track in select * from jsonb_array_elements(p_audio)
  loop
    if not exists (
      select 1 from storage.objects
      where bucket_id = 'exam-sources' and name = v_track ->> 'objectPath'
    ) then
      raise exception 'audio object of track % is missing',
        v_track ->> 'trackId'
        using errcode = 'P0001', hint = 'material_invalid';
    end if;
  end loop;

  insert into public.exams (slug, title, format)
  values (p_slug, p_title, p_format)
  on conflict (slug) do update set title = excluded.title
  returning id into v_exam_id;

  select coalesce(max(version), 0) + 1 into v_next
  from public.exam_versions where exam_id = v_exam_id;

  insert into public.exam_versions (exam_id, version, content)
  values (v_exam_id, v_next, p_content)
  returning id into v_version_id;

  insert into public.answer_keys (exam_version_id, question_id, correct_option_id)
  select v_version_id, k.key, k.value
  from jsonb_each_text(p_keys) k;

  insert into public.exam_version_audio (
    exam_version_id, track_id, kind, object_path, content_type, sha256
  )
  select v_version_id,
    t ->> 'trackId', t ->> 'kind', t ->> 'objectPath',
    t ->> 'contentType', t ->> 'sha256'
  from jsonb_array_elements(p_audio) t;

  return v_version_id;
end;
$$;

-- Opening ---------------------------------------------------------------------

-- The latest attempt of the session for the version: a completed one is
-- returned for its review, otherwise the active attempt is continued or
-- started. The session term is checked here as well.
create function public.open_attempt(
  p_session_id uuid,
  p_exam_version_id uuid,
  p_now timestamptz
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
  where guest_session_id = p_session_id
    and exam_version_id = p_exam_version_id
  order by created_at desc
  limit 1;
  if found and v_attempt.status = 'completed' then
    return v_attempt;
  end if;

  v_attempt := public.start_attempt(p_session_id, p_exam_version_id, p_now);
  return v_attempt;
end;
$$;

-- Completion ------------------------------------------------------------------

-- The trusted server scores the attempt with the policy of its scope and
-- passes the answers it scored. Under the row lock that also serialises
-- save_attempt_answer the function either
--   * returns the stored result when the attempt is already completed, so a
--     repeated or overlapping finish never creates a second result, or
--   * rejects with answers_changed when the stored answers differ from the
--     scored ones (the server rescores), or
--   * completes the attempt and writes its only result.
create function public.finish_attempt(
  p_session_id uuid,
  p_attempt_id uuid,
  p_now timestamptz,
  p_scope text,
  p_scored_answers jsonb,
  p_score integer,
  p_max_score integer,
  p_correct integer,
  p_incorrect integer,
  p_skipped integer
)
returns public.attempt_results
language plpgsql
set search_path = ''
as $$
declare
  v_attempt public.attempts;
  v_answers jsonb;
  v_result public.attempt_results;
begin
  perform 1 from public.guest_sessions
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
    correct_count, incorrect_count, skipped_count, computed_at
  )
  values (
    p_attempt_id, p_scope, p_score, p_max_score,
    p_correct, p_incorrect, p_skipped, p_now
  )
  returning * into v_result;
  return v_result;
end;
$$;

-- Access ----------------------------------------------------------------------

alter table public.exam_version_audio enable row level security;

revoke all on public.exam_version_audio from anon, authenticated;
grant select, insert, update, delete on public.exam_version_audio
  to service_role;

revoke all on function public.publish_exam_version(text, text, text, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.open_attempt(uuid, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.finish_attempt(uuid, uuid, timestamptz, text, jsonb, integer, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.keep_attempt_completed() from public, anon, authenticated;
revoke all on function public.reject_completed_answer_change() from public, anon, authenticated;
revoke all on function public.reject_result_change() from public, anon, authenticated;

grant execute on function public.publish_exam_version(text, text, text, jsonb, jsonb, jsonb)
  to service_role;
grant execute on function public.open_attempt(uuid, uuid, timestamptz)
  to service_role;
grant execute on function public.finish_attempt(uuid, uuid, timestamptz, text, jsonb, integer, integer, integer, integer, integer)
  to service_role;
