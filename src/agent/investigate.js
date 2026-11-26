// The investigator. When the maths raises an alarm, Claude investigates with read-only tools
// (our event data + Flagsmith via its MCP server) and proposes ONE action.
//
// Who does what:
//   maths  -> detects the alarm (fast, cheap, every 10s) and supplies the evidence numbers
//   Claude -> decides which tools to use, reads error messages and Flagsmith, proposes an action
//   guardrails (this file) -> check the proposal against the evidence; Claude can't offer a kill the numbers don't back,
//                             or block someone who isn't actually causing errors
//   human  -> approves; only then does our code change Flagsmith
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { db, JUDGED } from '../db.js';
import { toolsForClaude, runTool, ACTIONS } from './tools.js';
import { mcpConnected } from '../flagsmithMcp.js';

const A = config.agent;
const MAX_STEPS = 8;
const pct = (x) => `${(x * 100).toFixed(1)}%`;

function systemPrompt(a) {
  return `You are the Kill Switch Agent's investigator, on call for a web shop that ships features behind Flagsmith feature flags.
An automatic check just raised an alarm. Investigate with the tools, then finish with propose_action.

Context:
- Flags watched: ${config.flagsmith.watchedFlags.join(', ')}.
- Flagsmith project id: ${config.flagsmith.projectId || 'n/a'}, environment key: ${config.flagsmith.environmentKey || 'n/a'}.${mcpConnected() ? ' Tools starting with flagsmith_ read Flagsmith directly through its MCP server.' : ''}
- Some users are deliberately kept on the old version (holdout segments), so ON vs OFF can be compared.

How to work:
- Use a few targeted tool calls (usually 2-5). Look at error rates by flag, who the errors come from, and the error messages.
- A feature bug: errors concentrated in users with one flag ON, spread over MANY different users, a consistent error message from the new code path. Propose turn_off_flag.
- Abuse: most errors come from a few users or IPs (check error_breakdown by user and by ip) while ordinary users with the same flag are fine.
  Propose block_sources with exactly those users and IPs. This holds even if the attackers are exploiting a real bug with crafted input:
  blocking them protects everyone without taking the feature away from real users. Mention the exploited bug in the summary so it gets fixed.
- No flag at fault: errors are spread across many different users, flag ON and OFF alike (e.g. "database connection refused" everywhere). Propose escalate_no_flag.
  Do not use escalate_no_flag when a few sources cause most errors: that is abuse.
- If the evidence is thin or still building, propose keep_watching.
- Use only numbers you saw in tool results. You cannot change anything yourself: a human approves every action.

The automatic check found (may be imperfect):
${JSON.stringify(summariseMaths(a))}`;
}

// A compact version of the maths result for the prompt.
export function summariseMaths(a) {
  return {
    overall_error_rate: pct(a.overall.rate),
    requests: a.overall.total,
    verdict_of_maths: a.kind,
    flags: (a.candidates || []).map((c) => ({
      flag: c.flag, error_rate_on: pct(c.onRate), error_rate_off: pct(c.offRate),
      users_affected_on: `${c.onAffectedUsers}/${c.onUsers}`, users_affected_off: `${c.offAffectedUsers}/${c.offUsers}`,
    })),
    concentrated_sources: a.abuse && { users: a.abuse.excludedUsers, ips: a.abuse.excludedSources,
      share_of_errors: pct(Math.max(a.abuse.users.share, a.abuse.sources.share)) },
  };
}

let defaultClient;

// Returns { proposal, trace } or throws. `client` can be injected (tests use a scripted fake).
export async function investigate(a, { client } = {}) {
  client ??= (defaultClient ??= new Anthropic({ apiKey: config.claude.apiKey }));
  const tools = toolsForClaude();
  const messages = [{ role: 'user', content: 'Investigate this alarm now and finish with propose_action.' }];
  const trace = [];
  const deadline = Date.now() + config.claude.investigatorTimeoutSeconds * 1000;
  let nudged = false;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (Date.now() > deadline) throw new Error('investigation timed out');
    const res = await client.messages.create({
      model: config.claude.investigatorModel,
      max_tokens: 1500,
      system: systemPrompt(a),
      tools,
      messages,
    }, { timeout: Math.max(5000, deadline - Date.now()) });

    const toolUses = res.content.filter((b) => b.type === 'tool_use');
    const proposal = toolUses.find((t) => t.name === 'propose_action');
    if (proposal) {
      trace.push({ tool: 'propose_action', input: proposal.input });
      return { proposal: proposal.input, trace };
    }
    if (!toolUses.length) {
      if (nudged) throw new Error('investigator stopped without a proposal');
      nudged = true;
      messages.push({ role: 'assistant', content: res.content });
      messages.push({ role: 'user', content: 'Please finish now by calling propose_action.' });
      continue;
    }
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const t of toolUses) {
      const out = await runTool(t.name, t.input);
      trace.push({ tool: t.name, input: t.input, result: out.slice(0, 400) });
      results.push({ type: 'tool_result', tool_use_id: t.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }
  throw new Error(`no proposal after ${MAX_STEPS} steps`);
}

// Errors per user and per IP in the recent window, to check who a proposal wants to block.
function errorCounts() {
  const rows = db.prepare(`SELECT user_id, source FROM events WHERE ts >= ? AND ok = 0 AND ${JUDGED}`).all(Date.now() - 120000);
  const users = new Map(), ips = new Map();
  for (const r of rows) {
    users.set(r.user_id, (users.get(r.user_id) || 0) + 1);
    ips.set(r.source, (ips.get(r.source) || 0) + 1);
  }
  return { users, ips };
}

// Guardrails: turn Claude's proposal into the decision we act on, never going beyond the evidence.
// Returns { kind, flag, abuse?, note? } or { wait: true }.
export function validate(proposal, a) {
  const p = proposal || {};
  if (!ACTIONS.includes(p.action)) return { kind: a.kind, flag: a.suspect?.flag, fallback: true, note: 'The investigator gave no valid proposal.' };
  if (p.action === 'keep_watching') return { wait: true };

  const mathsBlames = (flag) => {
    const c = (a.candidates || []).find((x) => x.flag === flag);
    return a.kind === 'bug' && a.suspect?.flag === flag && c != null;
  };

  if (p.action === 'turn_off_flag') {
    if (mathsBlames(p.flag)) return { kind: 'bug', flag: p.flag };
    return {
      kind: a.kind, flag: a.suspect?.flag, fallback: true,
      note: a.kind === 'abuse'
        ? `The investigator suggested turning off ${p.flag || 'a flag'}, but most errors come from a few sources, so the kill isn't offered yet. It will be if ordinary users keep failing.`
        : `The investigator suggested turning off ${p.flag || 'a flag'}, but the numbers don't show it hurting enough different users, so that option isn't offered.`,
    };
  }

  if (p.action === 'block_sources') {
    // Only block sources that really are causing errors right now (at least 3 each).
    const { users, ips } = errorCounts();
    const okUsers = (p.users || []).filter((u) => (users.get(u) || 0) >= 3);
    const okIps = (p.ips || []).filter((ip) => (ips.get(ip) || 0) >= 3);
    const dropped = [...(p.users || []), ...(p.ips || [])].filter((x) => !okUsers.includes(x) && !okIps.includes(x));
    if (!okUsers.length && !okIps.length) {
      return { kind: a.kind, flag: a.suspect?.flag, fallback: true, note: 'The investigator wanted to block sources that are not causing errors, so nothing is proposed for blocking.' };
    }
    const flag = p.flag && config.flagsmith.watchedFlags.includes(p.flag) ? p.flag : a.suspect?.flag || null;
    const blameBugToo = a.kind === 'bug'; // a real bug is also happening: keep the kill on offer
    return {
      kind: blameBugToo ? 'bug' : 'abuse', flag,
      abuse: { ...(a.abuse || { users: { share: 0, top: [] }, sources: { share: 0, top: [] } }), excludedUsers: okUsers, excludedSources: okIps },
      note: dropped.length ? `Not blocking ${dropped.join(', ')}: they aren't causing errors.` : undefined,
    };
  }

  // escalate_no_flag
  if (a.kind === 'bug') {
    return { kind: 'bug', flag: a.suspect.flag, note: `The investigator thinks no flag is at fault, but ${a.suspect.flag} users fail ${pct(a.suspect.onRate)} vs ${pct(a.suspect.offRate)} without it, so turning it off is still offered.` };
  }
  return { kind: 'no_suspect', flag: null };
}
