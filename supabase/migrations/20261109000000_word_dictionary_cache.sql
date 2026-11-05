-- B1 Kompass: word dictionary cache and provider budget (#60)
--
-- A shared technical cache of single-word lookups (DE -> EN/RU from MyMemory,
-- German synonyms and base forms from OpenThesaurus) and the counters of one
-- atomic budget for the free external providers. Exam material, answer keys,
-- attempts and results are not touched. The cache key is the word with its
-- significant case, the target and the provider version: no session id, no
-- answer and no result is stored with it. Neither table has a foreign key to
-- guest_sessions, so the existing purge of guest sessions keeps working.

-- Cache ------------------------------------------------------------------------

create table public.dictionary_cache (
  provider text not null check (provider in ('mymemory', 'openthesaurus')),
  version smallint not null check (version > 0),
  word text not null check (
    char_length(word) between 1 and 64 and octet_length(word) <= 200
  ),
  target text not null check (target in ('en', 'ru', 'de')),
  state text not null check (state in ('found', 'not-found')),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192
  ),
  fetched_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > fetched_at),
  primary key (provider, version, word, target)
);

create index dictionary_cache_expires_at_idx
  on public.dictionary_cache (expires_at);

-- Budget -----------------------------------------------------------------------

-- One row per scope and window: the shared provider budgets ('mymemory' per
-- day, 'openthesaurus' per minute) and the minute budget of one guest
-- ('guest:<session id>').
create table public.dictionary_budget (
  scope text not null check (char_length(scope) between 1 and 80),
  window_start timestamptz not null,
  used integer not null check (used >= 0),
  primary key (scope, window_start)
);

create index dictionary_budget_window_start_idx
  on public.dictionary_budget (window_start);

-- Reserves every item of p_items or none of them. p_items is a JSON array of
-- {scope, window ('minute' | 'day'), cost, limit}. The guest session is
-- checked again here: an unknown or expired session (now() >= expires_at) is
-- refused before anything is counted. Items are taken in scope order, so
-- concurrent calls lock the same rows in the same order; the conditional
-- upsert adds the cost only while the window stays within its limit, and a
-- refused item raises, which rolls back every item counted before it.
create function public.reserve_dictionary_budget(
  p_session_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_now timestamptz := pg_catalog.now();
  v_item jsonb;
  v_scope text;
  v_window text;
  v_cost integer;
  v_limit integer;
  v_start timestamptz;
  v_used integer;
begin
  if not exists (
    select 1 from public.guest_sessions s
    where s.id = p_session_id and s.expires_at > v_now
  ) then
    raise exception 'guest session is not active'
      using errcode = 'P0001', hint = 'guest_session_invalid';
  end if;

  if p_items is null
    or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 8
    or (select count(distinct e.value ->> 'scope')
        from jsonb_array_elements(p_items) e) <> jsonb_array_length(p_items)
  then
    raise exception 'dictionary budget items are invalid'
      using errcode = 'P0001', hint = 'invalid_budget';
  end if;

  for v_item in
    select e.value from jsonb_array_elements(p_items) e
    order by e.value ->> 'scope'
  loop
    v_scope := v_item ->> 'scope';
    v_window := v_item ->> 'window';
    if jsonb_typeof(v_item -> 'cost') <> 'number'
      or jsonb_typeof(v_item -> 'limit') <> 'number'
      or v_scope is null
      or v_scope !~ '^[a-z0-9]{1,24}(:[0-9a-z-]{1,40})?$'
      or v_window is null
      or v_window not in ('minute', 'day')
    then
      raise exception 'dictionary budget item is invalid'
        using errcode = 'P0001', hint = 'invalid_budget';
    end if;
    v_cost := (v_item ->> 'cost')::integer;
    v_limit := (v_item ->> 'limit')::integer;
    if v_cost < 1 or v_limit < 1 then
      raise exception 'dictionary budget item is invalid'
        using errcode = 'P0001', hint = 'invalid_budget';
    end if;

    v_start := pg_catalog.date_trunc(v_window, v_now, 'UTC');
    v_used := null;
    if v_cost <= v_limit then
      insert into public.dictionary_budget as b (scope, window_start, used)
      values (v_scope, v_start, v_cost)
      on conflict (scope, window_start) do update
        set used = b.used + excluded.used
        where b.used + excluded.used <= v_limit
      returning b.used into v_used;
    end if;
    if v_used is null then
      raise exception 'dictionary budget is used up'
        using errcode = 'P0001',
          hint = 'dictionary_budget_exhausted',
          detail = pg_catalog.split_part(v_scope, ':', 1);
    end if;
  end loop;
end;
$$;

-- Purge ------------------------------------------------------------------------

-- Deletes expired cache rows and budget windows older than two days. Returns
-- the number of deleted rows of both tables.
create function public.purge_dictionary_data(p_now timestamptz)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cache integer;
  v_budget integer;
begin
  delete from public.dictionary_cache c where c.expires_at <= p_now;
  get diagnostics v_cache = row_count;
  delete from public.dictionary_budget b
  where b.window_start < p_now - interval '2 days';
  get diagnostics v_budget = row_count;
  return v_cache + v_budget;
end;
$$;

select cron.schedule(
  'purge-dictionary-data',
  '41 * * * *',
  $$select public.purge_dictionary_data(now())$$
);

-- Access -----------------------------------------------------------------------

alter table public.dictionary_cache enable row level security;
alter table public.dictionary_budget enable row level security;

revoke all on public.dictionary_cache from public, anon, authenticated;
revoke all on public.dictionary_budget from public, anon, authenticated;
grant select, insert, update, delete on public.dictionary_cache to service_role;
grant select, insert, update, delete on public.dictionary_budget to service_role;

revoke all on function public.reserve_dictionary_budget(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.purge_dictionary_data(timestamptz)
  from public, anon, authenticated;

grant execute on function public.reserve_dictionary_budget(uuid, jsonb)
  to service_role;
grant execute on function public.purge_dictionary_data(timestamptz)
  to service_role;
