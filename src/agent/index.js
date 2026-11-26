// The Kill Switch Agent. Every few seconds it:
//   1. acts on decisions humans made (approve -> switch the flag off in Flagsmith),
//   2. checks whether a switched-off flag actually fixed things,
//   3. looks for a new error spike and works out which flag is to blame.
// It never changes a flag without a human's approval.
import { config } from '../config.js';
import { db, audit, setKv, getKv, JUDGED } from '../db.js';
import { analyse } from './attribution.js';
import { explain } from './explain.js';
import { startSlack, postAlert, postFollowUp } from './slack.js';
import { disableFlag, getFlagState } from '../flagsmithAdmin.js';
import { writeReport } from './report.js';
import { investigate, validate } from './investigate.js';
import { connectFlagsmithMcp, mcpConnected } from '../flagsmithMcp.js';

const A = config.agent;
const pct = (x) => `${(x * 100).toFixed(1)}%`;
const secs = (ms) => `${Math.round(ms / 1000)}s`;
const snoozed = new Map(); // key -> until (ms)
let busy = false;
let noSuspectStreak = 0;
let keepWatchingStreak = 0;
let detecting = false;

// Only successes and server errors are judged; rejected input, rate-limited and blocked requests are not bugs.
function eventsSince(since) {
  return db.prepare(`SELECT ok, flags, user_id, source FROM events WHERE ts >= ? AND ${JUDGED}`).all(since)
    .map((r) => ({ ok: r.ok === 1, flags: JSON.parse(r.flags), userId: r.user_id, source: r.source }));
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
      recordFlagChange(inc.flag, `switched OFF by the agent (incident #${inc.id}, approved by ${inc.decided_by})`);
      audit(inc.id, 'flagsmith:disabled', `${inc.flag} switched off via ${r.method}`);
      await postFollowUp(inc.slack_ts, `:electric_plug: \`${inc.flag}\` is now OFF in Flagsmith. Checking recovery in ${A.verifyAfterSeconds}s…`);
    } catch (err) {
      setIncident(inc.id, { status: 'failed', closed_at: Date.now() });
      audit(inc.id, 'flagsmith:error', err.message);
      await postFollowUp(inc.slack_ts, `:x: Could not switch off \`${inc.flag}\`: ${err.message}. Please turn it off in the Flagsmith dashboard.`);
    }
  }
  // A human chose to block the sources behind a suspected attack.
  for (const inc of getIncidents('block_requested')) {
    const ab = JSON.parse(inc.stats).abuse || {};
    const list = JSON.parse(getKv('blocklist') || '{"users":[],"sources":[]}');
    const users = [...new Set([...list.users, ...(ab.excludedUsers || [])])];
    const sources = [...new Set([...list.sources, ...(ab.excludedSources || [])])];
    setKv('blocklist', JSON.stringify({ users, sources }));
    setIncident(inc.id, { status: 'blocked', closed_at: Date.now() });
    audit(inc.id, 'blocked', `users: ${(ab.excludedUsers || []).join(', ') || '-'} · IPs: ${(ab.excludedSources || []).join(', ') || '-'}`);
    const file = writeReport(inc.id);
    audit(inc.id, 'report:written', file);
    await postFollowUp(inc.slack_ts, `:shield: Blocked ${ab.excludedUsers?.length || 0} users and ${ab.excludedSources?.length || 0} IPs. The feature flag was left ON.\n• Full report: \`${file}\``);
  }
  for (const inc of getIncidents('ignored')) {
    snoozed.set(inc.kind === 'abuse' ? `abuse:${inc.flag}` : inc.flag, Date.now() + A.snoozeMinutes * 60000);
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
      const traffic = db.prepare(`SELECT COUNT(*) AS n FROM events WHERE ts > ? AND ${JUDGED}`).get(now - quietMs).n;
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
    `SELECT * FROM incidents WHERE status IN ('waiting_approval','approved','block_requested','disabling','disabled')`
  ).all();
  // An abuse alert waiting for a human must not hide a real bug that starts meanwhile, so keep checking.
  const waitingAbuse = open.length === 1 && open[0].kind === 'abuse' && open[0].status === 'waiting_approval' ? open[0] : null;
  if (open.length && !waitingAbuse) return;

  const a = analyse(eventsSince(windowStart()), A);
  if (waitingAbuse) {
    if (a.kind !== 'bug') return; // still just the attack
    setIncident(waitingAbuse.id, { status: 'superseded' });
    audit(waitingAbuse.id, 'superseded', `a real bug in ${a.suspect.flag} now affects ${a.suspect.onAffectedUsers} other users`);
    await postFollowUp(waitingAbuse.slack_ts, `:arrow_up: Update: besides the attack, a real bug in \`${a.suspect.flag}\` now affects ${a.suspect.onAffectedUsers} other users. See the new alert.`);
  }
  if (!a.alarm || a.waiting) { noSuspectStreak = 0; return; }

  // Early in a spike the window still holds healthy traffic and the blame can look unclear.
  // Only report "no flag to blame" if it is still true on the next check too.
  if (!a.suspect) {
    noSuspectStreak++;
    if (noSuspectStreak < 2) return;
  }
  noSuspectStreak = 0;

  const key = a.kind === 'abuse' ? `abuse:${a.suspect?.flag}` : a.suspect?.flag || '__no_suspect__';
  if ((snoozed.get(key) || 0) > Date.now()) return;

  if (a.suspect && a.kind === 'bug') {
    // Don't ask to turn off a flag that is already off.
    try {
      const st = await getFlagState(a.suspect.flag);
      if (st.enabled === false) return;
    } catch (err) {
      console.warn('[agent] could not read flag state:', err.message);
    }
  }

  // ---- The investigator: Claude looks into the alarm and proposes one action ----
  let decision = null;
  let trace = null;
  let confidence = null;
  let summary = null;
  let byAgent = 'maths';
  if (config.claude.apiKey && config.claude.investigator) {
    const started = Date.now();
    try {
      const r = await investigate(a);
      trace = r.trace;
      const v = validate(r.proposal, a);
      if (v.wait) {
        keepWatchingStreak++;
        audit(null, 'investigator:keep_watching', `${r.proposal.reasoning} (${keepWatchingStreak}/3)`);
        if (keepWatchingStreak < 3) return;
        decision = { kind: a.kind, flag: a.suspect?.flag, fallback: true, note: 'The investigator kept watching 3 times in a row, so the alert is raised from the numbers.' };
      } else {
        decision = v;
        confidence = r.proposal.confidence;
        summary = r.proposal.summary;
        byAgent = v.fallback ? 'maths' : 'claude';
      }
      console.log(`[agent] investigation took ${Math.round((Date.now() - started) / 1000)}s, ${trace.length} steps: ${r.proposal.action}`);
    } catch (err) {
      console.warn('[agent] investigator unavailable, using the numbers only:', err.message);
      audit(null, 'investigator:fallback', err.message);
    }
  }
  keepWatchingStreak = 0;
  decision ??= { kind: a.kind, flag: a.suspect?.flag };

  // The analysis we act on: the maths evidence, shaped by the validated decision.
  const final = {
    ...a,
    kind: decision.kind,
    suspect: decision.flag ? (a.candidates || []).find((c) => c.flag === decision.flag) || a.suspect : null,
    abuse: decision.abuse || a.abuse,
  };
  const key2 = final.kind === 'abuse' ? `abuse:${final.suspect?.flag}` : final.suspect?.flag || '__no_suspect__';
  if ((snoozed.get(key2) || 0) > Date.now()) return;

  const explanation = [summary || await explain(final), decision.note].filter(Boolean).join(' ');
  const status = final.kind === 'no_suspect' ? 'no_suspect' : 'waiting_approval';
  const id = db.prepare(
    'INSERT INTO incidents (opened_at, flag, status, stats, explanation, kind, trace, confidence, decided_by_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(Date.now(), final.suspect?.flag || null, status, JSON.stringify(final), explanation, final.kind,
    trace ? JSON.stringify(trace) : null, confidence, byAgent).lastInsertRowid;

  for (const t of trace || []) {
    if (t.tool === 'propose_action') continue;
    audit(id, 'investigator:checked', `${t.tool}${t.input && Object.keys(t.input).length ? ' ' + JSON.stringify(t.input) : ''}`);
  }
  const ab = final.abuse;
  audit(id, final.kind === 'abuse' ? 'detected:possible_abuse' : 'detected',
    (byAgent === 'claude' ? `[investigator, ${confidence} confidence] ` : '[numbers] ') +
    (final.kind === 'abuse'
      ? `errors come from ${ab.excludedUsers.length} users / ${ab.excludedSources.length} IP${ab.excludedSources.length === 1 ? '' : 's'}` +
        (final.suspect ? `, hitting ${final.suspect.flag}` : '') + ' (proposes blocking, not a kill)'
      : final.suspect
        ? `${final.suspect.flag}: ON ${pct(final.suspect.onRate)} vs OFF ${pct(final.suspect.offRate)}, ${final.suspect.onAffectedUsers} users affected`
        : `overall ${pct(final.overall.rate)}, no feature flag at fault (escalate)`));

  const incident = { id, explanation, trace, confidence, byAgent };
  try {
    const ts = await postAlert(incident, final);
    if (ts) setIncident(id, { slack_ts: ts });
    audit(id, 'alert:sent', ts ? 'Slack' : 'console + dashboard');
  } catch (err) {
    audit(id, 'alert:failed', `${err.message} (approve from the dashboard instead)`);
  }
  if (status === 'no_suspect') {
    snoozed.set(key2, Date.now() + A.snoozeMinutes * 60000);
    setIncident(id, { closed_at: Date.now() });
  }
}

// ---- Flag history: snapshot flag states so the investigator can link a spike to a recent change ----
const lastSeen = new Map();
export function recordFlagChange(flag, note) {
  db.prepare('INSERT INTO flag_history (ts, flag, note) VALUES (?, ?, ?)').run(Date.now(), flag, note);
}
async function snapshotFlags() {
  for (const flag of config.flagsmith.watchedFlags) {
    try {
      const st = await getFlagState(flag);
      const sig = `${st.enabled}|${st.segmentOverrides ?? '-'}`;
      if (lastSeen.get(flag) === sig) continue;
      const first = !lastSeen.has(flag);
      lastSeen.set(flag, sig);
      db.prepare('INSERT INTO flag_history (ts, flag, enabled, segment_overrides, note) VALUES (?, ?, ?, ?, ?)').run(
        Date.now(), flag, st.enabled ? 1 : 0, st.segmentOverrides ?? null,
        `${first ? 'state when the agent started' : 'changed'}: enabled=${st.enabled}${st.segmentOverrides != null ? `, segment overrides=${st.segmentOverrides}` : ''}`);
    } catch (err) {
      console.warn(`[agent] flag snapshot failed for ${flag}:`, err.message);
    }
  }
}

// Detection (which may wait ~20s for the investigator) has its own lock, so approvals are never delayed by it.
async function tick() {
  if (!detecting) {
    detecting = true;
    detect().catch((err) => console.error('[agent] detect failed:', err)).finally(() => { detecting = false; });
  }
}
async function actOnDecisions() {
  if (busy) return;
  busy = true;
  try {
    await handleApproved();
    await verifyDisabled();
  } catch (err) {
    console.error('[agent] acting on decisions failed:', err);
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
setInterval(actOnDecisions, 2000);
setInterval(snapshotFlags, 30000);
snapshotFlags();
connectFlagsmithMcp().then(() => {
  const mode = !config.claude.apiKey || !config.claude.investigator ? 'off (numbers only)'
    : `on (${config.claude.investigatorModel}${mcpConnected() ? ', Flagsmith MCP' : ', Admin API'})`;
  console.log(`[agent] Investigator: ${mode}`);
});
setInterval(tick, A.intervalSeconds * 1000);
tick();
