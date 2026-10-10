import { parseMedia } from './media.js';

export const MAX_ROUNDS = 3;
export const CATEGORIES = 6;
export const CLUES = 5;
export const COLUMNS = ['round', 'category', 'value', 'clue', 'media', 'response', 'note', 'dont_trip'];

export const defaultValue = (roundIndex, row) => (row + 1) * 200 * (roundIndex + 1);

const emptyClue = () => ({ clue: '', media: '', response: '', note: '', trip: false });
const emptySingle = () => ({ category: '', clue: '', media: '', response: '', note: '' });

export function emptyRound(roundIndex) {
  return {
    categories: Array.from({ length: CATEGORIES }, () => ({
      name: '',
      clues: Array.from({ length: CLUES }, () => emptyClue()),
    })),
  };
}

export function emptyDraft() {
  return { title: '', rounds: [emptyRound(0), emptyRound(1)], final: emptySingle(), tiebreaker: emptySingle() };
}

const has = (v) => String(v ?? '').trim() !== '';
const clueStarted = (c) => has(c.clue) || has(c.media) || has(c.response) || has(c.note);
const singleStarted = (s) => has(s.category) || has(s.clue) || has(s.media) || has(s.response);
const badMedia = (v) => has(v) && !parseMedia(v);
const MEDIA_FIX = 'the image or video link needs to be a full link starting with https://';

export function csvField(v) {
  const s = String(v ?? '').trim();
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function draftToCSV(draft) {
  const lines = [COLUMNS.join(',')];
  const row = (cells) => lines.push(cells.map(csvField).join(','));
  draft.rounds.forEach((round, r) => {
    for (const cat of round.categories) {
      cat.clues.forEach((c, i) => {
        if (!clueStarted(c)) return;
        row([r + 1, cat.name, defaultValue(r, i), c.clue, c.media, c.response, c.note, c.trip ? 'yes' : '']);
      });
    }
  });
  for (const [key, label] of [['final', 'final'], ['tiebreaker', 'tiebreaker']]) {
    const s = draft[key];
    if (singleStarted(s)) {
      row([label, s.category, '', s.clue, s.media, s.response, s.note, '']);
    }
  }
  return lines.join('\n') + '\n';
}

export function checkDraft(draft) {
  const issues = [];
  draft.rounds.forEach((round, r) => {
    const where = `Round ${r + 1}`;
    let used = 0;
    let trips = 0;
    round.categories.forEach((cat, ci) => {
      const started = cat.clues.filter(clueStarted);
      if (!started.length) {
        if (has(cat.name)) issues.push(`${where}, ${cat.name}: no clues yet.`);
        return;
      }
      used += 1;
      const name = has(cat.name) ? cat.name : `category ${ci + 1}`;
      if (!has(cat.name)) issues.push(`${where}, category ${ci + 1}: needs a name.`);
      cat.clues.forEach((c, row) => {
        if (!clueStarted(c)) return;
        const at = `${where}, ${name}, clue ${row + 1}`;
        if (!has(c.clue)) issues.push(`${at}: needs the clue.`);
        if (!has(c.response)) issues.push(`${at}: needs the correct response.`);
        if (badMedia(c.media)) issues.push(`${at}: ${MEDIA_FIX}.`);
        if (c.trip) trips += 1;
      });
    });
    if (!used) issues.push(`${where}: no clues yet.`);
    else if (!trips) issues.push(`${where}: no DON'T TRIP! clue.`);
  });
  for (const [key, label] of [['final', 'Final'], ['tiebreaker', 'Tiebreaker']]) {
    const s = draft[key];
    if (!singleStarted(s)) {
      if (key === 'final') issues.push('Final: none yet, so the game ends after the last round.');
      continue;
    }
    for (const [f, text] of [['category', 'a category'], ['clue', 'the clue'], ['response', 'the correct response']]) {
      if (!has(s[f])) issues.push(`${label}: needs ${text}.`);
    }
    if (badMedia(s.media)) issues.push(`${label}: ${MEDIA_FIX}.`);
  }
  return issues;
}

export function draftFromGame(game, title = '') {
  const single = (e) =>
    e
      ? { category: e.category, clue: e.clue, media: e.media || '', response: e.response, note: e.note }
      : emptySingle();
  const rounds = game.rounds.slice(0, MAX_ROUNDS).map((round, r) => {
    const out = emptyRound(r);
    round.categories.slice(0, CATEGORIES).forEach((cat, ci) => {
      out.categories[ci].name = cat.name;
      cat.clues.slice(0, CLUES).forEach((c, row) => {
        out.categories[ci].clues[row] = {
          clue: c.clue,
          media: c.media || '',
          response: c.response,
          note: c.note,
          trip: !!c.wager,
        };
      });
    });
    return out;
  });
  return { title: title || game.title || '', rounds, final: single(game.final), tiebreaker: single(game.tiebreaker) };
}

export const fileName = (title) =>
  `${
    String(title || 'crypardy-game')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'crypardy-game'
  }.csv`;
