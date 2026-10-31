-- M1 P4-T2: the order of the changes of one answer.
--
-- Every answer carries a revision: a number the client gives each new choice
-- of one question, counted per (attempt, question) and continued from the
-- value the server returned when the page was loaded. The attempt row lock
-- serialises all saves of an attempt, so the comparison below sees the stored
-- revision of the moment of writing. A save is written only when its revision
-- is higher than the stored one; an equal or lower revision writes nothing and
-- gets the stored answer back, so the server can tell a repeat of the same
-- request from a stale or a conflicting one. There is no save without a
-- revision: the function of the earlier contract is dropped.

-- Answers stored before this migration (and rows written directly by trusted
-- tools) count as the first revision.
alter table public.attempt_answers
  add column revision integer not null default 1 check (revision > 0);

drop function public.save_attempt_answer(uuid, uuid, text, text, timestamptz);

create function public.save_attempt_answer(
  p_session_id uuid,
  p_attempt_id uuid,
  p_question_id text,
  p_option_id text,
  p_revision integer,
  p_now timestamptz
)
returns public.attempt_answers
language plpgsql
set search_path = ''
as $$
declare
  v_version_id uuid;
  v_answer public.attempt_answers;
begin
  perform 1 from public.guest_sessions
  where id = p_session_id and p_now < expires_at;
  if not found then
    raise exception 'guest session is not active'
      using errcode = 'P0001', hint = 'guest_session_invalid';
  end if;

  if p_revision is null or p_revision < 1 then
    raise exception 'answer revision must be positive'
      using errcode = 'P0001', hint = 'revision_invalid';
  end if;

  select exam_version_id into v_version_id from public.attempts
  where id = p_attempt_id
    and guest_session_id = p_session_id
    and status = 'active'
  for update;
  if not found then
    raise exception 'attempt not found for this session'
      using errcode = 'P0001', hint = 'attempt_not_found';
  end if;

  if not exists (
    select 1
    from public.exam_versions v,
      jsonb_array_elements(v.content -> 'questions') q,
      jsonb_array_elements(q -> 'options') o
    where v.id = v_version_id
      and q ->> 'id' = p_question_id
      and o ->> 'id' = p_option_id
  ) then
    raise exception 'option is not allowed for this question'
      using errcode = 'P0001', hint = 'option_not_allowed';
  end if;

  -- Not newer than the stored answer: a repeat, a stale or a conflicting
  -- request. Nothing is written; the caller compares the stored answer.
  select * into v_answer from public.attempt_answers
  where attempt_id = p_attempt_id and question_id = p_question_id;
  if found and p_revision <= v_answer.revision then
    return v_answer;
  end if;

  insert into public.attempt_answers (
    attempt_id, question_id, option_id, revision, updated_at
  )
  values (p_attempt_id, p_question_id, p_option_id, p_revision, p_now)
  on conflict (attempt_id, question_id)
  do update set
    option_id = excluded.option_id,
    revision = excluded.revision,
    updated_at = excluded.updated_at
  returning * into v_answer;

  update public.attempts set updated_at = p_now where id = p_attempt_id;
  return v_answer;
end;
$$;

revoke all on function public.save_attempt_answer(uuid, uuid, text, text, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_attempt_answer(uuid, uuid, text, text, integer, timestamptz)
  to service_role;
