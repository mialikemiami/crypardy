export const SOUND_FILES = {
  select: 'selection.mp3',
  trip: 'donttrip.wav',
  buzz: 'buzzer.wav',
  right: 'right.wav',
  wrong: 'wrong.wav',
  timesup: 'timesup.wav',
  think: 'think.mp3',
  wager: 'wager.mp3',
  next: 'next.flac',
  undo: 'undo.flac',
  gamestart: 'gamestart.wav',
  newround: 'newround.wav',
  final: 'final.wav',
  tie: 'tie.wav',
  openbuzz: 'openbuzz.wav',
};

export function soundForEvent(ev) {
  switch (ev?.type) {
    case 'clue-opened':
      return { play: ev.wager ? 'trip' : 'select' };
    case 'armed':
      return ev.rebound ? null : { play: 'openbuzz' };
    case 'buzz-winner':
      return { play: 'buzz' };
    case 'wager-locked':
    case 'final-wager-locked':
      return { play: 'wager' };
    case 'judged':
    case 'final-judged':
      return { play: ev.correct ? 'right' : 'wrong' };
    case 'timeout':
    case 'answer-timeout':
      return { play: 'timesup' };
    case 'final-clue':
      return { play: 'think' };
    case 'final-time-up':
      return { stop: true };
    case 'undo':
      return { stop: true, play: 'undo' };
    case 'next':
      return { play: 'next' };
    case 'game-start':
      return { play: 'gamestart' };
    case 'round':
      return { play: 'newround' };
    case 'final-category':
      return { play: 'final' };
    case 'tiebreaker':
      return { play: 'tie' };
    case 'revealed':
      return ev.outcome === 'skipped' ? { stop: true } : null;
    default:
      return null;
  }
}

export function createSoundPlayer({ base = 'sounds/', volume = 0.8 } = {}) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const gain = ctx.createGain();
  gain.gain.value = volume;
  gain.connect(ctx.destination);
  const buffers = {};
  let current = null;

  const ready = Promise.all(
    Object.entries(SOUND_FILES).map(async ([name, file]) => {
      try {
        const res = await fetch(base + file);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffers[name] = await ctx.decodeAudioData(await res.arrayBuffer());
      } catch (err) {
        console.warn(`Could not load the ${name} sound (${file}): ${err.message}`);
      }
    }),
  );

  function stop() {
    if (!current) return;
    try {
      current.stop();
    } catch {
    }
    current = null;
  }

  return {
    ready,
    get unlocked() {
      return ctx.state === 'running';
    },
    unlock: () => ctx.resume(),
    onChange(cb) {
      ctx.addEventListener('statechange', () => cb(ctx.state));
    },
    stop,
    play(name) {
      const buffer = buffers[name];
      if (!buffer || ctx.state !== 'running') return false;
      stop();
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      src.onended = () => {
        if (current === src) current = null;
      };
      src.start();
      current = src;
      return true;
    },
  };
}
