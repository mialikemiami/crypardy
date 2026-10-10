import {
  SETTINGS,
  initialState,
  reduce,
  replay,
  publicView,
  primaryAction,
  canJudge,
  judgeAction,
  wagerLimits,
  clueSource,
  roundRows,
  cellKey,
  seatName,
  mediaKey,
} from './engine.js';
import { buildGame, summarize } from './csv.js';
import { connect } from './transport.js';
import { isPlayable, mediaLabel, parseMedia } from './media.js';
import { $, esc, fmt, secs, renderInto, startTimerLoop, copyText, typingInField } from './util.js';
import {
  EMOTE_PATTERN,
  slowmodeMessage,
  clueMessage,
  clueSummary,
  finalMessage,
  finalSummary,
  joinMessage,
  playersMessage,
  preview,
  resultsMessage,
  scoresMessage,
  welcomeMessage,
} from './discord.js';

const app = $('#app');

let conn = null;
let connStatus = 'offline';
let password = '';
let game = null;
let warnings = [];
let mediaStarted = null;
let state = initialState();
let actions = [];
let lobby = new Map();
let saved = null;
let loginError = '';
let fileError = '';
let wagerError = '';
let busy = false;
let timers = [];
let lobbyTimer = null;
let seq = 0;
let lastClue = null;
const sid = Math.random().toString(36).slice(2, 10);

const ICONS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"></path>',
  x: '<path d="M6 6l12 12"></path><path d="M18 6L6 18"></path>',
  next: '<path d="M5 12h14"></path><path d="M13 6l6 6-6 6"></path>',
  undo: '<path d="M9 14L4 9l5-5"></path><path d="M4 9h10a6 6 0 0 1 0 12h-3"></path>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 3 8 3 8H3s3-2 3-8"></path><path d="M10.3 21a2 2 0 0 0 3.4 0"></path>',
  skip: '<path d="M5 5l10 7-10 7z"></path><path d="M19 5v14"></path>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4z"></path><path d="M13.5 6.5l4 4"></path>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path>',
  play: '<path d="M7 5l12 7-12 7z"></path>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"></rect>',
};
const icon = (name, size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
const diamond = (size = 10) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l10 10-10 10L2 12z"></path></svg>`;

const WORDS_A = ['maple', 'cosmic', 'velvet', 'turbo', 'lucky', 'rapid', 'sunny', 'neon', 'brave', 'fuzzy', 'golden', 'mighty', 'jolly', 'crispy', 'swift', 'silver'];
const WORDS_B = ['otter', 'comet', 'taco', 'falcon', 'pickle', 'rocket', 'banjo', 'waffle', 'panda', 'cactus', 'meteor', 'noodle', 'walrus', 'lantern', 'marble', 'zebra'];
const WORDS_C = ['dances', 'sings', 'naps', 'skates', 'juggles', 'bounces', 'giggles', 'zooms', 'wobbles', 'sparkles', 'surfs', 'hums', 'yodels', 'tumbles', 'whistles', 'glides'];
function suggestPassword() {
  const n = (max) => crypto.getRandomValues(new Uint32Array(1))[0] % max;
  const pick = (a) => a[n(a.length)];
  return `${pick(WORDS_A)} ${pick(WORDS_B)} ${pick(WORDS_C)} ${100 + n(900)}`;
}

async function signIn(hostPassword, gamePassword) {
  busy = true;
  loginError = '';
  render();
  try {
    conn = await connect({
      role: 'host',
      password: gamePassword,
      hostPassword,
      onStatus: (s) => {
        connStatus = s;
        if (conn) render();
      },
    });
    connStatus = 'connected';
    password = gamePassword.trim();
    sessionStorage.setItem('cr:host', JSON.stringify({ hostPassword, gamePassword: password }));
    await conn.enter('lobby', { role: 'host', name: 'Host' });
    await conn.onPresence('lobby', refreshLobby);
    await conn.subscribe('input', onInput);
    saved = loadSaved();
    if (!saved?.game && !saved?.actions?.length) saved = null;
    refreshLobby();
    setInterval(publishState, 10000);
    publishState();
  } catch (err) {
    conn = null;
    loginError = err.message;
  }
  busy = false;
  render();
}

function signOut() {
  sessionStorage.removeItem('cr:host');
  conn?.close();
  location.reload();
}

const storeKey = () => `cr:host:${conn.room}`;

function save() {
  saved = null;
  try {
    localStorage.setItem(storeKey(), JSON.stringify({ game, warnings, actions, savedAt: Date.now() }));
  } catch {
  }
}

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(storeKey()) || 'null');
  } catch {
    return null;
  }
}

function resume() {
  game = saved.game;
  warnings = saved.warnings || [];
  actions = saved.actions || [];
  state = replay(game, actions, SETTINGS);
  saved = null;
  continueTimers();
}

function discardSaved() {
  saved = null;
  localStorage.removeItem(storeKey());
  render();
}

function loadGameText(text, title) {
  if (state.phase !== 'lobby') return;
  try {
    const res = buildGame(text, { title });
    game = res.game;
    warnings = res.warnings;
    fileError = '';
    save();
    publishState();
  } catch (err) {
    fileError = err.message;
  }
  render();
}

function refreshLobby() {
  clearTimeout(lobbyTimer);
  lobbyTimer = setTimeout(async () => {
    try {
      const members = await conn.members('lobby');
      lobby = new Map(
        members.filter((m) => m.clientId !== 'host').map((m) => [m.clientId, { ...(m.data || {}), role: roleOf(m.clientId) }]),
      );
    } catch {
    }
    publishState();
    render();
  }, 200);
}

function roleOf(id) {
  if (id.startsWith('s-')) return 'stream';
  if (id.startsWith('p-')) return 'player';
  return 'other';
}

const lobbyPlayers = () => [...lobby.entries()].filter(([, d]) => d.role === 'player');
const streamOnline = () => [...lobby.values()].some((d) => d.role === 'stream');
const streamSound = () => [...lobby.values()].some((d) => d.role === 'stream' && d.sound);

function onInput(m) {
  const recv = Date.now();
  const id = m.clientId;
  if (!id || id === 'host') return;
  const d = m.data || {};
  const base = { by: 'player', at: recv };
  switch (m.name) {
    case 'buzz':
      dispatch({ ...base, type: 'buzz', id, ts: m.timestamp ? m.timestamp - conn.serverOffset() : recv, recv });
      break;
    case 'pick':
      dispatch({ ...base, type: 'pick', who: id, cat: Number(d.cat), row: Number(d.row) });
      break;
    case 'wager':
      dispatch({ ...base, type: 'wager', id, amount: d.amount });
      break;
    case 'final-wager':
      dispatch({ ...base, type: 'finalWager', id, amount: d.amount });
      break;
    case 'final-response':
      dispatch({ ...base, type: 'finalResponse', id, text: d.text, recv });
      break;
    default:
  }
}

function dispatch(action) {
  action.at ??= Date.now();
  const res = reduce(game, state, action, SETTINGS);
  if (!res.ok) return false;
  state = res.state;
  actions.push(action);
  wagerError = '';
  save();
  res.events.forEach(publishEvent);
  publishState();
  schedule();
  render();
  return true;
}

const host = (action) => dispatch({ ...action, by: 'host' });

function undo() {
  let i = actions.length - 1;
  while (i >= 0 && actions[i].by !== 'host') i--;
  if (i < 0) return;
  if (actions[i].type === 'adjust') {
    const rest = [...actions.slice(0, i), ...actions.slice(i + 1)];
    actions = [];
    let s = initialState();
    for (const a of rest) {
      const r = reduce(game, s, a, SETTINGS);
      if (r.ok) {
        s = r.state;
        actions.push(a);
      }
    }
    state = s;
  } else {
    actions = actions.slice(0, i);
    state = replay(game, actions, SETTINGS);
  }
  publishEvent({ type: 'undo', phase: state.phase });
  continueTimers();
}

function continueTimers() {
  if (dispatch({ type: 'resumeTimers', by: 'auto' })) return;
  save();
  publishState();
  schedule();
  render();
}

function schedule() {
  timers.forEach(clearTimeout);
  timers = [];
  const now = Date.now();
  const at = (t, action) =>
    timers.push(setTimeout(() => dispatch({ ...action, at: Math.max(Date.now(), t) }), Math.max(0, t - now)));
  const c = state.clue;
  if (c && c.armed && !c.answering) {
    if (c.buzzes.length) at(c.firstRecv + SETTINGS.collectMs, { type: 'award', by: 'auto' });
    else at(c.deadline, { type: 'timeout', by: 'auto' });
  }
  if (c && c.answering && c.timer === 'answer') at(c.deadline, { type: 'answerTimeout', by: 'auto' });
  if (state.phase === 'final-clue' && state.final?.deadline) {
    at(state.final.deadline + SETTINGS.finalGraceMs, { type: 'finalTimeUp', by: 'auto' });
  }
}

function publishState() {
  if (!conn) return;
  const view = publicView(game, state, Date.now(), SETTINGS);
  conn.publish('public', 'state', { sid, seq: ++seq, view }).catch(() => {});
}

function publishEvent(ev) {
  conn?.publish('public', 'event', ev).catch(() => {});
}

function startGame() {
  if (!game || !state.seats.length) return;
  const control = state.seats[Math.floor(Math.random() * state.seats.length)].id;
  host({ type: 'start', control });
}

function newGame() {
  if (!confirm('Start a new game with the same players?')) return;
  actions = actions.filter((a) => ['seat', 'unseat', 'reseat', 'rename'].includes(a.type));
  lastClue = null;
  state = replay(game, actions, SETTINGS);
  save();
  publishState();
  schedule();
  render();
}

function editScore(id) {
  const seat = state.seats.find((s) => s.id === id);
  if (!seat) return;
  const input = prompt(`New score for ${seat.name}`, String(seat.score));
  if (input == null) return;
  const n = Math.round(Number(String(input).replace(/−/g, '-').replace(/[^0-9-]/g, '')));
  if (!Number.isFinite(n) || n === seat.score) return;
  host({ type: 'adjust', id, delta: n - seat.score });
}

function lockWager(inputId) {
  const value = $(`#${inputId}`)?.value;
  if (!host({ type: 'wager', id: state.control, amount: value })) {
    const { min, max } = wagerLimits(game, state, state.control);
    wagerError = `Enter a whole number from ${fmt(min)} to ${fmt(max)}.`;
    render();
  }
}

const base = () => location.href.replace(/[#?].*$/, '').replace(/[^/]*$/, '');
const playerLink = () => `${base()}play`;
const streamLink = () => `${base()}stream#password=${encodeURIComponent(password)}`;

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const hostPassword = $('#host-password').value;
  signIn(hostPassword, $('#game-password').value);
});

document.addEventListener('change', (e) => {
  if (e.target.id !== 'csv-file') return;
  const file = e.target.files?.[0];
  if (file) file.text().then((t) => loadGameText(t, file.name.replace(/\.csv$/i, '')));
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  switch (d.act) {
    case 'suggest': {
      const input = $('#game-password');
      input.value = suggestPassword();
      input.focus();
      break;
    }
    case 'sample':
      fetch('sample-game.csv')
        .then((r) => (r.ok ? r.text() : Promise.reject()))
        .then((t) => loadGameText(t, 'Sample game'))
        .catch(() => {
          fileError = 'Could not load the sample game.';
          render();
        });
      break;
    case 'load-csv':
      $('#csv-file').click();
      break;
    case 'seat':
      host({ type: 'seat', id: d.id, name: lobby.get(d.id)?.name });
      break;
    case 'unseat':
      host({ type: 'unseat', id: d.id });
      break;
    case 'reseat':
      host({ type: 'reseat', oldId: d.old, id: d.id, name: lobby.get(d.id)?.name });
      break;
    case 'start':
      startGame();
      break;
    case 'resume':
      resume();
      break;
    case 'discard':
      discardSaved();
      break;
    case 'pick':
      host({ type: 'pick', cat: Number(d.cat), row: Number(d.row) });
      break;
    case 'primary': {
      const p = primaryAction(game, state);
      if (p) p.type === 'start' ? startGame() : host({ type: p.type });
      break;
    }
    case 'judge-yes':
      host(judgeAction(state, true));
      break;
    case 'judge-no':
      host(judgeAction(state, false));
      break;
    case 'undo':
      undo();
      break;
    case 'skip':
      host({ type: 'skip' });
      break;
    case 'end-round':
      if (confirm('End this round now? Unplayed clues are skipped.')) host({ type: 'endRound' });
      break;
    case 'end-think':
      host({ type: 'finalTimeUp' });
      break;
    case 'give-control':
      host({ type: 'setControl', id: d.id });
      break;
    case 'edit-score':
      editScore(d.id);
      break;
    case 'wager-lock':
      lockWager(d.input);
      break;
    case 'new-game':
      newGame();
      break;
    case 'copy-password':
      copyText(password, el);
      break;
    case 'copy-player-link':
      copyText(playerLink(), el);
      break;
    case 'copy-stream-link':
      copyText(streamLink(), el);
      break;
    case 'copy-discord':
      copyText(discordText(d.kind), el);
      break;
    case 'media-play':
      playMedia(d.key);
      break;
    case 'media-stop':
      stopMedia(d.key);
      break;
    case 'sign-out':
      signOut();
      break;
    default:
  }
  if (el.tagName === 'BUTTON') el.blur();
});

document.addEventListener('keydown', (e) => {
  if (!conn || typingInField(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === ' ') {
    e.preventDefault();
    if (e.repeat) return;
    const p = primaryAction(game, state);
    if (p) p.type === 'start' ? startGame() : host({ type: p.type });
  } else if (e.repeat) return;
  else if (k === 'c' && canJudge(state)) host(judgeAction(state, true));
  else if (k === 'x' && canJudge(state)) host(judgeAction(state, false));
  else if (k === 'u') undo();
  else if (k === 'p') {
    const key = liveMedia();
    if (key) mediaStarted === key ? stopMedia(key) : playMedia(key);
  }
});

function liveMedia() {
  const c = state.clue;
  if (c && ['clue', 'reveal', 'tiebreaker'].includes(state.phase)) {
    return isPlayable(parseMedia(clueSource(game, c)?.media)) ? mediaKey(c) : null;
  }
  if (['final-clue', 'final-reveal'].includes(state.phase)) {
    return isPlayable(parseMedia(game?.final?.media)) ? 'final' : null;
  }
  return null;
}

function playMedia(key) {
  mediaStarted = key;
  publishEvent({ type: 'media', action: 'play', key });
  render();
}

function stopMedia(key) {
  mediaStarted = null;
  publishEvent({ type: 'media', action: 'stop', key });
  render();
}

function render() {
  if (!conn) return renderLogin();
  noteClue();
  if (mediaStarted && mediaStarted !== liveMedia()) mediaStarted = null;
  renderInto(
    app,
    `<div class="wrap">${topBar()}${state.phase === 'lobby' ? lobbyView() : gameView()}</div>`,
  );
}

function renderLogin() {
  const remembered = JSON.parse(sessionStorage.getItem('cr:host') || 'null');
  renderInto(
    app,
    `<div class="centered">
      <form class="card login" id="login-form">
        <div class="wordmark" style="font-size:44px">CRYPARDY<span>!</span></div>
        <h1 class="h" style="font-size:28px">Host sign-in</h1>
        <div class="field">
          <label for="host-password">Host Password</label>
          <input id="host-password" type="password" autocomplete="current-password" required value="${esc(remembered?.hostPassword || '')}">
          <span class="hint">The HOST_PASSWORD you set in Netlify.</span>
        </div>
        <div class="field">
          <label for="game-password">Game Password</label>
          <div class="row" style="flex-wrap:nowrap">
            <input id="game-password" type="text" autocomplete="off" spellcheck="false" required minlength="4" maxlength="64" value="${esc(remembered?.gamePassword || '')}">
            <button class="btn small" type="button" data-act="suggest">Suggest</button>
          </div>
          <span class="hint">Share this with players. It isn’t case-sensitive.</span>
        </div>
        ${loginError ? `<div class="error" role="alert">${esc(loginError)}</div>` : ''}
        <button class="btn" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Signing in…' : 'Open host view'}</button>
      </form>
    </div>`,
  );
}

function topBar() {
  const round = game?.rounds?.[state.roundIndex];
  const where =
    state.phase === 'lobby'
      ? 'Lobby'
      : state.phase.startsWith('final')
        ? 'Final Round'
        : state.phase === 'tiebreaker'
          ? 'Tiebreaker'
          : state.phase === 'over'
            ? 'Game Over'
            : round?.name || '';
  const conOk = connStatus === 'connected';
  return `<header class="top">
    <div class="brand">
      <div class="wordmark" style="font-size:34px">CRYPARDY<span>!</span></div>
      <strong>Host View</strong>
      <span>${esc(where)}</span>
    </div>
    <div class="chips">
      <span class="chip">Password: ${esc(password)} <button class="link" data-act="copy-password">Copy</button></span>
      <span class="chip"><span class="dot ${conOk ? '' : 'off'}"></span>${conOk ? 'Connected' : esc(connStatus)}</span>
      <span class="chip"><span class="dot ${streamOnline() ? '' : 'off'}"></span>Stream view ${streamOnline() ? 'on' : 'off'}</span>
      <span class="chip"><span class="dot ${streamSound() ? '' : 'off'}"></span>Stream sound ${streamSound() ? 'on' : 'off'}</span>
      <button class="link" data-act="copy-player-link">Copy player link</button>
      <button class="link" data-act="copy-stream-link">Copy stream link</button>
      <button class="link" data-act="sign-out">Sign out</button>
    </div>
  </header>`;
}

function lobbyView() {
  const seatedIds = new Set(state.seats.map((s) => s.id));
  const waiting = lobbyPlayers().filter(([id]) => !seatedIds.has(id));
  const full = state.seats.length >= SETTINGS.maxSeats;
  const resumeCard = saved
    ? `<div class="msg">A saved game from ${esc(new Date(saved.savedAt).toLocaleString())} is here.
         <div class="row" style="margin-top:10px">
           <button class="btn small" data-act="resume" style="background:var(--cream);color:var(--black)">Resume it</button>
           <button class="link" data-act="discard" style="color:var(--white)">Discard</button>
         </div></div>`
    : '';
  return `<div class="lobby">
    <section class="card">
      <h2 class="h" style="font-size:26px">Game file</h2>
      ${resumeCard}
      ${game ? `<p><strong>${esc(game.title || 'Game loaded')}</strong><br>${esc(summarize(game))}</p>` : '<p>Load a CSV game file, or try the sample game.</p>'}
      ${warnings.length ? `<ul class="warnings">${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      ${fileError ? `<div class="error" role="alert">${esc(fileError)}</div>` : ''}
      <div class="row">
        <button class="btn" data-act="load-csv">Load CSV</button>
        <button class="btn" data-act="sample">Use sample game</button>
        <input id="csv-file" type="file" accept=".csv,text/csv" class="sr-only" tabindex="-1" aria-hidden="true">
      </div>
    </section>
    <section class="card">
      <h2 class="h" style="font-size:26px">Players</h2>
      <p>Share the game password and the player link. Players appear here when they join.</p>
      <div class="label">Seated (${state.seats.length} of ${SETTINGS.maxSeats})</div>
      <ul class="people">
        ${
          state.seats
            .map(
              (s) => `<li><span class="dot ${lobby.has(s.id) ? '' : 'off'}"></span><span class="grow"><strong>${esc(s.name)}</strong>${lobby.has(s.id) ? '' : ' · not connected'}</span>
                <button class="link" data-act="unseat" data-id="${esc(s.id)}">Unseat</button></li>`,
            )
            .join('') || '<li>Nobody yet.</li>'
        }
      </ul>
      <div class="label">Waiting to Be Seated</div>
      <ul class="people">
        ${
          waiting
            .map(
              ([id, d]) => `<li><span class="dot"></span><span class="grow">${esc(d.name || 'Player')}</span>
                <button class="btn small" data-act="seat" data-id="${esc(id)}" ${full ? 'disabled' : ''}>Seat</button></li>`,
            )
            .join('') || '<li>Nobody waiting.</li>'
        }
      </ul>
    </section>
    <section class="card">
      <h2 class="h" style="font-size:26px">Start</h2>
      <p>${!game ? 'Load a game file first.' : !state.seats.length ? 'Seat at least one player.' : 'Ready when you are. A random player picks first.'}</p>
      <button class="btn" data-act="start" ${!game || !state.seats.length ? 'disabled' : ''}>Start game <kbd>Space</kbd></button>
      <p class="hint">During the game: Space moves things along, C marks correct, X marks incorrect, U undoes your last decision, P plays a clue’s video or audio on the stream.</p>
    </section>
    ${discordCard()}
  </div>`;
}

function gameView() {
  return `<div class="cols">${boardCard()}${mainCard()}<div class="side">${buzzCard()}${scoresCard()}${discordCard()}</div></div>`;
}

function boardCard() {
  const r = state.roundIndex;
  const round = game?.rounds?.[r];
  if (!round || !['board', 'wager', 'clue', 'reveal'].includes(state.phase)) {
    const text = state.phase === 'over' ? 'The game is over.' : 'The board is done.';
    return `<section class="card board-card"><div class="card-head"><h2 class="h">Board</h2></div><p>${text}</p></section>`;
  }
  const rows = roundRows(game, r);
  const c = state.clue;
  const cats = round.categories.map((cat) => `<div class="cat">${esc(cat.name)}</div>`).join('');
  let cells = '';
  for (let row = 0; row < rows; row++) {
    round.categories.forEach((cat, ci) => {
      const cl = cat.clues[row];
      if (!cl || state.used[cellKey(r, ci, row)]) {
        cells += '<div class="cell used"></div>';
        return;
      }
      const live = c && c.kind === 'board' && c.cat === ci && c.row === row;
      const cls = `cell${live ? ' live' : ''}${cl.wager ? ' wager' : ''}`;
      const label = esc(`${cat.name} for ${cl.value}${cl.wager ? ', DON’T TRIP!' : ''}`);
      const inner = `${cl.wager ? diamond() : ''}${cl.value}`;
      cells +=
        state.phase === 'board'
          ? `<button class="${cls}" data-act="pick" data-cat="${ci}" data-row="${row}" aria-label="${label}">${inner}</button>`
          : `<div class="${cls}" aria-label="${label}">${inner}</div>`;
    });
  }
  return `<section class="card board-card">
    <div class="card-head"><h2 class="h">${esc(round.name)}</h2>${state.phase === 'board' ? `<span>${esc(seatName(state, state.control))} picks</span>` : ''}</div>
    <div class="board" style="grid-template-columns:repeat(${round.categories.length},minmax(0,1fr))">${cats}${cells}</div>
    <div class="legend">
      <span><i class="swatch" style="background:var(--pink)"></i>Live</span>
      <span><i class="swatch" style="border:1.5px dashed var(--black)"></i>Played</span>
      <span>${diamond()} DON’T TRIP!, hidden from players</span>
    </div>
    ${state.phase === 'board' ? '<div><button class="link" data-act="end-round">End this round early</button></div>' : ''}
  </section>`;
}

const undoBtn = () => `<button class="btn" data-act="undo" ${actions.some((a) => a.by === 'host') ? '' : 'disabled'}>${icon('undo')}Undo<kbd>U</kbd></button>`;
const skipBtn = () => `<button class="btn" data-act="skip">${icon('skip')}Skip clue</button>`;

function primaryBtn() {
  const p = primaryAction(game, state);
  if (!p) return '';
  return `<button class="btn" data-act="primary">${icon(p.type === 'arm' ? 'bell' : 'next')}${esc(p.label)}<kbd>Space</kbd></button>`;
}

function judgeBtns() {
  const ok = canJudge(state);
  return `<button class="btn" data-act="judge-yes" ${ok ? '' : 'disabled'}>${icon('check')}Correct<kbd>C</kbd></button>
    <button class="btn pink" data-act="judge-no" ${ok ? '' : 'disabled'}>${icon('x')}Incorrect<kbd>X</kbd></button>`;
}

function timerBlock(label, deadline, total) {
  return `<div class="timer">
    <div class="timer-top"><span>${esc(label)}</span><span data-deadline="${deadline}" data-total="${total}" data-countdown></span></div>
    <div class="bar" data-deadline="${deadline}" data-total="${total}"><i></i></div>
  </div>`;
}

function mediaBlock(raw, key, waitText = '') {
  const m = parseMedia(raw);
  if (!m) return '';
  const link = `<a class="link" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">Open link</a>`;
  if (m.type === 'image') return `<div class="host-media"><img src="${esc(m.src)}" alt="Clue image"></div>`;
  const started = mediaStarted === key;
  const controls = waitText
    ? `<span class="hint">${esc(waitText)}</span>`
    : `<button class="btn small" data-act="media-play" data-key="${esc(key)}">${icon('play')}${started ? 'Replay' : 'Play'} on stream<kbd>P</kbd></button>
      <button class="btn small" data-act="media-stop" data-key="${esc(key)}" ${started ? '' : 'disabled'}>${icon('stop')}Stop</button>`;
  return `<div class="host-media-row"><span class="tag">${mediaLabel(m)}</span>${link}${controls}${started ? '<span class="hint">Started on the stream and phones</span>' : ''}</div>`;
}

function extras(src) {
  return src.note ? `<div class="msg">Host Note: ${esc(src.note)}</div>` : '';
}

function responseBlock(src) {
  return `<div class="rule"></div>
    <div class="field"><div class="label">Correct Response</div><div class="response">${esc(src.response)}</div></div>
    ${extras(src)}`;
}

function mainCard() {
  switch (state.phase) {
    case 'board':
      return boardPrompt();
    case 'wager':
      return wagerCard();
    case 'clue':
    case 'reveal':
    case 'tiebreaker':
      return clueCard();
    case 'final-category':
    case 'final-clue':
    case 'final-reveal':
      return finalCard();
    case 'over':
      return overCard();
    default:
      return '<section class="card main-card"></section>';
  }
}

function boardPrompt() {
  return `<section class="card main-card">
    <div class="label">${esc(game.rounds[state.roundIndex].name)}</div>
    <h2 class="h big-name">${esc(seatName(state, state.control))} is picking</h2>
    <p>They tap a clue on their phone, or you can click it on the board for them.</p>
    <div class="controls">${undoBtn()}</div>
  </section>`;
}

function wagerCard() {
  const c = state.clue;
  const src = clueSource(game, c);
  const name = seatName(state, state.control);
  const { min, max } = wagerLimits(game, state, state.control);
  const inputId = `wager-${c.r}-${c.cat}-${c.row}`;
  return `<section class="card main-card">
    <div class="clue-head">
      <div class="left"><span class="label">${esc(src.category)}</span><span class="value-chip">${fmt(c.value)}</span></div>
      <span class="status"><span class="dot live"></span>DON’T TRIP!</span>
    </div>
    <h2 class="h big-name">DON’T TRIP!</h2>
    <p><strong>${esc(name)}</strong> is choosing a wager from ${fmt(min)} to ${fmt(max)} on their screen.</p>
    <div class="field">
      <label for="${inputId}">Or type the wager they say out loud</label>
      <div class="row" style="flex-wrap:nowrap">
        <input id="${inputId}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1">
        <button class="btn" data-act="wager-lock" data-input="${inputId}">${icon('lock')}Lock wager</button>
      </div>
      ${wagerError ? `<div class="error" role="alert">${esc(wagerError)}</div>` : ''}
    </div>
    <div class="label">Clue, hidden from everyone until the wager is in</div>
    <p class="clue-text">${esc(src.clue)}</p>
    ${mediaBlock(src.media, mediaKey(c), 'Can be played once the wager is in.')}
    ${responseBlock(src)}
    <div class="controls">${skipBtn()}${undoBtn()}</div>
  </section>`;
}

function outcomeText(c) {
  const who = (id) => esc(seatName(state, id));
  switch (c.outcome) {
    case 'correct':
      return `${who(c.correctBy)} got it`;
    case 'incorrect':
      return c.wager ? `${who(c.attempted[0])} missed it` : 'Nobody got it';
    case 'timeout':
      return 'Time’s up';
    case 'skipped':
      return 'Skipped';
    default:
      return '';
  }
}

function clueCard() {
  const c = state.clue;
  const src = clueSource(game, c) || {};
  const tb = c.kind === 'tiebreaker';
  const chip = tb
    ? '<span class="value-chip">Tiebreaker</span>'
    : c.wager
      ? `<span class="value-chip">DON’T TRIP! · ${fmt(c.wagerAmount)}</span>`
      : `<span class="value-chip">${fmt(c.value)}</span>`;
  let status;
  if (c.revealed) status = outcomeText(c);
  else if (c.answering && c.overtime) status = `Time’s up: rule on ${esc(seatName(state, c.answering))}’s answer`;
  else if (c.answering) status = `${esc(seatName(state, c.answering))} is answering`;
  else if (c.armed) status = c.buzzes.length ? 'Buzz received' : 'Buzzers open';
  else status = 'Read the clue then open the buzzers';
  const total = c.timer === 'buzz' ? SETTINGS.buzzWindowMs : c.wager ? SETTINGS.wagerAnswerMs : SETTINGS.answerMs;
  const timer =
    c.timer && !c.revealed
      ? timerBlock(c.timer === 'buzz' ? 'Time to buzz' : `${seatName(state, c.answering)} is answering`, c.deadline, total)
      : '';
  const eligible = tb ? `<p>Only ${c.eligible.map((id) => `<strong>${esc(seatName(state, id))}</strong>`).join(' and ')} can buzz.</p>` : '';
  return `<section class="card main-card">
    <div class="clue-head">
      <div class="left"><span class="label">${esc(src.category)}</span>${chip}</div>
      <span class="status"><span class="dot ${c.revealed ? 'off' : 'live'}"></span>${status}</span>
    </div>
    ${eligible}
    <p class="clue-text">${esc(src.clue)}</p>
    ${mediaBlock(src.media, mediaKey(c))}
    ${responseBlock(src)}
    ${timer}
    <div class="controls">${primaryBtn()}${judgeBtns()}${undoBtn()}${!c.revealed && !tb ? skipBtn() : ''}</div>
  </section>`;
}

function finalCard() {
  const f = state.final;
  const fin = game.final;
  const name = (id) => esc(seatName(state, id));
  const out = state.seats.filter((s) => !f.eligible.includes(s.id));
  const sitting = out.length ? `<p>Sitting out with 0 or less: ${out.map((s) => esc(s.name)).join(', ')}.</p>` : '';

  if (state.phase === 'final-category') {
    return `<section class="card main-card">
      <div class="label">Final Round</div>
      <h2 class="h big-name">${esc(fin.category)}</h2>
      <p>Players are choosing their wagers.</p>
      <ul class="list">${f.eligible
        .map((id) => `<li class="${f.wagers[id] != null ? 'done' : ''}"><span class="grow"><strong>${name(id)}</strong></span><span>${f.wagers[id] != null ? 'Wager in' : 'Wagering…'}</span></li>`)
        .join('')}</ul>
      ${sitting}
      <p class="hint">Anyone without a wager when you reveal the clue wagers 0.</p>
      <div class="rule"></div>
      <div class="label">Clue</div>
      <p class="clue-text">${esc(fin.clue)}</p>
      ${mediaBlock(fin.media, 'final', 'Can be played once the clue is revealed.')}
      ${responseBlock(fin)}
      <div class="controls">${primaryBtn()}${undoBtn()}</div>
    </section>`;
  }

  if (state.phase === 'final-clue') {
    return `<section class="card main-card">
      <div class="clue-head"><div class="left"><span class="label">Final Round · ${esc(fin.category)}</span></div>
        <span class="status"><span class="dot live"></span>Thinking time</span></div>
      <p class="clue-text">${esc(fin.clue)}</p>
      ${mediaBlock(fin.media, 'final')}
      ${responseBlock(fin)}
      ${timerBlock('Thinking time', f.deadline, SETTINGS.finalThinkMs)}
      <ul class="list">${f.eligible
        .map((id) => `<li class="${f.responses[id] != null ? 'done' : ''}"><span class="grow"><strong>${name(id)}</strong></span><span>${f.responses[id] != null ? 'Response in' : 'Writing…'}</span></li>`)
        .join('')}</ul>
      <div class="controls"><button class="btn" data-act="end-think">End thinking time</button>${undoBtn()}</div>
    </section>`;
  }

  const items = f.order
    .map((id, i) => {
      const shown = i <= f.index;
      const judged = f.judged[id] !== undefined;
      const cls = i === f.index && !judged ? 'current' : judged ? 'done' : '';
      const resp = shown ? `<div class="final-response">${esc(f.responses[id] || '(no response)')}</div>` : '<div>Not revealed yet</div>';
      const result = judged ? `<strong>${f.judged[id] ? 'Correct' : 'Incorrect'}</strong> · ` : '';
      return `<li class="${cls}" style="align-items:flex-start"><div class="grow">
          <strong>${name(id)}</strong> · started with ${fmt(f.start[id])}
          ${resp}
          <div>${result}Wager ${fmt(f.wagers[id] || 0)}${judged ? ` · now ${fmt(state.seats.find((s) => s.id === id).score)}` : ''}</div>
        </div></li>`;
    })
    .join('');
  return `<section class="card main-card">
    <div class="label">Final Round · ${esc(fin.category)}</div>
    <h2 class="h big-name">Reveals</h2>
    <p>Revealed from the lowest score to the highest. Reveal a response then judge it.</p>
    <ul class="list">${items}</ul>
    ${mediaBlock(fin.media, 'final')}
    ${responseBlock(fin)}
    <div class="controls">${primaryBtn()}${judgeBtns()}${undoBtn()}</div>
  </section>`;
}

function overCard() {
  const winners = state.winners || [];
  const title = !winners.length ? 'No winner' : winners.length > 1 ? 'Co-champions' : 'Winner';
  const ranked = [...state.seats].sort((a, b) => b.score - a.score);
  return `<section class="card main-card">
    <div class="label">Game Over</div>
    <h2 class="h big-name">${title}</h2>
    ${winners.length ? `<div class="winner">${winners.map((id) => esc(seatName(state, id))).join(' & ')}</div>` : '<p>Nobody finished above zero.</p>'}
    <ul class="list">${ranked.map((s) => `<li><span class="grow"><strong>${esc(s.name)}</strong></span><span>${fmt(s.score)}</span></li>`).join('')}</ul>
    <div class="controls"><button class="btn" data-act="new-game">New game, same players</button>${undoBtn()}</div>
  </section>`;
}

function buzzCard() {
  const c = state.clue;
  const name = (id) => esc(seatName(state, id));
  let body;
  if (state.lastBuzz.length) {
    body = `<ol class="list">${state.lastBuzz
      .map(
        (b, i) => `<li class="${i === 0 ? 'first' : ''}"><strong>${i + 1}</strong><span class="grow"><strong>${name(b.id)}</strong></span>
          <span>${i === 0 ? `${secs(b.ms)} s` : `+${secs(b.behind)} s`}</span></li>`,
      )
      .join('')}</ol>`;
  } else if (c?.buzzes?.length) {
    body = `<p>${c.buzzes.map((b) => name(b.id)).join(', ')} buzzed…</p>`;
  } else {
    body = '<p>No buzzes yet.</p>';
  }
  const tried = c?.attempted?.length ? `<p>Already answered: ${c.attempted.map(name).join(', ')}</p>` : '';
  return `<section class="card">
    <h2 class="h" style="font-size:26px">Buzz order</h2>
    ${body}${tried}
    <p class="hint">Ranked by when each press reached Ably’s servers. Presses arriving within 200 ms of the first are compared. Times include network delay.</p>
  </section>`;
}

function scoresCard() {
  const seatedIds = new Set(state.seats.map((s) => s.id));
  const newcomers = lobbyPlayers().filter(([id]) => !seatedIds.has(id));
  const rows = state.seats
    .map((s) => {
      const online = lobby.has(s.id);
      const picking = state.phase === 'board' && state.control === s.id;
      const give =
        state.phase === 'board' && !picking
          ? `<button class="link" data-act="give-control" data-id="${esc(s.id)}">Give control</button>`
          : '';
      return `<div class="score-row">
        <span class="avatar">${esc((s.name[0] || '?').toUpperCase())}</span>
        <div class="who"><strong>${esc(s.name)}</strong><span class="sub">${online ? 'Connected' : 'Not connected'}${picking ? ' · picking' : ''}</span>${give}</div>
        <span class="score">${fmt(s.score)}</span>
        ${state.phase === 'over' ? '' : `<button class="icon-btn" data-act="edit-score" data-id="${esc(s.id)}" aria-label="Edit ${esc(s.name)}’s score">${icon('pencil', 16)}</button>`}
      </div>`;
    })
    .join('');
  const swap = newcomers.length
    ? `<div class="label">Joined Since the Start</div>
       ${newcomers
         .map(
           ([id, d]) => `<div class="row"><span>${esc(d.name || 'Player')} can take over:</span>
             ${state.seats.map((s) => `<button class="link" data-act="reseat" data-old="${esc(s.id)}" data-id="${esc(id)}">${esc(s.name)}’s seat</button>`).join(' ')}</div>`,
         )
         .join('')}
       <p class="hint">Use this when a player rejoins from another device. Their score moves with them.</p>`
    : '';
  return `<section class="card"><h2 class="h" style="font-size:26px">Scores</h2>${rows}${swap}</section>`;
}

function noteClue() {
  const c = state.clue;
  if (!c || !game) return;
  const key = `${c.kind}-${c.r}-${c.cat}-${c.row}`;
  if (c.revealed) lastClue = { key, ...clueSummary(game, state, SETTINGS) };
  else if (lastClue?.key === key) lastClue = null;
}

function scoresLabel() {
  if (state.phase.startsWith('final')) return 'Final Round';
  if (state.phase === 'tiebreaker') return 'Tiebreaker';
  return game?.rounds?.[state.roundIndex]?.name || 'Scores';
}

function discordText(kind) {
  switch (kind) {
    case 'join':
      return joinMessage({ link: playerLink(), password });
    case 'players':
      return playersMessage(state.seats.map((s) => s.name));
    case 'chat':
      return slowmodeMessage();
    case 'welcome':
      return welcomeMessage({ names: state.seats.map((s) => s.name), control: seatName(state, state.control) });
    case 'final':
      return finalMessage(finalSummary(game, state));
    case 'clue':
      return clueMessage(lastClue);
    case 'scores':
      return scoresMessage(state.seats, scoresLabel());
    case 'results':
      return resultsMessage({ winners: (state.winners || []).map((id) => seatName(state, id)), seats: state.seats });
    default:
      return '';
  }
}

function script(kind) {
  const text = discordText(kind);
  if (!text) return '';
  return `<div class="script">
    <div class="script-text">${esc(preview(text)).replace(EMOTE_PATTERN, '<span class="emote">$1</span>')}</div>
    <button class="btn small" data-act="copy-discord" data-kind="${kind}">Copy</button>
  </div>`;
}

const step = (n, text, extra = '') => `<li><span class="num">${n}</span><div class="grow"><p>${text}</p>${extra}</div></li>`;
const names = (list) => list.map((n) => `<strong>${esc(n)}</strong>`).join(', ');

function discordCard() {
  const head = '<h2 class="h" style="font-size:26px">Discord</h2>';
  const slowmode = 'the Stage’s gear icon → <strong>Overview</strong> → <strong>Slowmode</strong>';
  if (state.phase === 'lobby') {
    const seated = state.seats.map((s) => s.name);
    return `<section class="card discord">
      ${head}
      <p>Do these in the Stage before you start.</p>
      <ol class="steps">
        ${step(1, 'Post the join message in the Stage chat or send it directly to players.', script('join'))}
        ${step(
          2,
          'Seat players here then bring each one up to speak: right-click their name in the Stage and choose <strong>Invite to Speak</strong>, or accept their raised hand. Bring the streamer up too; only speakers can share their screen.',
          `${seated.length ? `<p class="hint">To invite: ${names(seated)}</p>` : ''}${script('players')}`,
        )}
        ${step(3, `Turn on slowmode: ${slowmode} → <strong>30s</strong> → <strong>Save Changes</strong>. Then post the chat notice.`, script('chat'))}
      </ol>
    </section>`;
  }
  if (state.phase === 'over') {
    const winners = (state.winners || []).map((id) => seatName(state, id));
    return `<section class="card discord">
      ${head}
      <ol class="steps">
        ${step(1, 'Post the results.', script('results'))}
        ${winners.length ? step(2, `Using a winner role? Right-click ${names(winners)} in the Stage → <strong>Roles</strong> → tick it.`) : ''}
        ${step(winners.length ? 3 : 2, `Turn off slowmode: ${slowmode} → <strong>Off</strong> → <strong>Save Changes</strong>.`)}
        ${step(winners.length ? 4 : 3, 'Send the players and streamer back: right-click each one → <strong>Move to Audience</strong>.')}
      </ol>
    </section>`;
  }
  const fresh = state.phase === 'board' && state.roundIndex === 0 && !Object.keys(state.used || {}).length;
  const final = ['final-clue', 'final-reveal'].includes(state.phase);
  return `<section class="card discord">
    ${head}
    <p>Slowmode stays on until the game ends. Paste an update whenever you like.</p>
    ${fresh ? `<div class="label">Welcome</div>${script('welcome')}` : ''}
    ${final ? `<div class="label">Final Round</div>${script('final')}` : ''}
    ${lastClue && !final ? `<div class="label">Last Clue</div>${script('clue')}` : ''}
    <div class="label">Scores</div>
    ${script('scores')}
  </section>`;
}

startTimerLoop();
const remembered = JSON.parse(sessionStorage.getItem('cr:host') || 'null');
if (remembered?.gamePassword) signIn(remembered.hostPassword, remembered.gamePassword);
else render();
