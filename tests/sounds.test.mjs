import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { SOUND_FILES, soundForEvent } from '../public/js/sounds.js';

test('each sound plays at its own moment', () => {
  assert.deepEqual(soundForEvent({ type: 'clue-opened', wager: true }), { play: 'trip' }, "DON'T TRIP! picked");
  assert.deepEqual(soundForEvent({ type: 'clue-opened', wager: false }), { play: 'select' }, 'regular clue picked');
  assert.deepEqual(soundForEvent({ type: 'buzz-winner', name: 'Theo', ms: 180 }), { play: 'buzz' }, 'a player buzzes in');
  assert.deepEqual(soundForEvent({ type: 'wager-locked', amount: 500 }), { play: 'wager' }, "DON'T TRIP! wager locks in");
  assert.deepEqual(soundForEvent({ type: 'final-wager-locked', name: 'Mara' }), { play: 'wager' }, 'a Final Round wager locks in');
  assert.deepEqual(soundForEvent({ type: 'judged', correct: true }), { play: 'right' });
  assert.deepEqual(soundForEvent({ type: 'judged', correct: false }), { play: 'wrong' });
  assert.deepEqual(soundForEvent({ type: 'final-judged', correct: true }), { play: 'right' });
  assert.deepEqual(soundForEvent({ type: 'final-judged', correct: false }), { play: 'wrong' });
  assert.deepEqual(soundForEvent({ type: 'timeout' }), { play: 'timesup' }, 'nobody buzzed in time');
  assert.deepEqual(soundForEvent({ type: 'answer-timeout', name: 'Theo' }), { play: 'timesup' }, 'the answerer ran out of time');
  assert.deepEqual(soundForEvent({ type: 'final-clue' }), { play: 'think' });
  assert.deepEqual(soundForEvent({ type: 'final-time-up' }), { stop: true });
  assert.deepEqual(soundForEvent({ type: 'undo', phase: 'board' }), { stop: true, play: 'undo' }, 'undo stops think music and stings, then plays the undo sound');
  assert.deepEqual(soundForEvent({ type: 'next' }), { play: 'next' }, 'the host moves on from a clue');
  assert.deepEqual(soundForEvent({ type: 'game-start', names: ['Mara'] }), { play: 'gamestart' }, 'the game starts');
  assert.deepEqual(soundForEvent({ type: 'round', name: 'Round 2' }), { play: 'newround' }, 'a new round starts');
  assert.deepEqual(soundForEvent({ type: 'final-category', category: 'Movie Trailers' }), { play: 'final' }, 'the Final Round starts');
  assert.deepEqual(soundForEvent({ type: 'tiebreaker', names: ['Mara', 'Theo'] }), { play: 'tie' }, 'a tiebreaker starts');
  assert.deepEqual(soundForEvent({ type: 'revealed', outcome: 'skipped', wager: true }), { stop: true }, "a skipped DON'T TRIP! goes quiet");
  assert.equal(soundForEvent({ type: 'revealed', outcome: 'correct' }), null, 'a reveal never cuts off the Correct sound');
});

test('no sound plays from a button or on its own at game over', () => {
  assert.equal('applause' in SOUND_FILES, false);
  for (const name of ['applause', 'buzz', 'nope']) assert.equal(soundForEvent({ type: 'sound', name }), null, name);
  assert.equal(soundForEvent({ type: 'game-over', winners: ['Mara'] }), null);
});

test('every sound has its file in the site', () => {
  for (const [name, file] of Object.entries(SOUND_FILES)) {
    assert.ok(existsSync(new URL(`../public/sounds/${file}`, import.meta.url)), `${name}: ${file} exists`);
  }
});
