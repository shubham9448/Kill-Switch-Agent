// Tests the investigator's loop and guardrails with a scripted stand-in for Claude (no API key needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.DB_PATH = `/tmp/kill-switch-inv-test-${process.pid}.db`;
process.env.LOCAL_TEST_MODE = 'true';
const { db } = await import('../src/db.js');
const { investigate, validate } = await import('../src/agent/investigate.js');
const { toolsForClaude } = await import('../src/agent/tools.js');
const { READ_ONLY_TOOLS } = await import('../src/flagsmithMcp.js');
const { analyse } = await import('../src/agent/attribution.js');

const opts = { minRequests: 40, minRequestsPerGroup: 20, errorRateThreshold: 0.05, blameRatio: 3, minAffectedUsers: 10, concentrationShare: 0.5 };

// Fill the events table: `n` shoppers; new_checkout ON for 80%; errors decided by `fail`.
function seed(n, fail, extra = []) {
  db.exec('DELETE FROM events');
  const ins = db.prepare('INSERT INTO events (ts, user_id, route, ok, latency_ms, flags, status, source, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  const events = [];
  for (let i = 0; i < n; i++) {
    const flags = { new_checkout: i % 10 < 8, new_search_banner: i % 2 === 0 };
    const err = fail(flags, i);
    const e = { ok: !err, flags, userId: `user-${i}`, source: `10.0.0.${i % 250}`, error: err || null };
    events.push(e);
    ins.run(now - 1000, e.userId, 'checkout', e.ok ? 1 : 0, 5, JSON.stringify(flags), e.ok ? 200 : 500, e.source, e.error);
  }
  for (const e of extra) {
    events.push(e);
    ins.run(now - 1000, e.userId, 'checkout', 0, 5, JSON.stringify(e.flags), 500, e.source, e.error);
  }
  return events;
}
const bugEvents = () => seed(600, (f, i) => (f.new_checkout && i % 3 === 0 ? 'TypeError: cannot read properties of undefined (reading "couponCode")' : null));
const attackers = (k) => Array.from({ length: k }, (_, i) => ({ ok: false, flags: { new_checkout: true, new_search_banner: false },
  userId: ['user-901', 'user-902', 'user-903'][i % 3], source: '203.0.113.66', error: 'RangeError: coupon code overflowed the discount table' }));

// A scripted Claude: returns the given responses in order, and records what it was sent.
function fakeClaude(script) {
  const calls = [];
  let i = 0;
  return {
    calls,
    messages: { create: async (req) => { calls.push(req); const r = script[i++]; if (r instanceof Error) throw r; return r; } },
  };
}
const use = (name, input, id = name) => ({ content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use' });

test('the investigator loop runs real tools and returns the proposal with a trace', async () => {
  const a = analyse(bugEvents(), opts);
  const claude = fakeClaude([
    use('error_breakdown', { by: 'flag' }),
    use('sample_errors', { n: 3, flag: 'new_checkout' }),
    use('propose_action', { action: 'turn_off_flag', flag: 'new_checkout', confidence: 'high', summary: 's', reasoning: 'r' }),
  ]);
  const r = await investigate(a, { client: claude });
  assert.equal(r.proposal.action, 'turn_off_flag');
  assert.deepEqual(r.trace.map((t) => t.tool), ['error_breakdown', 'sample_errors', 'propose_action']);
  assert.match(r.trace[0].result, /new_checkout: ON \d+\/\d+ requests failed/); // real numbers from the database
  assert.match(r.trace[1].result, /couponCode/); // real error messages
  // Claude received the tool results on the next turn
  const last = claude.calls[2].messages.at(-1);
  assert.equal(last.content[0].type, 'tool_result');
});

test('if Claude stops without a proposal it is asked once to finish', async () => {
  const a = analyse(bugEvents(), opts);
  const claude = fakeClaude([
    { content: [{ type: 'text', text: 'Looks like new_checkout.' }], stop_reason: 'end_turn' },
    use('propose_action', { action: 'turn_off_flag', flag: 'new_checkout', confidence: 'medium', summary: 's', reasoning: 'r' }),
  ]);
  const r = await investigate(a, { client: claude });
  assert.equal(r.proposal.action, 'turn_off_flag');
});

test('API failure throws, so the agent falls back to the numbers', async () => {
  const a = analyse(bugEvents(), opts);
  await assert.rejects(investigate(a, { client: fakeClaude([new Error('overloaded')]) }));
});

test('guardrail: Claude cannot offer a kill the numbers do not support', () => {
  const ev = seed(600, () => null, attackers(60)); // attack only
  const a = analyse(ev, opts);
  assert.equal(a.kind, 'abuse');
  const v = validate({ action: 'turn_off_flag', flag: 'new_checkout', confidence: 'high', summary: 's', reasoning: 'r' }, a);
  assert.equal(v.kind, 'abuse');
  assert.equal(v.fallback, true);
  assert.match(v.note, /isn't offered/);
});

test('guardrail: only sources really causing errors can be blocked', () => {
  const ev = seed(600, () => null, attackers(60));
  const a = analyse(ev, opts);
  const v = validate({ action: 'block_sources', users: ['user-901', 'user-5'], ips: ['203.0.113.66', '10.0.0.9'], confidence: 'high', summary: 's', reasoning: 'r' }, a);
  assert.equal(v.kind, 'abuse');
  assert.deepEqual(v.abuse.excludedUsers, ['user-901']);
  assert.deepEqual(v.abuse.excludedSources, ['203.0.113.66']);
  assert.match(v.note, /user-5/); // innocent shopper not blocked, and it says so
});

test('guardrail: "no flag at fault" cannot hide a flag the numbers clearly blame', () => {
  const a = analyse(bugEvents(), opts);
  const v = validate({ action: 'escalate_no_flag', confidence: 'low', summary: 's', reasoning: 'r' }, a);
  assert.equal(v.kind, 'bug');
  assert.equal(v.flag, 'new_checkout');
});

test('Claude is never given a tool that changes Flagsmith', () => {
  const names = toolsForClaude().map((t) => t.name);
  assert.ok(names.includes('propose_action'));
  for (const n of [...names, ...READ_ONLY_TOOLS]) assert.doesNotMatch(n, /^(flagsmith_)?(create|update|delete|publish)_/);
});

test.after(() => { db.close(); fs.rmSync(process.env.DB_PATH, { force: true }); });
