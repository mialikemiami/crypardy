import { connect } from './transport.js';
import { $, esc, fmt, secs, startTimerLoop } from './util.js';
import { createSoundPlayer, soundForEvent } from './sounds.js';
import { createMediaLayer, mediaSlot, syncMediaLayer } from './media.js';

const stage = $('#stage');
const joinLayer = $('#join-layer');
const tripLayer = $('#trip-layer');
const hashParams = new URLSearchParams(location.hash.slice(1));
const volume = Math.min(1, Math.max(0, Number(hashParams.get('volume') ?? 0.8) || 0));

let conn = null;
let view = null;
let latest = { sid: null, seq: -1 };
let receivedAt = 0;
let attachedAt = 0;
let joinError = '';
let joinPassword = '';
let busy = false;

const sounds = createSoundPlayer({ base: 'sounds/', volume });
const mediaLayer = createMediaLayer({ volume });

const presence = () => ({ role: 'stream', name: 'Stream view', sound: sounds.unlocked });
function reportSound() {
  conn?.update('lobby', presence()).catch(() => {});
}
sounds.onChange(reportSound);

function startSound() {
  if (!sounds.unlocked) sounds.unlock().catch(() => {});
}
for (const type of ['pointerdown', 'keydown', 'touchend']) document.addEventListener(type, startSound, true);
startSound();

function fresh(sentAt) {
  if (sentAt && conn?.clockKnown()) return Date.now() + conn.serverOffset() - sentAt < 3000;
  return Date.now() - attachedAt >= 2000;
}

function onGameEvent(ev, sentAt) {
  if (!fresh(sentAt)) return;
  if (ev?.type === 'media') {
    if (ev.action === 'play') mediaLayer.play(ev.key);
    else mediaLayer.stop(ev.key);
    return;
  }
  const action = soundForEvent(ev);
  if (!action) return;
  if (action.stop) sounds.stop();
  if (action.play) {
    sounds.play(action.play);
    document.body.dataset.lastSound = action.play;
  }
}

const nameOf = (id) => view?.seats?.find((s) => s.id === id)?.name || '';
const pts = (n) => fmt(n, '-');
const deadlineOf = (timer) => receivedAt + timer.remaining;

function fit() {
  const s = Math.min(innerWidth / 1280, innerHeight / 720);
  stage.style.transform = `translate(${(innerWidth - 1280 * s) / 2}px, ${(innerHeight - 720 * s) / 2}px) scale(${s})`;
}
addEventListener('resize', fit);
fit();

async function join(password) {
  busy = true;
  joinError = '';
  joinPassword = password;
  renderJoin();
  try {
    conn = await connect({ role: 'stream', password });
    await conn.enter('lobby', presence());
    attachedAt = Date.now();
    await conn.subscribe('public', onPublic);
    sessionStorage.setItem('cr:stream', JSON.stringify({ password }));
    joinLayer.innerHTML = '';
  } catch (err) {
    conn = null;
    joinError = err.message;
  }
  busy = false;
  if (!conn) renderJoin();
  render();
}

function onPublic(m) {
  if (m.name === 'event') return onGameEvent(m.data, m.timestamp);
  if (m.name !== 'state' || !m.data?.view) return;
  const { sid, seq, view: v } = m.data;
  if (sid === latest.sid && seq <= latest.seq) return;
  latest = { sid, seq };
  view = v;
  receivedAt = Date.now();
  render();
}

function renderJoin() {
  joinLayer.innerHTML = `<div class="join"><form class="card login" id="stream-form">
    <div class="wordmark" style="font-size:44px">CRYPARDY<span>!</span></div>
    <h1 class="h" style="font-size:28px">Stream view</h1>
    <p>Tip: open the host’s “Copy stream link” and the password fills in by itself. Press Show the game, then make the window full screen and share it to the Stage.</p>
    <div class="field"><label for="stream-password">Game Password</label>
      <input id="stream-password" type="text" autocomplete="off" spellcheck="false" required value="${esc(joinPassword)}"></div>
    ${joinError ? `<div class="error" role="alert">${esc(joinError)}</div>` : ''}
    <button class="btn" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Connecting…' : 'Show the game'}</button>
  </form></div>`;
}

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'stream-form') return;
  e.preventDefault();
  startSound();
  join($('#stream-password').value);
});

const header = (right = '') =>
  `<header class="s-top"><div class="wordmark" style="font-size:42px">CRYPARDY<span>!</span></div><div class="info">${right}</div></header>`;

function podiums({ control = null, lit = [], notes = {}, out = [] } = {}) {
  const seats = view?.seats || [];
  const cards = seats
    .map((s) => {
      const cls = ['podium', s.id === control ? 'control' : '', lit.includes(s.id) ? 'lit' : '', out.includes(s.id) ? 'out' : '']
        .filter(Boolean)
        .join(' ');
      return `<div class="${cls}">
        <div class="name-row"><span class="name">${esc(s.name)}</span>${notes[s.id] || ''}</div>
        <div class="pts">${pts(s.score)}</div>
      </div>`;
    })
    .join('');
  return `<div class="podiums">${cards}</div>`;
}

const note = (text) => `<span class="note">${esc(text)}</span>`;

function clueSize(text) {
  const n = String(text || '').length;
  return n < 60 ? 68 : n < 110 ? 60 : n < 160 ? 52 : 44;
}

function mediaClueSize(text) {
  const n = String(text || '').length;
  return n < 60 ? 46 : n < 110 ? 40 : n < 160 ? 34 : 30;
}

function cluePanel(text, size, media, extra = '') {
  if (!media) return `<div class="panel"><p class="clue-text" style="font-size:${size}px">${esc(text || '')}</p>${extra}</div>`;
  return `<div class="panel with-media">${media}<div class="clue-col"><p class="clue-text" style="font-size:${size}px">${esc(text || '')}</p>${extra}</div></div>`;
}

function timerRow(label, timer) {
  if (!timer) return '<div class="timer-row"></div>';
  const dl = deadlineOf(timer);
  return `<div class="timer-row">
    <span class="who">${esc(label)}</span>
    <div class="bar" data-deadline="${dl}" data-total="${timer.total}"><i></i></div>
    <span class="secs" data-deadline="${dl}" data-total="${timer.total}" data-countdown></span>
  </div>`;
}

function renderTrip() {
  const on = view?.phase === 'wager';
  const html = on
    ? `<div class="trip" role="alert"><div class="trip-text">DON’T TRIP!</div><div class="trip-sub">${esc(nameOf(view.control))} is wagering</div></div>`
    : '';
  tripLayer.hidden = !on;
  if (tripLayer.__html !== html) {
    tripLayer.innerHTML = html;
    tripLayer.__html = html;
  }
}

function render() {
  renderScene();
  syncMediaLayer(mediaLayer, stage);
}

function renderScene() {
  renderTrip();
  if (!view) {
    stage.innerHTML = `${header()}<div class="panel"><div class="big" style="font-size:96px">Starting soon</div>
      <div class="sub">${conn ? 'Waiting for the host…' : ''}</div></div>`;
    return;
  }
  switch (view.phase) {
    case 'lobby':
      stage.innerHTML = lobbyScene();
      break;
    case 'board':
      stage.innerHTML = boardScene();
      break;
    case 'wager':
      stage.innerHTML = wagerScene();
      break;
    case 'clue':
    case 'reveal':
    case 'tiebreaker':
      stage.innerHTML = clueScene();
      break;
    case 'final-category':
      stage.innerHTML = finalCategoryScene();
      break;
    case 'final-clue':
      stage.innerHTML = finalClueScene();
      break;
    case 'final-reveal':
      stage.innerHTML = finalRevealScene();
      break;
    case 'over':
      stage.innerHTML = overScene();
      break;
    default:
  }
}

function lobbyScene() {
  return `${header()}<div class="panel">
      <div class="big" style="font-size:110px">Starting soon</div>
      <div class="sub">${view.seats.length ? `Tonight’s players: ${view.seats.map((s) => esc(s.name)).join(', ')}` : 'Players are joining'}</div>
    </div>${podiums()}`;
}

function boardScene() {
  const b = view.board;
  const cats = b.categories.map((n) => `<div class="g-cat">${esc(n)}</div>`).join('');
  let vals = '';
  for (let row = 0; row < b.rows; row++) {
    b.cells.forEach((col) => {
      const cell = col[row];
      vals += !cell || cell.used ? '<div class="g-val used"></div>' : `<div class="g-val">${pts(cell.value)}</div>`;
    });
  }
  return `${header(esc(view.round?.name || ''))}
    <div class="grid" style="grid-template-columns:repeat(${b.categories.length},minmax(0,1fr))">${cats}${vals}</div>
    ${podiums({ control: view.control, notes: { [view.control]: '<span class="tag">In control</span>' } })}`;
}

function wagerScene() {
  const c = view.clue;
  return `${header(`${esc(c.category)} <span class="value-chip">${pts(c.value)}</span>`)}
    <div class="panel">
      <div class="big" style="font-size:130px">DON’T TRIP!</div>
      <div class="sub">${esc(nameOf(view.control))} is choosing a wager</div>
    </div>
    ${podiums({ lit: [view.control], notes: { [view.control]: note('Wagering') } })}`;
}

function clueScene() {
  const c = view.clue;
  const tb = c.kind === 'tiebreaker';
  const right = tb
    ? 'Tiebreaker'
    : `${esc(c.category)} <span class="value-chip">${c.wager ? `DON’T TRIP! ${pts(c.wagerAmount)}` : pts(c.value)}</span>`;
  const notes = {};
  for (const id of c.attempted || []) notes[id] = note('Missed');
  let lit = [];
  let label = '';
  if (c.answering) {
    lit = [c.answering];
    const first = view.lastBuzz?.[0];
    notes[c.answering] = note(first && first.id === c.answering && first.ms != null ? `Buzzed · ${secs(first.ms)} s` : 'Answering');
    label = c.overtime ? `${nameOf(c.answering)}: time’s up` : `${nameOf(c.answering)} answering`;
  } else if (c.revealed && c.correctBy) {
    lit = [c.correctBy];
    notes[c.correctBy] = note('Correct');
  } else if (c.armed) {
    label = 'Buzzers open';
  }
  const outcome =
    c.outcome === 'timeout' ? 'Time’s up' : c.outcome === 'incorrect' ? (c.wager ? 'Missed' : 'Nobody got it') : '';
  const answer = c.revealed
    ? `<div class="answer">${esc(c.response)}</div>${outcome ? `<div class="sub">${outcome}</div>` : ''}`
    : '';
  const out = c.eligible ? view.seats.filter((s) => !c.eligible.includes(s.id)).map((s) => s.id) : [];
  return `${header(right)}
    ${cluePanel(c.text, (c.media ? mediaClueSize(c.text) : clueSize(c.text)) - (c.revealed ? (c.media ? 4 : 8) : 0), mediaSlot(c.key, c.media), answer)}
    ${c.answering && c.overtime ? `<div class="timer-row"><span class="who">${esc(label)}</span></div>` : timerRow(label, c.revealed ? null : c.timer)}
    ${podiums({ lit, notes, out })}`;
}

function finalCategoryScene() {
  const f = view.final;
  const notes = {};
  for (const id of f.eligible) notes[id] = note(f.wagered.includes(id) ? 'Wager in' : 'Wagering');
  const out = view.seats.filter((s) => !f.eligible.includes(s.id)).map((s) => s.id);
  return `${header('Final Round')}
    <div class="panel">
      <div class="label" style="font-size:22px">Final Round Category</div>
      <div class="big" style="font-size:110px">${esc(f.category)}</div>
      <div class="sub">Players are making their wagers</div>
    </div>
    ${podiums({ notes, out })}`;
}

function finalClueScene() {
  const f = view.final;
  const notes = {};
  for (const id of f.eligible) notes[id] = note(f.responded.includes(id) ? 'Response in' : 'Writing');
  const out = view.seats.filter((s) => !f.eligible.includes(s.id)).map((s) => s.id);
  return `${header(`Final Round · ${esc(f.category)}`)}
    ${cluePanel(f.clue, f.media ? mediaClueSize(f.clue) : clueSize(f.clue), mediaSlot('final', f.media))}
    ${timerRow('Thinking time', f.timer)}
    ${podiums({ notes, out })}`;
}

function finalRevealScene() {
  const f = view.final;
  const order = f.order || [];
  const cards = order
    .map((id, i) => {
      const r = f.reveals[i];
      const current = i === f.index && r && r.correct === null;
      return `<div class="reveal-card${current ? ' current' : ''}">
        <div class="name">${esc(nameOf(id))}</div>
        <div class="resp">${r ? esc(r.response || '(no response)') : '…'}</div>
        <div class="meta">${r && r.correct !== null ? `${r.correct ? 'Correct' : 'Incorrect'} · wager ${pts(r.wager)}` : ''}</div>
      </div>`;
    })
    .join('');
  const cols = Math.min(Math.max(order.length, 1), 4);
  return `${header(`Final Round · ${esc(f.category)}`)}
    <div class="panel" style="padding:28px 40px">
      <div class="reveal-cards" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${cards}</div>
      ${f.response ? `<div class="answer">${esc(f.response)}</div>` : ''}
    </div>
    ${podiums({ lit: f.index >= 0 && f.reveals[f.index]?.correct === null ? [order[f.index]] : [] })}`;
}

function overScene() {
  const winners = view.winners || [];
  const title = !winners.length ? 'No winner' : winners.length > 1 ? 'Co-champions' : 'Winner';
  const names = winners.map((id) => esc(nameOf(id))).join(' & ');
  return `${header('Game Over')}
    <div class="panel">
      <div class="label" style="font-size:24px">${title}</div>
      ${names ? `<div class="big" style="font-size:${names.length > 18 ? 88 : 120}px">${names}</div>` : '<div class="sub">Nobody finished above zero</div>'}
    </div>
    ${podiums({ lit: winners })}`;
}

startTimerLoop();
const fromLink = hashParams.get('password');
const remembered = JSON.parse(sessionStorage.getItem('cr:stream') || 'null')?.password;
joinPassword = fromLink || remembered || '';
render();
renderJoin();
($(joinPassword ? '#stream-form button' : '#stream-password') || {}).focus?.();
