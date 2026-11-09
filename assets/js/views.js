import { html, nothing } from '../vendor/lit-html.js';
import { isHost, draftClock } from './main.js';
import { predict } from './prediction.js';

const ATTRS = [['str', 'Сила'], ['agi', 'Ловкость'], ['int', 'Интеллект'], ['all', 'Универсальные']];
const STAGES = [['lobby', 'Лобби'], ['captains', 'Капитаны'], ['squads', 'Составы'], ['coin', 'Монетка'], ['draft', 'Драфт'], ['result', 'Итог']];

// Призы за места. Картинки лежат в assets/prizes.
const PRIZES = [
  { place: 1, title: '500 ₽', note: 'на Steam', icon: 'assets/prizes/steam-gift.svg' },
  { place: 2, title: 'Discord Nitro', icon: 'assets/prizes/discord-nitro.svg' },
  { place: 3, title: 'Wyrmwrought Flare', note: 'Предмет на Lina', icon: 'assets/prizes/lina-wyrmwrought-flare.png' },
];

const nick = (r, id) => r.players.find(p => p.id === id)?.nick ?? '—';
const teamName = (r, t) => nick(r, r.captains[t]);
const heroOf = (app, id) => app.heroes.get(id);
const cls = (...parts) => parts.filter(Boolean).join(' ');
const mmss = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function appView(app, a) {
  if (!app.ready) return html`<p class="boot">Загружаем турнир…</p>`;
  if (app.fatal) return html`<p class="boot">${app.fatal}</p>`;
  return html`
    ${header(app, a)}
    <main class=${cls('page', app.room && 'in-room')}>
      ${app.room ? roomView(app, a) : homeView(app, a)}
    </main>
    ${app.error ? html`<div class="toast" role="alert"><span>${app.error}</span><button class="link" @click=${a.dismissError}>Закрыть</button></div>` : nothing}
    ${app.overlay === 'rules' ? rulesOverlay(a) : nothing}
    ${app.overlay === 'scores' ? scoresOverlay(app, a) : nothing}
    ${app.overlay === 'admin' ? adminOverlay(app, a) : nothing}
    ${app.confirm ? confirmOverlay(app, a) : nothing}
  `;
}

function header(app, a) {
  return html`<header class="bar">
    <div class="bar-left">
      <div class="brand"><span>The</span> Daunational <b>2</b></div>
      <nav class="bar-nav">
        <button class="link" @click=${a.openRules}>Формат</button>
        <button class="link" @click=${a.openScores}>Таблица</button>
      </nav>
    </div>
    ${app.room ? html`<div class="bar-right">
      <span class=${cls('sync', app.live && 'on')} title=${app.live ? 'Обновления в реальном времени' : 'Подключаемся, данные обновляются раз в 3 секунды'}></span>
      <button class="link dim" @click=${a.exit}>Выйти</button>
    </div>` : nothing}
  </header>`;
}

/* ---------- Главная ---------- */

function homeBoard(app) {
  const list = [...app.heroes.values()];
  const rows = ATTRS.flatMap(([k]) => list.filter(h => h.attr === k).slice(3, 10));
  const banned = new Set([2, 9, 15, 20, 24]), first = new Set([5, 12]), second = new Set([17, 26]);
  return html`<div class="demo-board" aria-hidden="true">
    ${rows.map((h, i) => html`<div class=${cls('demo-tile', banned.has(i) && 'banned', first.has(i) && 'pick-a', second.has(i) && 'pick-b')}><img src=${h.img} alt=""></div>`)}
  </div>`;
}

function homeView(app, a) {
  const submit = e => { e.preventDefault(); e.submitter?.value === 'create' ? a.create() : a.join(); };
  return html`<section class="home">
    <div class="home-copy">
      <p class="eyebrow">Закрытый турнир · Turbo · Captains Draft</p>
      <h1 class="title"><span>The</span> Daunational <b>2</b></h1>
      <p class="lead">Десять друзей, два капитана, монетка и 28 героев на доске. Всё остальное решается в игре.</p>
      <form class="entry" @submit=${submit}>
        <label class="field"><span>Твой ник в Dota 2</span>
          <input maxlength="24" autocomplete="nickname" placeholder="Ник" .value=${app.nick} @input=${e => a.setNick(e.target.value)}>
        </label>
        <label class="field"><span>Код комнаты</span>
          <input class="code" maxlength="6" autocomplete="off" placeholder="ABC123" .value=${app.codeInput} @input=${e => a.setCode(e.target.value)}>
        </label>
        <button class="btn primary" value="join" ?disabled=${app.busy}>Войти</button>
        <p class="entry-or">Нет кода? <button class="link strong" value="create" ?disabled=${app.busy}>Создать комнату</button></p>
      </form>
      <p class="hint">Очки записываются на ник, поэтому пиши его так же, как в игре.</p>
    </div>
    <div class="home-side">
      ${gameCard(app, a)}
      ${homeBoard(app)}
    </div>
  </section>`;
}

function gameDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return {
    day: date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }),
    weekday: date.toLocaleDateString('ru-RU', { weekday: 'long' }),
  };
}

function gameCard(app, a) {
  const g = app.game;
  const game = g?.game;
  const players = g?.players || [];
  const limit = g?.limit || 10;
  const mine = players.some(p => p.mine);
  const full = players.length >= limit;
  const when = game ? gameDate(game.date) : null;
  const onJoin = e => { e.preventDefault(); a.joinGame(); };
  return html`<section class="game-card">
    <div class="game-head">
      <div>
        <p class="eyebrow">Ближайшая игра</p>
        ${when
          ? html`<p class="game-date">${when.day}</p><p class="game-when">${when.weekday}${game.time ? `, ${game.time} UTC+3 (мск)` : ''}</p>`
          : html`<p class="game-date">Дата скоро</p><p class="game-when">Организатор объявит дату здесь</p>`}
      </div>
      ${game ? html`<span class=${cls('game-count', full && 'full')}>${players.length} / ${limit}</span>` : nothing}
    </div>
    ${game ? html`
      <ol class="game-slots">
        ${players.map((p, i) => html`<li class=${cls('game-slot', p.mine && 'mine')}>
          <i>${i + 1}</i><span>${p.nick}</span>
          ${app.adminPin ? html`<button class="x" aria-label=${'Убрать ' + p.nick} @click=${() => a.adminRemovePlayer(p.nick)}>×</button>` : nothing}
        </li>`)}
        ${Array.from({ length: Math.max(0, limit - players.length) }, (_, i) => html`<li class="game-slot empty"><i>${players.length + i + 1}</i><span>Свободно</span></li>`)}
      </ol>
      ${mine ? html`<div class="game-action">
          <p class="game-status">Ты в стаке</p>
          <button class="btn ghost" ?disabled=${app.busy} @click=${a.leaveGame}>Выйти из стака</button>
        </div>`
      : full ? html`<p class="game-status">Стак собран, все места заняты</p>`
      : html`<form class="game-join" @submit=${onJoin}>
          <input maxlength="24" autocomplete="nickname" placeholder="Твой ник" aria-label="Твой ник" .value=${app.nick} @input=${e => a.setNick(e.target.value)}>
          <button class="btn primary" ?disabled=${app.busy}>Присоединиться</button>
        </form>`}
    ` : nothing}
    <button class="link dim game-admin" @click=${a.openAdmin}>${app.adminPin ? 'Управление игрой' : 'Организатор'}</button>
  </section>`;
}

/* ---------- Комната ---------- */

function roomView(app, a) {
  const r = app.room;
  const stage = r.stage === 'finished' ? 'result' : r.stage;
  const at = STAGES.findIndex(([k]) => k === stage);
  return html`
    <ol class=${cls('rail', stage === 'draft' && 'compact')}>
      ${STAGES.map(([k, label], i) => html`<li class=${cls(i < at && 'done', i === at && 'now')}>${label}</li>`)}
    </ol>
    ${{ lobby: lobbyView, captains: captainsView, squads: squadsView, coin: coinView, draft: draftView, result: resultView }[stage](app, a)}
  `;
}

function lobbyView(app, a) {
  const r = app.room, host = isHost(), n = r.players.length;
  const ready = n >= 2 && n % 2 === 0;
  const onAdd = e => { e.preventDefault(); const f = e.target.elements.bot; a.addBot(f.value); f.value = ''; };
  return html`<section class="stage">
    <div class="stage-head">
      <div>
        <p class="eyebrow">Код комнаты</p>
        <p class="room-code">${r.code}</p>
      </div>
      <button class="btn" @click=${a.copyLink}>${app.copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}</button>
    </div>
    <div class="section-title"><h2>Игроки</h2><span class="count">${n} / 10</span></div>
    <ul class="slots">
      ${r.players.map(p => html`<li class=${cls('slot', p.id === app.uid && 'mine')}>
        <span class="slot-name">${p.nick}</span>
        ${p.id === r.hostId ? html`<em>Организатор</em>` : p.bot ? html`<em>Бот</em>` : nothing}
        ${host && p.id !== r.hostId ? html`<button class="x" aria-label=${'Убрать ' + p.nick} @click=${() => a.kick(p.id)}>×</button>` : nothing}
      </li>`)}
      ${Array.from({ length: Math.max(0, 10 - n) }, () => html`<li class="slot empty">Свободно</li>`)}
    </ul>
    ${host ? html`
      <div class="controls">
        <button class="btn primary" ?disabled=${!ready || app.busy} @click=${a.toCaptains}>К выбору капитанов</button>
        ${n < 10 ? html`<button class="btn" ?disabled=${app.busy} @click=${a.fillBots}>Заполнить ботами</button>` : nothing}
        <form class="inline" @submit=${onAdd}><input name="bot" maxlength="24" placeholder="Имя бота"><button class="btn">Добавить</button></form>
      </div>
      ${!ready ? html`<p class="hint">Для старта нужно чётное число игроков.</p>` : nothing}
      ${r.players.some(p => p.bot) ? html`<p class="hint">Комната с ботами считается тестовой: очки в ней не начисляются.</p>` : nothing}
    ` : html`<p class="waiting">Ждём, пока организатор запустит игру.</p>`}
  </section>`;
}

function captainsView(app, a) {
  const r = app.room, host = isHost(), picked = app.pickedCaptains;
  return html`<section class="stage">
    <div class="section-title"><h2>Капитаны</h2></div>
    ${host ? html`<p class="sub">Выбери двух игроков: первый возглавит команду 1, второй команду 2.</p>` : html`<p class="waiting">Организатор выбирает капитанов.</p>`}
    <ul class="slots">
      ${r.players.map(p => {
        const at = picked.indexOf(p.id);
        return html`<li><button class=${cls('slot pickable', at >= 0 && 't' + at, at >= 0 && 'chosen')} ?disabled=${!host} @click=${() => a.toggleCaptain(p.id)}>
          <span class="slot-name">${p.nick}</span>${at >= 0 ? html`<em>Команда ${at + 1}</em>` : nothing}
        </button></li>`;
      })}
    </ul>
    ${host ? html`<div class="controls">
      <button class="btn primary" ?disabled=${picked.length !== 2 || app.busy} @click=${a.saveCaptains}>Подтвердить</button>
      <button class="btn" ?disabled=${app.busy} @click=${a.randomCaptains}>Случайные капитаны</button>
      <button class="btn ghost" @click=${a.restart}>Назад в лобби</button>
    </div>` : nothing}
  </section>`;
}

function squadColumn(r, t, active) {
  return html`<div class=${cls('squad', 't' + t, active && 'active')}>
    <p class="eyebrow">Команда ${t + 1}</p>
    <h3>${teamName(r, t)}</h3>
    <ul>${r.squads[t].map((id, i) => html`<li>${nick(r, id)}${i === 0 ? html`<em>Капитан</em>` : nothing}</li>`)}</ul>
  </div>`;
}

function squadsView(app, a) {
  const r = app.room, turn = r.squadTurn, canPick = isHost() || r.captains[turn] === app.uid;
  const placed = new Set(r.squads.flat());
  const free = r.players.filter(p => !placed.has(p.id));
  return html`<section class="stage">
    <div class="section-title"><h2>Составы</h2><span class=${cls('turn-tag', 't' + turn)}>Выбирает ${teamName(r, turn)}</span></div>
    <div class="squads">
      ${squadColumn(r, 0, turn === 0)}
      <div class="squad-pool">
        <p class="eyebrow">Свободные игроки</p>
        <ul>${free.map(p => html`<li><button class="slot pickable" ?disabled=${!canPick || app.busy} @click=${() => a.pickPlayer(p.id)}><span class="slot-name">${p.nick}</span></button></li>`)}</ul>
      </div>
      ${squadColumn(r, 1, turn === 1)}
    </div>
    ${!canPick ? html`<p class="waiting">Сейчас выбирает ${teamName(r, turn)}.</p>` : nothing}
    ${isHost() ? html`<div class="controls"><button class="btn ghost" @click=${a.restart}>Сбросить в лобби</button></div>` : nothing}
  </section>`;
}

function coinView(app, a) {
  const r = app.room, canAct = isHost() || r.captains.includes(app.uid);
  const w = r.coin?.winner, spinning = app.coinSpinning, shown = r.coin && !spinning;
  return html`<section class="stage center">
    <div class="section-title"><h2>Монетка</h2></div>
    <div class="versus">
      <span class=${cls('vs-name t0', shown && w === 0 && 'won')}>${teamName(r, 0)}</span>
      <div class=${cls('coin', spinning && 'spin', shown && 'side-' + w)}>
        <div class="face a">1</div><div class="face b">2</div>
      </div>
      <span class=${cls('vs-name t1', shown && w === 1 && 'won')}>${teamName(r, 1)}</span>
    </div>
    ${!r.coin ? html`<p class="sub">Монетка решит, кто начинает драфт героев.</p>` : nothing}
    ${shown ? html`<p class="verdict">Драфт начинает <strong class=${'t' + w}>${teamName(r, w)}</strong></p>` : nothing}
    <div class="controls center">
      ${canAct && !r.coin ? html`<button class="btn primary big" ?disabled=${app.busy} @click=${a.flipCoin}>Подбросить</button>` : nothing}
      ${canAct && shown ? html`<button class="btn primary big" ?disabled=${app.busy} @click=${a.startDraft}>Открыть доску героев</button>` : nothing}
      ${!canAct && !shown ? html`<p class="waiting">Монетку бросает капитан или организатор.</p>` : nothing}
      ${!canAct && shown ? html`<p class="waiting">Капитаны открывают доску героев.</p>` : nothing}
    </div>
  </section>`;
}

/* ---------- Драфт ---------- */

function teamPanel(app, t, d, stepTeam) {
  const r = app.room;
  const slots = type => d.order.map((o, i) => ({ ...o, i })).filter(o => o.t === t && o.a === type);
  const heroAt = i => d.actions[i] ? heroOf(app, d.actions[i].hero) : null;
  const isNow = i => i === d.idx;
  return html`<aside class=${cls('team', 't' + t, stepTeam === t && 'active')}>
    <div class="team-head">
      <p class="eyebrow">Команда ${t + 1}</p>
      <h3>${teamName(r, t)}</h3>
      <p class="reserve">Резерв <b>${mmss(reserveOf(d, t))}</b></p>
    </div>
    <div class="picks">
      ${slots('pick').map(o => { const h = heroAt(o.i); return html`<div class=${cls('pick-slot', isNow(o.i) && 'now')}>${h ? html`<img src=${h.img} alt=${h.name}><span>${h.name}</span>` : nothing}</div>`; })}
    </div>
    <div class="bans">
      ${slots('ban').map(o => { const h = heroAt(o.i); return html`<div class=${cls('ban-slot', isNow(o.i) && 'now', d.actions[o.i] && !h && 'skipped')}>${h ? html`<img src=${h.img} alt=${'Бан: ' + h.name} title=${h.name}>` : nothing}</div>`; })}
    </div>
    <ul class="roster">${r.squads[t].map(id => html`<li>${nick(r, id)}</li>`)}</ul>
  </aside>`;
}

function reserveOf(d, t) {
  const step = d.order[d.idx];
  if (step?.t !== t) return d.reserve[t];
  return draftClock(d).reserve;
}

// Порядок драфта: по дорожке на команду, столбцы идут слева направо по очереди ходов.
function timeline(app, d) {
  const r = app.room;
  const phases = [];
  d.order.forEach((o, i) => {
    const last = phases[phases.length - 1];
    if (last && last.a === o.a) last.n++;
    else phases.push({ a: o.a, start: i, n: 1 });
  });
  const stepCell = (o, i) => {
    const x = d.actions[i], h = x?.hero ? heroOf(app, x.hero) : null;
    const word = o.a === 'ban' ? 'Бан' : 'Пик';
    return html`<div class=${cls('tl-step', 't' + o.t, o.a === 'ban' ? 'is-ban' : 'is-pick', x && 'done', i === d.idx && 'now')}
      style=${`grid-column:${i + 2};grid-row:${o.t + 2}`} title=${`${i + 1}. ${teamName(r, o.t)}: ${word.toLowerCase()}`}>
      ${h ? html`<img src=${h.img} alt=${h.name}>` : x ? html`<i class="tl-skip">—</i>` : html`<i class="tl-word">${word}</i><i class="tl-sign">${o.a === 'ban' ? '×' : '+'}</i>`}
    </div>`;
  };
  return html`<div class="tl" style=${`--steps:${d.order.length}`} role="img" aria-label="Порядок банов и пиков">
    ${phases.map(p => html`<div class=${cls('tl-phase', p.a === 'ban' ? 'is-ban' : 'is-pick', d.idx >= p.start && d.idx < p.start + p.n && 'current')}
      style=${`grid-column:${p.start + 2} / span ${p.n}`}>${p.a === 'ban' ? 'Баны' : 'Пики'}</div>`)}
    ${[0, 1].map(t => html`
      <div class=${'tl-lane t' + t} style=${`grid-row:${t + 2}`}></div>
      <div class=${'tl-team t' + t} style=${`grid-row:${t + 2}`}><span class="tl-nick">${teamName(r, t)}</span><span class="tl-num">${t + 1}</span></div>
    `)}
    ${d.order.map(stepCell)}
  </div>`;
}

function draftView(app, a) {
  const r = app.room, d = r.draft;
  const step = d.order[d.idx];
  const next = d.order[d.idx + 1];
  const clock = draftClock(d);
  const captainId = r.captains[step.t];
  const isCaptain = captainId === app.uid;
  const canAct = isCaptain || isHost();
  const verb = step.a === 'ban' ? 'бан' : 'пик';

  const used = new Map();
  d.actions.forEach((x, i) => { if (x.hero) used.set(x.hero, d.order[i]); });
  const pool = d.pool.map(id => heroOf(app, id)).filter(Boolean);
  const sel = app.selectedHero ? heroOf(app, app.selectedHero) : null;
  const urgent = clock.inReserve ? clock.reserve <= 10 : clock.main <= 10;

  const tile = h => {
    const u = used.get(h.id);
    const state = u ? (u.a === 'ban' ? 'banned' : 'picked t' + u.t) : '';
    return html`<button class=${cls('hero', state, app.selectedHero === h.id && 'selected')}
      ?disabled=${!!u || !canAct} aria-label=${h.name} @click=${() => a.selectHero(h.id)}>
      <img src=${h.img} alt="" loading="eager"><span>${h.name}</span>
    </button>`;
  };

  return html`<section class="draft">
    <div class=${cls('turnbar', 't' + step.t, step.a === 'ban' && 'is-ban')}>
      <div class="turn-text">
        <p class="eyebrow">${step.a === 'ban' ? 'Фаза банов' : 'Фаза пиков'} · ход ${d.idx + 1} из ${d.order.length}</p>
        <h2>${isCaptain
          ? html`<span class="verb">Твой ход:</span> ${step.a === 'ban' ? 'забань героя' : 'выбери героя'}`
          : html`${teamName(r, step.t)} <span class="verb">${step.a === 'ban' ? 'банит' : 'пикает'}</span>`}</h2>
        <p class="turn-next">${next ? `Дальше: ${teamName(r, next.t)} · ${next.a === 'ban' ? 'бан' : 'пик'}` : 'Последний ход драфта'}</p>
      </div>
      <div class=${cls('timer', urgent && 'urgent', clock.inReserve && 'reserve-mode')} role="timer">
        <small>${clock.inReserve ? 'Резерв' : 'Время'}</small>
        <strong>${clock.inReserve ? mmss(clock.reserve) : clock.main}</strong>
      </div>
    </div>

    ${timeline(app, d)}

    <div class="arena">
      ${teamPanel(app, 0, d, step.t)}
      <div class="board-wrap">
        <div class="board">
          ${ATTRS.map(([k, label]) => html`<div class=${'attr attr-' + k}>
            <h4>${label}</h4>
            <div class="row">${pool.filter(h => h.attr === k).sort((x, y) => x.name.localeCompare(y.name)).map(tile)}</div>
          </div>`)}
        </div>
        <div class=${cls('dock', canAct && 'mine')}>
          ${canAct ? html`
            <p>${sel ? html`<b>${sel.name}</b>` : `Выбери героя на ${verb === 'бан' ? 'бан' : 'пик'}`}${!isCaptain ? html`<small>за капитана ${nick(r, captainId)}</small>` : nothing}</p>
            <button class=${cls('btn big', step.a === 'ban' ? 'danger' : 'primary')} ?disabled=${!sel || app.busy} @click=${a.confirmHero}>${step.a === 'ban' ? 'Забанить' : 'Пикнуть'}</button>
          ` : html`<p>Ходит ${nick(r, captainId)}</p>`}
        </div>
      </div>
      ${teamPanel(app, 1, d, step.t)}
    </div>
    ${isHost() ? html`<div class="controls end"><button class="btn ghost small" @click=${a.restart}>Сбросить игру</button></div>` : nothing}
  </section>`;
}

/* ---------- Итог ---------- */

function lineup(app, t, winner) {
  const r = app.room, d = r.draft;
  const take = type => d.order.map((o, i) => ({ o, x: d.actions[i] })).filter(({ o }) => o.t === t && o.a === type).map(({ x }) => heroOf(app, x?.hero)).filter(Boolean);
  return html`<div class=${cls('lineup', 't' + t, winner === t + 1 && 'winner')}>
    <div class="team-head">
      <p class="eyebrow">Команда ${t + 1}${winner === t + 1 ? ' · победа' : ''}</p>
      <h3>${teamName(r, t)}</h3>
    </div>
    <div class="final-picks">${take('pick').map(h => html`<figure><img src=${h.img} alt=""><figcaption>${h.name}</figcaption></figure>`)}</div>
    <div class="final-bans">${take('ban').map(h => html`<img src=${h.img} alt=${'Бан: ' + h.name} title=${h.name}>`)}</div>
    <ul class="roster">${r.squads[t].map(id => html`<li>${nick(r, id)}</li>`)}</ul>
  </div>`;
}

function predictionBlock(app) {
  const r = app.room, d = r.draft;
  const picks = t => d.order.flatMap((o, i) => (o.t === t && o.a === 'pick' && d.actions[i]?.hero ? [d.actions[i].hero] : []));
  const p = predict(app.winrates, picks(0), picks(1));
  if (!p) return nothing;
  const bestLine = id => `Лучший пик: ${heroOf(app, id).name}, ${Math.round(app.winrates.get(id) * 100)}% побед в Turbo`;
  return html`<div class="predict">
    <h3>Прогноз по драфту</h3>
    <div class="predict-sides">
      <div class="predict-side t0"><span class="predict-name">${teamName(r, 0)}</span><strong>${p.a}%</strong></div>
      <div class="predict-side t1"><strong>${p.b}%</strong><span class="predict-name">${teamName(r, 1)}</span></div>
    </div>
    <div class="predict-bar" role="img" aria-label=${`Шанс победы: ${p.a}% и ${p.b}%`}>
      <span class="t0" style=${`width:${p.a}%`}></span><span class="t1" style=${`width:${p.b}%`}></span>
    </div>
    <div class="predict-best"><span>${bestLine(p.bestA)}</span><span>${bestLine(p.bestB)}</span></div>
    <p class="hint">Оценка только по силе героев в Turbo. Как играют сами игроки, сайт не знает.</p>
  </div>`;
}

function resultView(app, a) {
  const r = app.room, host = isHost(), done = r.stage === 'finished';
  const res = r.result;
  const canFinish = app.winner && app.mvp && !app.busy;
  return html`<section class="stage">
    <div class="section-title"><h2>${done ? 'Игра завершена' : 'Драфт завершён'}</h2></div>
    ${!done ? html`<p class="sub">Создавайте лобби в Dota 2 с режимом Turbo и берите героев из этого драфта.</p>` : nothing}
    ${done ? html`<p class="verdict">Победила <strong class=${'t' + (res.winner - 1)}>команда ${teamName(r, res.winner - 1)}</strong>, MVP проигравших — <strong>${nick(r, res.mvp)}</strong>${res.scored ? ', очки начислены.' : '. Тестовая игра, очки не начислялись.'}</p>` : nothing}
    ${predictionBlock(app)}
    <div class="lineups">${lineup(app, 0, res?.winner)}${lineup(app, 1, res?.winner)}</div>

    ${!done && host ? html`<div class="result-form">
      <h3>Результат матча</h3>
      <div class="choice">
        ${[1, 2].map(w => html`<button class=${cls('slot pickable', 't' + (w - 1), app.winner === w && 'chosen')} @click=${() => a.setWinner(w)}><span class="slot-name">Победил ${teamName(r, w - 1)}</span></button>`)}
      </div>
      <h3>MVP проигравшей команды</h3>
      ${app.winner ? html`<div class="choice mvp">
        ${r.squads[2 - app.winner].map(id => html`<button class=${cls('slot pickable', app.mvp === id && 'chosen')} @click=${() => a.setMvp(id)}><span class="slot-name">${nick(r, id)}</span></button>`)}
      </div>` : html`<p class="sub">Сначала выбери победителя.</p>`}
      <p class="hint">Победа +100, поражение +40, MVP проигравших ещё +15.</p>
      <div class="controls"><button class="btn primary big" ?disabled=${!canFinish} @click=${a.finish}>Завершить и начислить очки</button></div>
    </div>` : nothing}
    ${!done && !host ? html`<p class="waiting">После матча организатор внесёт результат.</p>` : nothing}
    ${done && host ? html`<div class="controls"><button class="btn primary" ?disabled=${app.busy} @click=${a.nextGame}>Следующая игра этим составом</button></div>` : nothing}
  </section>`;
}

/* ---------- Окна ---------- */

function overlay(a, title, body) {
  return html`<div class="overlay" @click=${e => { if (e.target === e.currentTarget) a.closeOverlay(); }}>
    <div class="dialog" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="dialog-head"><h2>${title}</h2><button class="x" aria-label="Закрыть" @click=${a.closeOverlay}>×</button></div>
      ${body}
    </div>
  </div>`;
}

function rulesOverlay(a) {
  return overlay(a, 'Формат', html`<dl class="rules">
    <dt>Режим</dt><dd>Turbo. Герои определяются драфтом Captains Draft на этом сайте.</dd>
    <dt>Порядок</dt><dd>Лобби, капитаны, набор составов, монетка, драфт.</dd>
    <dt>Пул</dt><dd>Случайные 28 героев: по 7 силы, ловкости, интеллекта и универсальных.</dd>
    <dt>Драфт</dt><dd>У каждой команды 3 бана и 5 пиков. Начинает победитель монетки.</dd>
    <dt>Время</dt><dd>30 секунд на ход и 130 секунд резерва на команду. Если время вышло, бан пропадает, а пик выбирается случайно.</dd>
    <dt>Очки</dt><dd>Победа +100, поражение +40. MVP выбирается из проигравшей команды и получает ещё +15. Очки суммируются между играми.</dd>
    <dt>Ник</dt><dd>Один на весь турнир: очки записываются на него. Под другим ником очки не сложатся.</dd>
    <dt>Возврат</dt><dd>Вылетел или сменил устройство — введи свой ник и код комнаты и подтверди, что это ты.</dd>
  </dl>${prizesBlock()}`);
}

function prizesBlock() {
  return html`<section class="prizes">
    <h3>Призы</h3>
    <ol>${PRIZES.map(p => html`<li class=${'prize place-' + p.place}>
      <img class="prize-icon" src=${p.icon} alt="">
      <div class="prize-text">
        <strong>${p.place} место</strong>
        <span class="prize-title">${p.title}</span>
        ${p.note ? html`<span class="prize-note">${p.note}</span>` : nothing}
      </div>
    </li>`)}</ol>
  </section>`;
}

function rowName(i, name) {
  const p = PRIZES[i];
  return html`<span class="row-name">${name}${p ? html`<img class="prize-mini" src=${p.icon} alt=${'Приз: ' + p.title} title=${p.title}>` : nothing}</span>`;
}

function scoresOverlay(app, a) {
  const rows = app.scores || [];
  const vacant = Array.from({ length: Math.max(0, PRIZES.length - rows.length) }, (_, i) => rows.length + i + 1);
  const placeClass = i => (i < PRIZES.length ? 'place-' + (i + 1) : '');
  const table = html`<div class="table-wrap"><table class="scores">
      <thead><tr><th>#</th><th>Игрок</th><th>Очки</th><th>Игры</th><th>Победы</th><th>MVP</th></tr></thead>
      <tbody>
        ${rows.map((p, i) => html`<tr class=${placeClass(i)}><td>${i + 1}</td><td class="n">${rowName(i, p.nickname)}</td><td class="pts">${p.total_points}</td><td>${p.games_played}</td><td>${p.wins}</td><td>${p.mvp_awards}</td></tr>`)}
        ${vacant.map(n => html`<tr class=${placeClass(n - 1) + ' vacant'}><td>${n}</td><td class="n">${rowName(n - 1, 'Место свободно')}</td><td>—</td><td>—</td><td>—</td><td>—</td></tr>`)}
      </tbody>
    </table></div>`;
  const note = app.scoresError ? app.scoresError
    : !app.scores ? 'Загружаем…'
    : !rows.length ? 'Завершённых игр пока нет.'
    : '';
  return overlay(a, 'Турнирная таблица', html`
    ${prizesBlock()}
    ${app.scoresError ? nothing : table}
    ${note ? html`<p class="hint">${note}</p>` : nothing}
  `);
}

function adminOverlay(app, a) {
  if (!app.adminPin) {
    const unlock = e => { e.preventDefault(); a.adminUnlock(e.target.elements.pin.value.trim()); };
    return overlay(a, 'Организатор', html`<form class="admin-form" @submit=${unlock}>
      <label class="field"><span>PIN организатора</span><input name="pin" type="password" autocomplete="off" required></label>
      <div class="controls end"><button class="btn primary" ?disabled=${app.busy}>Войти</button></div>
    </form>`);
  }
  const game = app.game?.game;
  const save = e => { e.preventDefault(); const f = e.target.elements; a.adminSave(f.date.value, f.time.value); };
  return overlay(a, 'Управление игрой', html`<form class="admin-form" @submit=${save}>
    <div class="admin-row">
      <label class="field"><span>Дата игры</span><input name="date" type="date" required .value=${game?.date || ''}></label>
      <label class="field"><span>Время UTC+3, мск (необязательно)</span><input name="time" type="time" .value=${game?.time || ''}></label>
    </div>
    <p class="hint">Если дата уже назначена, список игроков при её смене сохранится.</p>
    <div class="controls end"><button class="btn primary" ?disabled=${app.busy}>Сохранить</button></div>
  </form>
  ${game ? html`<div class="controls">
    <button class="btn ghost small" ?disabled=${app.busy} @click=${a.adminClearList}>Очистить список</button>
    <button class="btn ghost small" ?disabled=${app.busy} @click=${a.adminRemoveGame}>Снять игру</button>
  </div>` : nothing}
  <div class="controls end"><button class="link dim" @click=${a.adminLock}>Выйти из режима организатора</button></div>`);
}

function confirmOverlay(app, a) {
  return html`<div class="overlay"><div class="dialog small" role="alertdialog" aria-modal="true">
    ${app.confirm.title ? html`<h2 class="confirm-title">${app.confirm.title}</h2>` : nothing}
    ${app.confirm.highlight ? html`<p class="confirm-nick">${app.confirm.highlight}</p>` : nothing}
    <p class="confirm-text">${app.confirm.text}</p>
    <div class="controls end">
      <button class="btn ghost" @click=${a.confirmNo}>${app.confirm.noLabel || 'Отмена'}</button>
      <button class="btn primary" @click=${a.confirmYes}>${app.confirm.yesLabel}</button>
    </div>
  </div></div>`;
}
