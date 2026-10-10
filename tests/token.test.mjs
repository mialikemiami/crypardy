import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, createLimiter, makeTicket, playerIdFromSecret } from '../netlify/functions/ably-token.mjs';
import { roomFromPassword } from '../shared/room.mjs';

process.env.ABLY_API_KEY = 'appId.keyId:not-a-real-secret-just-for-tests';
process.env.HOST_PASSWORD = 'letmein';

let hostOnline = true;
const handler = createHandler({ checkHost: async () => hostOnline, failDelayMs: 0 });

const call = (body, method = 'POST') =>
  handler(
    new Request('https://example.test/.netlify/functions/ably-token', {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }),
  );

const secret = 'abcdefghijklmnop0123456789';
const room = roomFromPassword(process.env.ABLY_API_KEY, 'Taco Night');

const caps = (tr) =>
  Object.fromEntries(Object.entries(JSON.parse(tr.capability)).map(([k, v]) => [k, [...v].sort()]));

test('the game password picks the room, ignoring case and extra spaces', () => {
  assert.equal(roomFromPassword(process.env.ABLY_API_KEY, '  taco   NIGHT '), room);
  assert.notEqual(roomFromPassword(process.env.ABLY_API_KEY, 'taco nights'), room);
  assert.notEqual(roomFromPassword('appId.keyId:other-secret', 'taco night'), room, 'depends on the API key');
  assert.match(room, /^[0-9A-F]{16}$/);
});

test('host needs the host password', async () => {
  assert.equal((await call({ role: 'host', password: 'taco night', hostPassword: 'nope' })).status, 401);
  const res = await call({ role: 'host', password: 'Taco Night', hostPassword: 'letmein' });
  assert.equal(res.status, 200);
  const { room: r, tokenRequest: tr } = await res.json();
  assert.equal(r, room);
  assert.equal(tr.clientId, 'host');
  assert.deepEqual(caps(tr), { [`cr:${room}:*`]: ['history', 'presence', 'publish', 'subscribe'] });
  assert.equal(tr.keyName, 'appId.keyId');
  assert.ok(tr.mac && tr.nonce && tr.timestamp);
});

test('players join with the game password and get narrow permissions', async () => {
  const { room: r, tokenRequest: tr } = await (await call({ role: 'player', password: 'taco night', secret })).json();
  assert.equal(r, room);
  assert.equal(tr.clientId, `p-${playerIdFromSecret(secret)}`);
  assert.deepEqual(caps(tr), {
    [`cr:${room}:public`]: ['history', 'subscribe'],
    [`cr:${room}:input`]: ['publish'],
    [`cr:${room}:lobby`]: ['presence'],
  });
});

test('a wrong game password finds no game', async () => {
  hostOnline = false;
  const res = await call({ role: 'player', password: 'wrong password', secret });
  assert.equal(res.status, 404);
  assert.match((await res.json()).error, /No game is running/);
  hostOnline = true;
});

test('renewals need the ticket from an earlier sign-in for the same room and player', async () => {
  const first = await (await call({ role: 'player', password: 'taco night', secret })).json();
  assert.ok(first.renewTicket);
  hostOnline = false;
  const renewed = await call({ role: 'player', password: 'taco night', secret, renewTicket: first.renewTicket });
  assert.equal(renewed.status, 200);
  assert.equal((await renewed.json()).renewTicket, first.renewTicket, 'renewing never pushes the 12-hour limit back');
  assert.equal((await call({ role: 'player', password: 'taco night', secret, renew: true })).status, 404);
  assert.equal((await call({ role: 'player', password: 'taco night', secret: 'zzzzzzzzzzzzzzzzzzzz', renewTicket: first.renewTicket })).status, 404);
  assert.equal((await call({ role: 'player', password: 'other room', secret, renewTicket: first.renewTicket })).status, 404);
  assert.equal((await call({ role: 'stream', password: 'taco night', secret, renewTicket: first.renewTicket })).status, 404);
  hostOnline = true;
});

test('too many wrong passwords from one address are refused for a while', async () => {
  const limited = createHandler({ checkHost: async () => false, failDelayMs: 0, limiter: createLimiter({ max: 3 }) });
  const guess = (ip, body) =>
    limited(
      new Request('https://example.test/.netlify/functions/ably-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nf-client-connection-ip': ip },
        body: JSON.stringify(body),
      }),
    );
  for (let i = 0; i < 3; i++) assert.equal((await guess('1.2.3.4', { role: 'player', password: `guess ${i}`, secret })).status, 404);
  assert.equal((await guess('1.2.3.4', { role: 'player', password: 'guess 4', secret })).status, 429);
  assert.equal((await guess('1.2.3.4', { role: 'host', password: 'taco night', hostPassword: 'letmein' })).status, 429);
  assert.equal((await guess('5.6.7.8', { role: 'host', password: 'taco night', hostPassword: 'letmein' })).status, 200, 'others are unaffected');
});

test('stream view is read-only', async () => {
  const { tokenRequest: tr } = await (await call({ role: 'stream', password: 'taco night', secret })).json();
  assert.ok(tr.clientId.startsWith('s-'));
  assert.deepEqual(caps(tr), {
    [`cr:${room}:public`]: ['history', 'subscribe'],
    [`cr:${room}:lobby`]: ['presence'],
  });
});

test('bad requests are refused', async () => {
  assert.equal((await call({ role: 'player', password: 'abc', secret })).status, 400);
  assert.equal((await call({ role: 'player', password: 'taco night', secret: 'short' })).status, 400);
  assert.equal((await call({ role: 'admin', password: 'taco night' })).status, 400);
  assert.equal((await call({}, 'GET')).status, 405);
});

test('the browser derives the same player id as the function', async () => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const b64 = Buffer.from(digest).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(b64.slice(0, 16), playerIdFromSecret(secret));
});

test('a renewal ticket runs out 12 hours after the first sign-in', async () => {
  hostOnline = false;
  const clientId = `p-${playerIdFromSecret(secret)}`;
  const old = makeTicket(process.env.ABLY_API_KEY, room, clientId, Date.now() - 13 * 60 * 60 * 1000);
  assert.equal((await call({ role: 'player', password: 'taco night', secret, renewTicket: old })).status, 404, 'the host check applies again');
  hostOnline = true;
  assert.equal((await call({ role: 'player', password: 'taco night', secret, renewTicket: old })).status, 200);
});
