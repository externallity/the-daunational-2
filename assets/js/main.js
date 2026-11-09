import { render } from '../vendor/lit-html.js';
import * as api from './api.js';
import { appView } from './views.js';

const ROOM_KEY = 'dn2.room';
const NICK_KEY = 'dn2.nick';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  del: k => { try { localStorage.removeItem(k); } catch { /* приватный режим */ } },
};

// Единственный источник правды для интерфейса.
export const app = {
  uid: null,
  ready: false,
  fatal: '',
  heroes: new Map(),
  room: null,
  live: false,
  busy: false,
  error: '',
  toast: '',
  overlay: null,
  confirm: null,
  scores: null,
  scoresError: '',
  nick: store.get(NICK_KEY) || '',
  codeInput: new URLSearchParams(location.search).get('room')?.toUpperCase() || '',
  pickedCaptains: [],
  selectedHero: null,
  winner: null,
  mvp: null,
  coinSpinning: false,
  clockOffset: 0,
  copied: false,
};

let unsubscribe = null;
let pollTimer = null;
let frameQueued = false;
let timeoutSentFor = { idx: -1, at: 0 };

export function draw() {
  if (frameQueued) return;
  frameQueued = true;
  requestAnimationFrame(() => {
    frameQueued = false;
    render(appView(app, actions), document.getElementById('app'));
  });
}

export const isHost = () => !!app.room && app.room.hostId === app.uid;

function applyState(next) {
  if (!next || next.v !== 2) return;
  if (next.serverNow) app.clockOffset = Date.parse(next.serverNow) - Date.now();
  const prev = app.room;
  if (prev && next.rev < prev.rev) return;

  if (prev && !prev.coin && next.coin) {
    app.coinSpinning = true;
    setTimeout(() => { app.coinSpinning = false; draw(); }, 1900);
  }
  if (prev?.draft?.idx !== next.draft?.idx) app.selectedHero = null;
  if (next.stage !== 'result') { app.winner = null; app.mvp = null; }
  if (next.stage !== 'captains') app.pickedCaptains = [];

  app.room = next;
  draw();
}

async function sync() {
  if (!app.room) return;
  try { applyState(await api.getRoom(app.room.code)); } catch (e) { console.warn(e); }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(sync, app.live ? 15000 : 3000);
}

function enterRoom(state) {
  app.room = null;
  applyState(state);
  store.set(ROOM_KEY, state.code);
  history.replaceState(null, '', '?room=' + state.code);
  unsubscribe?.();
  unsubscribe = api.subscribeRoom(state.code, applyState, live => {
    app.live = live;
    startPolling();
    if (live) sync();
  });
  startPolling();
}

function leaveRoomLocal() {
  unsubscribe?.();
  unsubscribe = null;
  clearInterval(pollTimer);
  store.del(ROOM_KEY);
  history.replaceState(null, '', location.pathname);
  app.room = null;
  app.live = false;
  app.error = '';
  draw();
}

async function run(task) {
  if (app.busy) return;
  app.busy = true;
  app.error = '';
  draw();
  try {
    await task();
  } catch (e) {
    console.error(e);
    app.error = api.errorText(e);
    sync();
  } finally {
    app.busy = false;
    draw();
  }
}

const act = (name, args) => run(async () => applyState(await api.roomAction(app.room.code, name, args)));

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

function ask(text, yesLabel, onYes) {
  app.confirm = { text, yesLabel, onYes };
  draw();
}

export const actions = {
  setNick: v => { app.nick = v; },
  setCode: v => { app.codeInput = v.toUpperCase(); },

  create() {
    const nick = app.nick.trim();
    if (!nick) { app.error = 'Сначала укажи ник.'; draw(); return; }
    store.set(NICK_KEY, nick);
    run(async () => enterRoom(await api.createRoom(randomCode(), nick)));
  },
  join() {
    const nick = app.nick.trim(), code = app.codeInput.trim();
    if (!nick || !code) { app.error = 'Нужны ник и код комнаты.'; draw(); return; }
    store.set(NICK_KEY, nick);
    run(async () => enterRoom(await api.joinRoom(code, nick)));
  },
  exit() {
    const canLeave = app.room.stage === 'lobby' && !isHost();
    ask(canLeave ? 'Выйти из комнаты? Твоё место освободится.' : 'Выйти на главную? Вернуться можно по коду комнаты.', 'Выйти', () => {
      if (canLeave) api.roomAction(app.room.code, 'leave').catch(console.warn).finally(leaveRoomLocal);
      else leaveRoomLocal();
    });
  },
  async copyLink() {
    const link = `${location.origin}${location.pathname}?room=${app.room.code}`;
    try { await navigator.clipboard.writeText(link); app.copied = true; }
    catch { window.prompt('Скопируй ссылку:', link); }
    draw();
    setTimeout(() => { app.copied = false; draw(); }, 1600);
  },

  addBot: nick => { if (nick.trim()) act('add_bot', { nick: nick.trim() }); },
  fillBots: () => act('fill_bots'),
  kick: id => act('kick', { id }),
  toCaptains: () => act('to_captains'),
  restart() {
    ask('Вернуть всех в лобби? Текущий прогресс игры будет сброшен.', 'Сбросить', () => act('restart'));
  },
  nextGame: () => act('restart'),

  toggleCaptain(id) {
    const list = app.pickedCaptains;
    app.pickedCaptains = list.includes(id) ? list.filter(x => x !== id) : [...list, id].slice(-2);
    draw();
  },
  saveCaptains: () => act('set_captains', { a: app.pickedCaptains[0], b: app.pickedCaptains[1] }),
  randomCaptains: () => act('set_captains', { random: true }),
  pickPlayer: id => act('pick_player', { id }),
  flipCoin: () => act('flip_coin'),
  startDraft: () => act('start_draft'),

  selectHero: id => { app.selectedHero = app.selectedHero === id ? null : id; draw(); },
  confirmHero: () => act('draft', { hero: app.selectedHero, idx: app.room.draft.idx }),

  setWinner: w => { app.winner = w; draw(); },
  setMvp: id => { app.mvp = id; draw(); },
  finish: () => run(async () => applyState(await api.finishRoom(app.room.code, app.winner, app.mvp))),

  openRules: () => { app.overlay = 'rules'; draw(); },
  async openScores() {
    app.overlay = 'scores';
    app.scores = null;
    app.scoresError = '';
    draw();
    try { app.scores = await api.getScores(); }
    catch (e) { app.scoresError = api.errorText(e); }
    draw();
  },
  closeOverlay: () => { app.overlay = null; draw(); },
  dismissError: () => { app.error = ''; draw(); },
  confirmYes() { const f = app.confirm?.onYes; app.confirm = null; draw(); f?.(); },
  confirmNo: () => { app.confirm = null; draw(); },
};

// Часы драфта. Источник времени — сервер, клиент только показывает остаток.
export function draftClock(d) {
  const team = d.order[d.idx]?.t ?? 0;
  const elapsed = (Date.now() + app.clockOffset - Date.parse(d.turnStartedAt)) / 1000;
  const main = d.turnSeconds - elapsed;
  if (main > 0) return { main: Math.ceil(main), inReserve: false, reserve: d.reserve[team], expired: false };
  const left = d.reserve[team] + main;
  return { main: 0, inReserve: true, reserve: Math.max(0, Math.ceil(left)), expired: left <= 0 };
}

// Истёкший ход закрывает любой участник: драфт не зависит от вкладки организатора.
function tick() {
  const r = app.room;
  if (r?.stage !== 'draft') return;
  draw();
  if (!draftClock(r.draft).expired) return;
  const idx = r.draft.idx, now = Date.now();
  if (timeoutSentFor.idx === idx && now - timeoutSentFor.at < 3000) return;
  timeoutSentFor = { idx, at: now };
  api.roomAction(r.code, 'timeout', { idx }).then(applyState).catch(e => { if (!api.isSilent(e)) console.warn(e); });
}

async function boot() {
  document.getElementById('app').replaceChildren();
  try {
    const list = await fetch('heroes.json').then(r => { if (!r.ok) throw new Error('heroes'); return r.json(); });
    app.heroes = new Map(list.map(h => [h.id, h]));
    app.uid = await api.signIn();
    const code = app.codeInput || store.get(ROOM_KEY);
    if (code) {
      try {
        const state = await api.getRoom(code);
        if (state.players.some(p => p.id === app.uid)) enterRoom(state);
        else if (!app.codeInput) store.del(ROOM_KEY);
      } catch (e) {
        store.del(ROOM_KEY);
        if (app.codeInput) app.error = api.errorText(e);
      }
    }
  } catch (e) {
    console.error(e);
    app.fatal = 'Не удалось подключиться к серверу турнира. Обнови страницу.';
  }
  app.ready = true;
  draw();
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && (app.overlay || app.confirm)) { app.overlay = null; app.confirm = null; draw(); }
});
setInterval(tick, 250);
boot();
