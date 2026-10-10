const ABLY_SRC = 'https://cdn.ably.com/lib/ably.min-2.js';
const TOKEN_URL = '/.netlify/functions/ably-token';

export const fullName = (room, ch) => `cr:${room}:${ch}`;

export function normalizePassword(password) {
  return String(password ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function getSecret() {
  const store = localStorage;
  let s = store.getItem('cr:secret');
  if (!s || !/^[A-Za-z0-9]{32,}$/.test(s)) {
    s = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
    store.setItem('cr:secret', s);
  }
  return s;
}

export function connect(opts) {
  if (normalizePassword(opts.password).length < 4) {
    return Promise.reject(new Error('Game passwords have at least 4 characters.'));
  }
  return connectAbly(opts);
}

function loadAbly() {
  if (window.Ably) return Promise.resolve(window.Ably);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ABLY_SRC;
    s.onload = () => resolve(window.Ably);
    s.onerror = () => reject(new Error('Could not load the Ably library. Check your connection.'));
    document.head.appendChild(s);
  });
}

async function signIn(body) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the sign-in service.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
  }
  if (!res.ok) {
    if (res.status === 404 && !data) {
      throw new Error('Sign-in service not found. Check that the site is deployed on Netlify with its functions.');
    }
    throw new Error(data?.error || `Sign-in failed (${res.status}).`);
  }
  return data;
}

async function connectAbly({ role, password, hostPassword, onStatus }) {
  const body = { role, password, hostPassword, secret: role === 'host' ? undefined : getSecret() };
  const first = await signIn(body);
  const room = first.room;
  let pending = first.tokenRequest;
  let ticket = first.renewTicket;
  const renew = async () => {
    const d = await signIn({ ...body, renewTicket: ticket });
    if (d.renewTicket) ticket = d.renewTicket;
    return d.tokenRequest;
  };
  const Ably = await loadAbly();
  const realtime = new Ably.Realtime({
    authCallback: (_params, cb) => {
      const ready = pending;
      pending = null;
      (ready ? Promise.resolve(ready) : renew()).then(
        (token) => cb(null, token),
        (err) => cb(err.message, null),
      );
    },
    echoMessages: false,
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Ably.')), 20000);
      const watch = (change) => {
        if (change.current === 'connected') {
          clearTimeout(timer);
          realtime.connection.off(watch);
          resolve();
        } else if (change.current === 'failed') {
          clearTimeout(timer);
          reject(new Error(change.reason?.message || 'Could not connect to Ably.'));
        }
      };
      realtime.connection.on(watch);
    });
  } catch (err) {
    realtime.close();
    throw err;
  }
  realtime.connection.on((change) => onStatus?.(change.current));
  onStatus?.('connected');

  let offset = 0;
  let clockKnown = false;
  const measure = async () => {
    let best = null;
    for (let i = 0; i < 3; i++) {
      try {
        const t0 = Date.now();
        const server = await realtime.time();
        const t1 = Date.now();
        if (t1 - t0 < 500 && (!best || t1 - t0 < best.rtt)) best = { rtt: t1 - t0, offset: server - (t0 + t1) / 2 };
      } catch {
      }
    }
    if (best) {
      offset = best.offset;
      clockKnown = true;
    }
  };
  let offsetTimer = null;
  await measure();
  if (role === 'host') offsetTimer = setInterval(measure, 5 * 60 * 1000);

  const channels = {};
  const ch = (name) =>
    (channels[name] ||= realtime.channels.get(
      fullName(room, name),
      name === 'public' && role !== 'host' ? { params: { rewind: '1' } } : undefined,
    ));
  const toMsg = (m) => ({ name: m.name, data: m.data, clientId: m.clientId, timestamp: m.timestamp });

  return {
    room,
    clientId: realtime.auth.clientId,
    publish: (name, event, data) => ch(name).publish(event, data),
    subscribe: (name, cb) => ch(name).subscribe((m) => cb(toMsg(m))),
    enter: (name, data) => ch(name).presence.enter(data),
    update: (name, data) => ch(name).presence.update(data),
    members: async (name) => (await ch(name).presence.get()).map((m) => ({ clientId: m.clientId, data: m.data })),
    onPresence: (name, cb) =>
      ch(name).presence.subscribe((m) => cb({ action: m.action, clientId: m.clientId, data: m.data })),
    serverOffset: () => offset,
    clockKnown: () => clockKnown,
    close: () => {
      clearInterval(offsetTimer);
      realtime.close();
    },
  };
}
