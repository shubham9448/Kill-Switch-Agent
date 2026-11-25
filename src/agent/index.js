// The Kill Switch Agent. Every few seconds it:
//   1. acts on decisions humans made (approve -> switch the flag off in Flagsmith),
//   2. checks whether a switched-off flag actually fixed things,
//   3. looks for a new error spike and works out which flag is to blame.
// It never changes a flag without a human's approval.
import { config } from '../config.js';
import { db, audit } from '../db.js';
import { analyse } from './attribution.js';
import { explain } from './explain.js';
import { startSlack, postAlert, postFollowUp } from './slack.js';
import { disableFlag, getFlagState } from '../flagsmithAdmin.js';
import { writeReport } from './report.js';

const A = config.agent;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const secs = (ms) => `${Math.round(ms / 1000)}s`;
const snoozed = new Map(); // key -> until (ms)
let busy = false;
let noSuspectStreak = 0;

function eventsSince(since) {
  return db.prepare('SELECT ok, flags FROM events WHERE ts >= ?').all(since)
    .map((r) => ({ ok: r.ok === 1, flags: JSON.parse(r.flags) }));
}

const getIncidents = (status) => db.prepare('SELECT * FROM incidents WHERE status = ?').all(status);
const setIncident = (id, fields) => {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE incidents SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
};

// Only look at events after the last incident was dealt with, so old errors don't re-trigger an alarm.
function windowStart() {
  const last = db.prepare('SELECT MAX(COALESCE(closed_at, disabled_at, decided_at)) AS t FROM incidents').get().t || 0;
  return Math.max(Date.now() - A.windowSeconds * 1000, last);
}

// 1. Humans approved -> flip the switch in Flagsmith.
async function handleApproved() {
  for (const inc of getIncidents('approved')) {
    try {
      setIncident(inc.id, { status: 'disabling' });
      const r = await disableFlag(inc.flag);
      setIncident(inc.id, { status: 'disabled', disabled_at: Date.now() });
      audit(inc.id, 'flagsmith:disabled', `${inc.flag} switched off via ${r.method}`);
      await postFollowUp(inc.slack_ts, `:electric_plug: \`${inc.flag}\` is now OFF in Flagsmith. Checking recovery in ${A.verifyAfterSeconds}s…`);
    } catch (err) {
      setIncident(inc.id, { status: 'failed', closed_at: Date.now() });
      audit(inc.id, 'flagsmith:error', err.message);
      await postFollowUp(inc.slack_ts, `:x: Could not switch off \`${inc.flag}\`: ${err.message}. Please turn it off in the Flagsmith dashboard.`);
    }
  }
  for (const inc of getIncidents('ignored')) {
    snoozed.set(inc.flag, Date.now() + A.snoozeMinutes * 60000);
    setIncident(inc.id, { status: 'ignored_closed', closed_at: Date.now() });
    audit(inc.id, 'snoozed', `${inc.flag} alerts snoozed for ${A.snoozeMinutes} min`);
  }
}

// 2. Did turning it off work?
// Flagsmith needs some time to deliver the change to the app (its SDK refresh + Flagsmith's own caching).
// So first wait until no request is served with the flag ON, record that delay, then measure recovery.
const PROPAGATION_TIMEOUT_MS = 3 * 60 * 1000;

async function verifyDisabled() {
  for (const inc of getIncidents('disabled')) {
    const now = Date.now();
    let propagatedAt = inc.propagated_at;
    if (!propagatedAt) {
      const lastOn = db.prepare(
        `SELECT MAX(ts) AS t FROM events WHERE ts > ? AND json_extract(flags, '$.' || ?) = 1`
      ).get(inc.disabled_at, inc.flag).t;
      const quietMs = 5000; // no flag-ON requests for 5s = the app has the change
      const traffic = db.prepare('SELECT COUNT(*) AS n FROM events WHERE ts > ?').get(now - quietMs).n;
      if (!traffic) continue; // no traffic, can't tell yet
      if (lastOn && now - lastOn < quietMs) {
        if (now - inc.disabled_at > PROPAGATION_TIMEOUT_MS) {
          setIncident(inc.id, { status: 'not_recovered', closed_at: now });
          audit(inc.id, 'verified:not_propagated', `${inc.flag} still served ON ${secs(now - inc.disabled_at)} after switching off`);
          await postFollowUp(inc.slack_ts, `:warning: \`${inc.flag}\` is OFF in Flagsmith but the app still serves it ON after ${secs(now - inc.disabled_at)}. Check the app's Flagsmith connection.`);
        }
        continue; // still propagating
      }
      propagatedAt = lastOn || inc.disabled_at;
      setIncident(inc.id, { propagated_at: propagatedAt });
      audit(inc.id, 'flagsmith:propagated', `app stopped serving ${inc.flag} ${secs(propagatedAt - inc.disabled_at)} after the switch`);
    }

    if (now - propagatedAt < A.verifyAfterSeconds * 1000) continue;
    const evs = eventsSince(propagatedAt + 1000);
    if (evs.length < A.minRequests) continue; // wait for enough traffic
    const rate = evs.filter((e) => !e.ok).length / evs.length;
    const recovered = rate < A.errorRateThreshold;
    setIncident(inc.id, { status: recovered ? 'recovered' : 'not_recovered', closed_at: now });
    audit(inc.id, recovered ? 'verified:recovered' : 'verified:not_recovered', `error rate now ${pct(rate)} over ${evs.length} requests`);
    const before = JSON.parse(inc.stats).overall.rate;
    const summary = recovered
      ? `:white_check_mark: *Recovered.* Error rate ${pct(before)} → ${pct(rate)}.\n` +
        `• Suspect: \`${inc.flag}\`\n• Approved by: ${inc.decided_by}\n` +
        `• Time to approve: ${secs(inc.decided_at - inc.opened_at)} · Flagsmith delivered the change in ${secs(propagatedAt - inc.disabled_at)}\n` +
        `• Errors stopped (users back on the old version): ${secs(propagatedAt - inc.opened_at)} after the alert\n` +
        `• Next step: fix the bug, then switch \`${inc.flag}\` back on in Flagsmith.`
      : `:warning: \`${inc.flag}\` is off but errors are still ${pct(rate)}. Something else is wrong; please investigate.`;
    const file = writeReport(inc.id, { rateAfter: rate });
    audit(inc.id, 'report:written', file);
    await postFollowUp(inc.slack_ts, `${summary}\n• Full report: \`${file}\``);
  }
}

// 3. New spike?
async function detect() {
  const open = db.prepare(
    `SELECT COUNT(*) AS n FROM incidents WHERE status IN ('waiting_approval','approved','disabling','disabled')`
  ).get().n;
  if (open) return;

  const a = analyse(eventsSince(windowStart()), A);
  if (!a.alarm || a.waiting) { noSuspectStreak = 0; return; }

  // Early in a spike the window still holds healthy traffic and the blame can look unclear.
  // Only report "no flag to blame" if it is still true on the next check too.
  if (!a.suspect) {
    noSuspectStreak++;
    if (noSuspectStreak < 2) return;
  }
  noSuspectStreak = 0;

  const key = a.suspect?.flag || '__no_suspect__';
  if ((snoozed.get(key) || 0) > Date.now()) return;

  if (a.suspect) {
    // Don't ask to turn off a flag that is already off.
    try {
      const st = await getFlagState(a.suspect.flag);
      if (st.enabled === false) return;
    } catch (err) {
      console.warn('[agent] could not read flag state:', err.message);
    }
  }

  const explanation = await explain(a);
  const status = a.suspect ? 'waiting_approval' : 'no_suspect';
  const id = db.prepare(
    'INSERT INTO incidents (opened_at, flag, status, stats, explanation) VALUES (?, ?, ?, ?, ?)'
  ).run(Date.now(), a.suspect?.flag || null, status, JSON.stringify(a), explanation).lastInsertRowid;
  audit(id, 'detected', a.suspect
    ? `${a.suspect.flag}: ON ${pct(a.suspect.onRate)} vs OFF ${pct(a.suspect.offRate)} (overall ${pct(a.overall.rate)}, ${a.overall.total} requests)`
    : `overall ${pct(a.overall.rate)}, no single flag explains it`);

  const incident = { id, explanation };
  try {
    const ts = await postAlert(incident, a);
    if (ts) setIncident(id, { slack_ts: ts });
    audit(id, 'alert:sent', ts ? 'Slack' : 'console + dashboard');
  } catch (err) {
    audit(id, 'alert:failed', `${err.message} (approve from the dashboard instead)`);
  }
  if (!a.suspect) {
    snoozed.set(key, Date.now() + A.snoozeMinutes * 60000);
    setIncident(id, { closed_at: Date.now() });
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await handleApproved();
    await verifyDisabled();
    await detect();
  } catch (err) {
    console.error('[agent] tick failed:', err);
  } finally {
    busy = false;
  }
}

// Safety net: a stray error from a library must never stop the agent from watching.
process.on('unhandledRejection', (err) => console.error('[agent] unhandled error (agent keeps running):', err?.message || err));

startSlack(); // don't wait: the agent keeps watching even if Slack is slow or down
console.log(`[agent] Watching every ${A.intervalSeconds}s · window ${A.windowSeconds}s · threshold ${pct(A.errorRateThreshold)} · blame ratio ${A.blameRatio}x` +
  (config.localTestMode ? ' · LOCAL TEST MODE' : ''));
// Check decisions often (snappy response to a click); run the full check on the configured interval.
setInterval(() => { if (!busy) { busy = true; Promise.all([handleApproved(), verifyDisabled()]).finally(() => { busy = false; }); } }, 2000);
setInterval(tick, A.intervalSeconds * 1000);
tick();
