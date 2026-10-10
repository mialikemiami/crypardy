const VIDEO = /\.(mp4|webm|mov|m4v|ogv)$/i;
const AUDIO = /\.(mp3|m4a|wav|aac|oga|ogg|flac)$/i;
const YOUTUBE = ['youtube.com', 'youtube-nocookie.com', 'music.youtube.com', 'youtu.be'];

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function toSeconds(value) {
  const s = String(value ?? '').trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const m = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || !m[0]) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

export function parseMedia(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text);
  if (text.startsWith('//') || (hasScheme && !/^https:/i.test(text))) return null;
  let url;
  try {
    url = new URL(text, 'https://site.invalid/');
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, '');
  if (hasScheme && YOUTUBE.includes(host)) {
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/')[1] || '';
    else if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else id = (url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/]+)/) || [])[1] || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return {
      type: 'youtube',
      id,
      url: text,
      start: toSeconds(url.searchParams.get('t') ?? url.searchParams.get('start')),
      end: toSeconds(url.searchParams.get('end')),
    };
  }
  const src = hasScheme ? url.href : text;
  if (host === 'i.imgur.com' && /\.gifv$/i.test(url.pathname)) {
    return { type: 'video', src: url.href.replace(/\.gifv/i, '.mp4'), url: text };
  }
  if (VIDEO.test(url.pathname)) return { type: 'video', src, url: text };
  if (AUDIO.test(url.pathname)) return { type: 'audio', src, url: text };
  return { type: 'image', src, url: text };
}

export const isPlayable = (m) => !!m && m.type !== 'image';

export const mediaLabel = (m) => ({ image: 'Image', video: 'Video', youtube: 'Video', audio: 'Audio clip' })[m?.type] || '';

export function youtubeEmbed(m, { autoplay = true, muted = false, controls = false } = {}) {
  const p = new URLSearchParams({ playsinline: '1', rel: '0', iv_load_policy: '3' });
  if (autoplay) p.set('autoplay', '1');
  if (!controls) p.set('controls', '0');
  if (m.start) p.set('start', String(m.start));
  if (m.end) p.set('end', String(m.end));
  if (muted) p.set('mute', '1');
  return `https://www.youtube-nocookie.com/embed/${m.id}?${p}`;
}

const frame = (src, title) =>
  `<iframe src="${esc(src)}" title="${esc(title)}" allow="autoplay; encrypted-media; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;

export function previewHtml(m) {
  if (!m) return '';
  switch (m.type) {
    case 'image':
      return `<img src="${esc(m.src)}" alt="Clue image preview">`;
    case 'video':
      return `<video src="${esc(m.src)}" controls muted playsinline preload="metadata"></video>`;
    case 'audio':
      return `<audio src="${esc(m.src)}" controls preload="metadata"></audio>`;
    case 'youtube':
      return frame(youtubeEmbed(m, { autoplay: false, controls: true }), 'Clue video preview');
    default:
      return '';
  }
}

function playerHtml(m, muted) {
  if (m.type === 'youtube') return frame(youtubeEmbed(m, { muted }), 'Clue video');
  if (m.type === 'video') return `<video src="${esc(m.src)}" playsinline autoplay${muted ? ' muted' : ''}></video>`;
  return `<audio src="${esc(m.src)}" autoplay></audio><div class="media-wait"><span class="media-icon">♪</span>Audio clip</div>`;
}

function waitingHtml(m, note = '') {
  const icon = m.type === 'audio' ? '♪' : '▶';
  return `<div class="media-wait"><span class="media-icon">${icon}</span>${mediaLabel(m)}${note ? `<span class="media-note">${esc(note)}</span>` : ''}</div>`;
}

export function createMediaLayer({ muted = false, volume = 1 } = {}) {
  const el = document.createElement('div');
  el.className = 'media-layer';
  el.hidden = true;
  document.body.appendChild(el);
  let slot = null;
  let key = null;
  let media = null;
  let playing = false;

  function place() {
    if (!slot || !slot.isConnected) {
      el.hidden = true;
      return;
    }
    const r = slot.getBoundingClientRect();
    el.hidden = !(r.width && r.height);
    el.style.left = `${r.left + scrollX}px`;
    el.style.top = `${r.top + scrollY}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
  }

  function draw() {
    if (!media) el.innerHTML = '';
    else if (media.type === 'image') el.innerHTML = `<img src="${esc(media.src)}" alt="">`;
    else if (!playing) el.innerHTML = waitingHtml(media);
    else if (muted && media.type === 'audio') el.innerHTML = waitingHtml(media, 'Playing on the stream');
    else el.innerHTML = playerHtml(media, muted);
    const player = el.querySelector('video, audio');
    if (player) {
      player.volume = Math.min(1, Math.max(0, volume));
      player.muted = muted || player.muted;
      player.play().catch(() => {});
    }
  }

  addEventListener('resize', place);
  setInterval(() => {
    if (slot) place();
  }, 300);

  return {
    show(slotEl, nextKey, nextMedia) {
      slot = slotEl && nextMedia ? slotEl : null;
      const k = slot ? nextKey : null;
      if (k !== key) {
        key = k;
        media = slot ? nextMedia : null;
        playing = false;
        draw();
      }
      place();
    },
    play(k) {
      if (!key || k !== key || !isPlayable(media)) return false;
      playing = true;
      draw();
      return true;
    },
    stop(k) {
      if (!playing || (k && k !== key)) return;
      playing = false;
      draw();
    },
    get playing() {
      return playing;
    },
    get element() {
      return el;
    },
  };
}

export const mediaSlot = (key, raw, cls = '') =>
  raw ? `<div class="media-slot${cls ? ` ${cls}` : ''}" data-key="${esc(key)}" data-src="${esc(raw)}"></div>` : '';

export function syncMediaLayer(layer, root) {
  const slot = root.querySelector('.media-slot');
  layer.show(slot, slot?.dataset.key, slot ? parseMedia(slot.dataset.src) : null);
}
