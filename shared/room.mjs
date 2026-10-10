import { createHmac } from 'node:crypto';

export function normalizePassword(password) {
  return String(password ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function roomFromPassword(apiKey, password) {
  const key = String(apiKey ?? '');
  const secret = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  return createHmac('sha256', secret)
    .update(`crypardy-room:${normalizePassword(password)}`)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
}
