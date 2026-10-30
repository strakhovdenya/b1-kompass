-- M1 P1-T1: published material, private answer keys, fixed-term guest
-- sessions and attempts. Every table is reachable only through the trusted
-- server (service_role). anon/authenticated get no table or function rights,
-- RLS is enabled without policies as a second barrier.

-- Material ------------------------------------------------------------------

create table public.exams (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title text not null check (length(title) between 1 and 200),
  format text not null check (format in ('DTZ')),
  created_at timestamptz not null default now()
);

-- content is the public projection of the version: questions and options,
-- never keys. A published version is immutable.
create table public.exam_versions (
  id uuid primary key default gen_random_uuid(),
  exam_id uuid not null references public.exams (id),
  version integer not null check (version > 0),
  content jsonb not null check (jsonb_typeof(content -> 'questions') = 'array'),
  published_at timestamptz not null default now(),
  unique (exam_id, version)
);

create table public.answer_keys (
  exam_version_id uuid not null references public.exam_versions (id),
  question_id text not null,
  correct_option_id text not null,
  primary key (exam_version_id, question_id)
);

create function public.reject_published_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'published exam material is immutable'
    using errcode = 'P0001', hint = 'material_immutable';
end;
$$;

create trigger exam_versions_immutable
  before update or delete on public.exam_versions
  for each row execute function public.reject_published_change();

create trigger answer_keys_immutable
  before update or delete on public.answer_keys
  for each row execute function public.reject_published_change();

-- Guest sessions -----------------------------------------------------------

-- Only the sha256 of the browser token is stored. The term is fixed: 720 hours
-- (30 days) from the first entry, independent of the session time zone.
create table public.guest_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  visitor_id uuid not null default gen_random_uuid(),
  locale text not null default 'en' check (locale in ('en', 'ru')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  constraint guest_sessions_fixed_term
    check (expires_at = created_at + interval '720 hours')
);

create function public.keep_guest_session_identity()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.id <> old.id
    or new.token_hash <> old.token_hash
    or new.visitor_id <> old.visitor_id
    or new.created_at <> old.created_at
    or new.expires_at <> old.expires_at then
    raise exception 'guest session identity and term are fixed'
      using errcode = 'P0001', hint = 'guest_session_fixed';
  end if;
  return new;
end;
$$;

create trigger guest_sessions_fixed
  before update on public.guest_sessions
  for each row execute function public.keep_guest_session_identity();

-- Attempts -----------------------------------------------------------------

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  guest_session_id uuid not null
    references public.guest_sessions (id) on delete cascade,
  exam_version_id uuid not null references public.exam_versions (id),
  status text not null default 'active'
    check (status in ('active', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index attempts_one_active_per_session
  on public.attempts (guest_session_id, exam_version_id)
  where status = 'active';

create table public.attempt_answers (
  attempt_id uuid not null references public.attempts (id) on delete cascade,
  question_id text not null,
  option_id text not null,
  updated_at timestamptz not null default now(),
  primary key (attempt_id, question_id)
);

-- Filled only by the server-side scoring of P1-T2.
create table public.attempt_results (
  attempt_id uuid primary key
    references public.attempts (id) on delete cascade,
  score integer not null check (score >= 0),
  max_score integer not null check (max_score > 0 and score <= max_score),
  computed_at timestamptz not null default now()
);

-- Trusted operations --------------------------------------------------------

create function public.publish_exam_version(
  p_slug text,
  p_title text,
  p_format text,
  p_content jsonb,
  p_keys jsonb
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

  return v_version_id;
end;
$$;

create function public.start_attempt(
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

  insert into public.attempts (guest_session_id, exam_version_id)
  values (p_session_id, p_exam_version_id)
  on conflict (guest_session_id, exam_version_id) where status = 'active'
  do nothing;

  select * into v_attempt from public.attempts
  where guest_session_id = p_session_id
    and exam_version_id = p_exam_version_id
    and status = 'active';
  return v_attempt;
end;
$$;

create function public.save_attempt_answer(
  p_session_id uuid,
  p_attempt_id uuid,
  p_question_id text,
  p_option_id text,
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

  insert into public.attempt_answers (attempt_id, question_id, option_id, updated_at)
  values (p_attempt_id, p_question_id, p_option_id, p_now)
  on conflict (attempt_id, question_id)
  do update set option_id = excluded.option_id, updated_at = excluded.updated_at
  returning * into v_answer;

  update public.attempts set updated_at = p_now where id = p_attempt_id;
  return v_answer;
end;
$$;

-- Access --------------------------------------------------------------------

alter table public.exams enable row level security;
alter table public.exam_versions enable row level security;
alter table public.answer_keys enable row level security;
alter table public.guest_sessions enable row level security;
alter table public.attempts enable row level security;
alter table public.attempt_answers enable row level security;
alter table public.attempt_results enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select, insert, update, delete on all tables in schema public
  to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

-- Private bucket for exam sources. No storage.objects policy is created, so
-- only service_role can read or write it.
insert into storage.buckets (id, name, public)
values ('exam-sources', 'exam-sources', false)
on conflict (id) do nothing;
