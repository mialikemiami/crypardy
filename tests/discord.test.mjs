import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildGame } from '../public/js/csv.js';
import { initialState, reduce } from '../public/js/engine.js';
import {
  safe,
  joinMessage,
  playersMessage,
  scoresMessage,
  resultsMessage,
  clueSummary,
  clueMessage,
  preview,
  EMOTES,
  EMOTE_PATTERN,
  welcomeMessage,
  finalSummary,
  finalMessage,
} from '../public/js/discord.js';

const csv = readFileSync(new URL('../public/sample-game.csv', import.meta.url), 'utf8');

function play(actions) {
  const { game } = buildGame(csv, { random: () => 0 });
  let s = initialState();
  for (const a of actions) {
    const r = reduce(game, s, a);
    assert.ok(r.ok, `${a.type} should be accepted`);
    s = r.state;
  }
  return { game, s };
}

const seated = [
  { type: 'seat', id: 'p-a', name: 'Mara', by: 'host', at: 1 },
  { type: 'seat', id: 'p-b', name: 'Theo', by: 'host', at: 2 },
  { type: 'seat', id: 'p-c', name: 'Jun', by: 'host', at: 3 },
  { type: 'start', control: 'p-a', by: 'host', at: 4 },
];

test('player names and clue text can’t format a post or ping anyone', () => {
  assert.equal(safe('**@everyone**'), '\\*\\*@​everyone\\*\\*');
  assert.ok(!safe('<@123456789012345678>').includes('<@1'), 'user mentions are broken');
  assert.ok(!safe('<@&123>').includes('<@&'), 'role mentions are broken');
  assert.equal(safe('Theo_99 [link](x) > - #'), 'Theo\\_99 \\[link\\]\\(x\\) \\> \\- \\#');
  assert.equal(playersMessage(['@here']).includes('@here'), false);
});

test('the join message carries the link without a preview and the password', () => {
  const msg = joinMessage({ link: 'https://crypardy.netlify.app/play', password: 'lucky otter yodels 482' });
  assert.match(msg, /<https:\/\/crypardy\.netlify\.app\/play>/);
  assert.match(msg, /\*\*lucky otter yodels 482\*\*/);
  assert.equal(
    preview(msg),
    'Crypardy starts soon!\nJoin on your phone: https://crypardy.netlify.app/play\nGame password: lucky otter yodels 482\nFor ease, you could use your Discord display name so I can find you in the Stage easily.',
  );
});

test('scores and results list everyone, and ties share a place', () => {
  const seats = [
    { name: 'Jun', score: -600 },
    { name: 'Mara', score: 1650 },
    { name: 'Theo', score: 1650 },
  ];
  assert.equal(preview(scoresMessage(seats, 'Round 1')), 'Scores · Round 1\n1. Mara: 1,650\n1. Theo: 1,650\n3. Jun: −600');
  assert.ok(scoresMessage(seats, 'Round 1').includes('1\\. Mara'), 'numbers stay literal, not a Discord list that renumbers');
  assert.equal(preview(resultsMessage({ winners: ['Mara', 'Theo'], seats })).split('\n')[0], ':crybaby: Game over! Co-champions: Mara and Theo');
  assert.equal(preview(resultsMessage({ winners: [], seats })).split('\n')[0], ':crybaby: Game over! Nobody finished above zero.');
  assert.equal(scoresMessage([], 'Round 1'), '', 'nothing to post before anyone is seated');
});

test('the last clue post follows the rulings, including a rebound', () => {
  const { game, s } = play([
    ...seated,
    { type: 'pick', cat: 1, row: 2, by: 'host', at: 10 },
    { type: 'arm', by: 'host', at: 100 },
    { type: 'buzz', id: 'p-c', ts: 300, recv: 320, by: 'player', at: 320 },
    { type: 'award', by: 'auto', at: 520 },
    { type: 'judge', correct: false, by: 'host', at: 600 },
    { type: 'buzz', id: 'p-b', ts: 900, recv: 920, by: 'player', at: 920 },
    { type: 'award', by: 'auto', at: 1120 },
    { type: 'judge', correct: true, by: 'host', at: 1200 },
  ]);
  const msg = preview(clueMessage(clueSummary(game, s)));
  assert.equal(
    msg,
    'Hometown · 600\nAs a kid, Vince played in the youth football league this Long Beach rapper started.\nJun: incorrect (−600) :angry~1:\nTheo: correct (+600) :yes:\nResponse: Who is Snoop Dogg?',
  );
});

test('nothing to post until the clue is revealed; wager clues and time-outs read right', () => {
  const open = play([...seated, { type: 'pick', cat: 0, row: 0, by: 'host', at: 10 }]);
  assert.equal(clueSummary(open.game, open.s), null, 'the response stays private until the reveal');

  const timedOut = play([
    ...seated,
    { type: 'pick', cat: 0, row: 0, by: 'host', at: 10 },
    { type: 'arm', by: 'host', at: 100 },
    { type: 'timeout', by: 'auto', at: 5200 },
  ]);
  assert.match(preview(clueMessage(clueSummary(timedOut.game, timedOut.s))), /Time’s up\. :angry~1:\nResponse: /);

  const wager = play([
    ...seated,
    { type: 'adjust', id: 'p-a', delta: 2000, by: 'host', at: 5 },
    { type: 'pick', cat: 4, row: 3, by: 'host', at: 10 },
    { type: 'wager', id: 'p-a', amount: 1500, by: 'player', at: 20 },
    { type: 'judge', correct: false, by: 'host', at: 40 },
  ]);
  const lines = preview(clueMessage(clueSummary(wager.game, wager.s))).split('\n');
  assert.equal(lines[0], 'Featuring Vince · DON’T TRIP!');
  assert.equal(lines[1], 'Mara wagered 1,500.');
  assert.ok(lines.includes('Mara: incorrect (−1,500) :angry~1: :laugh:'));
  assert.ok(!lines.some((l) => l.startsWith('Nobody got it')), 'a missed DON’T TRIP! has one player, so no “Nobody got it”');
});

test('posts use the server emotes, with :angry~1: for misses', () => {
  assert.equal(EMOTES.angry, ':angry~1:');
  assert.match(playersMessage(['Mara']), /^:crybaby: Tonight’s players/);
  const { game, s } = play([
    ...seated,
    { type: 'pick', cat: 1, row: 2, by: 'host', at: 10 },
    { type: 'arm', by: 'host', at: 100 },
    { type: 'buzz', id: 'p-c', ts: 300, recv: 320, by: 'player', at: 320 },
    { type: 'award', by: 'auto', at: 520 },
    { type: 'judge', correct: false, by: 'host', at: 600 },
    { type: 'timeout', by: 'auto', at: 6000 },
  ]);
  const msg = clueMessage(clueSummary(game, s));
  assert.ok(!msg.includes(':angry1:') && !msg.includes('angry\\~'), 'the emote name is not escaped');
});

test('the welcome and final round posts carry their emotes', () => {
  assert.equal(
    preview(welcomeMessage({ names: ['Mara', 'Theo'], control: 'Theo' })),
    ':crybaby: Welcome to Crypardy! Tonight’s players: Mara and Theo. Theo picks first.',
  );
  const game = { final: { category: 'Big Fish', clue: 'Year it came out', response: 'What is 2017?' } };
  const s = {
    phase: 'final-reveal',
    seats: [
      { id: 'p-a', name: 'Mara', score: 3000 },
      { id: 'p-b', name: 'Theo', score: 200 },
    ],
    final: {
      order: ['p-b', 'p-a'],
      index: 1,
      judged: { 'p-b': false, 'p-a': true },
      wagers: { 'p-b': 400, 'p-a': 1000 },
      responses: { 'p-b': '2015', 'p-a': '2017' },
    },
  };
  assert.equal(
    preview(finalMessage(finalSummary(game, s))),
    [
      'Final Round · Big Fish :music:',
      'Year it came out',
      'Theo wrote “2015” and was incorrect :angry~1:. Wagered 400, now has 200.',
      'Mara wrote “2017” and was correct :yes: :eat:. Wagered 1,000, now has 3,000.',
      'Correct response: What is 2017?',
    ].join('\n'),
  );
  assert.equal(finalSummary(game, { ...s, phase: 'final-category' }), null, 'the clue stays private until it is revealed');
  assert.deepEqual('Theo :angry~1: :yes:'.match(EMOTE_PATTERN), [':angry~1:', ':yes:']);
});
