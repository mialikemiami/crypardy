import { connect } from './transport.js';
import { $, esc, fmt, renderInto, startTimerLoop, typingInField } from './util.js';
import { createMediaLayer, mediaSlot, syncMediaLayer } from './media.js';

const app = $('#app');
const mediaLayer = createMediaLayer({ muted: true });
let attachedAt = 0;

let conn = null;
let connStatus = 'offline';
let me = null;
let myName = '';
let view = null;
let latest = { sid: null, seq: -1 };
let receivedAt = 0;
let joinError = '';
let formError = '';
let busy = false;
let lastPress = 0;
let earlyUntil = 0;
let pressedAt = 0;
let pickSentAt = 0;
let wagerSentFor = '';
let finalWagerSent = null;
let responseSent = null;
let autoTimer = null;
let draftTimer = null;
let holding = false;
let tripKey = null;
let tripUntil = 0;
const TRIP_MS = 3100;
const deadlines = new Map();

const cleanName = (n) =>
  String(n || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
const nameOf = (id) => view?.seats?.find((s) => s.id === id)?.name || 'Someone';
const clueKey = () => (view?.clue ? `${view.round?.index ?? 't'}-${view.clue.kind}-${view.clue.cat}-${view.clue.row}` : 'none');
function deadlineOf(timer) {
  const key = `${clueKey()}:${timer.kind}`;
  const next = receivedAt + timer.remaining;
  const old = deadlines.get(key);
  if (old != null && Math.abs(old - next) < 400) return old;
  deadlines.set(key, next);
  return next;
}

async function join(password, name) {
  myName = cleanName(name);
  if (!myName) {
    joinError = 'Enter your name.';
    render();
    return;
  }
  busy = true;
  joinError = '';
  render();
  try {
    conn = await connect({
      role: 'player',
      password,
      onStatus: (s) => {
        connStatus = s;
        if (conn) render();
      },
    });
    connStatus = 'connected';
    me = conn.clientId;
    localStorage.setItem('cr:name', myName);
    sessionStorage.setItem('cr:play', JSON.stringify({ password }));
    await conn.enter('lobby', { role: 'player', name: myName });
    attachedAt = Date.now();
    await conn.subscribe('public', onPublic);
  } catch (err) {
    conn = null;
    joinError = err.message;
  }
  busy = false;
  render();
}

function leave() {
  sessionStorage.removeItem('cr:play');
  conn?.close();
  location.reload();
}

function fresh(sentAt) {
  if (sentAt && conn?.clockKnown()) return Date.now() + conn.serverOffset() - sentAt < 3000;
  return Date.now() - attachedAt >= 2000;
}

function onEvent(ev, sentAt) {
  if (ev?.type !== 'media' || !fresh(sentAt)) return;
  if (ev.action === 'play') mediaLayer.play(ev.key);
  else mediaLayer.stop(ev.key);
}

function onPublic(m) {
  if (m.name === 'event') return onEvent(m.data, m.timestamp);
  if (m.name !== 'state' || !m.data?.view) return;
  const { sid, seq, view: v } = m.data;
  if (sid === latest.sid && seq <= latest.seq) return;
  latest = { sid, seq };
  view = v;
  receivedAt = Date.now();
  formError = '';
  if (view.phase !== 'wager') tripKey = null;
  else if (clueKey() !== tripKey) {
    tripKey = clueKey();
    tripUntil = receivedAt + TRIP_MS;
    setTimeout(render, TRIP_MS + 50);
  }
  scheduleAutoSend();
  render();
}

const send = (event, data) => conn?.publish('input', event, data).catch(() => {});

function buzz() {
  const c = view?.clue;
  if (!c) return;
  const now = Date.now();
  if (now - lastPress < 250) return;
  lastPress = now;
  if (c.armed) {
    pressedAt = now;
    setTimeout(render, 2050);
  } else {
    earlyUntil = now + 700;
    setTimeout(render, 750);
  }
  send('buzz', {});
  render();
}

function roundMax() {
  const cells = view?.board?.cells?.flat().filter(Boolean) || [];
  return Math.max(0, ...cells.map((c) => c.value));
}

function readAmount(id, min, max) {
  const raw = $(`#${id}`)?.value ?? '';
  const n = Number(String(raw).replace(/[, ]/g, ''));
  if (raw === '' || !Number.isInteger(n) || n < min || n > max) {
    formError = `Enter a whole number from ${fmt(min)} to ${fmt(max)}.`;
    render();
    return null;
  }
  return n;
}

function sendResponse(text) {
  clearTimeout(draftTimer);
  responseSent = text;
  send('final-response', { text });
  render();
}

function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (view?.phase !== 'final-clue') return;
    const text = $('#final-response')?.value?.trim();
    if (text && text !== responseSent) sendResponse(text);
  }, 400);
}

function scheduleAutoSend() {
  clearTimeout(autoTimer);
  const f = view?.final;
  if (view?.phase !== 'final-clue' || !f?.timer || !f.eligible.includes(me)) return;
  autoTimer = setTimeout(
    () => {
      const text = $('#final-response')?.value?.trim();
      if (text && text !== responseSent) sendResponse(text);
    },
    Math.max(0, f.timer.remaining - 800),
  );
}

document.addEventListener('submit', (e) => {
  e.preventDefault();
  if (e.target.id === 'join-form') join($('#join-password').value, $('#join-name').value);
  else if (e.target.id === 'response-form') {
    const text = $('#final-response').value.trim();
    if (text) sendResponse(text);
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'final-response') saveDraft();
});

document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-act="buzz"]');
  if (!el || el.disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
  e.preventDefault();
  holding = true;
  buzz();
});
const letGo = () => {
  if (!holding) return;
  holding = false;
  render();
};
document.addEventListener('pointerup', letGo);
document.addEventListener('pointercancel', letGo);
window.addEventListener('blur', letGo);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  switch (d.act) {
    case 'buzz':
      if (e.detail === 0) buzz();
      break;
    case 'pick':
      pickSentAt = Date.now();
      send('pick', { cat: Number(d.cat), row: Number(d.row) });
      setTimeout(render, 2600);
      render();
      break;
    case 'send-wager': {
      const seat = view.seats.find((s) => s.id === me);
      const max = Math.max(seat.score, roundMax());
      const amount = readAmount(d.input, Math.min(5, max), max);
      if (amount == null) return;
      wagerSentFor = clueKey();
      send('wager', { amount });
      render();
      break;
    }
    case 'fw-quick': {
      const seat = view.seats.find((s) => s.id === me);
      const amount = d.kind === 'none' ? 0 : d.kind === 'half' ? Math.floor(seat.score / 2) : seat.score;
      const input = $('#final-wager');
      if (input) input.value = String(amount);
      break;
    }
    case 'send-final-wager': {
      const seat = view.seats.find((s) => s.id === me);
      const amount = readAmount('final-wager', 0, seat.score);
      if (amount == null) return;
      finalWagerSent = amount;
      send('final-wager', { amount });
      render();
      break;
    }
    case 'leave':
      leave();
      break;
    default:
  }
  if (el.tagName === 'BUTTON' && d.act !== 'buzz') el.blur();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || typingInField(e)) return;
  const btn = document.querySelector('[data-act="buzz"]:not(:disabled)');
  if (!btn) return;
  e.preventDefault();
  if (!e.repeat) buzz();
});

function render() {
  if (!conn) return renderJoin();
  const seat = view?.seats?.find((s) => s.id === me) || null;
  const trip =
    Date.now() < tripUntil && view?.phase === 'wager'
      ? '<div class="trip" role="alert"><div class="trip-text">DON’T TRIP!</div></div>'
      : '';
  renderInto(app, `<div class="phone">${top(seat)}<div class="body">${body(seat)}</div>${foot()}</div>${trip}`);
  syncMediaLayer(mediaLayer, app);
}

function renderJoin() {
  const fromLink = decodeURIComponent((location.hash.match(/password=([^&]*)/) || [])[1] || '');
  renderInto(
    app,
    `<div class="centered">
      <form class="card login" id="join-form">
        <div class="wordmark" style="font-size:44px">CRYPARDY<span>!</span></div>
        <h1 class="h" style="font-size:28px">Join the Game</h1>
        <div class="field">
          <label for="join-password">Game Password</label>
          <input id="join-password" type="text" autocomplete="off" spellcheck="false" autocapitalize="none" required value="${esc(fromLink)}">
          <span class="hint">The host shares this. It isn’t case-sensitive.</span>
        </div>
        <div class="field">
          <label for="join-name">Your Name</label>
          <input id="join-name" type="text" autocomplete="nickname" maxlength="24" required value="${esc(localStorage.getItem('cr:name') || '')}">
          <span class="hint">You could use your Discord display name so the host can find you in the Stage.</span>
        </div>
        ${joinError ? `<div class="error" role="alert">${esc(joinError)}</div>` : ''}
        <button class="btn" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Joining…' : 'Join'}</button>
      </form>
    </div>`,
  );
}

function top(seat) {
  return `<header class="top">
    <div class="wordmark" style="font-size:26px">CRYPARDY<span>!</span></div>
    <div class="me">
      <span style="font-size:12px">${esc(seat?.name || myName)} · you</span>
      <span class="score">${seat ? fmt(seat.score) : 'Not Seated'}</span>
    </div>
  </header>`;
}

function foot() {
  const seats = view?.seats || [];
  if (!seats.length) {
    return '<footer class="foot"><button class="link" data-act="leave" style="justify-self:start">Leave game</button></footer>';
  }
  return `<footer class="foot" style="grid-template-columns:repeat(${seats.length},minmax(0,1fr))">
    ${seats.map((s) => `<div><span class="name">${esc(s.name)}${s.id === me ? ' (you)' : ''}</span><span class="pts">${fmt(s.score)}</span></div>`).join('')}
  </footer>`;
}

function body(seat) {
  const warn = `<div class="warn-slot">${
    connStatus !== 'connected' ? `<div class="error" role="status">Connection ${esc(connStatus)}. Reconnecting…</div>` : ''
  }</div>`;
  if (!view) return `${warn}<p>Connected. Waiting for the host’s game…</p>`;
  if (!seat) return warn + spectator();
  switch (view.phase) {
    case 'lobby':
      return `${warn}<div class="msg">You’re seated! The game starts soon.</div>`;
    case 'board':
      return warn + boardView();
    case 'wager':
      return warn + wagerView(seat);
    case 'clue':
    case 'reveal':
    case 'tiebreaker':
      return warn + clueView();
    case 'final-category':
      return warn + finalWagerView(seat);
    case 'final-clue':
      return warn + finalClueView();
    case 'final-reveal':
      return warn + finalRevealView();
    case 'over':
      return warn + overView();
    default:
      return warn;
  }
}

function spectator() {
  if (view.phase === 'lobby') {
    return `<div class="msg">You’re in the lobby. The host will seat you soon.</div>
      <p class="hint">Not seated in time? You can watch and the host can seat you in the next game.</p>
      <button class="link" data-act="leave" style="align-self:flex-start">Leave game</button>`;
  }
  const c = view.clue;
  return `<div class="msg">You’re watching this game. The host can seat you in the next one.</div>
    ${c?.text ? `<div class="card clue">${clueHead(c)}<p class="clue-text">${esc(c.text)}</p>${mediaSlot(c.key, c.media)}</div>` : ''}`;
}

function clueHead(c) {
  const chip =
    c.kind === 'tiebreaker'
      ? 'Tiebreaker'
      : c.wager && c.wagerAmount != null
        ? `DON’T TRIP! · ${fmt(c.wagerAmount)}`
        : fmt(c.value);
  return `<div class="clue-head"><span class="label">${esc(c.category)}</span><span class="value-chip">${chip}</span></div>`;
}

function timerBar(timer) {
  return `<div class="timer"><div class="bar" data-deadline="${deadlineOf(timer)}" data-total="${timer.total}"><i></i></div></div>`;
}

function boardView() {
  const mine = view.control === me;
  const b = view.board;
  const locked = !mine || Date.now() - pickSentAt < 2500;
  const banner = mine
    ? '<div class="msg"><strong style="font-size:17px">You’re in control</strong><br>Tap a clue to pick it, and say it out loud for the stream.</div>'
    : `<div class="msg"><strong>${esc(nameOf(view.control))}</strong> is picking a clue.</div>`;
  const rows = b.categories
    .map(
      (cat, ci) => `<div class="cat-row">
        <div class="cat-name">${esc(cat)}</div>
        <div class="vals" style="grid-template-columns:repeat(${b.rows},minmax(0,1fr))">
          ${b.cells[ci]
            .map((cell, row) =>
              !cell || cell.used
                ? `<button class="val used" disabled aria-label="${esc(cat)}, played"></button>`
                : `<button class="val" data-act="pick" data-cat="${ci}" data-row="${row}" ${locked ? 'disabled' : ''} aria-label="${esc(cat)} for ${cell.value}">${fmt(cell.value)}</button>`,
            )
            .join('')}
        </div>
      </div>`,
    )
    .join('');
  return `${banner}<div class="cats">${rows}</div>`;
}

function wagerView(seat) {
  const c = view.clue;
  if (view.control !== me) {
    return `${clueHead(c)}<h2 class="h big">DON’T TRIP!</h2>
      <div class="msg"><strong>${esc(nameOf(view.control))}</strong> is choosing a wager.</div>`;
  }
  const max = Math.max(seat.score, roundMax());
  const min = Math.min(5, max);
  const inputId = `wager-${clueKey()}`;
  const sent = wagerSentFor === clueKey();
  return `${clueHead(c)}<h2 class="h big">DON’T TRIP!</h2>
    <p>You found a DON’T TRIP! Only you answer this. Wager from ${fmt(min)} to ${fmt(max)} then say your response out loud when the clue appears.</p>
    <div class="card" style="display:flex;flex-direction:column;gap:14px">
      <div class="field">
        <label for="${inputId}">Your Wager</label>
        <input id="${inputId}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1">
      </div>
      ${formError ? `<div class="error" role="alert">${esc(formError)}</div>` : ''}
      <button class="btn wide" data-act="send-wager" data-input="${inputId}">${sent ? 'Wager Sent · send again' : 'Lock in wager'}</button>
    </div>`;
}

function outcomeLine(c) {
  switch (c.outcome) {
    case 'correct':
      return c.correctBy === me ? 'You got it!' : `${esc(nameOf(c.correctBy))} got it!`;
    case 'incorrect':
      return c.wager ? 'Missed the DON’T TRIP!' : 'Nobody got it!';
    case 'timeout':
      return 'Time’s up!';
    case 'skipped':
      return 'The host skipped this clue.';
    default:
      return '';
  }
}

function clueView() {
  const c = view.clue;
  const head = `<div class="card clue">${clueHead(c)}<p class="clue-text">${esc(c.text || '')}</p>${mediaSlot(c.key, c.media)}</div>`;
  if (c.revealed) {
    return `${head}<div class="msg"><div class="label">Correct Response</div>
      <div class="response-line">${esc(c.response)}</div><div>${outcomeLine(c)}</div></div>`;
  }
  const answerTimer = c.timer?.kind === 'answer' ? timerBar(c.timer) : '';
  if (c.wager) {
    return c.answering === me
      ? `${head}<div class="buzz-wrap"><div class="buzzer in" role="status">YOU’RE UP</div><p>${c.overtime ? 'Time’s up! The host will rule.' : 'Say your response out loud.'}</p>${answerTimer}</div>`
      : `${head}<div class="msg"><strong>${esc(nameOf(c.answering))}</strong> is answering the DON’T TRIP!</div>`;
  }
  if (c.eligible && !c.eligible.includes(me)) {
    return `${head}<div class="msg">Only ${c.eligible.map((id) => esc(nameOf(id))).join(' and ')} can buzz on the tiebreaker.</div>`;
  }
  if (c.answering === me) {
    return `${head}<div class="buzz-wrap"><div class="buzzer in" role="status">YOU’RE IN</div><p>${c.overtime ? 'Time’s up! The host will rule.' : 'Say your response out loud.'}</p>${answerTimer}</div>`;
  }
  if (c.attempted.includes(me)) {
    return `${head}<div class="msg">You already answered this one, beloved.</div>`;
  }
  if (c.answering) {
    return `${head}<div class="buzz-wrap"><button class="buzzer" disabled>BUZZ</button>
      <p><strong>${esc(nameOf(c.answering))}</strong> is answering.</p>${answerTimer}</div>`;
  }
  const now = Date.now();
  const early = now < earlyUntil;
  const pressed = c.armed && now - pressedAt < 2000;
  const label = early ? 'TOO SOON' : pressed ? 'BUZZED' : 'BUZZ';
  return `${head}<div class="buzz-wrap">
    <div class="armed-line"><span class="dot ${c.armed ? 'live' : 'off'}"></span>${c.armed ? 'buzzers open' : 'wait for buzzers to open'}</div>
    <button class="buzzer ${c.armed ? 'armed' : 'waiting'}${holding ? ' down' : ''}${pressed ? ' pressed' : ''}" data-act="buzz">${label}</button>
    <p>Tap or press Space. Buzzing early locks you out for a moment.</p>
    ${c.timer?.kind === 'buzz' ? timerBar(c.timer) : ''}
  </div>`;
}

function finalWagerView(seat) {
  const f = view.final;
  const head = `<div class="label">Final Round</div><h2 class="h big">${esc(f.category)}</h2>`;
  if (!f.eligible.includes(me)) {
    return `${head}<div class="msg">You sit out the final round because your score is 0 or less.</div>`;
  }
  const sent = f.wagered.includes(me);
  return `${head}
    <div class="card" style="display:flex;flex-direction:column;gap:14px">
      <div class="field">
        <label for="final-wager">Your Wager</label>
        <span class="hint">Any amount from 0 to ${fmt(seat.score)}</span>
        <input id="final-wager" type="number" inputmode="numeric" min="0" max="${seat.score}" step="1">
      </div>
      <div class="quick">
        <button class="btn small" data-act="fw-quick" data-kind="none">Nothing</button>
        <button class="btn small" data-act="fw-quick" data-kind="half">Half</button>
        <button class="btn small" data-act="fw-quick" data-kind="all">All in</button>
      </div>
      ${formError ? `<div class="error" role="alert">${esc(formError)}</div>` : ''}
      <button class="btn wide" data-act="send-final-wager">${sent ? 'Update wager' : 'Lock in wager'}</button>
      <p class="hint">${sent ? `Locked in${finalWagerSent != null ? `: ${fmt(finalWagerSent)}` : ''}. You can change it until the clue appears.` : 'Only you and the host see your wager.'}</p>
    </div>`;
}

function finalClueView() {
  const f = view.final;
  const deadline = deadlineOf(f.timer);
  const head = `<div class="clue-head"><span class="label">Final Round · ${esc(f.category)}</span>
      <span class="value-chip" data-deadline="${deadline}" data-total="${f.timer.total}" data-countdown></span></div>
    <div class="card clue"><p class="clue-text">${esc(f.clue)}</p>${mediaSlot('final', f.media)}</div>`;
  if (!f.eligible.includes(me)) return `${head}<p>The players are writing their responses.</p>`;
  const sent = f.responded.includes(me);
  return `${head}
    <form class="card" id="response-form" style="display:flex;flex-direction:column;gap:14px">
      <div class="field">
        <label for="final-response">Your Response</label>
        <span class="hint">Phrase it as a question.</span>
        <input id="final-response" type="text" maxlength="200" autocomplete="off" spellcheck="false">
      </div>
      <button class="btn wide" type="submit">${sent ? 'Update response' : 'Lock in response'}</button>
      <p class="hint">${sent ? 'Saved. You can change it until time runs out.' : 'Hidden until the host reveals it. What you type is saved as you go.'}</p>
    </form>`;
}

function finalRevealView() {
  const f = view.final;
  return `<div class="label">Final Round · ${esc(f.category)}</div>
    <h2 class="h big">Reveals</h2>
    <div class="card clue"><p class="clue-text">${esc(f.clue)}</p>${mediaSlot('final', f.media)}</div>
    <ul class="reveals">${
      f.reveals
        .map(
          (r) => `<li><strong>${esc(nameOf(r.id))}${r.id === me ? ' (you)' : ''}</strong>
            <span class="response-line">${esc(r.response || '(no response)')}</span>
            <span>${r.correct === null ? 'Waiting for the host…' : `${r.correct ? 'Correct' : 'Incorrect'} · wager ${fmt(r.wager)}`}</span></li>`,
        )
        .join('') || '<li>The host is about to reveal the responses...</li>'
    }</ul>
    ${f.response ? `<div class="msg">Correct Response: <strong>${esc(f.response)}</strong></div>` : ''}`;
}

function overView() {
  const winners = view.winners || [];
  const ranked = [...view.seats].sort((a, b) => b.score - a.score);
  const title = winners.includes(me) ? 'You win!' : !winners.length ? 'No winner' : winners.length > 1 ? 'Co-champions' : 'Winner';
  return `<div class="label">Game Over</div>
    <h2 class="h big">${title}</h2>
    ${winners.length ? `<div class="winner">${winners.map((id) => esc(nameOf(id))).join(' & ')}</div>` : ''}
    <ul class="reveals">${ranked.map((s) => `<li><strong>${esc(s.name)}</strong><span>${fmt(s.score)}</span></li>`).join('')}</ul>
    <p>Thanks for playing!</p>`;
}

startTimerLoop();
const rememberedPw = JSON.parse(sessionStorage.getItem('cr:play') || 'null')?.password;
const rememberedName = localStorage.getItem('cr:name');
if (rememberedPw && rememberedName) join(rememberedPw, rememberedName);
else render();
