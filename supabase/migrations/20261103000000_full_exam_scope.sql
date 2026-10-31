-- M1 P3-T2: the server gives a new attempt its scope, and a completed full
-- DTZ attempt stores the totals of Hören and Lesen, the percentage with one
-- decimal place and the level of the sum. The scale itself lives in
-- @b1k/domain; the database only keeps the stored result consistent. The
-- access model is kept: only service_role reaches tables and functions.

-- Result of the full exam -------------------------------------------------------

-- Columns are nullable: results written before this migration have no
-- percentage, and a short set has no skill totals and no level. The check
-- keeps the stored totals consistent; the inventory (20 + 25) and the scale
-- stay in @b1k/domain.
alter table public.attempt_results
  add column percent numeric(4, 1)
    check (percent between 0 and 100),
  add column hoeren_score integer check (hoeren_score >= 0),
  add column hoeren_max integer check (hoeren_max > 0),
  add column lesen_score integer check (lesen_score >= 0),
  add column lesen_max integer check (lesen_max > 0),
  add column level text check (level in ('below-A2', 'A2', 'B1')),
  add constraint attempt_results_scope_totals check (
    case scope
      when 'full-exam' then
        percent is not null
        and level is not null
        and hoeren_score is not null and hoeren_max is not null
        and lesen_score is not null and lesen_max is not null
        and hoeren_score <= hoeren_max and lesen_score <= lesen_max
        and hoeren_max + lesen_max = max_score
        and hoeren_score + lesen_score = score
      else
        hoeren_score is null and hoeren_max is null
        and lesen_score is null and lesen_max is null
        and level is null
    end
  );

-- Opening with a scope ----------------------------------------------------------

-- The trusted server passes the scope it derived from the version. It is
-- written only when a new attempt is created: an existing active attempt
-- keeps its scope, so attempts started before this migration stay short-set.
drop function public.open_attempt(uuid, uuid, timestamptz);
drop function public.start_attempt(uuid, uuid, timestamptz);

create function public.start_attempt(
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
begin
  perform 1 from public.guest_sessions
  where id = p_session_id and p_now < expires_at;
  if not found then
    raise exception 'guest session is not active'
      using errcode = 'P0001', hint = 'guest_session_invalid';
  end if;

  insert into public.attempts (guest_session_id, exam_version_id, scope)
  values (p_session_id, p_exam_version_id, p_scope)
  on conflict (guest_session_id, exam_version_id) where status = 'active'
  do nothing;

  select * into v_attempt from public.attempts
  where guest_session_id = p_session_id
    and exam_version_id = p_exam_version_id
    and status = 'active';
  return v_attempt;
end;
$$;

create function public.open_attempt(
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

  v_attempt := public.start_attempt(
    p_session_id, p_exam_version_id, p_now, p_scope
  );
  return v_attempt;
end;
$$;

-- Completion with skill totals and level ----------------------------------------

-- Same lock, idempotence and answers check as before; the result row also
-- carries what the scoring policy returned for the scope of the attempt.
drop function public.finish_attempt(
  uuid, uuid, timestamptz, text, jsonb,
  integer, integer, integer, integer, integer
);

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
  return v_result;
end;
$$;

-- Access ------------------------------------------------------------------------

revoke all on function public.start_attempt(uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.open_attempt(uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.finish_attempt(uuid, uuid, timestamptz, text, jsonb, integer, integer, integer, integer, integer, numeric, integer, integer, integer, integer, text)
  from public, anon, authenticated;

grant execute on function public.start_attempt(uuid, uuid, timestamptz, text)
  to service_role;
grant execute on function public.open_attempt(uuid, uuid, timestamptz, text)
  to service_role;
grant execute on function public.finish_attempt(uuid, uuid, timestamptz, text, jsonb, integer, integer, integer, integer, integer, numeric, integer, integer, integer, integer, text)
  to service_role;
