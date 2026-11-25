import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../src/agent/attribution.js';

const opts = { minRequests: 40, minRequestsPerGroup: 20, errorRateThreshold: 0.05, blameRatio: 3 };

// Build n events where a given share of users have each flag on, and errors depend on a rule.
function make(n, { onShare = { a: 0.8, b: 0.5 }, errorIf }) {
  const ev = [];
  for (let i = 0; i < n; i++) {
    const flags = { a: (i % 10) < onShare.a * 10, b: ((i * 7 + 3) % 10) < onShare.b * 10 };
    ev.push({ ok: !errorIf(flags, i), flags });
  }
  return ev;
}

test('no alarm when error rate is normal', () => {
  const r = analyse(make(500, { errorIf: (_f, i) => i % 100 === 0 }), opts);
  assert.equal(r.alarm, false);
});

test('no alarm with too little traffic, even if errors are high', () => {
  const r = analyse(make(20, { errorIf: () => true }), opts);
  assert.equal(r.alarm, false);
});

test('blames the flag whose ON users fail, not the innocent one', () => {
  const r = analyse(make(1000, { errorIf: (f, i) => f.a && i % 3 === 0 }), opts);
  assert.equal(r.alarm, true);
  assert.equal(r.suspect.flag, 'a');
  assert.ok(r.suspect.onRate > 0.25 && r.suspect.offRate === 0);
});

test('waits for more data instead of a false "no suspect" when groups are small', () => {
  const r = analyse(make(60, { errorIf: (f, i) => f.a && i % 2 === 0 }), opts);
  assert.equal(r.alarm, true);
  assert.equal(r.waiting, true);
});

test('no suspect when everyone fails equally (not a flag problem)', () => {
  const r = analyse(make(1000, { errorIf: (_f, i) => ((i * 2654435761) >>> 0) % 5 === 0 }), opts);
  assert.equal(r.alarm, true);
  assert.equal(r.suspect, null);
});

test('no suspect when a flag is on for everyone (nothing to compare against)', () => {
  const r = analyse(make(1000, { onShare: { a: 1, b: 0.5 }, errorIf: (f, i) => f.a && i % 4 === 0 }), opts);
  assert.equal(r.alarm, true);
  assert.equal(r.suspect, null);
  assert.equal(r.candidates.find((c) => c.flag === 'a').enoughData, false);
  assert.deepEqual(r.unjudgeable, ['a']);
});
