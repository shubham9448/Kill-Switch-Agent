// Demo shop: a checkout endpoint whose new version sits behind the `new_checkout` flag.
// Every request is logged with the flags that user saw, so the agent can work out which flag causes errors.
import express from 'express';
import { config } from './config.js';
import { db, audit, getKv } from './db.js';
import { startFlags, getUserFlags } from './flags.js';
import { enableFlag, getFlagState } from './flagsmithAdmin.js';

startFlags();
const app = express();
app.use(express.json());
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
  return { version: 'old', total: 499 };
}

function newCheckout() {
  if (demo.allBroken && Math.random() < demo.failRate) throw new Error('database connection refused');
  if (demo.newCheckoutBroken && Math.random() < demo.failRate) {
    throw new Error('TypeError: cannot read properties of undefined (reading "couponCode")');
  }
  if (Math.random() < BASELINE_ERROR_RATE) throw new Error('payment gateway timeout');
  return { version: 'new', total: 449, savedWith: 'one-click checkout' };
}

const insertEvent = db.prepare(
  'INSERT INTO events (ts, user_id, route, ok, latency_ms, flags) VALUES (?, ?, ?, ?, ?, ?)'
);

app.post('/api/checkout', async (req, res) => {
  const userId = String(req.body?.userId || 'anonymous');
  const started = Date.now();
  let flags = {};
  try {
    flags = await getUserFlags(userId); // Flagsmith decides which version this user gets
    const result = flags.new_checkout ? newCheckout() : oldCheckout();
    const banner = flags.new_search_banner ? 'New: smarter search!' : null; // harmless second flag
    insertEvent.run(Date.now(), userId, 'checkout', 1, Date.now() - started, JSON.stringify(flags));
    res.json({ ok: true, ...result, banner });
  } catch (err) {
    insertEvent.run(Date.now(), userId, 'checkout', 0, Date.now() - started, JSON.stringify(flags));
    res.status(500).json({ ok: false, error: err.message });
  }
});

// A page a person can open to see which checkout they get.
app.get('/shop', async (req, res) => {
  const userId = String(req.query.user || 'visitor-1');
  const flags = await getUserFlags(userId);
  res.send(`<!doctype html><meta name=viewport content="width=device-width"><title>Demo Shop</title><link rel="icon" href="data:,">
  <body style="font-family:system-ui;max-width:520px;margin:40px auto;padding:0 16px">
  ${flags.new_search_banner ? '<div style="background:#e7f1fb;padding:8px 12px;border-radius:8px">New: smarter search!</div>' : ''}
  <h1>Demo Shop</h1><p>Signed in as <b>${userId.replace(/[<>&"]/g, '')}</b></p>
  <div style="border:2px solid ${flags.new_checkout ? '#2f9e44' : '#868e96'};border-radius:12px;padding:16px">
  <h2>${flags.new_checkout ? 'New one-click checkout' : 'Classic checkout'}</h2>
  <p>Wireless earbuds: ₹${flags.new_checkout ? '449' : '499'}</p>
  <small>Flag <code>new_checkout</code> is <b>${flags.new_checkout ? 'ON' : 'OFF'}</b> for this user</small></div>
  <p style="margin-top:20px">Try another shopper:
  ${['user-1', 'user-2', 'user-3', 'user-4', 'user-5', 'user-6', 'user-7', 'user-8'].map((u) => `<a href="/shop?user=${u}">${u}</a>`).join(' · ')}</p>
  <p style="color:#666;font-size:13px">Each shopper always gets the same answer from Flagsmith. About 20% are in the <code>checkout_holdout</code> segment and keep the classic checkout.</p>
  <p><a href="/">Open the live dashboard</a></p></body>`);
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
     FROM events WHERE ts >= ? GROUP BY t ORDER BY t`
  ).all(since);
  const incidents = db.prepare('SELECT * FROM incidents ORDER BY id DESC LIMIT 5').all();
  const auditRows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 25').all();
  res.json({ series: rows, incidents, audit: auditRows, demo, localTestMode: config.localTestMode, dashboardApproval: dashboardApproval() });
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
  if (!['approve', 'ignore'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or ignore' });
  const r = db.prepare(
    `UPDATE incidents SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'waiting_approval'`
  ).run(decision === 'approve' ? 'approved' : 'ignored', by || 'dashboard', Date.now(), req.params.id);
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
    audit(null, 'demo:reset', 'bug fixed and new_checkout switched back on');
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(config.port, () => {
  console.log(`[app] Demo shop on ${config.appUrl}  (dashboard: ${config.appUrl}/ , shop: ${config.appUrl}/shop)`);
});
