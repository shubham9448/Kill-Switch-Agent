import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse } from '../src/agent/attribution.js';

const opts = { minRequests: 40, minRequestsPerGroup: 20, errorRateThreshold: 0.05, blameRatio: 3, minAffectedUsers: 10, concentrationShare: 0.5 };

// Build n events where a given share of users have each flag on, and errors depend on a rule.
function make(n, { onShare = { a: 0.8, b: 0.5 }, errorIf }) {
  const ev = [];
  for (let i = 0; i < n; i++) {
    const flags = { a: (i % 10) < onShare.a * 10, b: ((i * 7 + 3) % 10) < onShare.b * 10 };
    // Every request comes from a different shopper on a different network, like real traffic.
    ev.push({ ok: !errorIf(flags, i), flags, userId: `u${i}`, source: `10.0.${i >> 8}.${i & 255}` });
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

// ---- Abuse protection -------------------------------------------------------------

// An attacker: a few accounts from one IP, all with flag `a` ON, all failing.
function attackEvents(n, accounts = ['x1', 'x2', 'x3'], ip = '203.0.113.66') {
  return Array.from({ length: n }, (_, i) => ({ ok: false, flags: { a: true, b: false }, userId: accounts[i % accounts.length], source: ip }));
}
const healthy = () => make(600, { errorIf: (_f, i) => ((i * 2654435761) >>> 0) % 100 === 0 }); // ~1% background errors

test('attack only: errors from 3 accounts on 1 IP = possible abuse, not a bug', () => {
  const r = analyse([...healthy(), ...attackEvents(60)], opts);
  assert.equal(r.alarm, true);
  assert.equal(r.kind, 'abuse');
  assert.equal(r.suspect.flag, 'a'); // names the flag they hit...
  assert.deepEqual(r.abuse.excludedUsers.sort(), ['x1', 'x2', 'x3']);
  assert.deepEqual(r.abuse.excludedSources, ['203.0.113.66']); // ...and who is behind it
});

test('attack from many IPs but only 3 accounts is still caught by the user concentration', () => {
  const ev = attackEvents(60).map((e, i) => ({ ...e, source: `198.51.100.${i}` }));
  const r = analyse([...healthy(), ...ev], opts);
  assert.equal(r.kind, 'abuse');
});

test('real bug spread over many users is still blamed (no false abuse)', () => {
  const r = analyse(make(1000, { errorIf: (f, i) => f.a && i % 3 === 0 }), opts);
  assert.equal(r.kind, 'bug');
  assert.equal(r.suspect.flag, 'a');
  assert.ok(r.suspect.onAffectedUsers >= 10);
  assert.equal(r.abuse, undefined);
});

test('real bug AND an attack at the same time: the bug is still found, the attackers set aside', () => {
  const bug = make(1000, { errorIf: (f, i) => f.a && i % 3 === 0 });
  const r = analyse([...bug, ...attackEvents(400)], opts); // attackers cause most errors
  assert.equal(r.kind, 'bug');
  assert.equal(r.suspect.flag, 'a');
  assert.deepEqual(r.abuse.excludedSources, ['203.0.113.66']);
});

test('fewer than 10 affected users: never blamed as a bug', () => {
  // 8 accounts each failing many times on different IPs: not concentrated enough for top-3, but too few people.
  const accounts = Array.from({ length: 8 }, (_, i) => `y${i}`);
  const ev = Array.from({ length: 80 }, (_, i) => ({ ok: false, flags: { a: true, b: false }, userId: accounts[i % 8], source: `198.51.100.${i}` }));
  const quiet = make(600, { errorIf: () => false }); // no background errors, so only these 8 people are affected
  const r = analyse([...quiet, ...ev], { ...opts, concentrationShare: 0.9 });
  assert.equal(r.alarm, true);
  assert.notEqual(r.kind, 'bug');
});
