import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMedia, toSeconds, youtubeEmbed, previewHtml, mediaSlot } from '../public/js/media.js';
import { buildGame } from '../public/js/csv.js';
import { initialState, reduce, publicView } from '../public/js/engine.js';
import { emptyDraft, draftToCSV, checkDraft, draftFromGame } from '../public/js/gamefile.js';

const sample = readFileSync(new URL('../public/sample-game.csv', import.meta.url), 'utf8');

test('links are read as images, videos, audio or YouTube', () => {
  assert.equal(parseMedia('https://example.com/pic.jpg').type, 'image');
  assert.equal(parseMedia('https://cdn.example.com/photo').type, 'image', 'no extension counts as an image');
  assert.deepEqual(parseMedia('https://example.com/clip.MP4#t=5,12'), { type: 'video', src: 'https://example.com/clip.MP4#t=5,12', url: 'https://example.com/clip.MP4#t=5,12' });
  assert.equal(parseMedia('https://example.com/song.mp3').type, 'audio');
  assert.equal(parseMedia('https://i.imgur.com/AbC123.gifv').src, 'https://i.imgur.com/AbC123.mp4');
  assert.equal(parseMedia('media/clip.webm').src, 'media/clip.webm', 'a file in the site’s own folder');
  assert.equal(parseMedia('/media/pic.png').type, 'image');
});

test('YouTube links keep their start and end times', () => {
  const id = 'dQw4w9WgXcQ';
  assert.deepEqual(parseMedia(`https://www.youtube.com/watch?v=${id}&t=1m30s`), { type: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}&t=1m30s`, start: 90, end: null });
  assert.equal(parseMedia(`https://youtu.be/${id}?t=42`).start, 42);
  assert.equal(parseMedia(`https://youtube.com/shorts/${id}`).id, id);
  assert.equal(parseMedia(`https://music.youtube.com/watch?v=${id}`).id, id);
  const embed = parseMedia(`https://www.youtube.com/embed/${id}?start=10&end=20`);
  assert.deepEqual([embed.start, embed.end], [10, 20]);
  assert.equal(parseMedia('https://www.youtube.com/watch?v=short'), null);
  const url = youtubeEmbed(embed, { muted: true });
  assert.ok(url.startsWith(`https://www.youtube-nocookie.com/embed/${id}?`));
  for (const part of ['autoplay=1', 'start=10', 'end=20', 'mute=1', 'controls=0', 'playsinline=1']) assert.ok(url.includes(part), part);
  assert.ok(!youtubeEmbed(embed).includes('mute=1'), 'the stream plays with sound');
});

test('only https links and the site’s own files are accepted', () => {
  for (const bad of ['http://example.com/a.jpg', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:image/png;base64,AAAA', '//evil.example/a.jpg', 'ftp://x/y.jpg', '', '   ']) {
    assert.equal(parseMedia(bad), null, bad);
  }
  assert.deepEqual([toSeconds('90'), toSeconds('1m30s'), toSeconds('1h2m3s'), toSeconds('42s'), toSeconds('abc'), toSeconds('')], [90, 90, 3723, 42, null, null]);
});

test('links can’t break out of the page markup', () => {
  const html = previewHtml(parseMedia('media/a"onerror="alert(1).jpg'));
  assert.ok(!html.includes('"onerror'), html);
  const slot = mediaSlot('k"x', 'media/"><script>.jpg');
  assert.ok(!slot.includes('<script>') && !slot.includes('k"x'), slot);
});

function withMedia(links) {
  const rows = sample.trim().split('\n');
  const at = rows[0].split(',').indexOf('media');
  return rows
    .map((row) => {
      const link = Object.entries(links).find(([start]) => row.startsWith(start))?.[1];
      if (!link) return row;
      const cells = row.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g).map((c) => c.replace(/^,/, ''));
      cells[at] = link;
      return cells.join(',');
    })
    .join('\n');
}

test('game files read a media column and skip links that won’t work', () => {
  const csv = withMedia({ '1,The Albums,200,': 'https://example.com/a.jpg', '1,The Albums,400,': 'http://example.com/b.jpg', 'final,': 'https://youtu.be/dQw4w9WgXcQ' });
  const { game, warnings } = buildGame(csv);
  assert.equal(game.rounds[0].categories[0].clues[0].media, 'https://example.com/a.jpg');
  assert.equal(game.rounds[0].categories[0].clues[1].media, '', 'the http link is left out');
  assert.ok(warnings.some((w) => /isn’t a full https:\/\/ link/.test(w)));
  assert.equal(game.final.media, 'https://youtu.be/dQw4w9WgXcQ');
  const alias = buildGame('round,category,value,clue,response,image\n1,Cat,200,Q,A,https://example.com/x.png\n');
  assert.equal(alias.game.rounds[0].categories[0].clues[0].media, 'https://example.com/x.png', 'an "image" column works too');
});

test('media stays hidden on a DON’T TRIP! until the wager is in, and on the final until it’s revealed', () => {
  const { game } = buildGame(withMedia({ '1,Featuring Vince,800,': 'https://example.com/trip.jpg', '1,The Albums,200,': 'https://example.com/a.jpg', 'final,': 'https://example.com/final.jpg' }), { random: () => 0 });
  let s = initialState();
  const run = (a) => {
    const r = reduce(game, s, a);
    assert.ok(r.ok, a.type);
    s = r.state;
  };
  for (const a of [
    { type: 'seat', id: 'p-a', name: 'Mara', by: 'host', at: 1 },
    { type: 'start', control: 'p-a', by: 'host', at: 2 },
    { type: 'adjust', id: 'p-a', delta: 2000, by: 'host', at: 3 },
  ]) run(a);
  run({ type: 'pick', cat: 0, row: 0, by: 'host', at: 10 });
  assert.equal(publicView(game, s, 11).clue.media, 'https://example.com/a.jpg');
  assert.equal(publicView(game, s, 11).clue.key, 'board-0-0-0');
  run({ type: 'skip', by: 'host', at: 12 });
  run({ type: 'next', by: 'host', at: 13 });
  run({ type: 'pick', cat: 4, row: 3, by: 'host', at: 20 });
  assert.equal(publicView(game, s, 21).clue.media, null, 'hidden while wagering');
  run({ type: 'wager', id: 'p-a', amount: 500, by: 'player', at: 22 });
  assert.equal(publicView(game, s, 23).clue.media, 'https://example.com/trip.jpg');
  run({ type: 'judge', correct: true, by: 'host', at: 24 });
  run({ type: 'next', by: 'host', at: 25 });
  run({ type: 'endRound', by: 'host', at: 30 });
  run({ type: 'endRound', by: 'host', at: 31 });
  assert.equal(s.phase, 'final-category');
  assert.equal(publicView(game, s, 32).final.media, null, 'hidden before the final clue');
  run({ type: 'finalClue', by: 'host', at: 40 });
  assert.equal(publicView(game, s, 41).final.media, 'https://example.com/final.jpg');
});

test('the game writer saves media links and flags ones that won’t work', () => {
  const d = emptyDraft();
  d.rounds[0].categories[0].name = 'Videos';
  d.rounds[0].categories[0].clues[0] = { clue: 'Name the video', media: 'https://youtu.be/dQw4w9WgXcQ?t=5', response: 'What is X?', note: '', trip: true };
  d.final = { category: 'Pics', clue: 'Who is this?', media: 'media/face.jpg', response: 'Who is Vince?', note: '' };
  const csv = draftToCSV(d);
  assert.equal(csv.split('\n')[0], 'round,category,value,clue,media,response,note,dont_trip');
  const { game } = buildGame(csv);
  assert.equal(game.rounds[0].categories[0].clues[0].media, 'https://youtu.be/dQw4w9WgXcQ?t=5');
  assert.equal(game.final.media, 'media/face.jpg');
  assert.equal(draftFromGame(game).final.media, 'media/face.jpg');
  d.rounds[0].categories[0].clues[1] = { clue: 'Another', media: 'http://insecure.example/x.jpg', response: 'What is Y?', note: '', trip: false };
  assert.ok(checkDraft(d).includes('Round 1, Videos, clue 2: the image or video link needs to be a full link starting with https://.'));
});
