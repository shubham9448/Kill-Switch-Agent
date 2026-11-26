// Writes a short Markdown incident report when an incident closes: what happened, the evidence,
// who approved, how long each step took, and the full timeline from the audit log.
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const secs = (ms) => (ms == null || ms < 0 ? '–' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const clock = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { hour12: false }) : '–');

export function writeReport(incidentId, { rateAfter } = {}) {
  const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
  if (!inc) return null;
  const a = JSON.parse(inc.stats);
  const s = a.suspect;
  const steps = db.prepare('SELECT * FROM audit_log WHERE incident_id = ? ORDER BY id').all(incidentId);

  const md = [
    `# Incident #${inc.id}: ${inc.kind === 'abuse' ? 'possible abuse' + (s ? ` on \`${s.flag}\`` : '') : s ? `\`${s.flag}\` switched off` : 'error spike, no flag to blame'}`,
    '',
    `**Outcome:** ${inc.status.replace(/_/g, ' ')}`,
    '',
    '## Summary',
    '',
    inc.explanation || '',
    '',
    '## Evidence',
    '',
    '| Group | Requests | Errors | Error rate |',
    '| --- | --- | --- | --- |',
    `| All users | ${a.overall.total} | ${a.overall.errors} | ${pct(a.overall.rate)} |`,
    ...(a.candidates || []).flatMap((c) => [
      `| \`${c.flag}\` ON | ${c.onTotal} | ${c.onErrors} | ${pct(c.onRate)} |`,
      `| \`${c.flag}\` OFF | ${c.offTotal} | ${c.offErrors} | ${pct(c.offRate)} |`,
    ]),
    '',
    s ? `\`${s.flag}\` was blamed because its ON users failed ${s.ratio.toFixed(1)}x more often than its OFF users, and it accounted for ${pct(s.errorShare)} of all errors.` : '',
    '',
    ...(inc.trace ? (() => {
      const t = JSON.parse(inc.trace);
      const p = (t.find((x) => x.tool === 'propose_action') || {}).input || {};
      return [
        '## How the agent investigated',
        '',
        `Investigated by Claude (${inc.confidence || '?'} confidence). Proposal: **${(p.action || '').replace(/_/g, ' ')}**${p.flag ? ` \`${p.flag}\`` : ''}.`,
        '',
        ...t.filter((x) => x.tool !== 'propose_action').map((x, n) => `${n + 1}. \`${x.tool}\`${x.input && Object.keys(x.input).length ? ` ${JSON.stringify(x.input)}` : ''}`),
        '',
        p.reasoning ? `Why: ${p.reasoning}` : '',
        '',
      ];
    })() : [`_Raised from the numbers only (investigator ${inc.decided_by_agent === 'maths' ? 'unavailable or overruled by the guardrails' : 'off'})._`, '']),
    '## Who was affected',
    '',
    s && s.onUsers != null ? `- Flag ON: **${s.onAffectedUsers} of ${s.onUsers} users** hit an error (${pct(s.onUserRate)})` : '',
    s && s.offUsers != null ? `- Flag OFF: **${s.offAffectedUsers} of ${s.offUsers} users** hit an error (${pct(s.offUserRate)})` : '',
    a.abuse ? `- Errors concentrated in a few sources: top 3 users caused ${pct(a.abuse.users.share)} of errors, top 3 IPs ${pct(a.abuse.sources.share)}` : '- No concentration: errors were spread across many users, as a real bug looks',
    ...(a.abuse ? [
      a.kind === 'abuse' ? '- Verdict: **possible abuse**, so turning the flag off was not recommended' : '- Verdict: real bug; these noisy sources were set aside before blaming the flag',
      '',
      '| Source | Errors |',
      '| --- | --- |',
      ...a.abuse.users.top.filter((t) => a.abuse.excludedUsers.includes(t.id)).map((t) => `| user \`${t.id}\` | ${t.errors} |`),
      ...a.abuse.sources.top.filter((t) => a.abuse.excludedSources.includes(t.id)).map((t) => `| IP \`${t.id}\` | ${t.errors} |`),
    ] : []),
    '',
    '## Response times',
    '',
    '| Step | Time |',
    '| --- | --- |',
    `| Alert raised | ${clock(inc.opened_at)} |`,
    `| Human decision (${inc.decided_by || '–'}) | ${secs(inc.decided_at - inc.opened_at)} after alert |`,
    ...(inc.disabled_at ? [
      `| Flag off in Flagsmith | ${secs(inc.disabled_at - inc.opened_at)} after alert |`,
      `| App stopped serving the flag (Flagsmith delivered the change) | ${secs(inc.propagated_at - inc.opened_at)} after alert (${secs(inc.propagated_at - inc.disabled_at)} after the switch) |`,
      `| Recovery confirmed | ${secs(inc.closed_at - inc.opened_at)} after alert |`,
    ] : [`| Closed (${inc.status.replace(/_/g, ' ')}) | ${secs(inc.closed_at - inc.opened_at)} after alert |`]),
    rateAfter != null ? `| Error rate after | ${pct(rateAfter)} (was ${pct(a.overall.rate)}) |` : '',
    '',
    '## Timeline',
    '',
    ...steps.map((r) => `- ${clock(r.ts)} · **${r.step}** ${r.detail || ''}`),
    '',
    '## Follow-up',
    '',
    inc.kind === 'abuse'
      ? `- [ ] Fix the input handling the attacker exploited${s ? ` in \`${s.flag}\`` : ''}\n- [ ] Review the blocked accounts and IPs`
      : s ? `- [ ] Fix the bug behind \`${s.flag}\`\n- [ ] Switch \`${s.flag}\` back on in Flagsmith, ideally for the holdout segment first` : '- [ ] Investigate the cause outside feature flags',
    '',
  ].filter((l) => l !== null).join('\n');

  fs.mkdirSync('reports', { recursive: true });
  const file = path.join('reports', `incident-${inc.id}.md`);
  fs.writeFileSync(file, md);
  return file;
}
