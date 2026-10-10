import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGame } from '../public/js/csv.js';
import { checkDraft, csvField, draftFromGame, draftToCSV, emptyDraft, fileName } from '../public/js/gamefile.js';
import { createHandler } from '../netlify/functions/create-signin.mjs';
import { createLimiter } from '../netlify/functions/ably-token.mjs';

const sample = readFileSync(new URL('../public/sample-game.csv', import.meta.url), 'utf8');

function filled() {
  const d = emptyDraft();
  d.title = 'Vince Night';
  const cat = d.rounds[0].categories[0];
  cat.name = 'Albums, EPs & "more"';
  cat.clues[0] = { ...cat.clues[0], clue: 'His 2015 debut, with a comma, and a\nline break.', response: 'What is Summertime ’06?', trip: true };
  cat.clues[1] = { ...cat.clues[1], clue: 'Second', response: 'What is two?', note: 'Say "two"' };
  d.final = { category: 'Movies', clue: 'Final clue', response: 'What is Black Panther?', note: 'Not Wakanda Forever' };
  return d;
}

test('a written game becomes a CSV the host view loads as written', () => {
  const csv = draftToCSV(filled());
  assert.equal(csv.split('\n')[0], 'round,category,value,clue,media,response,note,dont_trip');
  const { game } = buildGame(csv);
  const cat = game.rounds[0].categories[0];
  assert.equal(cat.name, 'Albums, EPs & "more"');
  assert.equal(cat.clues.length, 2, 'empty clues are left out');
  assert.equal(cat.clues[0].clue, 'His 2015 debut, with a comma, and a\nline break.');
  assert.equal(cat.clues[0].value, 200);
  assert.equal(cat.clues[0].wager, true);
  assert.equal(cat.clues[1].note, 'Say "two"');
  assert.equal(game.rounds.length, 1, 'an empty round 2 is left out');
  assert.equal(game.final.note, 'Not Wakanda Forever');
  assert.equal(game.tiebreaker, null);
});

test('the sample game survives a round trip through the writer', () => {
  const a = buildGame(sample).game;
  const b = buildGame(draftToCSV(draftFromGame(a, 'Sample'))).game;
  assert.deepEqual(b.rounds, a.rounds);
  assert.deepEqual(b.final, a.final);
  assert.deepEqual(b.tiebreaker, a.tiebreaker);
  assert.deepEqual(checkDraft(draftFromGame(a)), []);
});

test('board values come from the clue’s place, not the draft', () => {
  const d = filled();
  d.rounds[0].categories[0].clues[1].value = 9999;
  d.rounds[1].categories[0] = { name: 'Late', clues: d.rounds[1].categories[0].clues.map((c, i) => (i === 4 ? { ...c, clue: 'Last', response: 'What is last?' } : c)) };
  const { game } = buildGame(draftToCSV(d));
  assert.deepEqual(game.rounds[0].categories[0].clues.map((c) => c.value), [200, 400]);
  assert.deepEqual(game.rounds[1].categories[0].clues.map((c) => c.value), [2000]);
});

test('the check lists what is missing', () => {
  const d = emptyDraft();
  assert.ok(checkDraft(d).includes('Round 1: no clues yet.'));
  d.rounds[0].categories[2].clues[1].clue = 'A clue with no response';
  const issues = checkDraft(d);
  assert.ok(issues.includes('Round 1, category 3: needs a name.'));
  assert.ok(issues.includes('Round 1, category 3, clue 2: needs the correct response.'));
  assert.ok(issues.includes("Round 1: no DON'T TRIP! clue."));
  assert.ok(issues.includes('Final: none yet, so the game ends after the last round.'));
});

test('fields and file names are safe', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a, b'), '"a, b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(fileName('Vince Night: Week 3!'), 'vince-night-week-3.csv');
  assert.equal(fileName(''), 'crypardy-game.csv');
});

test('the game writer page needs its password', async () => {
  process.env.CREATE_PASSWORD = 'big fish';
  const handler = createHandler({ failDelayMs: 0, limiter: createLimiter({ max: 2 }) });
  const call = (password) =>
    handler(new Request('https://example.test/.netlify/functions/create-signin', { method: 'POST', body: JSON.stringify({ password }) }));
  assert.equal((await call('big fish')).status, 200);
  assert.equal((await call('nope')).status, 401);
  assert.equal((await call('also nope')).status, 401);
  assert.equal((await call('big fish')).status, 429, 'too many wrong guesses');
  delete process.env.CREATE_PASSWORD;
  assert.equal((await createHandler({ failDelayMs: 0 })(new Request('https://x.test', { method: 'POST', body: '{}' }))).status, 500);
});
