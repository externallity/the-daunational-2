import { html, nothing } from '../vendor/lit-html.js';
import { isHost, draftClock } from './main.js';

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
    ${homeBoard(app)}
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

function draftView(app, a) {
  const r = app.room, d = r.draft;
  const step = d.order[d.idx];
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
        <p class="eyebrow">Ход ${d.idx + 1} из ${d.order.length}</p>
        <h2><span class="verb">${verb}</span> ${teamName(r, step.t)}</h2>
      </div>
      <div class=${cls('timer', urgent && 'urgent', clock.inReserve && 'reserve-mode')} role="timer">
        <small>${clock.inReserve ? 'Резерв' : 'Время'}</small>
        <strong>${clock.inReserve ? mmss(clock.reserve) : clock.main}</strong>
      </div>
    </div>

    <ol class="strip" aria-label="Порядок драфта">
      ${d.order.map((o, i) => {
        const x = d.actions[i], h = x?.hero ? heroOf(app, x.hero) : null;
        return html`<li class=${cls('cell', 't' + o.t, o.a, i === d.idx && 'now', x && 'done')}>
          ${h ? html`<img src=${h.img} alt="">` : html`<i>${o.a === 'ban' ? 'Б' : 'П'}</i>`}
        </li>`;
      })}
    </ol>

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

function resultView(app, a) {
  const r = app.room, host = isHost(), done = r.stage === 'finished';
  const res = r.result;
  const canFinish = app.winner && app.mvp && !app.busy;
  return html`<section class="stage">
    <div class="section-title"><h2>${done ? 'Игра завершена' : 'Драфт завершён'}</h2></div>
    ${!done ? html`<p class="sub">Создавайте лобби в Dota 2 с режимом Turbo и берите героев из этого драфта.</p>` : nothing}
    ${done ? html`<p class="verdict">Победила <strong class=${'t' + (res.winner - 1)}>команда ${teamName(r, res.winner - 1)}</strong>, MVP — <strong>${nick(r, res.mvp)}</strong>${res.scored ? ', очки начислены.' : '. Тестовая игра, очки не начислялись.'}</p>` : nothing}
    <div class="lineups">${lineup(app, 0, res?.winner)}${lineup(app, 1, res?.winner)}</div>

    ${!done && host ? html`<div class="result-form">
      <h3>Результат матча</h3>
      <div class="choice">
        ${[1, 2].map(w => html`<button class=${cls('slot pickable', 't' + (w - 1), app.winner === w && 'chosen')} @click=${() => a.setWinner(w)}><span class="slot-name">Победил ${teamName(r, w - 1)}</span></button>`)}
      </div>
      <h3>MVP</h3>
      <div class="choice mvp">
        ${r.squads.flat().map(id => html`<button class=${cls('slot pickable', app.mvp === id && 'chosen')} @click=${() => a.setMvp(id)}><span class="slot-name">${nick(r, id)}</span></button>`)}
      </div>
      <p class="hint">Победа +100, поражение +40, MVP ещё +15.</p>
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
    <dt>Очки</dt><dd>Победа +100, поражение +40, MVP ещё +15. Очки суммируются между играми.</dd>
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
