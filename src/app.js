// Demo shop: a checkout endpoint whose new version sits behind the `new_checkout` flag.
// Every request is logged with the flags that user saw, so the agent can work out which flag causes errors.
import express from 'express';
import { config } from './config.js';
import { db, audit, getKv, JUDGED } from './db.js';
import { startFlags, getUserFlags } from './flags.js';
import { enableFlag, getFlagState } from './flagsmithAdmin.js';

startFlags();
const app = express();
app.set('trust proxy', config.protection.trustProxy);
app.use(express.json({ limit: '10kb' }));
app.use(express.static('public'));
app.use('/vendor', express.static('node_modules/chart.js/dist')); // Chart.js served locally, no CDN needed

// ---- The feature under test ---------------------------------------------------------
// "Bug switch" for the demo: when on, the NEW checkout fails for a share of requests,
// like a bad deploy would. The old checkout is untouched.
// allBroken simulates an outage that is NOT caused by a flag (e.g. the database is down).
const demo = { newCheckoutBroken: false, allBroken: false, failRate: 0.3 };
const BASELINE_ERROR_RATE = 0.01; // background noise every real app has

function oldCheckout() {
  if (demo.allBroken && Math.random() < demo.failRate) throw new Error('database connection refused');
  if (Math.random() < BASELINE_ERROR_RATE) throw new Error('payment gateway timeout');
  return { version: 'old', total: 2450 };
}

function newCheckout(input) {
  // A real bug in the new code: very long coupon codes crash it. An attacker who finds this can exploit it.
  if (input.coupon && input.coupon.length > 40) throw new Error('RangeError: coupon code overflowed the discount table');
  if (demo.allBroken && Math.random() < demo.failRate) throw new Error('database connection refused');
  if (demo.newCheckoutBroken && Math.random() < demo.failRate) {
    throw new Error('TypeError: cannot read properties of undefined (reading "couponCode")');
  }
  if (Math.random() < BASELINE_ERROR_RATE) throw new Error('payment gateway timeout');
  return { version: 'new', total: 2350, savedWith: 'one-tap UPI' };
}

const insertEvent = db.prepare(
  'INSERT INTO events (ts, user_id, route, ok, latency_ms, flags, status, source, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
);
const log = (userId, ok, status, started, flags, source, error = null) =>
  insertEvent.run(Date.now(), userId, 'checkout', ok, Date.now() - started, JSON.stringify(flags), status, source, error && String(error).slice(0, 200));

// ---- Protection --------------------------------------------------------------------------
// Sliding one-minute window per key. Requests over the limit get 429 and don't count as errors.
// Token bucket: `perMinute` requests a minute, refilled smoothly, with a small burst allowance (1/6 of the minute).
// So an attacker can't fire a whole minute's allowance in one second.
const buckets = new Map();
function overLimit(key, perMinute) {
  const now = Date.now();
  const capacity = Math.max(3, Math.ceil(perMinute / 6));
  const b = buckets.get(key) || { tokens: capacity, at: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 60000) * perMinute);
  b.at = now;
  buckets.set(key, b);
  if (b.tokens < 1) return true;
  b.tokens -= 1;
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.at > 120000) buckets.delete(k); }, 60000).unref();

// Sources a human chose to block from an abuse alert (stored by the agent in the kv table).
let blockCache = { at: 0, users: new Set(), sources: new Set() };
function blocked() {
  if (Date.now() - blockCache.at > 2000) {
    const b = JSON.parse(getKv('blocklist') || '{"users":[],"sources":[]}');
    blockCache = { at: Date.now(), users: new Set(b.users), sources: new Set(b.sources) };
  }
  return blockCache;
}

// In a real app the user comes from the login session; this demo takes it from the request.
const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

app.post('/api/checkout', async (req, res) => {
  const started = Date.now();
  const source = req.ip;
  const body = req.body || {};
  const userId = String(body.userId || '');

  // 1. Bad input is the caller's fault, not a bug: 400, not counted as an error.
  if (!USER_ID.test(userId) || (body.coupon !== undefined && (typeof body.coupon !== 'string' || body.coupon.length > 200))) {
    log(userId.slice(0, 64) || 'invalid', 1, 400, started, {}, source);
    return res.status(400).json({ ok: false, error: 'Invalid request: check userId and coupon' });
  }
  // 2. Blocked by a human after an abuse alert.
  const bl = blocked();
  if (bl.users.has(userId) || bl.sources.has(source)) {
    log(userId, 1, 403, started, {}, source);
    return res.status(403).json({ ok: false, error: 'Blocked after suspected abuse' });
  }
  // 3. Rate limits: one shopper or one IP can't flood the checkout.
  if (overLimit(`u:${userId}`, config.protection.perUserPerMinute) || overLimit(`s:${source}`, config.protection.perSourcePerMinute)) {
    log(userId, 1, 429, started, {}, source);
    return res.status(429).json({ ok: false, error: 'Too many checkouts, slow down' });
  }

  let flags = {};
  try {
    flags = await getUserFlags(userId); // Flagsmith decides which version this user gets
    const result = flags.new_checkout ? newCheckout(body) : oldCheckout();
    const banner = flags.new_search_banner ? 'New: smarter search!' : null; // harmless second flag
    log(userId, 1, 200, started, flags, source);
    res.json({ ok: true, ...result, banner });
  } catch (err) {
    log(userId, 0, 500, started, flags, source, err.message); // only real server failures count as errors
    res.status(500).json({ ok: false, error: err.message });
  }
});

// The storefront (public/shop.html) asks which flags a shopper gets, then calls /api/checkout.
app.get('/shop', (_req, res) => res.sendFile('shop.html', { root: 'public' }));
app.get('/api/shop/flags', async (req, res) => {
  res.json(await getUserFlags(String(req.query.user || 'user-1')));
});

// ---- Dashboard data -------------------------------------------------------------------
app.get('/api/stats', (req, res) => {
  const seconds = Math.min(Number(req.query.seconds) || 300, 3600);
  const bucketMs = 5000;
  const since = Date.now() - seconds * 1000;
  const rows = db.prepare(
    `SELECT (ts / ${bucketMs}) * ${bucketMs} AS t, COUNT(*) AS total, SUM(ok = 0) AS errors,
            SUM(json_extract(flags, '$.new_checkout') = 1) AS on_total,
            SUM(json_extract(flags, '$.new_checkout') = 1 AND ok = 0) AS on_errors
     FROM events WHERE ts >= ? AND ${JUDGED} GROUP BY t ORDER BY t`
  ).all(since);
  const rejected = db.prepare(
    `SELECT COUNT(*) AS n, SUM(status = 429) AS limited, SUM(status = 403) AS blocked, SUM(status = 400) AS invalid
     FROM events WHERE ts >= ? AND status >= 400 AND status < 500`
  ).get(Date.now() - 60000);
  const incidents = db.prepare('SELECT * FROM incidents ORDER BY id DESC LIMIT 5').all();
  const auditRows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 25').all();
  res.json({ series: rows, rejected, incidents, audit: auditRows, demo, localTestMode: config.localTestMode, dashboardApproval: dashboardApproval() });
});

let flagCache = { at: 0, data: null };
app.get('/api/flags', async (_req, res) => {
  try {
    if (Date.now() - flagCache.at > 4000) {
      const names = config.flagsmith.watchedFlags;
      const states = await Promise.all(names.map((f) => getFlagState(f)));
      flagCache = { at: Date.now(), data: Object.fromEntries(names.map((f, i) => [f, states[i]])) };
    }
    res.json(flagCache.data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Backup approval route for when Slack isn't connected. Same rule: a human must choose.
// Dashboard approval is allowed when Slack isn't set up, isn't connected, or ALLOW_DASHBOARD_APPROVAL=true.
const dashboardApproval = () => config.allowDashboardApproval || getKv('slack_connected') === 'false';

app.post('/api/incidents/:id/decision', (req, res) => {
  if (!dashboardApproval()) {
    return res.status(403).json({ error: 'Approvals happen in Slack (set ALLOW_DASHBOARD_APPROVAL=true to allow the dashboard)' });
  }
  const { decision, by } = req.body || {};
  const statusFor = { approve: 'approved', ignore: 'ignored', block: 'block_requested' };
  if (!statusFor[decision]) return res.status(400).json({ error: 'decision must be approve, ignore or block' });
  const r = db.prepare(
    `UPDATE incidents SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'waiting_approval'`
  ).run(statusFor[decision], by || 'dashboard', Date.now(), req.params.id);
  if (!r.changes) return res.status(409).json({ error: 'incident is not waiting for approval' });
  audit(Number(req.params.id), `decision:${decision}`, `by ${by || 'dashboard'}`);
  res.json({ ok: true });
});

// ---- Demo controls (for recording the video) -------------------------------------------
app.post('/api/demo/break', (req, res) => {
  if (req.body?.failRate) demo.failRate = Number(req.body.failRate);
  if (req.body?.scope === 'all') {
    demo.allBroken = true;
    audit(null, 'demo:break-all', `whole app now fails ${Math.round(demo.failRate * 100)}% of requests (not a flag problem)`);
  } else {
    demo.newCheckoutBroken = true;
    audit(null, 'demo:break', `new checkout now fails ${Math.round(demo.failRate * 100)}% of requests`);
  }
  res.json(demo);
});
app.post('/api/demo/fix', (_req, res) => {
  demo.newCheckoutBroken = false;
  demo.allBroken = false;
  audit(null, 'demo:fix', 'bug fixed in code');
  res.json(demo);
});
app.post('/api/demo/reset', async (_req, res) => {
  demo.newCheckoutBroken = false;
  demo.allBroken = false;
  try {
    await enableFlag('new_checkout');
    db.prepare('INSERT INTO flag_history (ts, flag, note) VALUES (?, ?, ?)').run(Date.now(), 'new_checkout', 'switched ON by Reset demo');
    // Blocked sources stay blocked: unblocking is a separate, deliberate action.
    audit(null, 'demo:reset', 'bug fixed and new_checkout switched back on (blocked sources stay blocked)');
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Who is blocked right now, and a deliberate "unblock all".
app.get('/api/blocklist', (_req, res) => res.json(JSON.parse(getKv('blocklist') || '{"users":[],"sources":[]}')));
app.post('/api/blocklist/clear', (req, res) => {
  const before = JSON.parse(getKv('blocklist') || '{"users":[],"sources":[]}');
  db.prepare("DELETE FROM kv WHERE k = 'blocklist'").run();
  blockCache.at = 0;
  audit(null, 'unblocked', `by ${req.body?.by || 'dashboard'}: users ${before.users.join(', ') || '-'} · IPs ${before.sources.join(', ') || '-'}`);
  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`[app] Demo shop on ${config.appUrl}  (dashboard: ${config.appUrl}/ , shop: ${config.appUrl}/shop)`);
});
