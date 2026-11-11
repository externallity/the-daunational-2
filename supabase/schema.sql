-- THE DAUNATIONAL 2 — полная схема. Файл идемпотентен: его можно выполнять повторно.
-- Запуск: Supabase -> SQL Editor -> вставить весь файл -> Run.
-- Перед этим в Auth должны быть включены Anonymous Sign-Ins.
--
-- Всё состояние комнаты живёт в rooms.state (формат v2) и меняется только
-- через функции ниже. Клиент не может записать состояние напрямую.

-- ============================================================
-- Таблицы
-- ============================================================

create table if not exists public.rooms (
  code text primary key check (code ~ '^[A-Z0-9]{6}$'),
  host_user_id uuid not null references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.tournament_scores (
  nickname text primary key check (length(trim(nickname)) between 1 and 32),
  total_points integer not null default 0 check (total_points >= 0),
  wins integer not null default 0 check (wins >= 0),
  losses integer not null default 0 check (losses >= 0),
  mvp_awards integer not null default 0 check (mvp_awards >= 0),
  games_played integer not null default 0 check (games_played >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.heroes (
  id integer primary key,
  name text not null,
  attr text not null check (attr in ('str', 'agi', 'int', 'all'))
);

-- ============================================================
-- Доступ: чтение комнат и таблицы очков, запись только через RPC
-- ============================================================

alter table public.rooms enable row level security;
alter table public.tournament_scores enable row level security;
alter table public.heroes enable row level security;

drop policy if exists "Room host can create room" on public.rooms;
drop policy if exists "Room host can update room" on public.rooms;
drop policy if exists "Authenticated users can read rooms" on public.rooms;
create policy "Authenticated users can read rooms"
  on public.rooms for select to authenticated using (true);

drop policy if exists "Authenticated users can read tournament scores" on public.tournament_scores;
create policy "Authenticated users can read tournament scores"
  on public.tournament_scores for select to authenticated using (true);

revoke all on public.rooms, public.tournament_scores, public.heroes from anon, authenticated;
grant usage on schema public to authenticated;
grant select on public.rooms, public.tournament_scores to authenticated;

-- Прежняя функция позволяла организатору перезаписать состояние целиком.
drop function if exists public.update_room_state(text, jsonb);

-- ============================================================
-- Внутренние функции
-- ============================================================

-- Порядок Captains Draft: 6 банов и 10 пиков. F — кто выиграл монетку, S — второй.
-- Менять порядок драфта нужно только здесь.
create or replace function public._cm_order(p_first integer)
returns jsonb language sql immutable set search_path = public, pg_temp as $$
  select jsonb_agg(jsonb_build_object(
           't', case when step->>0 = 'F' then p_first else 1 - p_first end,
           'a', step->>1) order by ord)
  from jsonb_array_elements('[
    ["F","ban"],["S","ban"],["F","ban"],["S","ban"],["F","ban"],["S","ban"],
    ["F","pick"],["S","pick"],["S","pick"],["F","pick"],["F","pick"],
    ["S","pick"],["S","pick"],["F","pick"],["F","pick"],["S","pick"]
  ]'::jsonb) with ordinality as t(step, ord);
$$;

-- Случайный пул: по 7 героев каждого атрибута.
create or replace function public._hero_pool()
returns jsonb language sql volatile set search_path = public, pg_temp as $$
  select jsonb_agg(id)
  from (select id, row_number() over (partition by attr order by random()) as n from public.heroes) h
  where n <= 7;
$$;

create or replace function public._nick(p_state jsonb, p_id text)
returns text language sql immutable set search_path = public, pg_temp as $$
  select p->>'nick' from jsonb_array_elements(p_state->'players') p where p->>'id' = p_id limit 1;
$$;

create or replace function public._award(p_nick text, p_points int, p_wins int, p_losses int, p_mvp int, p_games int)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  update public.tournament_scores
     set total_points = total_points + p_points, wins = wins + p_wins, losses = losses + p_losses,
         mvp_awards = mvp_awards + p_mvp, games_played = games_played + p_games, updated_at = now()
   where lower(nickname) = lower(p_nick);
  if not found then
    insert into public.tournament_scores(nickname, total_points, wins, losses, mvp_awards, games_played)
    values (p_nick, p_points, p_wins, p_losses, p_mvp, p_games);
  end if;
end;
$$;

-- Записывает ход драфта и передаёт очередь дальше.
create or replace function public._draft_advance(p_state jsonb, p_hero integer, p_by text, p_reserve jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  d jsonb := p_state->'draft';
  v_idx integer := (d->>'idx')::int + 1;
  s jsonb := p_state;
begin
  d := jsonb_set(d, '{actions}', (d->'actions') || jsonb_build_array(jsonb_build_object('hero', p_hero, 'by', p_by)));
  d := jsonb_set(d, '{idx}', to_jsonb(v_idx));
  d := jsonb_set(d, '{reserve}', p_reserve);
  d := jsonb_set(d, '{turnStartedAt}', to_jsonb(now()));
  s := jsonb_set(s, '{draft}', d);
  if v_idx >= jsonb_array_length(d->'order') then
    s := jsonb_set(s, '{stage}', '"result"');
  end if;
  return s;
end;
$$;

-- ============================================================
-- Публичные функции
-- ============================================================

create or replace function public.create_room(p_code text, p_host_nickname text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_nick text := btrim(p_host_nickname);
  v_state jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_code !~ '^[A-Z0-9]{6}$' then raise exception 'BAD_CODE'; end if;
  if length(v_nick) not between 1 and 24 then raise exception 'BAD_NICK'; end if;

  v_state := jsonb_build_object(
    'v', 2, 'rev', 1, 'code', p_code, 'hostId', v_uid, 'stage', 'lobby',
    'players', jsonb_build_array(jsonb_build_object('id', v_uid, 'nick', v_nick, 'bot', false)),
    'captains', '[]'::jsonb, 'squads', '[[],[]]'::jsonb, 'squadTurn', 0,
    'coin', null, 'draft', null, 'result', null);

  insert into public.rooms(code, host_user_id, state) values (p_code, v_uid, v_state);
  return v_state || jsonb_build_object('serverNow', now());
end;
$$;

create or replace function public.join_room(p_code text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_nick text := btrim(p_nickname);
  v_room public.rooms;
  s jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_room from public.rooms where code = upper(btrim(p_code)) for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  s := v_room.state;
  if coalesce((s->>'v')::int, 0) <> 2 then raise exception 'ROOM_OUTDATED'; end if;

  -- Вернувшийся игрок входит под своим прежним ником.
  if s->'players' @> jsonb_build_array(jsonb_build_object('id', v_uid::text)) then
    return s || jsonb_build_object('serverNow', now());
  end if;

  if length(v_nick) not between 1 and 24 then raise exception 'BAD_NICK'; end if;
  if s->>'stage' <> 'lobby' then raise exception 'ALREADY_STARTED'; end if;
  if jsonb_array_length(s->'players') >= 10 then raise exception 'ROOM_FULL'; end if;
  if exists (select 1 from jsonb_array_elements(s->'players') p where lower(p->>'nick') = lower(v_nick)) then
    raise exception 'NICK_TAKEN';
  end if;

  s := jsonb_set(s, '{players}', (s->'players') || jsonb_build_array(jsonb_build_object('id', v_uid, 'nick', v_nick, 'bot', false)));
  s := jsonb_set(s, '{rev}', to_jsonb((s->>'rev')::int + 1));
  update public.rooms set state = s, updated_at = now() where code = v_room.code;
  return s || jsonb_build_object('serverNow', now());
end;
$$;

create or replace function public.get_room(p_code text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare s jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  select state into s from public.rooms where code = upper(btrim(p_code));
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if coalesce((s->>'v')::int, 0) <> 2 then raise exception 'ROOM_OUTDATED'; end if;
  return s || jsonb_build_object('serverNow', now());
end;
$$;

-- Возврат на своё место с другого устройства: игрок подтвердил на сайте, что это его ник.
-- Идентификаторы живых игроков — UUID, поэтому замена по всему состоянию безопасна
-- и сразу переносит роли: капитана, организатора, место в составе, MVP.
create or replace function public.reclaim_seat(p_code text, p_nickname text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_old text;
  v_room public.rooms;
  s jsonb;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_room from public.rooms where code = upper(btrim(p_code)) for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  s := v_room.state;
  if coalesce((s->>'v')::int, 0) <> 2 then raise exception 'ROOM_OUTDATED'; end if;

  if s->'players' @> jsonb_build_array(jsonb_build_object('id', v_uid::text)) then
    return s || jsonb_build_object('serverNow', now());
  end if;

  select p->>'id' into v_old
  from jsonb_array_elements(s->'players') p
  where lower(p->>'nick') = lower(btrim(p_nickname)) and not coalesce((p->>'bot')::boolean, false)
  limit 1;
  if v_old is null then raise exception 'NO_SEAT'; end if;

  s := replace(s::text, v_old, v_uid::text)::jsonb;
  -- Вписанный вручную игрок зашёл сам: убираем отметку.
  s := jsonb_set(s, '{players}', (
    select jsonb_agg(case when p->>'id' = v_uid::text then p - 'guest' else p end order by ord)
    from jsonb_array_elements(s->'players') with ordinality as t(p, ord)));
  s := jsonb_set(s, '{rev}', to_jsonb((s->>'rev')::int + 1));
  update public.rooms
     set state = s,
         updated_at = now(),
         host_user_id = case when host_user_id::text = v_old then v_uid else host_user_id end
   where code = v_room.code;
  return s || jsonb_build_object('serverNow', now());
end;
$$;

-- Все действия в комнате. Строка блокируется на время действия,
-- поэтому одновременные клики выполняются строго по очереди.
create or replace function public.room_action(p_code text, p_action text, p_args jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_me text := auth.uid()::text;
  v_room public.rooms;
  s jsonb;
  v_stage text;
  v_host boolean;
  v_count integer;
  v_a text; v_b text; v_id text; v_nick text;
  v_turn integer; v_n integer;
  d jsonb; v_idx integer; v_step jsonb; v_team integer; v_hero integer;
  v_elapsed numeric; v_limit numeric; v_reserve jsonb; v_left integer; v_by text;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  select * into v_room from public.rooms where code = upper(btrim(p_code)) for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  s := v_room.state;
  if coalesce((s->>'v')::int, 0) <> 2 then raise exception 'ROOM_OUTDATED'; end if;
  if not s->'players' @> jsonb_build_array(jsonb_build_object('id', v_me)) then raise exception 'NOT_MEMBER'; end if;

  v_stage := s->>'stage';
  v_host := v_room.host_user_id = v_uid;
  v_count := jsonb_array_length(s->'players');

  case p_action

  when 'add_bot', 'fill_bots' then
    if not v_host then raise exception 'FORBIDDEN'; end if;
    if v_stage <> 'lobby' then raise exception 'WRONG_STAGE'; end if;
    if p_action = 'add_bot' then
      v_nick := btrim(coalesce(p_args->>'nick', ''));
      if length(v_nick) not between 1 and 24 then raise exception 'BAD_NICK'; end if;
      if v_count >= 10 then raise exception 'ROOM_FULL'; end if;
      if exists (select 1 from jsonb_array_elements(s->'players') p where lower(p->>'nick') = lower(v_nick)) then
        raise exception 'NICK_TAKEN';
      end if;
      s := jsonb_set(s, '{players}', (s->'players') || jsonb_build_array(jsonb_build_object('id', 'bot:' || gen_random_uuid(), 'nick', v_nick, 'bot', true)));
    else
      v_n := 1;
      while jsonb_array_length(s->'players') < 10 loop
        v_nick := 'Бот ' || v_n;
        v_n := v_n + 1;
        continue when exists (select 1 from jsonb_array_elements(s->'players') p where lower(p->>'nick') = lower(v_nick));
        s := jsonb_set(s, '{players}', (s->'players') || jsonb_build_array(jsonb_build_object('id', 'bot:' || gen_random_uuid(), 'nick', v_nick, 'bot', true)));
      end loop;
    end if;

  when 'add_guest' then
    -- Игрок без аккаунта: очки получает как обычно, ходит за него организатор.
    if not v_host then raise exception 'FORBIDDEN'; end if;
    if v_stage <> 'lobby' then raise exception 'WRONG_STAGE'; end if;
    v_nick := btrim(coalesce(p_args->>'nick', ''));
    if length(v_nick) not between 1 and 24 then raise exception 'BAD_NICK'; end if;
    if v_count >= 10 then raise exception 'ROOM_FULL'; end if;
    if exists (select 1 from jsonb_array_elements(s->'players') p where lower(p->>'nick') = lower(v_nick)) then
      raise exception 'NICK_TAKEN';
    end if;
    s := jsonb_set(s, '{players}', (s->'players') || jsonb_build_array(jsonb_build_object('id', 'guest:' || gen_random_uuid(), 'nick', v_nick, 'bot', false, 'guest', true)));

  when 'kick', 'leave' then
    if v_stage <> 'lobby' then raise exception 'WRONG_STAGE'; end if;
    if p_action = 'kick' then
      if not v_host then raise exception 'FORBIDDEN'; end if;
      v_id := p_args->>'id';
      if v_id = v_me then raise exception 'FORBIDDEN'; end if;
    else
      if v_host then raise exception 'FORBIDDEN'; end if;
      v_id := v_me;
    end if;
    s := jsonb_set(s, '{players}', coalesce((select jsonb_agg(p) from jsonb_array_elements(s->'players') p where p->>'id' <> v_id), '[]'::jsonb));

  when 'to_captains' then
    if not v_host then raise exception 'FORBIDDEN'; end if;
    if v_stage <> 'lobby' then raise exception 'WRONG_STAGE'; end if;
    if v_count < 2 or v_count % 2 <> 0 then raise exception 'NEED_EVEN_PLAYERS'; end if;
    s := jsonb_set(s, '{stage}', '"captains"');

  when 'set_captains' then
    if not v_host then raise exception 'FORBIDDEN'; end if;
    if v_stage <> 'captains' then raise exception 'WRONG_STAGE'; end if;
    if coalesce((p_args->>'random')::boolean, false) then
      select min(id) filter (where n = 1), min(id) filter (where n = 2) into v_a, v_b
      from (select p->>'id' as id, row_number() over (order by random()) as n
            from jsonb_array_elements(s->'players') p) t where n <= 2;
    else
      v_a := p_args->>'a';
      v_b := p_args->>'b';
    end if;
    if v_a is null or v_b is null or v_a = v_b or public._nick(s, v_a) is null or public._nick(s, v_b) is null then
      raise exception 'BAD_CAPTAINS';
    end if;
    s := s || jsonb_build_object(
      'captains', jsonb_build_array(v_a, v_b),
      'squads', jsonb_build_array(jsonb_build_array(v_a), jsonb_build_array(v_b)),
      'squadTurn', case when random() < 0.5 then 0 else 1 end,
      'stage', case when v_count = 2 then 'coin' else 'squads' end);

  when 'pick_player' then
    if v_stage <> 'squads' then raise exception 'WRONG_STAGE'; end if;
    v_turn := (s->>'squadTurn')::int;
    if not v_host and v_me <> s->'captains'->>v_turn then raise exception 'NOT_YOUR_TURN'; end if;
    v_id := p_args->>'id';
    if public._nick(s, v_id) is null then raise exception 'BAD_PLAYER'; end if;
    if (s->'squads'->0) || (s->'squads'->1) ? v_id then raise exception 'BAD_PLAYER'; end if;
    s := jsonb_set(s, array['squads', v_turn::text], (s->'squads'->v_turn) || to_jsonb(v_id));
    s := jsonb_set(s, '{squadTurn}', to_jsonb(1 - v_turn));
    if jsonb_array_length(s->'squads'->0) + jsonb_array_length(s->'squads'->1) >= v_count then
      s := jsonb_set(s, '{stage}', '"coin"');
    end if;

  when 'flip_coin' then
    if v_stage <> 'coin' then raise exception 'WRONG_STAGE'; end if;
    if not v_host and not (s->'captains' ? v_me) then raise exception 'FORBIDDEN'; end if;
    if s->'coin' <> 'null'::jsonb then raise exception 'ALREADY_FLIPPED'; end if;
    s := jsonb_set(s, '{coin}', jsonb_build_object('winner', case when random() < 0.5 then 0 else 1 end, 'at', now()));

  when 'start_draft' then
    if v_stage <> 'coin' then raise exception 'WRONG_STAGE'; end if;
    if not v_host and not (s->'captains' ? v_me) then raise exception 'FORBIDDEN'; end if;
    if s->'coin' = 'null'::jsonb then raise exception 'NO_COIN'; end if;
    s := s || jsonb_build_object(
      'stage', 'draft',
      'draft', jsonb_build_object(
        'pool', public._hero_pool(),
        'order', public._cm_order((s->'coin'->>'winner')::int),
        'actions', '[]'::jsonb, 'idx', 0,
        'turnSeconds', 30, 'reserve', jsonb_build_array(130, 130),
        'turnStartedAt', now()));

  when 'draft', 'timeout' then
    if v_stage <> 'draft' then raise exception 'WRONG_STAGE'; end if;
    d := s->'draft';
    v_idx := (d->>'idx')::int;
    if (p_args->>'idx')::int is distinct from v_idx then raise exception 'STALE'; end if;
    v_step := d->'order'->v_idx;
    v_team := (v_step->>'t')::int;
    v_elapsed := extract(epoch from now() - (d->>'turnStartedAt')::timestamptz);
    v_left := (d->'reserve'->>v_team)::int;
    v_limit := (d->>'turnSeconds')::int;

    if p_action = 'timeout' then
      -- Вызвать может любой участник, но сервер сам проверяет, что время вышло.
      if v_elapsed < v_limit + v_left - 1 then raise exception 'NOT_EXPIRED'; end if;
      v_hero := null;
      if v_step->>'a' = 'pick' then
        select x.id::int into v_hero
        from jsonb_array_elements_text(d->'pool') x(id)
        where not d->'actions' @> jsonb_build_array(jsonb_build_object('hero', x.id::int))
        order by random() limit 1;
      end if;
      v_reserve := jsonb_set(d->'reserve', array[v_team::text], '0');
      s := public._draft_advance(s, v_hero, 'auto', v_reserve);
    else
      if not v_host and v_me <> s->'captains'->>v_team then raise exception 'NOT_YOUR_TURN'; end if;
      v_hero := (p_args->>'hero')::int;
      if v_hero is null or not d->'pool' @> to_jsonb(v_hero) then raise exception 'BAD_HERO'; end if;
      if d->'actions' @> jsonb_build_array(jsonb_build_object('hero', v_hero)) then raise exception 'HERO_USED'; end if;
      v_by := case when v_me = s->'captains'->>v_team then 'captain' else 'host' end;
      v_left := greatest(0, v_left - ceil(greatest(0, v_elapsed - v_limit))::int);
      v_reserve := jsonb_set(d->'reserve', array[v_team::text], to_jsonb(v_left));
      s := public._draft_advance(s, v_hero, v_by, v_reserve);
    end if;

  when 'restart' then
    -- Новая игра тем же составом или откат к лобби.
    if not v_host then raise exception 'FORBIDDEN'; end if;
    s := s || jsonb_build_object(
      'stage', 'lobby', 'captains', '[]'::jsonb, 'squads', '[[],[]]'::jsonb,
      'squadTurn', 0, 'coin', null, 'draft', null, 'result', null);

  else
    raise exception 'UNKNOWN_ACTION';
  end case;

  s := jsonb_set(s, '{rev}', to_jsonb((s->>'rev')::int + 1));
  update public.rooms set state = s, updated_at = now() where code = v_room.code;
  return s || jsonb_build_object('serverNow', now());
end;
$$;

-- Завершение игры. Комнаты с ботами считаются тестовыми, очки в них не начисляются.
create or replace function public.finish_room(p_code text, p_winner integer, p_mvp text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_room public.rooms;
  s jsonb;
  v_scored boolean;
  v_id text;
  v_team integer;
  v_win boolean;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_winner not in (1, 2) then raise exception 'BAD_WINNER'; end if;
  select * into v_room from public.rooms where code = upper(btrim(p_code)) for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if v_room.host_user_id <> auth.uid() then raise exception 'FORBIDDEN'; end if;
  s := v_room.state;
  if s->>'stage' <> 'result' then raise exception 'WRONG_STAGE'; end if;
  -- MVP выбирается только из проигравшей команды: p_winner 1 -> squads[1], 2 -> squads[0].
  if not (s->'squads'->(2 - p_winner)) ? p_mvp then raise exception 'BAD_MVP'; end if;

  v_scored := not s->'players' @> '[{"bot": true}]'::jsonb;

  if v_scored then
    for v_team in 0..1 loop
      v_win := v_team + 1 = p_winner;
      for v_id in select jsonb_array_elements_text(s->'squads'->v_team) loop
        perform public._award(public._nick(s, v_id), case when v_win then 100 else 50 end,
                              case when v_win then 1 else 0 end, case when v_win then 0 else 1 end, 0, 1);
      end loop;
    end loop;
    perform public._award(public._nick(s, p_mvp), 20, 0, 0, 1, 0);
  end if;

  s := s || jsonb_build_object(
    'stage', 'finished',
    'result', jsonb_build_object('winner', p_winner, 'mvp', p_mvp, 'scored', v_scored, 'at', now()),
    'rev', (s->>'rev')::int + 1);
  update public.rooms set state = s, updated_at = now() where code = v_room.code;
  return s || jsonb_build_object('serverNow', now());
end;
$$;

-- ============================================================
-- Права на функции
-- ============================================================

revoke all on function public._cm_order(integer) from public, anon, authenticated;
revoke all on function public._hero_pool() from public, anon, authenticated;
revoke all on function public._nick(jsonb, text) from public, anon, authenticated;
revoke all on function public._award(text, int, int, int, int, int) from public, anon, authenticated;
revoke all on function public._draft_advance(jsonb, integer, text, jsonb) from public, anon, authenticated;

revoke all on function public.create_room(text, text) from public, anon;
revoke all on function public.join_room(text, text) from public, anon;
revoke all on function public.get_room(text) from public, anon;
revoke all on function public.reclaim_seat(text, text) from public, anon;
revoke all on function public.room_action(text, text, jsonb) from public, anon;
revoke all on function public.finish_room(text, integer, text) from public, anon;

grant execute on function public.create_room(text, text) to authenticated;
grant execute on function public.join_room(text, text) to authenticated;
grant execute on function public.get_room(text) to authenticated;
grant execute on function public.reclaim_seat(text, text) to authenticated;
grant execute on function public.room_action(text, text, jsonb) to authenticated;
grant execute on function public.finish_room(text, integer, text) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null;
end $$;

-- ============================================================
-- Ближайшая игра и запись в стак (главная страница)
-- ============================================================

create table if not exists public.next_game (
  id integer primary key default 1 check (id = 1),
  play_date date not null,
  play_time time,
  updated_at timestamptz not null default now()
);

create table if not exists public.game_signups (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nick text not null check (length(btrim(nick)) between 1 and 24),
  created_at timestamptz not null default now()
);
create unique index if not exists game_signups_nick_key on public.game_signups (lower(nick));

-- Запись без аккаунта: организатор вписывает игрока по нику (user_id пустой).
alter table public.game_signups drop constraint if exists game_signups_pkey;
alter table public.game_signups alter column user_id drop not null;
create unique index if not exists game_signups_user_key on public.game_signups (user_id) where user_id is not null;

-- PIN организатора. Значение задаётся отдельно и в репозиторий не попадает.
create table if not exists public.admin_secret (
  id integer primary key default 1 check (id = 1),
  salt text not null,
  pin_hash text not null
);

alter table public.next_game enable row level security;
alter table public.game_signups enable row level security;
alter table public.admin_secret enable row level security;
revoke all on public.next_game, public.game_signups, public.admin_secret from anon, authenticated;

create or replace function public._check_pin(p_pin text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from public.admin_secret
    where pin_hash = encode(sha256(convert_to(salt || coalesce(p_pin, ''), 'UTF8')), 'hex')
  ) then
    raise exception 'BAD_PIN';
  end if;
end;
$$;

create or replace function public.get_next_game()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  return jsonb_build_object(
    'limit', 10,
    'game', (select jsonb_build_object('date', play_date, 'time', to_char(play_time, 'HH24:MI')) from public.next_game),
    'players', coalesce((
      select jsonb_agg(jsonb_build_object('nick', nick, 'mine', coalesce(user_id = v_uid, false)) order by created_at)
      from public.game_signups), '[]'::jsonb));
end;
$$;

create or replace function public.join_game(p_nick text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_nick text := btrim(p_nick);
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if length(v_nick) not between 1 and 24 then raise exception 'BAD_NICK'; end if;
  -- Блокировка строки игры: одновременные записи не превысят лимит.
  perform 1 from public.next_game for update;
  if not found then raise exception 'NO_GAME'; end if;
  if exists (select 1 from public.game_signups where user_id = v_uid) then raise exception 'ALREADY_IN'; end if;
  -- Если организатор уже вписал этот ник, игрок просто занимает своё место.
  update public.game_signups set user_id = v_uid where lower(nick) = lower(v_nick) and user_id is null;
  if found then return public.get_next_game(); end if;
  if (select count(*) from public.game_signups) >= 10 then raise exception 'GAME_FULL'; end if;
  if exists (select 1 from public.game_signups where lower(nick) = lower(v_nick)) then raise exception 'NICK_TAKEN'; end if;
  insert into public.game_signups(user_id, nick) values (v_uid, v_nick);
  return public.get_next_game();
end;
$$;

-- Возврат своей записи с другого устройства или адреса: игрок подтвердил на сайте, что это его ник.
create or replace function public.reclaim_signup(p_nick text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  perform 1 from public.next_game for update;
  if not found then raise exception 'NO_GAME'; end if;
  if exists (select 1 from public.game_signups where user_id = v_uid and lower(nick) <> lower(btrim(p_nick))) then
    raise exception 'ALREADY_IN';
  end if;
  update public.game_signups set user_id = v_uid where lower(nick) = lower(btrim(p_nick));
  if not found then raise exception 'NO_SEAT'; end if;
  return public.get_next_game();
end;
$$;

create or replace function public.leave_game()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  delete from public.game_signups where user_id = auth.uid();
  return public.get_next_game();
end;
$$;

create or replace function public.admin_check(p_pin text)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform public._check_pin(p_pin);
  return true;
end;
$$;

create or replace function public.admin_set_game(p_pin text, p_date date, p_time time default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform public._check_pin(p_pin);
  if p_date is null then raise exception 'BAD_DATE'; end if;
  insert into public.next_game(id, play_date, play_time) values (1, p_date, p_time)
  on conflict (id) do update set play_date = excluded.play_date, play_time = excluded.play_time, updated_at = now();
  return public.get_next_game();
end;
$$;

-- p_keep_game = true только очищает список, false снимает игру целиком.
create or replace function public.admin_clear_game(p_pin text, p_keep_game boolean)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform public._check_pin(p_pin);
  delete from public.game_signups where true;
  if not p_keep_game then delete from public.next_game where true; end if;
  return public.get_next_game();
end;
$$;

create or replace function public.admin_remove_signup(p_pin text, p_nick text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform public._check_pin(p_pin);
  delete from public.game_signups where lower(nick) = lower(btrim(p_nick));
  return public.get_next_game();
end;
$$;

create or replace function public.admin_add_signup(p_pin text, p_nick text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_nick text := btrim(p_nick);
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform public._check_pin(p_pin);
  if length(v_nick) not between 1 and 24 then raise exception 'BAD_NICK'; end if;
  perform 1 from public.next_game for update;
  if not found then raise exception 'NO_GAME'; end if;
  if (select count(*) from public.game_signups) >= 10 then raise exception 'GAME_FULL'; end if;
  if exists (select 1 from public.game_signups where lower(nick) = lower(v_nick)) then raise exception 'NICK_TAKEN'; end if;
  insert into public.game_signups(user_id, nick) values (null, v_nick);
  return public.get_next_game();
end;
$$;

-- Ручная правка турнирной таблицы организатором.
create or replace function public.admin_set_score(p_pin text, p_nick text, p_points integer, p_wins integer, p_games integer, p_mvp integer)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare v_nick text := btrim(p_nick);
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform public._check_pin(p_pin);
  if length(v_nick) not between 1 and 32 then raise exception 'BAD_NICK'; end if;
  if p_points is null or p_wins is null or p_games is null or p_mvp is null
     or p_points < 0 or p_wins < 0 or p_games < 0 or p_mvp < 0 then raise exception 'BAD_SCORE'; end if;
  update public.tournament_scores
     set total_points = p_points, wins = p_wins, games_played = p_games, mvp_awards = p_mvp,
         losses = greatest(p_games - p_wins, 0), updated_at = now()
   where lower(nickname) = lower(v_nick);
  if not found then
    insert into public.tournament_scores(nickname, total_points, wins, games_played, mvp_awards, losses)
    values (v_nick, p_points, p_wins, p_games, p_mvp, greatest(p_games - p_wins, 0));
  end if;
end;
$$;

create or replace function public.admin_delete_score(p_pin text, p_nick text)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  perform public._check_pin(p_pin);
  delete from public.tournament_scores where lower(nickname) = lower(btrim(p_nick));
end;
$$;

revoke all on function public._check_pin(text) from public, anon, authenticated;
revoke all on function public.admin_add_signup(text, text) from public, anon;
revoke all on function public.admin_set_score(text, text, integer, integer, integer, integer) from public, anon;
revoke all on function public.admin_delete_score(text, text) from public, anon;
grant execute on function public.admin_add_signup(text, text) to authenticated;
grant execute on function public.admin_set_score(text, text, integer, integer, integer, integer) to authenticated;
grant execute on function public.admin_delete_score(text, text) to authenticated;
revoke all on function public.get_next_game() from public, anon;
revoke all on function public.join_game(text) from public, anon;
revoke all on function public.leave_game() from public, anon;
revoke all on function public.reclaim_signup(text) from public, anon;
grant execute on function public.reclaim_signup(text) to authenticated;
revoke all on function public.admin_check(text) from public, anon;
revoke all on function public.admin_set_game(text, date, time) from public, anon;
revoke all on function public.admin_clear_game(text, boolean) from public, anon;
revoke all on function public.admin_remove_signup(text, text) from public, anon;
grant execute on function public.get_next_game() to authenticated;
grant execute on function public.join_game(text) to authenticated;
grant execute on function public.leave_game() to authenticated;
grant execute on function public.admin_check(text) to authenticated;
grant execute on function public.admin_set_game(text, date, time) to authenticated;
grant execute on function public.admin_clear_game(text, boolean) to authenticated;
grant execute on function public.admin_remove_signup(text, text) to authenticated;

-- ============================================================
-- Каталог героев (сгенерирован из heroes.json)
-- ============================================================

insert into public.heroes(id, name, attr) values
  (1, 'Anti-Mage', 'agi'),
  (2, 'Axe', 'str'),
  (3, 'Bane', 'all'),
  (4, 'Bloodseeker', 'agi'),
  (5, 'Crystal Maiden', 'int'),
  (6, 'Drow Ranger', 'agi'),
  (7, 'Earthshaker', 'str'),
  (8, 'Juggernaut', 'agi'),
  (9, 'Mirana', 'agi'),
  (10, 'Morphling', 'agi'),
  (11, 'Shadow Fiend', 'agi'),
  (12, 'Phantom Lancer', 'agi'),
  (13, 'Puck', 'int'),
  (14, 'Pudge', 'str'),
  (15, 'Razor', 'agi'),
  (16, 'Sand King', 'all'),
  (17, 'Storm Spirit', 'int'),
  (18, 'Sven', 'str'),
  (19, 'Tiny', 'str'),
  (20, 'Vengeful Spirit', 'agi'),
  (21, 'Windranger', 'all'),
  (22, 'Zeus', 'int'),
  (23, 'Kunkka', 'str'),
  (25, 'Lina', 'int'),
  (26, 'Lion', 'int'),
  (27, 'Shadow Shaman', 'int'),
  (28, 'Slardar', 'str'),
  (29, 'Tidehunter', 'str'),
  (30, 'Witch Doctor', 'int'),
  (31, 'Lich', 'int'),
  (32, 'Riki', 'agi'),
  (33, 'Enigma', 'all'),
  (34, 'Tinker', 'int'),
  (35, 'Sniper', 'agi'),
  (36, 'Necrophos', 'int'),
  (37, 'Warlock', 'int'),
  (38, 'Beastmaster', 'all'),
  (39, 'Queen of Pain', 'int'),
  (40, 'Venomancer', 'all'),
  (41, 'Faceless Void', 'agi'),
  (42, 'Wraith King', 'str'),
  (43, 'Death Prophet', 'all'),
  (44, 'Phantom Assassin', 'agi'),
  (45, 'Pugna', 'int'),
  (46, 'Templar Assassin', 'agi'),
  (47, 'Viper', 'agi'),
  (48, 'Luna', 'agi'),
  (49, 'Dragon Knight', 'str'),
  (50, 'Dazzle', 'all'),
  (51, 'Clockwerk', 'str'),
  (52, 'Leshrac', 'int'),
  (53, 'Nature''s Prophet', 'all'),
  (54, 'Lifestealer', 'str'),
  (55, 'Dark Seer', 'int'),
  (56, 'Clinkz', 'agi'),
  (57, 'Omniknight', 'str'),
  (58, 'Enchantress', 'int'),
  (59, 'Huskar', 'str'),
  (60, 'Night Stalker', 'str'),
  (61, 'Broodmother', 'agi'),
  (62, 'Bounty Hunter', 'agi'),
  (63, 'Weaver', 'agi'),
  (64, 'Jakiro', 'int'),
  (65, 'Batrider', 'all'),
  (66, 'Chen', 'int'),
  (67, 'Spectre', 'agi'),
  (68, 'Ancient Apparition', 'int'),
  (69, 'Doom', 'str'),
  (70, 'Ursa', 'agi'),
  (71, 'Spirit Breaker', 'str'),
  (72, 'Gyrocopter', 'agi'),
  (73, 'Alchemist', 'str'),
  (74, 'Invoker', 'int'),
  (75, 'Silencer', 'int'),
  (76, 'Outworld Devourer', 'int'),
  (77, 'Lycan', 'str'),
  (78, 'Brewmaster', 'all'),
  (79, 'Shadow Demon', 'int'),
  (80, 'Lone Druid', 'agi'),
  (81, 'Chaos Knight', 'str'),
  (82, 'Meepo', 'agi'),
  (83, 'Treant Protector', 'str'),
  (84, 'Ogre Magi', 'str'),
  (85, 'Undying', 'str'),
  (86, 'Rubick', 'int'),
  (87, 'Disruptor', 'int'),
  (88, 'Nyx Assassin', 'all'),
  (89, 'Naga Siren', 'agi'),
  (90, 'Keeper of the Light', 'int'),
  (91, 'Io', 'all'),
  (92, 'Visage', 'all'),
  (93, 'Slark', 'agi'),
  (94, 'Medusa', 'agi'),
  (95, 'Troll Warlord', 'agi'),
  (96, 'Centaur Warrunner', 'str'),
  (97, 'Magnus', 'all'),
  (98, 'Timbersaw', 'str'),
  (99, 'Bristleback', 'str'),
  (100, 'Tusk', 'str'),
  (101, 'Skywrath Mage', 'int'),
  (102, 'Abaddon', 'all'),
  (103, 'Elder Titan', 'str'),
  (104, 'Legion Commander', 'str'),
  (105, 'Techies', 'all'),
  (106, 'Ember Spirit', 'agi'),
  (107, 'Earth Spirit', 'str'),
  (108, 'Underlord', 'str'),
  (109, 'Terrorblade', 'agi'),
  (110, 'Phoenix', 'str'),
  (111, 'Oracle', 'int'),
  (112, 'Winter Wyvern', 'int'),
  (113, 'Arc Warden', 'all'),
  (114, 'Monkey King', 'agi'),
  (119, 'Dark Willow', 'int'),
  (120, 'Pangolier', 'all'),
  (121, 'Grimstroke', 'int'),
  (123, 'Hoodwink', 'agi'),
  (126, 'Void Spirit', 'all'),
  (128, 'Snapfire', 'all'),
  (129, 'Mars', 'str'),
  (131, 'Ring Master', 'int'),
  (135, 'Dawnbreaker', 'str'),
  (136, 'Marci', 'all'),
  (137, 'Primal Beast', 'str'),
  (138, 'Muerta', 'int'),
  (145, 'Kez', 'agi'),
  (155, 'Largo', 'str')
on conflict (id) do update set name = excluded.name, attr = excluded.attr;

-- Обновить кэш PostgREST, чтобы новые функции были доступны сразу.
notify pgrst, 'reload schema';
