-- THE DAUNATIONAL 2: shared room storage
-- Run this file in Supabase SQL Editor after enabling Anonymous Sign-Ins in Auth settings.

create table if not exists public.rooms (
  code text primary key check (code ~ '^[A-Z0-9]{6}$'),
  host_user_id uuid not null references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.rooms enable row level security;

drop policy if exists "Authenticated users can read rooms" on public.rooms;
create policy "Authenticated users can read rooms"
on public.rooms for select to authenticated
using (true);

drop policy if exists "Room host can create room" on public.rooms;
create policy "Room host can create room"
on public.rooms for insert to authenticated
with check (host_user_id = auth.uid());

drop policy if exists "Room host can update room" on public.rooms;
create policy "Room host can update room"
on public.rooms for update to authenticated
using (host_user_id = auth.uid())
with check (host_user_id = auth.uid());

create or replace function public.create_room(p_code text, p_host_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_state jsonb;
  v_room public.rooms;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_code !~ '^[A-Z0-9]{6}$' then raise exception 'Invalid room code'; end if;
  if length(trim(p_host_nickname)) not between 1 and 32 then raise exception 'Invalid nickname'; end if;

  v_state := jsonb_build_object(
    'code', p_code,
    'host', trim(p_host_nickname),
    'players', jsonb_build_array(trim(p_host_nickname)),
    'points', jsonb_build_object(trim(p_host_nickname), 0),
    'stage', 'lobby',
    'captains', jsonb_build_array(),
    'teamsPlayers', jsonb_build_array(jsonb_build_array(), jsonb_build_array()),
    'teamPickIndex', 0,
    'coinWinner', null,
    'heroPickOrder', jsonb_build_array(),
    'heroPickIndex', 0,
    'pool', jsonb_build_array(),
    'teams', jsonb_build_array(jsonb_build_array(), jsonb_build_array()),
    'draftReserve', jsonb_build_array(130, 130)
  );

  insert into public.rooms(code, host_user_id, state)
  values (p_code, auth.uid(), v_state)
  returning * into v_room;

  return v_room.state;
end;
$$;

create or replace function public.join_room(p_code text, p_nickname text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.rooms;
  v_players jsonb;
  v_points jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(trim(p_nickname)) not between 1 and 32 then raise exception 'Invalid nickname'; end if;

  select * into v_room from public.rooms where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Room not found'; end if;

  v_players := coalesce(v_room.state->'players', '[]'::jsonb);
  if not exists (
    select 1 from jsonb_array_elements_text(v_players) p
    where lower(p) = lower(trim(p_nickname))
  ) then
    if jsonb_array_length(v_players) >= 10 then raise exception 'Room is full'; end if;
    v_players := v_players || jsonb_build_array(trim(p_nickname));
  end if;

  v_points := coalesce(v_room.state->'points', '{}'::jsonb);
  if not (v_points ? trim(p_nickname)) then
    v_points := v_points || jsonb_build_object(trim(p_nickname), 0);
  end if;

  update public.rooms
  set state = jsonb_set(jsonb_set(v_room.state, '{players}', v_players), '{points}', v_points),
      updated_at = now()
  where code = v_room.code
  returning * into v_room;

  return v_room.state;
end;
$$;

create or replace function public.update_room_state(p_code text, p_state jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_room public.rooms;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_room from public.rooms where code = upper(trim(p_code)) for update;
  if not found then raise exception 'Room not found'; end if;
  if v_room.host_user_id <> auth.uid() then raise exception 'Only the room host can change the room'; end if;
  if p_state->>'code' <> v_room.code then raise exception 'Room code mismatch'; end if;

  update public.rooms set state = p_state, updated_at = now()
  where code = v_room.code returning * into v_room;

  return v_room.state;
end;
$$;

grant usage on schema public to authenticated;
grant select on public.rooms to authenticated;
grant execute on function public.create_room(text, text) to authenticated;
grant execute on function public.join_room(text, text) to authenticated;
grant execute on function public.update_room_state(text, jsonb) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null;
end $$;
