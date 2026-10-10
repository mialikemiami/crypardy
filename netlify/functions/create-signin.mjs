import { createHmac, timingSafeEqual } from 'node:crypto';
import { createLimiter } from './ably-token.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function samePassword(a, b) {
  const digest = (v) => createHmac('sha256', 'crypardy-create').update(String(v ?? '')).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const clientIp = (req) =>
  req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

export function createHandler({ failDelayMs = 600, limiter = createLimiter() } = {}) {
  return async (req) => {
    if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    const want = process.env.CREATE_PASSWORD;
    if (!want) return json({ error: 'The site is missing its CREATE_PASSWORD setting.' }, 500);
    const ip = clientIp(req);
    if (limiter.blocked(ip)) return json({ error: 'Too many wrong passwords. Wait 10 minutes and try again.' }, 429);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'Bad request.' }, 400);
    }
    if (!samePassword(body?.password, want)) {
      limiter.fail(ip);
      await pause(failDelayMs);
      return json({ error: 'Wrong password.' }, 401);
    }
    return json({ ok: true });
  };
}

export default createHandler();
