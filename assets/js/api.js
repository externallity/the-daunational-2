// Клиент Supabase. Publishable key рассчитан на браузер: доступ ограничен RLS
// и проверками внутри SQL-функций. service_role здесь быть не должно.
const SUPABASE_URL = 'https://wyjllrldtgclhkdwwhqu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_4bDnw5Ikz8Xi5r-6EFiLKQ_OCaFRi4M';

const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const ERRORS = {
  AUTH_REQUIRED: 'Нет сессии. Обнови страницу.',
  ROOM_NOT_FOUND: 'Комната с таким кодом не найдена.',
  ROOM_OUTDATED: 'Это комната старого формата. Создай новую.',
  ROOM_FULL: 'В комнате уже 10 игроков.',
  NICK_TAKEN: 'Этот ник уже занят в комнате.',
  NO_SEAT: 'Игрока с таким ником в комнате нет.',
  BAD_MVP: 'MVP выбирается из проигравшей команды.',
  BAD_PIN: 'Неверный PIN организатора.',
  GAME_FULL: 'Стак уже собран: все 10 мест заняты.',
  ALREADY_IN: 'Ты уже в списке на эту игру.',
  NO_GAME: 'Дата игры пока не назначена.',
  BAD_DATE: 'Укажи дату игры.',
  BAD_NICK: 'Ник должен быть от 1 до 24 символов.',
  ALREADY_STARTED: 'Игра в этой комнате уже началась.',
  NOT_MEMBER: 'Ты не участник этой комнаты.',
  FORBIDDEN: 'Это действие тебе недоступно.',
  NOT_YOUR_TURN: 'Сейчас ход другого капитана.',
  NEED_EVEN_PLAYERS: 'Нужно чётное число игроков, минимум двое.',
  HERO_USED: 'Этот герой уже занят.',
  BAD_CAPTAINS: 'Нужны два разных капитана.',
  WRONG_STAGE: 'Этап уже сменился. Состояние обновлено.',
  STALE: 'Ход уже сделан. Состояние обновлено.',
};

export function errorText(e) {
  const msg = e?.message || '';
  const code = Object.keys(ERRORS).find(k => msg.includes(k));
  if (code) return ERRORS[code];
  if (/Could not find|schema cache/i.test(msg)) return 'База ещё не обновлена: выполни supabase/schema.sql в Supabase.';
  if (/fetch|network/i.test(msg)) return 'Нет связи с сервером. Проверь интернет.';
  return msg || 'Что-то пошло не так.';
}

export const isSilent = e => /NOT_EXPIRED|STALE/.test(e?.message || '');

export async function signIn() {
  const { data: { session }, error } = await db.auth.getSession();
  if (error) throw error;
  if (session) return session.user.id;
  const res = await db.auth.signInAnonymously();
  if (res.error) throw res.error;
  return res.data.user.id;
}

async function rpc(fn, args) {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw error;
  return data;
}

export const createRoom = (code, nick) => rpc('create_room', { p_code: code, p_host_nickname: nick });
export const joinRoom = (code, nick) => rpc('join_room', { p_code: code, p_nickname: nick });
export const reclaimSeat = (code, nick) => rpc('reclaim_seat', { p_code: code, p_nickname: nick });
export const getRoom = code => rpc('get_room', { p_code: code });
export const roomAction = (code, action, args = {}) => rpc('room_action', { p_code: code, p_action: action, p_args: args });
export const finishRoom = (code, winner, mvp) => rpc('finish_room', { p_code: code, p_winner: winner, p_mvp: mvp });

export const getNextGame = () => rpc('get_next_game', {});
export const joinGame = nick => rpc('join_game', { p_nick: nick });
export const leaveGame = () => rpc('leave_game', {});
export const adminCheck = pin => rpc('admin_check', { p_pin: pin });
export const adminSetGame = (pin, date, time) => rpc('admin_set_game', { p_pin: pin, p_date: date, p_time: time || null });
export const adminClearGame = (pin, keepGame) => rpc('admin_clear_game', { p_pin: pin, p_keep_game: keepGame });
export const adminRemoveSignup = (pin, nick) => rpc('admin_remove_signup', { p_pin: pin, p_nick: nick });

export async function getScores() {
  const { data, error } = await db.from('tournament_scores')
    .select('nickname,total_points,wins,losses,mvp_awards,games_played')
    .order('total_points', { ascending: false })
    .order('nickname');
  if (error) throw error;
  return data;
}

export function subscribeRoom(code, onState, onStatus) {
  const channel = db.channel('room-' + code)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: 'code=eq.' + code },
      payload => onState(payload.new.state))
    .subscribe(status => onStatus(status === 'SUBSCRIBED'));
  return () => db.removeChannel(channel);
}
