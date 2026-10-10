export const SETTINGS = Object.freeze({
  buzzWindowMs: 5000,
  answerMs: 5000,
  wagerAnswerMs: 15000,
  finalThinkMs: 30000,
  finalGraceMs: 1500,
  finalResumeMs: 10000,
  collectMs: 200,
  lockoutMs: 250,
  maxTransitMs: 300,
  maxSeats: 4,
  negativeScores: true,
});

const CLUE_PHASES = ['clue', 'tiebreaker'];

export function initialState() {
  return {
    phase: 'lobby',
    roundIndex: 0,
    seats: [],
    control: null,
    used: {},
    clue: null,
    final: null,
    winners: null,
    lastBuzz: [],
    tiebreakerUsed: false,
  };
}

export const cellKey = (r, c, row) => `${r}-${c}-${row}`;
const findSeat = (s, id) => s.seats.find((x) => x.id === id) || null;
export const seatName = (s, id) => findSeat(s, id)?.name || 'Someone';

export function cleanName(name) {
  const n = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
  return n || 'Player';
}

export function roundMax(game, r) {
  const round = game?.rounds?.[r];
  if (!round) return 0;
  return Math.max(0, ...round.categories.flatMap((c) => c.clues.map((cl) => cl.value)));
}

export function roundRows(game, r) {
  const round = game?.rounds?.[r];
  if (!round) return 0;
  return Math.max(0, ...round.categories.map((c) => c.clues.length));
}

export function roundHasCells(game, s, r) {
  const round = game.rounds[r];
  if (!round) return false;
  return round.categories.some((cat, ci) => cat.clues.some((_, row) => !s.used[cellKey(r, ci, row)]));
}

export function wagerLimits(game, s, id) {
  const seat = findSeat(s, id);
  const score = seat ? seat.score : 0;
  const max = Math.max(score, roundMax(game, s.roundIndex));
  return { min: Math.min(5, max), max };
}

export function clueSource(game, clue) {
  if (!clue) return null;
  if (clue.kind === 'tiebreaker') return game.tiebreaker || null;
  const cat = game.rounds[clue.r]?.categories[clue.cat];
  const cl = cat?.clues[clue.row];
  return cl ? { ...cl, category: cat.name } : null;
}

function newClue(o) {
  return {
    kind: o.kind,
    r: o.r ?? null,
    cat: o.cat ?? null,
    row: o.row ?? null,
    value: o.value || 0,
    wager: !!o.wager,
    wagerAmount: null,
    armed: false,
    armedAt: null,
    deadline: null,
    timer: null,
    buzzes: [],
    firstRecv: null,
    answering: null,
    overtime: false,
    correctBy: null,
    attempted: [],
    eligible: o.eligible || null,
    lockouts: {},
    outcome: null,
    revealed: false,
  };
}

function armClue(c, at, cfg) {
  c.armed = true;
  c.overtime = false;
  c.armedAt = at;
  c.timer = 'buzz';
  c.deadline = at + cfg.buzzWindowMs;
  c.buzzes = [];
  c.firstRecv = null;
}

function toInt(v) {
  const n = Number(String(v ?? '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : NaN;
}

function advanceRound(game, s, emit) {
  if (s.roundIndex + 1 < game.rounds.length) {
    s.roundIndex += 1;
    s.phase = 'board';
    const low = Math.min(...s.seats.map((x) => x.score));
    s.control = s.seats.find((x) => x.score === low).id;
    emit('round', { name: game.rounds[s.roundIndex].name, control: seatName(s, s.control) });
    return;
  }
  const eligible = s.seats.filter((x) => x.score > 0).map((x) => x.id);
  if (game.final && eligible.length) {
    s.phase = 'final-category';
    s.control = null;
    s.final = {
      eligible,
      wagers: {},
      responses: {},
      deadline: null,
      order: null,
      index: -1,
      judged: {},
      start: Object.fromEntries(s.seats.map((x) => [x.id, x.score])),
    };
    emit('final-category', { category: game.final.category });
    return;
  }
  finish(game, s, emit);
}

function finish(game, s, emit) {
  const top = Math.max(...s.seats.map((x) => x.score));
  const leaders = s.seats.filter((x) => x.score === top).map((x) => x.id);
  if (top > 0 && leaders.length > 1 && game.tiebreaker && !s.tiebreakerUsed) {
    s.tiebreakerUsed = true;
    s.phase = 'tiebreaker';
    s.clue = newClue({ kind: 'tiebreaker', value: 0, eligible: leaders });
    emit('tiebreaker', {
      names: leaders.map((id) => seatName(s, id)),
      category: game.tiebreaker.category,
      clue: game.tiebreaker.clue,
    });
    return;
  }
  finishWith(s, top > 0 ? leaders : [], emit);
}

function finishWith(s, winners, emit) {
  s.phase = 'over';
  s.winners = winners;
  emit('game-over', {
    winners: winners.map((id) => seatName(s, id)),
    scores: s.seats.map((x) => ({ name: x.name, score: x.score })),
  });
}

function reveal(game, s, outcome, emit) {
  const c = s.clue;
  c.armed = false;
  c.timer = null;
  c.revealed = true;
  c.outcome = outcome;
  emit('revealed', { response: clueSource(game, c)?.response || '', outcome, wager: !!c.wager });
}

const HANDLERS = {
  seat(game, s, a, emit, cfg) {
    if (s.phase !== 'lobby' || !a.id) return false;
    if (s.seats.length >= cfg.maxSeats || findSeat(s, a.id)) return false;
    const name = cleanName(a.name);
    s.seats.push({ id: a.id, name, score: 0 });
    emit('seated', { name });
  },

  unseat(game, s, a, emit) {
    if (s.phase !== 'lobby') return false;
    const seat = findSeat(s, a.id);
    if (!seat) return false;
    s.seats = s.seats.filter((x) => x.id !== a.id);
    emit('unseated', { name: seat.name });
  },

  reseat(game, s, a, emit) {
    const seat = findSeat(s, a.oldId);
    if (!seat || !a.id || findSeat(s, a.id)) return false;
    const name = cleanName(a.name || seat.name);
    const swapped = JSON.parse(JSON.stringify(s).split(JSON.stringify(a.oldId)).join(JSON.stringify(a.id)));
    Object.assign(s, swapped);
    findSeat(s, a.id).name = name;
    emit('seated', { name });
  },

  rename(game, s, a) {
    const seat = findSeat(s, a.id);
    if (!seat) return false;
    seat.name = cleanName(a.name);
  },

  start(game, s, a, emit) {
    if (s.phase !== 'lobby' || !s.seats.length || !game?.rounds?.length) return false;
    s.phase = 'board';
    s.roundIndex = 0;
    s.control = findSeat(s, a.control) ? a.control : s.seats[0].id;
    emit('game-start', {
      names: s.seats.map((x) => x.name),
      round: game.rounds[0].name,
      control: seatName(s, s.control),
    });
  },

  pick(game, s, a, emit) {
    if (s.phase !== 'board') return false;
    if (a.by !== 'host' && a.who !== s.control) return false;
    const r = s.roundIndex;
    const cat = game.rounds[r]?.categories[a.cat];
    const cl = cat?.clues[a.row];
    if (!cl || s.used[cellKey(r, a.cat, a.row)]) return false;
    s.lastBuzz = [];
    s.clue = newClue({ kind: 'board', r, cat: a.cat, row: a.row, value: cl.value, wager: cl.wager });
    if (cl.wager) {
      s.phase = 'wager';
      s.clue.answering = s.control;
      emit('clue-opened', { category: cat.name, value: cl.value, wager: true, name: seatName(s, s.control) });
    } else {
      s.phase = 'clue';
      emit('clue-opened', { category: cat.name, value: cl.value, wager: false, clue: cl.clue });
    }
  },

  wager(game, s, a, emit, cfg) {
    if (s.phase !== 'wager' || a.id !== s.control) return false;
    const { min, max } = wagerLimits(game, s, a.id);
    const amount = toInt(a.amount);
    if (!Number.isFinite(amount) || amount < min || amount > max) return false;
    const c = s.clue;
    c.wagerAmount = amount;
    c.answering = a.id;
    c.timer = 'answer';
    c.deadline = a.at + cfg.wagerAnswerMs;
    s.phase = 'clue';
    emit('wager-locked', { name: seatName(s, a.id), amount, clue: clueSource(game, c).clue });
  },

  arm(game, s, a, emit, cfg) {
    if (!CLUE_PHASES.includes(s.phase)) return false;
    const c = s.clue;
    if (!c || c.wager || c.armed || c.answering || c.revealed) return false;
    armClue(c, a.at, cfg);
    emit('armed', {});
  },

  buzz(game, s, a, emit, cfg) {
    if (!CLUE_PHASES.includes(s.phase)) return false;
    const c = s.clue;
    if (!c || c.wager || c.revealed || c.answering) return false;
    if (!findSeat(s, a.id)) return false;
    if (c.eligible && !c.eligible.includes(a.id)) return false;
    if (c.attempted.includes(a.id)) return false;
    const sent = Number.isFinite(Number(a.ts)) && Number(a.ts) > 0 ? Number(a.ts) : a.recv;
    const ts = Math.min(a.recv, Math.max(sent, a.recv - cfg.maxTransitMs));
    if (!c.armed || ts < c.armedAt) {
      if (c.buzzes.some((b) => b.id === a.id)) return false;
      if ((c.lockouts[a.id] || 0) > a.recv) return false;
      c.lockouts[a.id] = a.recv + cfg.lockoutMs;
      return;
    }
    if ((c.lockouts[a.id] || 0) > a.recv) return false;
    if (a.recv > c.deadline) return false;
    if (c.buzzes.some((b) => b.id === a.id)) return false;
    c.buzzes.push({ id: a.id, ts: Math.max(ts, c.armedAt), recv: a.recv });
    if (c.firstRecv == null) c.firstRecv = a.recv;
  },

  award(game, s, a, emit, cfg) {
    const c = s.clue;
    if (!c || !c.armed || c.answering || !c.buzzes.length) return false;
    const order = [...c.buzzes].sort((x, y) => x.ts - y.ts || x.recv - y.recv);
    const winner = order[0];
    c.answering = winner.id;
    c.armed = false;
    c.overtime = false;
    c.timer = 'answer';
    c.deadline = a.at + cfg.answerMs;
    s.lastBuzz = order.map((b, i) =>
      i === 0 ? { id: b.id, ms: Math.max(0, b.recv - c.armedAt) } : { id: b.id, behind: Math.max(0, b.ts - winner.ts) },
    );
    emit('buzz-winner', { name: seatName(s, winner.id), ms: s.lastBuzz[0].ms });
  },

  judge(game, s, a, emit, cfg) {
    if (!CLUE_PHASES.includes(s.phase)) return false;
    const c = s.clue;
    if (!c || !c.answering) return false;
    const id = c.answering;
    const seat = findSeat(s, id);

    if (s.phase === 'tiebreaker') {
      emit('judged', { name: seat.name, correct: !!a.correct, delta: 0, score: seat.score, wager: false });
      if (a.correct) {
        c.correctBy = id;
        c.answering = null;
        reveal(game, s, 'correct', emit);
        finishWith(s, [id], emit);
        return;
      }
      c.attempted.push(id);
      c.answering = null;
      c.timer = null;
      const remaining = c.eligible.filter((x) => !c.attempted.includes(x));
      if (remaining.length) {
        armClue(c, a.at, cfg);
        emit('armed', { rebound: true });
      } else {
        reveal(game, s, 'incorrect', emit);
        finishWith(s, c.eligible.slice(), emit);
      }
      return;
    }

    const value = c.wager ? c.wagerAmount : c.value;
    if (a.correct) {
      seat.score += value;
      s.control = id;
      c.correctBy = id;
      c.answering = null;
      emit('judged', { name: seat.name, correct: true, delta: value, score: seat.score, wager: c.wager });
      reveal(game, s, 'correct', emit);
      s.phase = 'reveal';
      return;
    }
    const delta = cfg.negativeScores ? -value : 0;
    seat.score += delta;
    emit('judged', { name: seat.name, correct: false, delta, score: seat.score, wager: c.wager });
    c.attempted.push(id);
    c.answering = null;
    c.timer = null;
    const remaining = s.seats.filter((x) => !c.attempted.includes(x.id));
    if (!c.wager && remaining.length) {
      armClue(c, a.at, cfg);
      emit('armed', { rebound: true });
    } else {
      reveal(game, s, 'incorrect', emit);
      s.phase = 'reveal';
    }
  },

  answerTimeout(game, s, a, emit) {
    const c = s.clue;
    if (!CLUE_PHASES.includes(s.phase) || !c?.answering || c.timer !== 'answer' || a.at < c.deadline) return false;
    c.timer = null;
    c.overtime = true;
    emit('answer-timeout', { name: seatName(s, c.answering), wager: c.wager });
  },

  timeout(game, s, a, emit) {
    const c = s.clue;
    if (!c || !c.armed || c.buzzes.length || a.at < c.deadline) return false;
    emit('timeout', {});
    reveal(game, s, 'timeout', emit);
    if (s.phase === 'tiebreaker') finishWith(s, c.eligible.slice(), emit);
    else s.phase = 'reveal';
  },

  skip(game, s, a, emit) {
    const c = s.clue;
    if (!c || c.kind !== 'board' || !['clue', 'wager'].includes(s.phase) || c.revealed) return false;
    c.answering = null;
    reveal(game, s, 'skipped', emit);
    s.phase = 'reveal';
  },

  next(game, s, a, emit) {
    if (s.phase !== 'reveal') return false;
    emit('next', {});
    const c = s.clue;
    s.used[cellKey(c.r, c.cat, c.row)] = true;
    s.clue = null;
    s.lastBuzz = [];
    if (roundHasCells(game, s, s.roundIndex)) {
      s.phase = 'board';
      return;
    }
    advanceRound(game, s, emit);
  },

  endRound(game, s, a, emit) {
    if (s.phase !== 'board') return false;
    advanceRound(game, s, emit);
  },

  setControl(game, s, a) {
    if (s.phase !== 'board' || !findSeat(s, a.id)) return false;
    s.control = a.id;
  },

  adjust(game, s, a) {
    if (s.phase === 'over') return false;
    const seat = findSeat(s, a.id);
    const delta = toInt(a.delta);
    if (!seat || !Number.isFinite(delta) || delta === 0) return false;
    seat.score += delta;
    const f = s.final;
    if (s.phase === 'final-category' && f) {
      f.eligible = s.seats.filter((x) => x.score > 0).map((x) => x.id);
      for (const id of Object.keys(f.wagers)) {
        if (!f.eligible.includes(id)) delete f.wagers[id];
        else f.wagers[id] = Math.min(f.wagers[id], findSeat(s, id).score);
      }
      f.start[a.id] = seat.score;
    }
  },

  finalWager(game, s, a, emit) {
    if (s.phase !== 'final-category') return false;
    const f = s.final;
    if (!f.eligible.includes(a.id)) return false;
    const amount = toInt(a.amount);
    if (!Number.isFinite(amount) || amount < 0 || amount > findSeat(s, a.id).score) return false;
    const first = f.wagers[a.id] == null;
    f.wagers[a.id] = amount;
    if (first) emit('final-wager-locked', { name: seatName(s, a.id) });
  },

  finalClue(game, s, a, emit, cfg) {
    if (s.phase !== 'final-category') return false;
    const f = s.final;
    for (const id of f.eligible) if (f.wagers[id] == null) f.wagers[id] = 0;
    f.deadline = a.at + cfg.finalThinkMs;
    s.phase = 'final-clue';
    emit('final-clue', { category: game.final.category, clue: game.final.clue });
  },

  finalResponse(game, s, a, emit, cfg) {
    if (s.phase !== 'final-clue') return false;
    const f = s.final;
    if (!f.eligible.includes(a.id) || a.recv > f.deadline + cfg.finalGraceMs) return false;
    f.responses[a.id] = String(a.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  },

  finalTimeUp(game, s, a, emit, cfg) {
    if (s.phase !== 'final-clue') return false;
    const f = s.final;
    if (a.by === 'host' && a.at < f.deadline) {
      f.deadline = a.at;
      return;
    }
    if (a.at < f.deadline + cfg.finalGraceMs) return false;
    const seatOrder = s.seats.map((x) => x.id);
    f.order = [...f.eligible].sort((x, y) => f.start[x] - f.start[y] || seatOrder.indexOf(x) - seatOrder.indexOf(y));
    f.index = -1;
    s.phase = 'final-reveal';
    emit('final-time-up', {});
  },

  finalReveal(game, s, a, emit) {
    if (s.phase !== 'final-reveal') return false;
    const f = s.final;
    const current = f.order[f.index];
    if (f.index >= 0 && f.judged[current] === undefined) return false;
    if (f.index + 1 >= f.order.length) return false;
    f.index += 1;
    const id = f.order[f.index];
    emit('final-response', { name: seatName(s, id), response: f.responses[id] || '' });
  },

  finalJudge(game, s, a, emit) {
    if (s.phase !== 'final-reveal') return false;
    const f = s.final;
    const id = f.order[f.index];
    if (f.index < 0 || f.judged[id] !== undefined) return false;
    const seat = findSeat(s, id);
    const wager = Math.min(f.wagers[id] || 0, Math.max(0, seat.score));
    f.wagers[id] = wager;
    seat.score += a.correct ? wager : -wager;
    f.judged[id] = !!a.correct;
    emit('final-judged', { name: seat.name, correct: !!a.correct, wager, score: seat.score });
    if (f.order.every((x) => f.judged[x] !== undefined)) {
      emit('revealed', { response: game.final.response, outcome: 'final' });
    }
  },

  resumeTimers(game, s, a, emit, cfg) {
    let changed = false;
    const c = s.clue;
    if (c && c.armed && !c.answering && !c.buzzes.length && c.deadline <= a.at) {
      c.deadline = a.at + cfg.buzzWindowMs;
      changed = true;
    }
    if (c && c.answering && c.timer === 'answer' && c.deadline <= a.at) {
      c.deadline = a.at + (c.wager ? cfg.wagerAnswerMs : cfg.answerMs);
      changed = true;
    }
    const f = s.final;
    if (s.phase === 'final-clue' && f && f.deadline + cfg.finalGraceMs <= a.at) {
      f.deadline = a.at + cfg.finalResumeMs;
      changed = true;
    }
    if (!changed) return false;
  },

  finish(game, s, a, emit) {
    if (s.phase !== 'final-reveal') return false;
    const f = s.final;
    if (!f.order.every((x) => f.judged[x] !== undefined)) return false;
    finish(game, s, emit);
  },
};

export function reduce(game, state, action, cfg = SETTINGS) {
  const handler = HANDLERS[action?.type];
  if (!handler) return { ok: false, state, events: [] };
  const s = structuredClone(state);
  const events = [];
  const emit = (type, data) => events.push({ type, ...data });
  const result = handler(game, s, action, emit, cfg);
  if (result === false) return { ok: false, state, events: [] };
  return { ok: true, state: s, events };
}

export function replay(game, actions, cfg = SETTINGS) {
  let s = initialState();
  for (const a of actions) {
    const r = reduce(game, s, a, cfg);
    if (r.ok) s = r.state;
  }
  return s;
}

export function primaryAction(game, s) {
  switch (s.phase) {
    case 'lobby':
      return s.seats.length && game ? { type: 'start', label: 'Start game' } : null;
    case 'clue':
    case 'tiebreaker': {
      const c = s.clue;
      if (c && !c.wager && !c.armed && !c.answering && !c.revealed) return { type: 'arm', label: 'Open buzzers' };
      return null;
    }
    case 'reveal':
      return { type: 'next', label: 'Next' };
    case 'final-category':
      return { type: 'finalClue', label: 'Reveal final clue' };
    case 'final-reveal': {
      const f = s.final;
      const current = f.order[f.index];
      if (f.index >= 0 && f.judged[current] === undefined) return null;
      return f.index + 1 < f.order.length
        ? { type: 'finalReveal', label: 'Reveal next response' }
        : { type: 'finish', label: 'Finish game' };
    }
    default:
      return null;
  }
}

export function canJudge(s) {
  if (CLUE_PHASES.includes(s.phase)) return !!s.clue?.answering;
  if (s.phase === 'final-reveal') {
    const f = s.final;
    return f.index >= 0 && f.judged[f.order[f.index]] === undefined;
  }
  return false;
}

export const judgeAction = (s, correct) =>
  s.phase === 'final-reveal' ? { type: 'finalJudge', correct } : { type: 'judge', correct };

export const mediaKey = (c) => [c.kind, c.r, c.cat, c.row].join('-');

export function publicView(game, s, now, cfg = SETTINGS) {
  const r = s.roundIndex;
  const round = game?.rounds?.[r];
  const view = {
    title: game?.title || '',
    phase: s.phase,
    round: round ? { index: r, name: round.name, count: game.rounds.length } : null,
    seats: s.seats.map(({ id, name, score }) => ({ id, name, score })),
    control: s.control,
    winners: s.winners,
    lastBuzz: s.lastBuzz,
    board: null,
    clue: null,
    final: null,
  };

  if (round && ['board', 'wager', 'clue', 'reveal'].includes(s.phase)) {
    const rows = roundRows(game, r);
    view.board = {
      categories: round.categories.map((c) => c.name),
      rows,
      cells: round.categories.map((cat, ci) =>
        Array.from({ length: rows }, (_, row) => {
          const cl = cat.clues[row];
          return cl ? { value: cl.value, used: !!s.used[cellKey(r, ci, row)] } : null;
        }),
      ),
    };
  }

  const c = s.clue;
  if (c && game) {
    const src = clueSource(game, c) || {};
    const total =
      c.timer === 'buzz' ? cfg.buzzWindowMs : c.timer === 'answer' ? (c.wager ? cfg.wagerAnswerMs : cfg.answerMs) : 0;
    const hidden = c.wager && c.wagerAmount == null;
    view.clue = {
      key: mediaKey(c),
      kind: c.kind,
      cat: c.cat,
      row: c.row,
      category: src.category || '',
      value: c.value,
      wager: c.wager,
      wagerAmount: c.wagerAmount,
      text: hidden ? null : src.clue || '',
      media: hidden ? null : src.media || '',
      armed: c.armed,
      answering: c.answering,
      overtime: c.overtime,
      correctBy: c.correctBy,
      attempted: c.attempted,
      eligible: c.eligible,
      outcome: c.outcome,
      revealed: c.revealed,
      response: c.revealed ? src.response || '' : null,
      timer: c.timer ? { kind: c.timer, remaining: Math.max(0, c.deadline - now), total } : null,
    };
  }

  const f = s.final;
  if (f && game?.final) {
    const revealing = ['final-clue', 'final-reveal', 'over', 'tiebreaker'].includes(s.phase);
    const shown = f.order ? f.order.slice(0, f.index + 1) : [];
    const allJudged = !!f.order && f.order.every((x) => f.judged[x] !== undefined);
    view.final = {
      category: game.final.category,
      clue: revealing ? game.final.clue : null,
      media: revealing ? game.final.media || '' : null,
      response: allJudged ? game.final.response : null,
      eligible: f.eligible,
      wagered: Object.keys(f.wagers),
      responded: Object.keys(f.responses),
      timer:
        s.phase === 'final-clue'
          ? { kind: 'final', remaining: Math.max(0, f.deadline - now), total: cfg.finalThinkMs }
          : null,
      order: f.order,
      index: f.index,
      reveals: shown.map((id) => ({
        id,
        response: f.responses[id] || '',
        wager: f.judged[id] !== undefined ? f.wagers[id] || 0 : null,
        correct: f.judged[id] ?? null,
      })),
    };
  }

  return view;
}
