import { parseMedia } from './media.js';

export function parseCSV(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field.trim() === '') {
      field = '';
      inQuotes = true;
    }
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (inQuotes) {
    const line = rows.length + 1;
    throw new Error(`Line ${line} opens a quote (") that never closes. Close it, or check the clue for a stray quote mark.`);
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

const MAX_CATEGORIES = 6;
const MAX_CLUES = 5;

const headerKey = (h) =>
  String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/['’!]/g, '')
    .replace(/[\s-]+/g, '_');

export function buildGame(text, { title = '' } = {}) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('The file has a header row but no clues.');
  const header = rows[0].map(headerKey);
  const col = Object.fromEntries(
    ['round', 'category', 'value', 'clue', 'response', 'note'].map((k) => [k, header.indexOf(k)]),
  );
  col.trip = ['dont_trip', 'donttrip', 'wager'].map((k) => header.indexOf(k)).find((i) => i >= 0) ?? -1;
  col.media = ['media', 'image', 'video', 'link'].map((k) => header.indexOf(k)).find((i) => i >= 0) ?? -1;
  for (const k of ['round', 'category', 'clue', 'response']) {
    if (col[k] < 0) throw new Error(`The file needs a "${k}" column.`);
  }
  if (col.value < 0) {
    const boardRow = rows.slice(1).some((r) => /\d/.test(String(r[col.round] ?? '')));
    if (boardRow) throw new Error('The file needs a "value" column for the round 1 and 2 clues.');
  }

  const warnings = [];
  const rounds = new Map();
  let final = null;
  let tiebreaker = null;

  rows.slice(1).forEach((r, n) => {
    const line = n + 2;
    const get = (k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() : '');
    const entry = {
      category: get('category'),
      clue: get('clue'),
      response: get('response'),
      note: get('note'),
      media: get('media'),
    };
    if (!entry.category || !entry.clue || !entry.response) {
      warnings.push(`Line ${line} skipped: it needs a category, clue and response.`);
      return;
    }
    if (entry.media && !parseMedia(entry.media)) {
      warnings.push(`Line ${line}: the image or video link isn’t a full https:// link, so it’s left out.`);
      entry.media = '';
    }
    const roundRaw = get('round').toLowerCase();
    if (['final', 'f', 'final round'].includes(roundRaw)) {
      if (final) warnings.push(`Line ${line}: only the first final clue is used.`);
      else final = entry;
      return;
    }
    if (['tiebreaker', 'tie-breaker', 'tie', 'tb'].includes(roundRaw)) {
      if (tiebreaker) warnings.push(`Line ${line}: only the first tiebreaker clue is used.`);
      else tiebreaker = entry;
      return;
    }
    const rn = parseInt((roundRaw.match(/\d+/) || [''])[0], 10);
    if (!(rn >= 1)) {
      warnings.push(`Line ${line} skipped: unknown round "${get('round')}".`);
      return;
    }
    const value = Math.round(parseFloat(get('value').replace(/[$,\s]/g, '')));
    if (!(value > 0)) {
      warnings.push(`Line ${line} skipped: it needs a value.`);
      return;
    }
    entry.value = value;
    entry.wager = /^(y|yes|true|1|x)$/i.test(get('trip'));
    if (!rounds.has(rn)) rounds.set(rn, new Map());
    const cats = rounds.get(rn);
    if (!cats.has(entry.category)) cats.set(entry.category, []);
    cats.get(entry.category).push(entry);
  });

  const numbers = [...rounds.keys()].sort((a, b) => a - b);
  if (!numbers.length) throw new Error('No board clues found. Give each clue a round of 1 or 2.');

  const outRounds = numbers.map((rn) => {
    let cats = [...rounds.get(rn).entries()];
    if (cats.length > MAX_CATEGORIES) {
      warnings.push(`Round ${rn}: only the first ${MAX_CATEGORIES} categories are used.`);
      cats = cats.slice(0, MAX_CATEGORIES);
    }
    const categories = cats.map(([name, clues]) => {
      let sorted = [...clues].sort((a, b) => a.value - b.value);
      if (sorted.length > MAX_CLUES) {
        warnings.push(`${name}: only the first ${MAX_CLUES} clues are used.`);
        sorted = sorted.slice(0, MAX_CLUES);
      }
      return { name, clues: sorted };
    });
    if (!categories.some((c) => c.clues.some((cl) => cl.wager))) warnings.push(`Round ${rn} has no DON'T TRIP! clues.`);
    return { name: `Round ${rn}`, categories };
  });

  if (!final) warnings.push('No final clue, so the game ends after the last round.');
  return { game: { title, rounds: outRounds, final, tiebreaker }, warnings };
}

export function summarize(game) {
  const clues = game.rounds.reduce((n, r) => n + r.categories.reduce((m, c) => m + c.clues.length, 0), 0);
  const parts = [`${game.rounds.length} round${game.rounds.length === 1 ? '' : 's'}`, `${clues} clues`];
  parts.push(game.final ? 'final clue' : 'no final clue');
  if (game.tiebreaker) parts.push('tiebreaker');
  return parts.join(' · ');
}
