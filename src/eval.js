// npm run eval : tests the investigator with REAL Claude on 5 incident scenarios, 3 runs each, and prints a scorecard.
// Uses a temporary database with made-up traffic, so it never touches your demo data. Needs ANTHROPIC_API_KEY.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DB_PATH = path.join(os.tmpdir(), `kill-switch-eval-${process.pid}.db`);
const { config } = await import('./config.js');
const { db } = await import('./db.js');
const { analyse } = await import('./agent/attribution.js');
const { investigate, validate } = await import('./agent/investigate.js');
const { connectFlagsmithMcp, mcpConnected } = await import('./flagsmithMcp.js');

if (!config.claude.apiKey) { console.log('Set ANTHROPIC_API_KEY in .env first.'); process.exit(1); }
const argAfter = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const RUNS = Number(argAfter('--runs')) || 3;
const ONLY = (argAfter('--only') || '').toLowerCase(); // e.g. --only attack

const BUG = 'TypeError: cannot read properties of undefined (reading "couponCode")';
const DB_DOWN = 'Error: database connection refused (pool exhausted)';
const ATTACK = 'RangeError: coupon code overflowed the discount table';

// Writes a scenario's traffic into the temporary database.
function seed({ fail, attackers = 0, changes = [] }) {
  db.exec('DELETE FROM events; DELETE FROM flag_history;');
  const ins = db.prepare('INSERT INTO events (ts, user_id, route, ok, latency_ms, flags, status, source, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const now = Date.now();
  const events = [];
  const add = (e) => { events.push(e); ins.run(now - Math.floor(Math.random() * 25000), e.userId, 'checkout', e.ok ? 1 : 0, 20, JSON.stringify(e.flags), e.ok ? 200 : 500, e.source, e.error || null); };
  for (let i = 0; i < 600; i++) {
    const flags = { new_checkout: i % 10 < 8, new_search_banner: (i * 7) % 10 < 5 };
    const err = fail(flags, i);
    add({ ok: !err, flags, userId: `user-${i % 400}`, source: `10.0.${(i % 400) >> 8}.${(i % 400) & 255}`, error: err });
  }
  for (let i = 0; i < attackers; i++) {
    add({ ok: false, flags: { new_checkout: true, new_search_banner: false }, userId: ['user-901', 'user-902', 'user-903'][i % 3], source: '203.0.113.66', error: ATTACK });
  }
  for (const c of changes) db.prepare('INSERT INTO flag_history (ts, flag, note) VALUES (?, ?, ?)').run(now - c.minutesAgo * 60000, c.flag, c.note);
  return events.map((e) => ({ ...e, ok: e.ok }));
}
const noise = (i) => (((i * 2654435761) >>> 0) % 100 === 0 ? 'Error: payment gateway timeout' : null);

const SCENARIOS = [
  { name: 'New checkout bug', expect: 'turn_off_flag', flag: 'new_checkout',
    data: { fail: (f, i) => (f.new_checkout && i % 4 === 0 ? BUG : noise(i)), changes: [{ flag: 'new_checkout', minutesAgo: 6, note: 'changed: enabled=true, segment overrides=1' }] } },
  { name: 'Attack from 3 accounts', expect: 'block_sources',
    data: { fail: (_f, i) => noise(i), attackers: 90 } },
  { name: 'Database outage (no flag at fault)', expect: 'escalate_no_flag',
    data: { fail: (_f, i) => (i % 6 === 0 ? DB_DOWN : null) } },
  { name: 'Bug and attack at once', expect: 'turn_off_flag', flag: 'new_checkout',
    data: { fail: (f, i) => (f.new_checkout && i % 4 === 0 ? BUG : noise(i)), attackers: 60 } },
  { name: 'Two flags changed, one broken', expect: 'turn_off_flag', flag: 'new_checkout',
    data: { fail: (f, i) => (f.new_checkout && i % 4 === 0 ? BUG : noise(i)), changes: [
      { flag: 'new_search_banner', minutesAgo: 3, note: 'changed: enabled=true, segment overrides=1' },
      { flag: 'new_checkout', minutesAgo: 5, note: 'changed: enabled=true, segment overrides=1' }] } },
];

await connectFlagsmithMcp();
console.log(`\nInvestigator eval: model ${config.claude.investigatorModel}, ${mcpConnected() ? 'Flagsmith MCP' : 'Admin API'} tools, ${RUNS} runs per scenario\n`);

const rows = [];
let correct = 0, total = 0;
for (const sc of SCENARIOS.filter((x) => !ONLY || x.name.toLowerCase().includes(ONLY))) {
  for (let run = 1; run <= RUNS; run++) {
    const events = seed(sc.data);
    const a = analyse(events, config.agent);
    // Sanity check on the test data itself: a scenario should fail some requests, never all of them.
    if (a.overall.rate > 0.5 || a.overall.rate < 0.03) console.log(`      WARNING: scenario data looks wrong (${(a.overall.rate * 100).toFixed(0)}% of requests fail)`);
    const started = Date.now();
    let action = 'error', flag = '', final = '', steps = 0, note = '';
    try {
      const r = await investigate(a);
      action = r.proposal.action;
      flag = r.proposal.flag || '';
      steps = r.trace.length - 1;
      const v = validate(r.proposal, a);
      final = v.wait ? 'keep watching' : `${v.kind}${v.flag ? ` ${v.flag}` : ''}`;
      note = `${r.proposal.summary} | Why: ${r.proposal.reasoning}`;
    } catch (err) {
      note = err.message;
    }
    const ok = action === sc.expect && (!sc.flag || flag === sc.flag);
    correct += ok ? 1 : 0;
    total++;
    rows.push({ scenario: sc.name, run, ok, action: `${action}${flag ? ` ${flag}` : ''}`, final, steps, secs: ((Date.now() - started) / 1000).toFixed(1), note });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${sc.name} #${run}: proposed ${action}${flag ? ` ${flag}` : ''} (${steps} checks, ${((Date.now() - started) / 1000).toFixed(1)}s) -> acted on: ${final}`);
    if (!ok) console.log(`      Claude said: ${note}`);
  }
}

console.log(`\nScore: ${correct}/${total} proposals correct\n`);
const md = [
  `# Investigator eval`,
  '',
  `${new Date().toISOString().slice(0, 10)} · model \`${config.claude.investigatorModel}\` · ${mcpConnected() ? 'Flagsmith MCP' : 'Admin API'} tools · **${correct}/${total} correct**`,
  '',
  '| Scenario | Run | Result | Claude proposed | Acted on (after guardrails) | Checks | Seconds |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.scenario} | ${r.run} | ${r.ok ? 'pass' : 'FAIL'} | ${r.action} | ${r.final} | ${r.steps} | ${r.secs} |`),
  '',
  ...(rows.some((r) => !r.ok) ? ['## Failures', '', ...rows.filter((r) => !r.ok).map((r) => `- ${r.scenario} #${r.run}: ${r.note}`), ''] : []),
].join('\n');
fs.writeFileSync(ONLY ? 'eval-results-partial.md' : 'eval-results.md', md); // a partial run never overwrites the full scorecard
console.log(`Saved ${ONLY ? 'eval-results-partial.md' : 'eval-results.md'}`);
db.close();
fs.rmSync(process.env.DB_PATH, { force: true });
process.exit(0);
