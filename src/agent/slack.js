// Slack: posts the alert with Approve / Ignore buttons and records the human's decision.
// Uses Socket Mode, so it works from your laptop with no public URL.
// If Slack isn't configured, alerts print to the console and the dashboard's backup buttons are used.
import bolt from '@slack/bolt';
import { config } from '../config.js';
import { db, audit, setKv } from '../db.js';

const { App } = bolt;
let app = null;
export const slackEnabled = () => Boolean(app);

export async function startSlack() {
  const { botToken, appToken, channel } = config.slack;
  if (!botToken || !appToken || !channel) {
    console.log('[slack] Not configured: alerts go to the console, approve from the dashboard');
    setKv('slack_connected', 'false');
    return;
  }
  setKv('slack_connected', 'false'); // until proven otherwise, the dashboard backup stays usable

  // Quick token check first, so a wrong token or no network fails fast instead of retrying forever.
  try {
    const r = await fetch('https://slack.com/api/auth.test', {
      method: 'POST', headers: { Authorization: `Bearer ${botToken}` }, signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!j.ok) throw new Error(`bot token rejected: ${j.error}`);
  } catch (err) {
    console.error(`[slack] Could not connect (${err.message}). Using console alerts + dashboard approval. Run "npm run check".`);
    return;
  }

  app = new App({ token: botToken, appToken, socketMode: true, clientOptions: { retryConfig: { retries: 1 } } });

  const decide = (decision) => async ({ ack, body, action, client }) => {
    await ack();
    const incidentId = Number(action.value);
    const userId = body.user.id;
    const allowed = !config.slack.approvers.length || config.slack.approvers.includes(userId);
    if (!allowed) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: userId, text: 'You are not on the approver list for flag changes.' });
      audit(incidentId, 'decision:rejected', `<@${userId}> is not an approver`);
      return;
    }
    const r = db.prepare(
      `UPDATE incidents SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'waiting_approval'`
    ).run(decision === 'approve' ? 'approved' : 'ignored', `slack:${userId}`, Date.now(), incidentId);
    if (!r.changes) return; // already decided (double click or dashboard)
    audit(incidentId, `decision:${decision}`, `by slack user ${userId}`);
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: body.message.text,
      blocks: [
        ...body.message.blocks.filter((b) => b.type !== 'actions'),
        { type: 'context', elements: [{ type: 'mrkdwn',
          text: decision === 'approve' ? `:white_check_mark: Approved by <@${userId}>. Switching the flag off…` : `:no_entry_sign: Ignored by <@${userId}>.` }] },
      ],
    });
  };
  app.action('approve_kill', decide('approve'));
  app.action('ignore_kill', decide('ignore'));

  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('no connection after 15s')), 15000));
  const starting = app.start();
  try {
    await Promise.race([starting, timeout]);
    setKv('slack_connected', 'true');
    console.log('[slack] Connected (Socket Mode)');
  } catch (err) {
    starting.catch(() => {}); // stop an unhandled rejection if it fails later
    try { await app.stop(); } catch { /* not started */ }
    // Fail safe: keep the agent running, alert on the console, and unlock the dashboard's backup buttons.
    app = null;
    setKv('slack_connected', 'false');
    console.error(`[slack] Could not connect (${err.message}). Falling back to console alerts + dashboard approval. Run "npm run check".`);
  }
}

export async function postAlert(incident, analysis) {
  const s = analysis.suspect;
  const headline = s ? `:rotating_light: Errors spiking. Suspect flag: \`${s.flag}\`` : ':warning: Errors spiking with no clear flag to blame';
  if (!app) {
    console.log(`\n${'='.repeat(70)}\n${headline}\n${incident.explanation}\n` +
      (s ? `Approve on the dashboard: ${config.appUrl}/  (incident #${incident.id})` : '') + `\n${'='.repeat(70)}\n`);
    return null;
  }
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: s ? `Kill switch request: ${s.flag}` : 'Error spike, cause unclear' } },
    { type: 'section', text: { type: 'mrkdwn', text: incident.explanation } },
  ];
  if (s) {
    blocks.push({ type: 'section', fields: [
      { type: 'mrkdwn', text: `*Error rate, flag ON*\n${(s.onRate * 100).toFixed(1)}% (${s.onErrors}/${s.onTotal})` },
      { type: 'mrkdwn', text: `*Error rate, flag OFF*\n${(s.offRate * 100).toFixed(1)}% (${s.offErrors}/${s.offTotal})` },
    ] });
    blocks.push({ type: 'actions', elements: [
      { type: 'button', style: 'danger', action_id: 'approve_kill', value: String(incident.id),
        text: { type: 'plain_text', text: `Turn off ${s.flag}` },
        confirm: { title: { type: 'plain_text', text: 'Turn off the flag?' },
          text: { type: 'mrkdwn', text: `This disables \`${s.flag}\` for everyone in this environment.` },
          confirm: { type: 'plain_text', text: 'Turn it off' }, deny: { type: 'plain_text', text: 'Cancel' } } },
      { type: 'button', action_id: 'ignore_kill', value: String(incident.id), text: { type: 'plain_text', text: 'Ignore' } },
    ] });
  }
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Incident #${incident.id} · <${config.appUrl}/|Live dashboard>` }] });
  const res = await app.client.chat.postMessage({ channel: config.slack.channel, text: headline, blocks });
  return res.ts;
}

export async function postFollowUp(threadTs, text) {
  if (!app) { console.log(`[slack:console] ${text}`); return; }
  await app.client.chat.postMessage({ channel: config.slack.channel, thread_ts: threadTs || undefined, text });
}
