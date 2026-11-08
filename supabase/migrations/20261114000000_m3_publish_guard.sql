-- M3 P4-T1 (#81): the identity guard of the trusted publication.
--
-- The previous publish_exam_version (20261101000000_short_practice.sql) ran
-- `insert into exams … on conflict (slug) do update set title = …`: a package
-- with the slug of another exam silently renamed it and added a version of
-- foreign material, the format was never compared, and the "identical
-- package" check lived only in the TypeScript caller, so two concurrent runs
-- could publish the same package twice.
--
-- The replacement decides everything inside one transaction, under the row
-- lock of the exam (FOR NO KEY UPDATE: it serialises publications of one slug
-- but does not block guests whose new attempts reference the exam):
--   * p_intent, when given, must match: 'new-exam' needs a missing slug,
--     'new-version' an existing one. It is checked before any write;
--   * the format of an existing exam never changes;
--   * the title of an existing exam changes only with p_rename = true;
--   * a package identical to the latest version (content, keys, tracks) is
--     not published again: its version id is returned with is_new = false;
--   * otherwise a new immutable version max(version) + 1 is written with its
--     keys and tracks.
-- p_intent and p_rename have defaults, so the trusted callers that pass the
-- six material arguments keep working with the unchanged title and format.
-- The function stays SECURITY INVOKER: only service_role may execute it.

drop function public.publish_exam_version(text, text, text, jsonb, jsonb, jsonb);

create function public.publish_exam_version(
  p_slug text,
  p_title text,
  p_format text,
  p_content jsonb,
  p_keys jsonb,
  p_audio jsonb,
  p_intent text default null,
  p_rename boolean default false
)
returns table (version_id uuid, is_new boolean)
language plpgsql
volatile
set search_path = ''
as $$
#variable_conflict error
declare
  v_exam public.exams;
  v_created boolean := false;
  v_rename boolean := coalesce(p_rename, false);
  v_latest public.exam_versions;
  v_stored_keys jsonb;
  v_stored_audio jsonb;
  v_given_audio jsonb;
  v_version_id uuid;
  v_question jsonb;
  v_track jsonb;
  v_key text;
begin
  -- Arguments and material: read-only checks before any lock or write.
  if p_intent is not null and p_intent not in ('new-exam', 'new-version') then
    raise exception 'publication intent is not valid'
      using errcode = 'P0001', hint = 'publish_intent_invalid';
  end if;

  if p_slug is null or p_title is null or p_format is null then
    raise exception 'slug, title and format are required'
      using errcode = 'P0001', hint = 'material_invalid';
  end if;

  if jsonb_typeof(p_content -> 'questions') is distinct from 'array'
    or jsonb_typeof(p_keys) is distinct from 'object' then
    raise exception 'content questions and keys are required'
      using errcode = 'P0001', hint = 'material_invalid';
  end if;

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

  -- Every key names a question and is a text option id, so the stored keys
  -- compare equal to the same package on a repeated publication.
  if exists (
    select 1 from jsonb_each(p_keys) k
    where jsonb_typeof(k.value) <> 'string'
      or not exists (
        select 1 from jsonb_array_elements(p_content -> 'questions') q
        where q ->> 'id' = k.key
      )
  ) then
    raise exception 'keys do not match questions'
      using errcode = 'P0001', hint = 'material_invalid';
  end if;

  if jsonb_typeof(p_audio) is distinct from 'array' then
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

  -- Identity of the exam, under its row lock.
  select * into v_exam from public.exams e
  where e.slug = p_slug
  for no key update;

  if not found then
    if p_intent = 'new-version' then
      raise exception 'exam does not exist'
        using errcode = 'P0001', hint = 'exam_not_found';
    end if;
    -- A concurrent publication of the same new slug makes this insert wait
    -- for its outcome; after its commit nothing is inserted here.
    insert into public.exams (slug, title, format)
    values (p_slug, p_title, p_format)
    on conflict (slug) do nothing
    returning * into v_exam;
    if found then
      v_created := true;
    else
      select * into v_exam from public.exams e
      where e.slug = p_slug
      for no key update;
      if not found then
        raise exception 'exam identity could not be locked'
          using errcode = 'P0001', hint = 'exam_identity_conflict';
      end if;
    end if;
  end if;

  if not v_created then
    if p_intent = 'new-exam' then
      raise exception 'exam already exists'
        using errcode = 'P0001', hint = 'exam_exists';
    end if;
    if v_exam.format <> p_format then
      raise exception 'format of an existing exam cannot change'
        using errcode = 'P0001', hint = 'exam_format_mismatch';
    end if;
    if v_exam.title <> p_title and not v_rename then
      raise exception 'title of an existing exam changes only by rename'
        using errcode = 'P0001', hint = 'exam_title_mismatch';
    end if;
    if v_exam.title <> p_title then
      update public.exams e set title = p_title where e.id = v_exam.id;
    end if;

    -- A package identical to the latest version is not published again.
    -- The lock above makes a concurrent identical publication wait here
    -- and then find the version this one wrote.
    select * into v_latest from public.exam_versions v
    where v.exam_id = v_exam.id
    order by v.version desc
    limit 1;

    if found and v_latest.content = p_content then
      select coalesce(jsonb_object_agg(k.question_id, k.correct_option_id),
          '{}'::jsonb)
        into v_stored_keys
      from public.answer_keys k
      where k.exam_version_id = v_latest.id;

      select coalesce(jsonb_agg(jsonb_build_object(
            'trackId', a.track_id, 'kind', a.kind,
            'objectPath', a.object_path, 'contentType', a.content_type,
            'sha256', a.sha256) order by a.track_id), '[]'::jsonb)
        into v_stored_audio
      from public.exam_version_audio a
      where a.exam_version_id = v_latest.id;

      select coalesce(jsonb_agg(jsonb_build_object(
            'trackId', t ->> 'trackId', 'kind', t ->> 'kind',
            'objectPath', t ->> 'objectPath',
            'contentType', t ->> 'contentType',
            'sha256', t ->> 'sha256') order by t ->> 'trackId'), '[]'::jsonb)
        into v_given_audio
      from jsonb_array_elements(p_audio) t;

      if v_stored_keys = p_keys and v_stored_audio = v_given_audio then
        version_id := v_latest.id;
        is_new := false;
        return next;
        return;
      end if;
    end if;
  end if;

  insert into public.exam_versions (exam_id, version, content)
  values (
    v_exam.id,
    (select coalesce(max(v.version), 0) + 1 from public.exam_versions v
      where v.exam_id = v_exam.id),
    p_content
  )
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

  version_id := v_version_id;
  is_new := true;
  return next;
end;
$$;

-- Access ----------------------------------------------------------------------

revoke all on function public.publish_exam_version(text, text, text, jsonb, jsonb, jsonb, text, boolean)
  from public, anon, authenticated;
grant execute on function public.publish_exam_version(text, text, text, jsonb, jsonb, jsonb, text, boolean)
  to service_role;
