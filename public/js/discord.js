import { SETTINGS, clueSource, seatName } from './engine.js';
import { fmt } from './util.js';

export function safe(text) {
  return String(text ?? '')
    .replace(/[\\*_~`|>#[\]()-]/g, '\\$&')
    .replace(/@/g, '@​');
}

export const EMOTES = {
  crybaby: ':crybaby:',
  yes: ':yes:',
  angry: ':angry~1:',
  eat: ':eat:',
  laugh: ':laugh:',
  music: ':music:',
};

export const EMOTE_PATTERN = new RegExp(`(${Object.values(EMOTES).join('|')})`, 'g');

const bold = (text) => `**${safe(text)}**`;

function joinNames(list) {
  const n = list.map(bold);
  return n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`;
}

function standings(seats) {
  const ranked = [...seats].sort((a, b) => b.score - a.score);
  return ranked
    .map((s) => {
      const place = ranked.findIndex((x) => x.score === s.score) + 1;
      return `${place}\\. ${safe(s.name)}: ${fmt(s.score)}`;
    })
    .join('\n');
}

export function joinMessage({ link, password }) {
  return [
    '**Crypardy starts soon!**',
    `Join on your phone: <${link}>`,
    `Game password: ${bold(password)}`,
    'For ease, you could use your Discord display name so I can find you in the Stage easily.',
  ].join('\n');
}

export function playersMessage(names) {
  if (!names.length) return '';
  return `${EMOTES.crybaby} Tonight’s players: ${joinNames(names)}. I’m inviting you up to speak now, so accept the invite when it pops up.`;
}

export function welcomeMessage({ names, control }) {
  if (!names.length) return '';
  return `${EMOTES.crybaby} **Welcome to Crypardy!** Tonight’s players: ${joinNames(names)}.${control ? ` ${bold(control)} picks first.` : ''}`;
}

export function slowmodeMessage() {
  return 'Chat is on slowmode during the game. Don’t post answers while a clue is up or you will be timed out. Slowmode comes off after the final round.';
}

export function scoresMessage(seats, label) {
  if (!seats.length) return '';
  return `**Scores · ${safe(label)}**\n${standings(seats)}`;
}

export function resultsMessage({ winners, seats }) {
  const head = !winners.length
    ? `${EMOTES.crybaby} **Game over!** Nobody finished above zero.`
    : `${EMOTES.crybaby} **Game over!** ${winners.length > 1 ? 'Co-champions' : 'Winner'}: ${joinNames(winners)}`;
  return `${head}\n${standings(seats)}`;
}

export function clueSummary(game, s, cfg = SETTINGS) {
  const c = s?.clue;
  if (!game || !c?.revealed) return null;
  const src = clueSource(game, c) || {};
  const stake = c.kind === 'tiebreaker' ? 0 : c.wager ? c.wagerAmount || 0 : c.value;
  const attempts = c.attempted.map((id) => ({ name: seatName(s, id), correct: false, delta: cfg.negativeScores ? -stake : 0 }));
  if (c.correctBy) attempts.push({ name: seatName(s, c.correctBy), correct: true, delta: stake });
  return {
    kind: c.kind,
    category: src.category || '',
    value: c.value,
    wager: c.wager,
    wagerAmount: c.wager ? c.wagerAmount : null,
    wagerBy: c.wager ? seatName(s, c.answering || c.attempted[0] || c.correctBy) : null,
    clue: src.clue || '',
    response: src.response || '',
    outcome: c.outcome,
    attempts,
  };
}

export function clueMessage(sum) {
  if (!sum) return '';
  const head =
    sum.kind === 'tiebreaker'
      ? `**Tiebreaker · ${safe(sum.category)}**`
      : `**${safe(sum.category)} · ${sum.wager ? 'DON’T TRIP!' : fmt(sum.value)}**`;
  const lines = [head];
  if (sum.wagerAmount != null) lines.push(`${bold(sum.wagerBy)} wagered ${fmt(sum.wagerAmount)}.`);
  if (sum.clue) lines.push(`> ${safe(sum.clue)}`);
  for (const a of sum.attempts) {
    const delta = a.delta ? ` (${a.delta > 0 ? '+' : '−'}${fmt(Math.abs(a.delta))})` : '';
    const emotes = a.correct
      ? ` ${EMOTES.yes}${sum.wager ? ` ${EMOTES.eat}` : ''}`
      : ` ${EMOTES.angry}${sum.wager ? ` ${EMOTES.laugh}` : ''}`;
    lines.push(`${safe(a.name)}: ${a.correct ? 'correct' : 'incorrect'}${delta}${emotes}`);
  }
  if (sum.outcome === 'timeout') lines.push(`Time’s up. ${EMOTES.angry}`);
  if (sum.outcome === 'incorrect' && !sum.wager) lines.push(`Nobody got it. ${EMOTES.angry}`);
  if (sum.outcome === 'skipped') lines.push('Skipped.');
  lines.push(`Response: ${bold(sum.response)}`);
  return lines.join('\n');
}

export function finalSummary(game, s) {
  const f = s?.final;
  if (!game?.final || !f || !['final-clue', 'final-reveal', 'over'].includes(s.phase)) return null;
  const shown = f.order ? f.order.slice(0, f.index + 1) : [];
  const judged = shown.filter((id) => f.judged[id] !== undefined);
  return {
    category: game.final.category,
    clue: game.final.clue,
    results: judged.map((id) => ({
      name: seatName(s, id),
      response: f.responses[id] || '',
      correct: f.judged[id],
      wager: f.wagers[id] || 0,
      score: s.seats.find((x) => x.id === id)?.score ?? 0,
    })),
    response: f.order && f.order.every((id) => f.judged[id] !== undefined) ? game.final.response : null,
  };
}

export function finalMessage(sum) {
  if (!sum) return '';
  const lines = [`**Final Round · ${safe(sum.category)}** ${EMOTES.music}`];
  if (sum.clue) lines.push(`> ${safe(sum.clue)}`);
  for (const r of sum.results) {
    const ruling = r.correct ? `correct ${EMOTES.yes} ${EMOTES.eat}` : `incorrect ${EMOTES.angry}`;
    lines.push(`${bold(r.name)} wrote “${safe(r.response || 'nothing')}” and was ${ruling}. Wagered ${fmt(r.wager)}, now has ${fmt(r.score)}.`);
  }
  if (sum.response) lines.push(`Correct response: ${bold(sum.response)}`);
  return lines.join('\n');
}

export function preview(text) {
  return String(text ?? '')
    .replace(/\*\*/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/​/g, '')
    .replace(/^> /gm, '')
    .replace(/<(https?:[^>]+)>/g, '$1');
}
