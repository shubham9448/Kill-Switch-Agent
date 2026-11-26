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
    const who = body.user.username || body.user.name || userId; // readable name for the dashboard and report
    const allowed = !config.slack.approvers.length || config.slack.approvers.includes(userId);
    if (!allowed) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: userId, text: 'You are not on the approver list for flag changes.' });
      audit(incidentId, 'decision:rejected', `<@${userId}> is not an approver`);
      return;
    }
    const r = db.prepare(
      `UPDATE incidents SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'waiting_approval'`
    ).run({ approve: 'approved', ignore: 'ignored', block: 'block_requested' }[decision], `${who} (Slack)`, Date.now(), incidentId);
    if (!r.changes) return; // already decided (double click or dashboard)
    audit(incidentId, `decision:${decision}`, `by ${who} in Slack`);
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: body.message.text,
      blocks: [
        ...body.message.blocks.filter((b) => b.type !== 'actions'),
        { type: 'context', elements: [{ type: 'mrkdwn',
          text: { approve: `:white_check_mark: Approved by <@${userId}>. Switching the flag off…`,
                  block: `:shield: <@${userId}> chose to block the sources. The flag stays ON.`,
                  ignore: `:no_entry_sign: Ignored by <@${userId}>.` }[decision] }] },
      ],
    });
  };
  app.action('approve_kill', decide('approve'));
  app.action('ignore_kill', decide('ignore'));
  app.action('block_sources', decide('block'));

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

// One line per tool call, so the reader sees how the agent reached its proposal.
const TOOL_LABEL = {
  error_breakdown: (i) => `compared errors by ${i.by}`,
  sample_errors: (i) => `read recent error messages${i.flag ? ` for ${i.flag}` : ''}`,
  flag_changes: () => 'checked recent flag changes',
  flags_for_user: (i) => `checked flags served to ${i.user_id}`,
  flag_state: (i) => `read ${i.flag} in Flagsmith`,
};
export function describeStep(t) {
  if (TOOL_LABEL[t.tool]) return TOOL_LABEL[t.tool](t.input || {});
  if (t.tool.startsWith('flagsmith_')) return `asked Flagsmith MCP: ${t.tool.replace('flagsmith_', '')}`;
  return t.tool;
}
function investigationBlock(incident) {
  if (!incident.trace?.length) return [];
  const steps = incident.trace.filter((t) => t.tool !== 'propose_action').map((t, n) => `${n + 1}. ${describeStep(t)}`).join('\n');
  return [{ type: 'context', elements: [{ type: 'mrkdwn',
    text: `*How I investigated* (${incident.byAgent === 'claude' ? `Claude, ${incident.confidence} confidence` : 'numbers only'})\n${steps}` }] }];
}

export async function postAlert(incident, analysis) {
  if (analysis.kind === 'abuse') return postAbuseAlert(incident, analysis);
  const s = analysis.suspect;
  const headline = s ? `:rotating_light: Errors spiking. Suspect flag: \`${s.flag}\`` : ':warning: Errors spiking with no clear flag to blame';
  if (!app) {
    const steps = (incident.trace || []).filter((t) => t.tool !== 'propose_action').map((t, n) => `  ${n + 1}. ${describeStep(t)}`).join('\n');
    console.log(`\n${'='.repeat(70)}\n${headline}\n${incident.explanation}\n` + (steps ? `How I investigated:\n${steps}\n` : '') +
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
      { type: 'mrkdwn', text: `*Users affected, flag ON*\n${s.onAffectedUsers} of ${s.onUsers}` },
      { type: 'mrkdwn', text: `*Users affected, flag OFF*\n${s.offAffectedUsers} of ${s.offUsers}` },
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
  blocks.push(...investigationBlock(incident));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Incident #${incident.id} · <${config.appUrl}/|Live dashboard>` }] });
  const res = await app.client.chat.postMessage({ channel: config.slack.channel, text: headline, blocks });
  return res.ts;
}

export async function postFollowUp(threadTs, text) {
  if (!app) { console.log(`[slack:console] ${text}`); return; }
  await app.client.chat.postMessage({ channel: config.slack.channel, thread_ts: threadTs || undefined, text });
}

// Errors concentrated in a few users/IPs: suggest blocking them, keep "turn off" as a deliberate override.
async function postAbuseAlert(incident, a) {
  const ab = a.abuse;
  const flag = a.suspect?.flag;
  const headline = `:shield: Possible abuse${flag ? ` on \`${flag}\`` : ''}: errors come from a few sources`;
  const sources = [
    ...ab.users.top.map((t) => `user \`${t.id}\`: ${t.errors} errors`),
    ...ab.sources.top.slice(0, ab.excludedSources.length).map((t) => `IP \`${t.id}\`: ${t.errors} errors`),
  ].join('\n');
  if (!app) {
    console.log(`\n${'='.repeat(70)}\n${headline}\n${incident.explanation}\n${sources.replace(/`/g, '')}\n` +
      `Decide on the dashboard: ${config.appUrl}/  (incident #${incident.id})\n${'='.repeat(70)}\n`);
    return null;
  }
  const actions = [
    { type: 'button', style: 'primary', action_id: 'block_sources', value: String(incident.id),
      text: { type: 'plain_text', text: 'Block these sources' } },
  ];
  if (flag) {
    actions.push({ type: 'button', action_id: 'approve_kill', value: String(incident.id),
      text: { type: 'plain_text', text: `Turn off ${flag} anyway` },
      confirm: { title: { type: 'plain_text', text: 'Turn off anyway?' },
        text: { type: 'mrkdwn', text: `Errors come from a few sources, not your users. Turning off \`${flag}\` affects everyone.` },
        confirm: { type: 'plain_text', text: 'Turn it off' }, deny: { type: 'plain_text', text: 'Cancel' } } });
  }
  actions.push({ type: 'button', action_id: 'ignore_kill', value: String(incident.id), text: { type: 'plain_text', text: 'Ignore' } });
  const res = await app.client.chat.postMessage({ channel: config.slack.channel, text: headline, blocks: [
    { type: 'header', text: { type: 'plain_text', text: 'Possible abuse, not a bug' } },
    { type: 'section', text: { type: 'mrkdwn', text: incident.explanation } },
    { type: 'section', text: { type: 'mrkdwn', text: `*Where the errors come from*\n${sources}` } },
    { type: 'actions', elements: actions },
    ...investigationBlock(incident),
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Incident #${incident.id} · <${config.appUrl}/|Live dashboard>` }] },
  ] });
  return res.ts;
}
