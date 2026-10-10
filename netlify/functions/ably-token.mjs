import * as Ably from 'ably';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { normalizePassword, roomFromPassword } from '../../shared/room.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function sameSecret(a, b) {
  const digest = (v) => createHmac('sha256', 'crypardy').update(String(v ?? '')).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export const playerIdFromSecret = (secret) =>
  createHash('sha256').update(String(secret)).digest('base64url').slice(0, 16);

async function hostIsOnline(rest, room) {
  const page = await rest.channels.get(`cr:${room}:lobby`).presence.get({ clientId: 'host' });
  return page.items.some((m) => m.clientId === 'host');
}

const TICKET_MS = 12 * 60 * 60 * 1000;
const keySecret = (key) => (key.includes(':') ? key.slice(key.indexOf(':') + 1) : key);
const ticketMac = (key, room, clientId, exp) =>
  createHmac('sha256', keySecret(key)).update(`crypardy-renew:${room}:${clientId}:${exp}`).digest('base64url').slice(0, 32);

export function makeTicket(key, room, clientId, now = Date.now()) {
  const exp = now + TICKET_MS;
  return `${exp}.${ticketMac(key, room, clientId, exp)}`;
}

export function ticketValid(key, room, clientId, ticket, now = Date.now()) {
  const [expRaw, mac] = String(ticket || '').split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < now || !mac) return false;
  const want = Buffer.from(ticketMac(key, room, clientId, exp));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
}

export function createLimiter({ max = 20, windowMs = 10 * 60 * 1000 } = {}) {
  const hits = new Map();
  const entry = (ip, now) => {
    let e = hits.get(ip);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + windowMs };
      hits.set(ip, e);
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    return e;
  };
  return {
    blocked: (ip, now = Date.now()) => entry(ip, now).count >= max,
    fail: (ip, now = Date.now()) => {
      entry(ip, now).count += 1;
    },
  };
}

const clientIp = (req) =>
  req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

export function createHandler({ checkHost = hostIsOnline, failDelayMs = 600, limiter = createLimiter() } = {}) {
  return async (req) => {
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    const key = process.env.ABLY_API_KEY;
    if (!key) return json({ error: 'The site is missing its ABLY_API_KEY setting.' }, 500);
    const ip = clientIp(req);
    if (limiter.blocked(ip)) {
      return json({ error: 'Too many wrong passwords. Wait 10 minutes and try again.' }, 429);
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Bad request.' }, 400);
    }

    const password = normalizePassword(body.password);
    if (password.length < 4) return json({ error: 'Game passwords have at least 4 characters.' }, 400);
    if (password.length > 64) return json({ error: 'Game passwords have at most 64 characters.' }, 400);
    const room = roomFromPassword(key, password);
    const ns = `cr:${room}`;
    const rest = new Ably.Rest({ key });

    let clientId;
    let capability;
    let renewing = false;
    if (body.role === 'host') {
      if (!process.env.HOST_PASSWORD) return json({ error: 'The site is missing its HOST_PASSWORD setting.' }, 500);
      if (!sameSecret(body.hostPassword, process.env.HOST_PASSWORD)) {
        limiter.fail(ip);
        await pause(failDelayMs);
        return json({ error: 'Wrong host password.' }, 401);
      }
      clientId = 'host';
      capability = { [`${ns}:*`]: ['publish', 'subscribe', 'presence', 'history'] };
    } else if (body.role === 'player' || body.role === 'stream') {
      const secret = String(body.secret || '');
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(secret)) return json({ error: 'Bad sign-in request.' }, 400);
      const id = playerIdFromSecret(secret);
      clientId = `${body.role === 'player' ? 'p' : 's'}-${id}`;
      renewing = ticketValid(key, room, clientId, body.renewTicket);
      if (!renewing) {
        let online;
        try {
          online = await checkHost(rest, room);
        } catch (err) {
          return json({ error: `Could not check for the game: ${err.message}` }, 502);
        }
        if (!online) {
          limiter.fail(ip);
          await pause(failDelayMs);
          return json({ error: 'No game is running with that password. Check it with the host.' }, 404);
        }
      }
      if (body.role === 'player') {
        capability = {
          [`${ns}:public`]: ['subscribe', 'history'],
          [`${ns}:input`]: ['publish'],
          [`${ns}:lobby`]: ['presence'],
        };
      } else {
        capability = {
          [`${ns}:public`]: ['subscribe', 'history'],
          [`${ns}:lobby`]: ['presence'],
        };
      }
    } else {
      return json({ error: 'Unknown role.' }, 400);
    }

    try {
      const tokenRequest = await rest.auth.createTokenRequest({
        clientId,
        capability: JSON.stringify(capability),
        ttl: 6 * 60 * 60 * 1000,
      });
      const ticket = clientId === 'host' ? undefined : renewing ? body.renewTicket : makeTicket(key, room, clientId);
      return json({ room, tokenRequest, renewTicket: ticket });
    } catch (err) {
      return json({ error: `Could not sign the token: ${err.message}` }, 500);
    }
  };
}

export default createHandler();
