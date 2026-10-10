import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGame, parseCSV } from '../public/js/csv.js';
import {
  SETTINGS,
  initialState,
  reduce,
  replay,
  publicView,
  primaryAction,
  canJudge,
  wagerLimits,
} from '../public/js/engine.js';

const csv = readFileSync(new URL('../public/sample-game.csv', import.meta.url), 'utf8');

function harness() {
  const { game, warnings } = buildGame(csv, { random: () => 0 });
  let state = initialState();
  const log = [];
  const events = [];
  const act = (action, expectOk = true) => {
    const r = reduce(game, state, action);
    assert.equal(r.ok, expectOk, `action ${action.type} ok=${r.ok}, expected ${expectOk}`);
    if (r.ok) {
      state = r.state;
      log.push(action);
      events.push(...r.events);
    }
    return r;
  };
  return { game, warnings, act, log, events, get state() { return state; } };
}

const seatAll = (h) => {
  h.act({ type: 'seat', id: 'p-a', name: 'Mara', by: 'host', at: 1 });
  h.act({ type: 'seat', id: 'p-b', name: 'Theo', by: 'host', at: 2 });
  h.act({ type: 'seat', id: 'p-c', name: 'Jun', by: 'host', at: 3 });
};

test('CSV parser handles quotes, commas and escaped quotes', () => {
  const rows = parseCSV('a,b,c\n"x, y","say ""hi""",z\r\n\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'z']]);
});

test('sample game loads cleanly', () => {
  const { game, warnings } = buildGame(csv);
  assert.deepEqual(warnings, []);
  assert.equal(game.rounds.length, 2);
  for (const r of game.rounds) {
    assert.equal(r.categories.length, 6);
    for (const c of r.categories) assert.equal(c.clues.length, 5);
  }
  assert.equal(game.rounds[0].categories[4].clues[3].wager, true);
  assert.equal(game.rounds[1].categories.flatMap((c) => c.clues).filter((c) => c.wager).length, 2);
  assert.equal(game.final.response, 'What is Black Panther?');
  assert.equal(game.tiebreaker.category, 'Birthday');
});

test('old game files with accept and reject columns still load, and those columns are ignored', () => {
  const { game, warnings } = buildGame('round,category,value,clue,response,accept,reject,note\n1,Cat,200,Q,A,Also this,Not that,Psst\n');
  assert.deepEqual(warnings.filter((w) => !/DON'T TRIP|final/.test(w)), []);
  const clue = game.rounds[0].categories[0].clues[0];
  assert.equal(clue.note, 'Psst');
  assert.equal('accept' in clue || 'reject' in clue, false);
});

test('DON\'T TRIP! clues come only from the game file', () => {
  const plain = csv.replace(/,yes$/gm, ',');
  const { game, warnings } = buildGame(plain);
  assert.equal(game.rounds.flatMap((r) => r.categories.flatMap((c) => c.clues)).filter((cl) => cl.wager).length, 0, 'none placed at random');
  assert.ok(warnings.includes("Round 1 has no DON'T TRIP! clues."));
  for (const head of ['dont_trip', "DON'T TRIP!", 'Dont Trip', 'dont-trip', 'wager']) {
    const one = buildGame(`round,category,value,clue,response,"${head.replace(/"/g, '""')}"\n1,Cat,200,Q,A,yes\n1,Cat,400,Q2,A2,\n`);
    assert.deepEqual(one.game.rounds[0].categories[0].clues.map((c) => c.wager), [true, false], head);
  }
});

test('seating rules', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'seat', id: 'p-a', name: 'Dup', by: 'host', at: 4 }, false);
  h.act({ type: 'seat', id: 'p-d', name: '  Ana\u0007  ', by: 'host', at: 5 });
  assert.equal(h.state.seats[3].name, 'Ana');
  h.act({ type: 'seat', id: 'p-e', name: 'Five', by: 'host', at: 6 }, false);
  h.act({ type: 'unseat', id: 'p-d', by: 'host', at: 7 });
  assert.equal(h.state.seats.length, 3);
});

test('full clue: lockout, tie window ordering, rebound, scoring, undo', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-b', by: 'host', at: 100 });
  assert.equal(h.state.control, 'p-b');
  h.act({ type: 'pick', cat: 1, row: 2, by: 'player', who: 'p-a', at: 200 }, false);
  h.act({ type: 'pick', cat: 1, row: 2, by: 'player', who: 'p-b', at: 210 });
  assert.equal(h.state.phase, 'clue');
  const view = publicView(h.game, h.state, 300);
  assert.equal(view.clue.response, null, 'response hidden before reveal');
  assert.ok(!JSON.stringify(view).includes('Snoop Dogg?'));

  h.act({ type: 'buzz', id: 'p-a', ts: 9950, recv: 9950, by: 'player', at: 9950 });
  assert.deepEqual(primaryAction(h.game, h.state), { type: 'arm', label: 'Open buzzers' });
  h.act({ type: 'arm', by: 'host', at: 10000 });
  h.act({ type: 'buzz', id: 'p-a', ts: 10100, recv: 10100, by: 'player', at: 10100 }, false);
  h.act({ type: 'buzz', id: 'p-b', ts: 10150, recv: 10180, by: 'player', at: 10180 });
  h.act({ type: 'buzz', id: 'p-c', ts: 10140, recv: 10190, by: 'player', at: 10190 });
  h.act({ type: 'buzz', id: 'p-b', ts: 10160, recv: 10195, by: 'player', at: 10195 }, false);
  h.act({ type: 'award', by: 'auto', at: 10380 });
  assert.equal(h.state.clue.answering, 'p-c', 'earliest server timestamp wins');
  assert.equal(h.state.lastBuzz[0].ms, 190);
  assert.equal(h.state.lastBuzz[1].behind, 10);
  assert.ok(canJudge(h.state));

  h.act({ type: 'judge', correct: false, by: 'host', at: 11000 });
  assert.equal(h.state.seats[2].score, -600);
  assert.equal(h.state.clue.armed, true, 'buzzers reopen for the others');
  h.act({ type: 'buzz', id: 'p-c', ts: 11100, recv: 11100, by: 'player', at: 11100 }, false);
  h.act({ type: 'buzz', id: 'p-a', ts: 11200, recv: 11220, by: 'player', at: 11220 });
  h.act({ type: 'award', by: 'auto', at: 11420 });
  const beforeJudge = h.state;
  h.act({ type: 'judge', correct: true, by: 'host', at: 12000 });
  assert.equal(h.state.seats[0].score, 600);
  assert.equal(h.state.control, 'p-a');
  assert.equal(h.state.phase, 'reveal');
  assert.equal(publicView(h.game, h.state, 12000).clue.response, 'Who is Snoop Dogg?');
  assert.ok(h.events.some((e) => e.type === 'buzz-winner' && e.name === 'Jun'));

  const undone = replay(h.game, h.log.slice(0, -1));
  assert.deepEqual(undone, beforeJudge);

  h.act({ type: 'next', by: 'host', at: 13000 });
  assert.ok(h.events.some((e) => e.type === 'next'), 'moving on from a clue is announced');
  assert.equal(h.state.phase, 'board');
  assert.equal(publicView(h.game, h.state, 13000).board.cells[1][2].used, true);
});

test('timeout when nobody buzzes', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 1 });
  h.act({ type: 'pick', cat: 0, row: 0, by: 'host', at: 2 });
  h.act({ type: 'arm', by: 'host', at: 1000 });
  h.act({ type: 'timeout', by: 'auto', at: 1000 + SETTINGS.buzzWindowMs - 1 }, false);
  h.act({ type: 'timeout', by: 'auto', at: 1000 + SETTINGS.buzzWindowMs });
  assert.equal(h.state.clue.outcome, 'timeout');
  assert.equal(h.state.phase, 'reveal');
  assert.equal(h.state.control, 'p-a', 'control stays put');
});

test('wager clue hides its text until the wager is in and scores the wager', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 1 });
  h.act({ type: 'pick', cat: 4, row: 3, by: 'player', who: 'p-a', at: 2 });
  assert.equal(h.state.phase, 'wager');
  const v = publicView(h.game, h.state, 3);
  assert.equal(v.clue.wager, true);
  assert.equal(v.clue.text, null);
  assert.deepEqual(wagerLimits(h.game, h.state, 'p-a'), { min: 5, max: 1000 });
  h.act({ type: 'wager', id: 'p-a', amount: 1001, by: 'player', at: 4 }, false);
  h.act({ type: 'wager', id: 'p-b', amount: 500, by: 'player', at: 5 }, false);
  h.act({ type: 'wager', id: 'p-a', amount: '1,000', by: 'player', at: 6 });
  assert.equal(h.state.phase, 'clue');
  assert.ok(publicView(h.game, h.state, 7).clue.text.includes('FIFA 19'));
  h.act({ type: 'buzz', id: 'p-b', ts: 8, recv: 8, by: 'player', at: 8 }, false);
  h.act({ type: 'judge', correct: true, by: 'host', at: 9 });
  assert.equal(h.state.seats[0].score, 1000);
});

test('rounds, final round and a tiebreaker', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 1 });
  h.act({ type: 'adjust', id: 'p-a', delta: 3000, by: 'host', at: 2 });
  h.act({ type: 'adjust', id: 'p-b', delta: 2000, by: 'host', at: 3 });
  h.act({ type: 'adjust', id: 'p-c', delta: -200, by: 'host', at: 4 });
  h.act({ type: 'endRound', by: 'host', at: 5 });
  assert.equal(h.state.roundIndex, 1);
  assert.equal(h.state.control, 'p-c', 'lowest score picks first in round 2');
  h.act({ type: 'endRound', by: 'host', at: 6 });
  assert.equal(h.state.phase, 'final-category');
  assert.deepEqual(h.state.final.eligible, ['p-a', 'p-b'], 'no one at or below zero plays the final');

  h.act({ type: 'finalWager', id: 'p-c', amount: 0, by: 'player', at: 7 }, false);
  h.act({ type: 'finalWager', id: 'p-a', amount: 3001, by: 'player', at: 8 }, false);
  h.act({ type: 'finalWager', id: 'p-a', amount: 1000, by: 'player', at: 9 });
  assert.deepEqual(h.events.at(-1), { type: 'final-wager-locked', name: 'Mara' }, 'locking in a final wager is announced without the amount');
  const before = h.events.length;
  h.act({ type: 'finalWager', id: 'p-a', amount: 1000, by: 'player', at: 9 });
  assert.equal(h.events.length, before, 'updating a final wager makes no new announcement');
  h.act({ type: 'finalWager', id: 'p-b', amount: 2000, by: 'player', at: 10 });
  const fv = publicView(h.game, h.state, 11);
  assert.equal(fv.final.clue, null, 'final clue hidden while wagering');
  assert.deepEqual(fv.final.wagered.sort(), ['p-a', 'p-b']);
  assert.ok(!('wagers' in fv.final), 'wager amounts stay private');
  h.act({ type: 'finalClue', by: 'host', at: 1000 });
  h.act({ type: 'finalResponse', id: 'p-a', text: 'What is Black Panther?', recv: 5000, by: 'player', at: 5000 });
  h.act({ type: 'finalResponse', id: 'p-b', text: 'Black Panther', recv: 31000, by: 'player', at: 31000 });
  h.act(
    { type: 'finalResponse', id: 'p-b', text: 'too late', recv: 1000 + SETTINGS.finalThinkMs + SETTINGS.finalGraceMs + 1, by: 'player', at: 0 },
    false,
  );
  h.act({ type: 'finalTimeUp', by: 'auto', at: 1000 + SETTINGS.finalThinkMs }, false);
  h.act({ type: 'finalTimeUp', by: 'auto', at: 1000 + SETTINGS.finalThinkMs + SETTINGS.finalGraceMs });
  assert.deepEqual(h.state.final.order, ['p-b', 'p-a'], 'lowest score revealed first');
  const hidden = publicView(h.game, h.state, 40000);
  assert.deepEqual(hidden.final.reveals, []);

  h.act({ type: 'finalReveal', by: 'host', at: 41000 });
  assert.equal(primaryAction(h.game, h.state), null, 'judge before revealing the next one');
  h.act({ type: 'finalJudge', correct: true, by: 'host', at: 42000 });
  h.act({ type: 'finalReveal', by: 'host', at: 43000 });
  h.act({ type: 'finalJudge', correct: true, by: 'host', at: 44000 });
  const shown = publicView(h.game, h.state, 44000);
  assert.equal(shown.final.reveals[1].wager, 1000);
  assert.equal(shown.final.response, 'What is Black Panther?');

  h.act({ type: 'finish', by: 'host', at: 45000 });
  assert.equal(h.state.phase, 'tiebreaker');
  assert.deepEqual(h.state.clue.eligible, ['p-a', 'p-b']);
  h.act({ type: 'arm', by: 'host', at: 46000 });
  h.act({ type: 'buzz', id: 'p-c', ts: 46100, recv: 46100, by: 'player', at: 46100 }, false);
  h.act({ type: 'buzz', id: 'p-b', ts: 46200, recv: 46200, by: 'player', at: 46200 });
  h.act({ type: 'award', by: 'auto', at: 46400 });
  h.act({ type: 'judge', correct: true, by: 'host', at: 47000 });
  assert.equal(h.state.phase, 'over');
  assert.deepEqual(h.state.winners, ['p-b']);
  const over = h.events.find((e) => e.type === 'game-over');
  assert.deepEqual(over.winners, ['Theo']);
});

test('reseat moves a seat and its score to a new connection', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 1 });
  h.act({ type: 'adjust', id: 'p-a', delta: 400, by: 'host', at: 2 });
  h.act({ type: 'reseat', oldId: 'p-a', id: 'p-z', name: 'Mara', by: 'host', at: 3 });
  assert.equal(h.state.seats[0].id, 'p-z');
  assert.equal(h.state.seats[0].score, 400);
  assert.equal(h.state.control, 'p-z');
});

test('replaying a long random session never throws and stays consistent', () => {
  const h = harness();
  seatAll(h);
  const ids = ['p-a', 'p-b', 'p-c'];
  let t = 10;
  h.act({ type: 'start', control: 'p-a', by: 'host', at: t });
  let rng = 42;
  const rand = () => ((rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const types = ['pick', 'arm', 'buzz', 'award', 'judge', 'timeout', 'next', 'wager', 'skip', 'endRound', 'finalWager', 'finalClue', 'finalResponse', 'finalTimeUp', 'finalReveal', 'finalJudge', 'finish'];
  for (let i = 0; i < 4000 && h.state.phase !== 'over'; i++) {
    t += Math.floor(rand() * 3000);
    const type = types[Math.floor(rand() * types.length)];
    const id = ids[Math.floor(rand() * 3)];
    const a = { type, at: t, by: 'host', id, who: h.state.control, cat: Math.floor(rand() * 6), row: Math.floor(rand() * 5), ts: t, recv: t, amount: Math.floor(rand() * 2500), correct: rand() > 0.4, text: 'x' };
    const r = reduce(h.game, h.state, a);
    if (r.ok) {
      const v = publicView(h.game, r.state, t);
      if (v.clue && !v.clue.revealed) assert.equal(v.clue.response, null);
    }
    h.act(a, r.ok);
  }
  assert.deepEqual(replay(h.game, h.log), h.state);
});

test('a press made before the buzzers opened never wins, even if it arrives after', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 100 });
  h.act({ type: 'pick', cat: 0, row: 0, by: 'host', at: 200 });
  h.act({ type: 'arm', by: 'host', at: 1000 });
  h.act({ type: 'buzz', id: 'p-c', ts: 990, recv: 1030, by: 'player', at: 1030 });
  assert.equal(h.state.clue.buzzes.length, 0, 'counted as early');
  assert.equal(h.state.clue.lockouts['p-c'], 1030 + SETTINGS.lockoutMs);
  h.act({ type: 'buzz', id: 'p-b', ts: 1180, recv: 1200, by: 'player', at: 1200 });
  h.act({ type: 'award', by: 'auto', at: 1400 });
  assert.equal(h.state.clue.answering, 'p-b');
});

test('a faked press time only counts so far', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 100 });
  h.act({ type: 'pick', cat: 0, row: 0, by: 'host', at: 200 });
  h.act({ type: 'arm', by: 'host', at: 1000 });
  h.act({ type: 'buzz', id: 'p-b', ts: 1350, recv: 1370, by: 'player', at: 1370 });
  h.act({ type: 'buzz', id: 'p-a', ts: 1001, recv: 1700, by: 'player', at: 1700 });
  assert.equal(h.state.clue.buzzes.find((b) => b.id === 'p-a').ts, 1700 - SETTINGS.maxTransitMs);
  h.act({ type: 'award', by: 'auto', at: 1720 });
  assert.equal(h.state.clue.answering, 'p-b');
  const h2 = harness();
  seatAll(h2);
  h2.act({ type: 'start', control: 'p-a', by: 'host', at: 100 });
  h2.act({ type: 'pick', cat: 0, row: 0, by: 'host', at: 200 });
  h2.act({ type: 'arm', by: 'host', at: 1000 });
  h2.act({ type: 'buzz', id: 'p-a', ts: 99999, recv: 1300, by: 'player', at: 1300 });
  assert.equal(h2.state.clue.buzzes[0].ts, 1300);
});

test('score corrections in the final round stay fair, and none after the game ends', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 1 });
  h.act({ type: 'adjust', id: 'p-a', delta: 1000, by: 'host', at: 2 });
  h.act({ type: 'adjust', id: 'p-b', delta: 500, by: 'host', at: 3 });
  h.act({ type: 'endRound', by: 'host', at: 4 });
  h.act({ type: 'endRound', by: 'host', at: 5 });
  assert.deepEqual(h.state.final.eligible, ['p-a', 'p-b']);
  h.act({ type: 'finalWager', id: 'p-a', amount: 1000, by: 'player', at: 6 });
  h.act({ type: 'adjust', id: 'p-c', delta: 300, by: 'host', at: 7 });
  h.act({ type: 'adjust', id: 'p-a', delta: -900, by: 'host', at: 8 });
  assert.deepEqual(h.state.final.eligible, ['p-a', 'p-b', 'p-c']);
  assert.equal(h.state.final.wagers['p-a'], 100);
  h.act({ type: 'finalClue', by: 'host', at: 1000 });
  h.act({ type: 'finalTimeUp', by: 'host', at: 2000 });
  assert.equal(h.state.phase, 'final-clue', 'phones get the grace period to send what is typed');
  h.act({ type: 'finalResponse', id: 'p-b', text: 'x', recv: 2000 + SETTINGS.finalGraceMs - 1, by: 'player', at: 2001 });
  h.act({ type: 'finalTimeUp', by: 'auto', at: 2000 + SETTINGS.finalGraceMs });
  assert.equal(h.state.phase, 'final-reveal');
  h.act({ type: 'adjust', id: 'p-b', delta: -400, by: 'host', at: 5000 });
  const first = h.state.final.order[0];
  h.act({ type: 'finalReveal', by: 'host', at: 6000 });
  h.act({ type: 'finalJudge', correct: false, by: 'host', at: 6100 });
  assert.ok(h.state.seats.find((x) => x.id === first).score >= 0);
  while (primaryAction(h.game, h.state)?.type === 'finalReveal') {
    h.act({ type: 'finalReveal', by: 'host', at: 7000 });
    h.act({ type: 'finalJudge', correct: false, by: 'host', at: 7100 });
  }
  h.act({ type: 'finish', by: 'host', at: 8000 });
  assert.equal(h.state.phase, 'over');
  h.act({ type: 'adjust', id: 'p-a', delta: 5000, by: 'host', at: 9000 }, false);
});

test('timers that ran out while the host was away start over on resume', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 100 });
  h.act({ type: 'pick', cat: 0, row: 0, by: 'host', at: 200 });
  h.act({ type: 'arm', by: 'host', at: 1000 });
  h.act({ type: 'resumeTimers', by: 'auto', at: 3000 }, false);
  h.act({ type: 'resumeTimers', by: 'auto', at: 60000 });
  assert.equal(h.state.clue.deadline, 60000 + SETTINGS.buzzWindowMs);
  h.act({ type: 'timeout', by: 'auto', at: 60001 }, false);
});

test('CSV: a stray quote is just a character, values keep their decimals', () => {
  assert.deepEqual(parseCSV('a,b\n1,This 3.5" disk\n2,ok\n'), [['a', 'b'], ['1', 'This 3.5" disk'], ['2', 'ok']]);
  assert.throws(() => parseCSV('a,b\n1,"never closed\n2,x\n'), /never closes/);
  const { game } = buildGame('round,category,value,clue,response\n1,Cat,"$1,200",Q,A\n1,Cat,200.4,Q2,A2\n');
  assert.deepEqual(game.rounds[0].categories[0].clues.map((c) => c.value), [200, 1200]);
  assert.throws(() => buildGame('round,category,clue,response\n1,Cat,Q,A\n'), /"value" column/);
});

test('when the answering player runs out of time, Time\'s up fires and the host still rules', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 100 });
  h.act({ type: 'pick', cat: 0, row: 0, by: 'host', at: 200 });
  h.act({ type: 'arm', by: 'host', at: 1000 });
  h.act({ type: 'buzz', id: 'p-b', ts: 1500, recv: 1520, by: 'player', at: 1520 });
  h.act({ type: 'award', by: 'auto', at: 1720 });
  h.act({ type: 'answerTimeout', by: 'auto', at: 1720 + SETTINGS.answerMs - 1 }, false);
  h.act({ type: 'answerTimeout', by: 'auto', at: 1720 + SETTINGS.answerMs });
  assert.deepEqual(h.events.at(-1), { type: 'answer-timeout', name: 'Theo', wager: false });
  assert.equal(h.state.clue.answering, 'p-b', 'still waiting for the ruling');
  assert.equal(publicView(h.game, h.state, 9000).clue.overtime, true);
  h.act({ type: 'answerTimeout', by: 'auto', at: 9999 }, false);
  h.act({ type: 'judge', correct: false, by: 'host', at: 10000 });
  assert.equal(h.state.clue.overtime, false, 'buzzers reopen with a fresh clock');
  assert.equal(h.state.clue.armed, true);
});

test('an answer clock that ran out while the host was away starts over on resume', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 100 });
  h.act({ type: 'pick', cat: 0, row: 0, by: 'host', at: 200 });
  h.act({ type: 'arm', by: 'host', at: 1000 });
  h.act({ type: 'buzz', id: 'p-b', ts: 1500, recv: 1520, by: 'player', at: 1520 });
  h.act({ type: 'award', by: 'auto', at: 1720 });
  h.act({ type: 'resumeTimers', by: 'auto', at: 50000 });
  assert.equal(h.state.clue.deadline, 50000 + SETTINGS.answerMs);
});

test('a quick, honest press counts even if the clock reading makes it look early', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 100 });
  h.act({ type: 'pick', cat: 0, row: 0, by: 'host', at: 200 });
  h.act({ type: 'arm', by: 'host', at: 3000 });
  h.act({ type: 'buzz', id: 'p-b', ts: 2850, recv: 3300, by: 'player', at: 3300 });
  assert.equal(h.state.clue.buzzes.length, 1, 'counted, not locked out');
  assert.equal(h.state.clue.lockouts['p-b'], undefined);
});

test('mashing BUZZ before the buzzers open only records the first press of each lockout', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 100 });
  h.act({ type: 'pick', cat: 0, row: 0, by: 'host', at: 200 });
  h.act({ type: 'buzz', id: 'p-b', ts: 900, recv: 900, by: 'player', at: 900 });
  h.act({ type: 'buzz', id: 'p-b', ts: 950, recv: 950, by: 'player', at: 950 }, false);
  h.act({ type: 'buzz', id: 'p-b', ts: 1100, recv: 1100, by: 'player', at: 1100 }, false);
  h.act({ type: 'buzz', id: 'p-b', ts: 1160, recv: 1160, by: 'player', at: 1160 });
  assert.equal(h.state.clue.lockouts['p-b'], 1160 + SETTINGS.lockoutMs);
});

test('ending thinking time early always leaves the grace period for responses in flight', () => {
  const h = harness();
  seatAll(h);
  h.act({ type: 'start', control: 'p-a', by: 'host', at: 1 });
  h.act({ type: 'adjust', id: 'p-a', delta: 1000, by: 'host', at: 2 });
  h.act({ type: 'endRound', by: 'host', at: 3 });
  h.act({ type: 'endRound', by: 'host', at: 4 });
  h.act({ type: 'finalClue', by: 'host', at: 1000 });
  h.act({ type: 'finalTimeUp', by: 'host', at: 5000 });
  h.act({ type: 'finalTimeUp', by: 'host', at: 5100 }, false);
  h.act({ type: 'finalResponse', id: 'p-a', text: 'late but fine', recv: 6000, by: 'player', at: 6000 });
  h.act({ type: 'finalTimeUp', by: 'auto', at: 5000 + SETTINGS.finalGraceMs });
  assert.equal(h.state.phase, 'final-reveal');
  assert.equal(h.state.final.responses['p-a'], 'late but fine');
});

test('CSV: a quote after a space still opens a quoted field, and round numbers read the first number', () => {
  assert.deepEqual(parseCSV('a,b,c\n1, "x, y",z\n'), [['a', 'b', 'c'], ['1', 'x, y', 'z']]);
  const { game } = buildGame('round,category,value,clue,response\n1.5,Cat,200,Q,A\n"Round 2",Cat2,400,Q2,A2\n');
  assert.deepEqual(game.rounds.map((r) => r.name), ['Round 1', 'Round 2']);
});
