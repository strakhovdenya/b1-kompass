-- Where the guest stopped ------------------------------------------------------
--
-- The place of an attempt (the block, the position of the recording and, per
-- block, the task or group, the text and the paragraph) is stored beside the
-- attempt. The shape is checked by
-- the server against the strict schema of packages/domain; the database
-- re-checks the owner, the term, the status and that every id is part of the
-- version of the attempt.

alter table public.attempts add column progress jsonb;

alter table public.attempts add constraint attempts_progress_size
  check (progress is null or length(progress::text) <= 2048);

create function public.save_attempt_progress(
  p_session_id uuid,
  p_attempt_id uuid,
  p_progress jsonb,
  p_now timestamptz
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_version_id uuid;
  v_items text[] := array_remove(
    array[p_progress #>> '{hoeren,itemId}', p_progress #>> '{lesen,itemId}'],
    null
  );
  v_texts text[] := array_remove(array[p_progress #>> '{lesen,textId}'], null);
begin
  perform 1 from public.guest_sessions
  where id = p_session_id and p_now < expires_at;
  if not found then
    raise exception 'guest session is not active'
      using errcode = 'P0001', hint = 'guest_session_invalid';
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

  if jsonb_typeof(p_progress) is distinct from 'object'
    or length(p_progress::text) > 2048
    or exists (
      select 1 from unnest(v_items) as item
      where not exists (
        select 1 from public.exam_versions v,
          jsonb_array_elements(v.content -> 'questions') q
        where v.id = v_version_id and q ->> 'id' = item
      )
      and not exists (
        select 1 from public.exam_versions v,
          jsonb_array_elements(coalesce(v.content -> 'groups', '[]'::jsonb)) g
        where v.id = v_version_id and g ->> 'id' = item
      )
    )
    or exists (
      select 1 from unnest(v_texts) as text_id
      where not exists (
        select 1 from public.exam_versions v,
          jsonb_array_elements(coalesce(v.content -> 'texts', '[]'::jsonb)) t
        where v.id = v_version_id and t ->> 'id' = text_id
      )
    )
  then
    raise exception 'progress does not fit this attempt'
      using errcode = 'P0001', hint = 'progress_not_allowed';
  end if;

  update public.attempts
  set progress = p_progress, updated_at = p_now
  where id = p_attempt_id;
  return p_progress;
end;
$$;

revoke all on function public.save_attempt_progress(uuid, uuid, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.save_attempt_progress(uuid, uuid, jsonb, timestamptz)
  to service_role;
