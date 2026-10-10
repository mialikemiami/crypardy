import { buildGame } from './csv.js';
import { $, esc, fmt } from './util.js';
import { mediaLabel, parseMedia, previewHtml } from './media.js';
import {
  MAX_ROUNDS,
  checkDraft,
  draftFromGame,
  draftToCSV,
  emptyDraft,
  emptyRound,
  defaultValue,
  fileName,
} from './gamefile.js';

const app = $('#app');
const SIGNIN_URL = '/.netlify/functions/create-signin';
const DRAFT_KEY = 'cr:create-draft';
const SESSION_KEY = 'cr:create';

let signedIn = false;
let loginError = '';
let busy = false;
let tab = 'r0';
let catTab = {};
let draft = loadDraft();
let notice = '';

function loadDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (saved?.rounds?.length) return saved;
  } catch {
  }
  return emptyDraft();
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
  }
}

function session(value) {
  try {
    if (value === undefined) return sessionStorage.getItem(SESSION_KEY) === '1';
    if (value) sessionStorage.setItem(SESSION_KEY, '1');
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
  }
  return false;
}

async function signIn(password) {
  busy = true;
  loginError = '';
  render();
  try {
    let res;
    try {
      res = await fetch(SIGNIN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch {
      throw new Error('Could not reach the sign-in service. Check your connection.');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 404 && !data) throw new Error('Sign-in service not found. Check that the site is deployed on Netlify with its functions.');
      throw new Error(data?.error || `Sign-in failed (${res.status}).`);
    }
    signedIn = true;
    session(true);
  } catch (err) {
    loginError = err.message;
  }
  busy = false;
  render();
}

function signOut() {
  signedIn = false;
  session(false);
  render();
}

function setPath(path, value) {
  const keys = path.split('.');
  let obj = draft;
  for (const k of keys.slice(0, -1)) obj = obj[k];
  obj[keys[keys.length - 1]] = value;
}

const has = (v) => String(v ?? '').trim() !== '';
const roundHasContent = (round) =>
  round.categories.some((c) => has(c.name) || c.clues.some((q) => has(q.clue) || has(q.response)));
const draftHasContent = () =>
  has(draft.title) || draft.rounds.some(roundHasContent) || [draft.final, draft.tiebreaker].some((s) => has(s.clue) || has(s.category));

function flash(text) {
  notice = text;
  render();
  clearTimeout(flash.t);
  flash.t = setTimeout(() => {
    notice = '';
    render();
  }, 4000);
}

function download() {
  const csv = draftToCSV(draft);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(draft.title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importText(text, name) {
  let built;
  try {
    built = buildGame(text, { title: name });
  } catch (err) {
    flash(`Couldn’t open that file: ${err.message}`);
    return;
  }
  if (draftHasContent() && !confirm('Replace what’s here with that file?')) return;
  draft = draftFromGame(built.game, name);
  tab = 'r0';
  catTab = {};
  saveDraft();
  flash(`Opened ${name}.`);
}

document.addEventListener('submit', (e) => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  signIn($('#create-password')?.value || '');
});

document.addEventListener('input', (e) => {
  const el = e.target;
  const path = el.dataset?.path;
  if (!path) return;
  let value = el.type === 'checkbox' ? el.checked : el.value;
  setPath(path, value);
  saveDraft();
  renderCheck();
  const m = path.match(/^rounds\.(\d+)\./);
  if (m) refreshRoundLabels(Number(m[1]));
  if (path.endsWith('.media')) schedulePreview(path, el.value);
});

const previewTimers = {};
function schedulePreview(path, value) {
  clearTimeout(previewTimers[path]);
  previewTimers[path] = setTimeout(() => {
    const box = [...document.querySelectorAll('[data-preview]')].find((b) => b.dataset.preview === path);
    if (box) box.innerHTML = previewFor(value);
  }, 500);
}

document.addEventListener('change', (e) => {
  if (e.target.id !== 'csv-file') return;
  const file = e.target.files?.[0];
  e.target.value = '';
  if (file) file.text().then((t) => importText(t, file.name.replace(/\.csv$/i, '')));
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  switch (d.act) {
    case 'tab':
      tab = d.tab;
      render();
      break;
    case 'cat':
      catTab[Number(d.r)] = Number(d.c);
      render();
      document.querySelector(`[data-cat-tab="${d.r}-${d.c}"]`)?.focus();
      break;
    case 'add-round':
      if (draft.rounds.length < MAX_ROUNDS) {
        draft.rounds.push(emptyRound(draft.rounds.length));
        tab = `r${draft.rounds.length - 1}`;
        saveDraft();
        render();
      }
      break;
    case 'remove-round': {
      const r = Number(d.r);
      if (draft.rounds.length < 2 || r !== draft.rounds.length - 1) break;
      if (roundHasContent(draft.rounds[r]) && !confirm(`Delete everything in Round ${r + 1}?`)) break;
      draft.rounds.pop();
      tab = `r${draft.rounds.length - 1}`;
      saveDraft();
      render();
      break;
    }
    case 'import':
      $('#csv-file').click();
      break;
    case 'sample':
      if (draftHasContent() && !confirm('Replace what’s here with the sample game?')) break;
      fetch('sample-game.csv')
        .then((r) => (r.ok ? r.text() : Promise.reject()))
        .then((t) => {
          draft = emptyDraft();
          importText(t, 'Sample game');
        })
        .catch(() => flash('Couldn’t load the sample game.'));
      break;
    case 'download':
      download();
      break;
    case 'clear':
      if (!confirm('Clear the whole game and start over?')) break;
      draft = emptyDraft();
      tab = 'r0';
      saveDraft();
      render();
      break;
    case 'sign-out':
      signOut();
      break;
    default:
  }
});

function render() {
  if (!signedIn) {
    app.innerHTML = loginView();
    $('#create-password')?.focus();
    return;
  }
  app.innerHTML = `<div class="wrap">
    ${topBar()}
    <div class="layout">
      <div class="editor">${tabsView()}${tab === 'final' ? singlesView() : roundView(Number(tab.slice(1)))}</div>
      <aside class="check card" id="check" aria-live="polite"></aside>
    </div>
    ${notice ? `<div class="msg toast" role="status">${esc(notice)}</div>` : ''}
  </div>`;
  renderCheck();
}

function loginView() {
  return `<div class="centered">
    <form class="card login" id="login-form">
      <div class="wordmark" style="font-size:44px">CRYPARDY<span>!</span></div>
      <h1 class="h" style="font-size:28px">Write a game</h1>
      <div class="field">
        <label for="create-password">Password</label>
        <input id="create-password" type="password" autocomplete="current-password" required>
      </div>
      ${loginError ? `<div class="error" role="alert">${esc(loginError)}</div>` : ''}
      <button class="btn" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Open the game writer'}</button>
      <a class="link" href="./">Back to Crypardy</a>
    </form>
  </div>`;
}

function topBar() {
  return `<header class="top">
    <div class="brand">
      <div class="wordmark" style="font-size:34px">CRYPARDY<span>!</span></div>
      <strong>Write a game</strong>
    </div>
    <div class="actions">
      <button class="btn small" data-act="download">Download CSV</button>
      <button class="link" data-act="import">Open a CSV</button>
      <button class="link" data-act="sample">Start from the sample</button>
      <button class="link" data-act="clear">Clear</button>
      <button class="link" data-act="sign-out">Sign out</button>
    </div>
  </header>
  <div class="field" style="max-width:560px">
    <label for="game-title">Game Name</label>
    <input id="game-title" type="text" data-path="title" value="${esc(draft.title)}" placeholder="Vince night, week 3" autocomplete="off">
    <span class="hint">Used for the file name.</span>
  </div>`;
}

function tabsView() {
  const tabs = draft.rounds
    .map((_, r) => `<button class="tab" role="tab" aria-selected="${tab === `r${r}`}" data-act="tab" data-tab="r${r}">Round ${r + 1}</button>`)
    .join('');
  const add = draft.rounds.length < MAX_ROUNDS ? '<button class="tab add" data-act="add-round">+ Round</button>' : '';
  return `<div class="tabs" role="tablist">${tabs}<button class="tab" role="tab" aria-selected="${tab === 'final'}" data-act="tab" data-tab="final">Final &amp; Tiebreaker</button>${add}</div>`;
}

const cluesDone = (cat) => cat.clues.filter((q) => has(q.clue) && has(q.response)).length;
const catLabel = (cat, ci) => (has(cat.name) ? esc(cat.name) : `Category ${ci + 1}`);

function catTabInner(r, ci) {
  const cat = draft.rounds[r].categories[ci];
  const trip = cat.clues.some((q) => q.trip);
  return `<span class="cat-tab-name">${catLabel(cat, ci)}</span><span class="cat-tab-count">${cluesDone(cat)}/5${trip ? ' ◆' : ''}</span>`;
}

function refreshRoundLabels(r) {
  draft.rounds[r]?.categories.forEach((cat, ci) => {
    const t = document.querySelector(`[data-cat-tab="${r}-${ci}"]`);
    if (t) t.innerHTML = catTabInner(r, ci);
  });
  const head = document.querySelector(`[data-cat-head="${r}"]`);
  if (head) {
    const ci = Number(head.dataset.c);
    head.innerHTML = catLabel(draft.rounds[r].categories[ci], ci);
  }
}

function roundView(r) {
  const round = draft.rounds[r];
  if (!round) {
    tab = 'r0';
    return roundView(0);
  }
  const ci = Math.min(catTab[r] ?? 0, round.categories.length - 1);
  const cat = round.categories[ci];
  const removable = draft.rounds.length > 1 && r === draft.rounds.length - 1;
  const names = round.categories
    .map(
      (c, i) => `<div class="name-slot">
        <label class="name-num" for="r${r}n${i}">${i + 1}</label>
        <input id="r${r}n${i}" type="text" data-path="rounds.${r}.categories.${i}.name" value="${esc(c.name)}" placeholder="Category ${i + 1}" autocomplete="off">
      </div>`,
    )
    .join('');
  const tabs = round.categories
    .map(
      (c, i) =>
        `<button class="cat-tab" role="tab" aria-selected="${i === ci}" data-act="cat" data-r="${r}" data-c="${i}" data-cat-tab="${r}-${i}">${catTabInner(r, i)}</button>`,
    )
    .join('');
  const rows = cat.clues
    .map((q, row) => {
      const p = `rounds.${r}.categories.${ci}.clues.${row}`;
      const id = `r${r}c${ci}q${row}`;
      return `<li class="clue-row">
        <span class="value-chip">${fmt(defaultValue(r, row))}</span>
        <div class="clue-fields">
          <label class="sr-only" for="${id}-c">Clue for ${fmt(defaultValue(r, row))}</label>
          <textarea id="${id}-c" rows="2" data-path="${p}.clue" placeholder="Clue">${esc(q.clue)}</textarea>
          <label class="sr-only" for="${id}-r">Correct Response</label>
          <input id="${id}-r" type="text" data-path="${p}.response" value="${esc(q.response)}" placeholder="Correct response: What is …?" autocomplete="off">
          ${mediaField(p, id, q.media)}
          ${noteField(p, id, q.note)}
        </div>
        <label class="trip-toggle"><input type="checkbox" data-path="${p}.trip" ${q.trip ? 'checked' : ''}>DON’T TRIP!</label>
      </li>`;
    })
    .join('');
  return `<div class="round-head">
      <h2 class="h">Round ${r + 1}</h2>
      ${removable ? `<button class="link" data-act="remove-round" data-r="${r}">Delete this round</button>` : ''}
    </div>
    <section class="card names">
      <div class="label">Categories</div>
      <div class="name-grid">${names}</div>
      <p class="hint">Leave a category empty to skip it.</p>
    </section>
    <section class="card cat-panel">
      <div class="cat-tabs" role="tablist">${tabs}</div>
      <h3 class="h cat-head" data-cat-head="${r}" data-c="${ci}">${catLabel(cat, ci)}</h3>
      <ol class="clue-list">${rows}</ol>
      <p class="hint">Clues are worth ${fmt(defaultValue(r, 0))} to ${fmt(defaultValue(r, 4))}. Leave a clue empty to skip it. Mark at least one DON’T TRIP! clue per round.</p>
    </section>`;
}

function previewFor(value) {
  if (!has(value)) return '';
  const m = parseMedia(value);
  if (!m) return '<p class="hint media-bad">This link won’t work. Use a full link that starts with https://</p>';
  const hint =
    m.type === 'youtube'
      ? 'YouTube video. If the preview says it’s unavailable, its owner blocks playing it on other sites.'
      : m.type === 'image'
        ? 'Image. Shows with the clue.'
        : `${mediaLabel(m)}. Plays on the stream when the host presses Play.`;
  return `${previewHtml(m)}<p class="hint">${esc(hint)}</p>`;
}

function mediaField(p, id, value) {
  return `<details class="note" ${has(value) ? 'open' : ''}>
    <summary>Image or Video</summary>
    <label class="sr-only" for="${id}-m">Image or video link</label>
    <input id="${id}-m" type="text" inputmode="url" data-path="${p}.media" value="${esc(value)}" placeholder="https:// link to an image, video, audio clip or YouTube" autocomplete="off" spellcheck="false">
    <div class="media-preview" data-preview="${esc(`${p}.media`)}">${previewFor(value)}</div>
  </details>`;
}

function noteField(p, id, note) {
  return `<details class="note" ${has(note) ? 'open' : ''}>
    <summary>Host Note</summary>
    <label class="sr-only" for="${id}-n">Host Note</label>
    <input id="${id}-n" type="text" data-path="${p}.note" value="${esc(note)}" placeholder="Only the host sees this" autocomplete="off">
  </details>`;
}

function singlesView() {
  const block = (key, title, hint) => {
    const s = draft[key];
    const id = key;
    return `<section class="card single">
      <h2 class="h">${title}</h2>
      <p class="hint">${hint}</p>
      <div class="field"><label for="${id}-cat">Category</label>
        <input id="${id}-cat" type="text" data-path="${key}.category" value="${esc(s.category)}" autocomplete="off"></div>
      <div class="field"><label for="${id}-c">Clue</label>
        <textarea id="${id}-c" rows="3" data-path="${key}.clue">${esc(s.clue)}</textarea></div>
      <div class="field"><label for="${id}-r">Correct Response</label>
        <input id="${id}-r" type="text" data-path="${key}.response" value="${esc(s.response)}" placeholder="What is …?" autocomplete="off"></div>
      ${mediaField(key, id, s.media)}
      ${noteField(key, id, s.note)}
    </section>`;
  };
  return `<div class="singles">
    ${block('final', 'Final Round', 'Everyone above 0 wagers, then writes a response. Leave it empty to end after the last round.')}
    ${block('tiebreaker', 'Tiebreaker', 'Only used when two or more players tie for first. Optional.')}
  </div>`;
}

function renderCheck() {
  const el = $('#check');
  if (!el) return;
  const csv = draftToCSV(draft);
  let built = null;
  let error = '';
  try {
    built = buildGame(csv, { title: draft.title });
  } catch (err) {
    error = err.message;
  }
  const issues = checkDraft(draft);
  const rounds = draft.rounds
    .map((round, r) => {
      const cats = round.categories.filter((c) => c.clues.some((q) => has(q.clue) || has(q.response)));
      const clues = cats.reduce((n, c) => n + c.clues.filter((q) => has(q.clue) || has(q.response)).length, 0);
      const trips = cats.reduce((n, c) => n + c.clues.filter((q) => q.trip && (has(q.clue) || has(q.response))).length, 0);
      const cells = [];
      for (let row = 0; row < 5; row++) {
        round.categories.forEach((c) => {
          const q = c.clues[row];
          const on = has(q.clue) || has(q.response);
          cells.push(`<i class="${on ? (q.trip ? 'is-trip' : 'on') : ''}"></i>`);
        });
      }
      return `<div class="stat"><span><strong>Round ${r + 1}</strong></span><span>${cats.length} categories · ${clues} clues · ${trips} DON’T TRIP!</span></div>
        <div class="mini" style="grid-template-columns:repeat(${round.categories.length},1fr)" aria-hidden="true">${cells.join('')}</div>`;
    })
    .join('');
  const total = draft.rounds.reduce(
    (n, round) => n + round.categories.reduce((m, c) => m + c.clues.filter((q) => has(q.clue) || has(q.response)).length, 0),
    0,
  );
  el.innerHTML = `<h2 class="h" style="font-size:26px">Check</h2>
    ${rounds}
    <div class="stat"><strong>Final</strong><span>${has(draft.final.clue) ? esc(draft.final.category || 'Untitled') : 'None'}</span></div>
    <div class="stat"><strong>Tiebreaker</strong><span>${has(draft.tiebreaker.clue) ? esc(draft.tiebreaker.category || 'Untitled') : 'None'}</span></div>
    ${error && !issues.length ? `<div class="error">${esc(error)}</div>` : ''}
    ${
      issues.length
        ? `<div class="label">To Fix (${fmt(issues.length)})</div><ul class="issues">${issues.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`
        : built
          ? '<p class="ok">Ready. The host view can load this file.</p>'
          : ''
    }
    <button class="btn wide" data-act="download" ${total ? '' : 'disabled'}>Download ${esc(fileName(draft.title))}</button>
    <p class="hint">Load the file in the host view with <strong>Load CSV</strong>. Your draft saves in this browser as you type.</p>`;
}

signedIn = session();
render();
