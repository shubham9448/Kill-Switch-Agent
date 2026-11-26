// The investigator's toolbox. All tools only READ. The single way to act is propose_action,
// which ends the investigation; our code then validates the proposal and a human approves it.
import { db, JUDGED } from '../db.js';
import { config } from '../config.js';
import { getFlagState } from '../flagsmithAdmin.js';
import { mcpToolsForClaude, callMcpTool, PREFIX, mcpConnected } from '../flagsmithMcp.js';

const pct = (x) => `${(x * 100).toFixed(1)}%`;

export const ACTIONS = ['turn_off_flag', 'block_sources', 'escalate_no_flag', 'keep_watching'];

const LOCAL_TOOLS = [
  {
    name: 'error_breakdown',
    description: 'Error rate of recent checkout requests grouped by one dimension. by=flag compares users who had each flag ON vs OFF. ' +
      'by=user and by=ip list the sources with the most errors. by=error groups by error message. Only real server errors (5xx) count; rejected, rate-limited and blocked requests are excluded.',
    input_schema: {
      type: 'object',
      properties: {
        by: { type: 'string', enum: ['flag', 'user', 'ip', 'error'] },
        window_seconds: { type: 'integer', description: `How far back to look. Default ${config.agent.windowSeconds} (the agent's detection window), max 600.` },
      },
      required: ['by'],
    },
  },
  {
    name: 'sample_errors',
    description: 'Recent individual failed requests: time, user, IP, the flags that user had, and the error message.',
    input_schema: {
      type: 'object',
      properties: {
        n: { type: 'integer', description: 'How many, max 20. Default 8.' },
        flag: { type: 'string', description: 'Optional: only requests where this flag was ON.' },
      },
    },
  },
  {
    name: 'flag_changes',
    description: 'Changes to flag states that the agent saw in Flagsmith (it checks every 30 seconds), newest first. Useful to link a spike to a recent change.',
    input_schema: { type: 'object', properties: { minutes: { type: 'integer', description: 'How far back. Default 30.' } } },
  },
  {
    name: 'flags_for_user',
    description: 'Which flags Flagsmith currently serves to one user.',
    input_schema: { type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'] },
  },
  {
    name: 'propose_action',
    description: 'Finish the investigation with ONE proposal. Nothing happens until a human approves it. ' +
      'turn_off_flag: a feature flag is causing errors for many different users. ' +
      'block_sources: errors come from a few users/IPs (abuse); list them. ' +
      'escalate_no_flag: errors are real but no feature flag explains them (e.g. a shared dependency is down). ' +
      'keep_watching: evidence is too weak or still building.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS },
        flag: { type: 'string', description: 'For turn_off_flag: the flag name. For block_sources: the flag being hit, if any.' },
        users: { type: 'array', items: { type: 'string' }, description: 'For block_sources: user ids to block.' },
        ips: { type: 'array', items: { type: 'string' }, description: 'For block_sources: IPs to block.' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        summary: { type: 'string', description: 'For the on-call engineer: at most 3 short sentences. What is happening, the evidence (with numbers), what the action will do.' },
        reasoning: { type: 'string', description: 'Why this action and not the others, in 1-3 sentences.' },
      },
      required: ['action', 'confidence', 'summary', 'reasoning'],
    },
  },
];

// Without the MCP server, the investigator can still read a flag's state through the Admin API.
const ADMIN_FLAG_TOOL = {
  name: 'flag_state',
  description: 'Current state of a flag in Flagsmith: enabled for the environment, and how many segment overrides it has.',
  input_schema: { type: 'object', properties: { flag: { type: 'string' } }, required: ['flag'] },
};

export function toolsForClaude() {
  const mcp = mcpToolsForClaude();
  return [...LOCAL_TOOLS.slice(0, -1), ...(mcp.length ? mcp : [ADMIN_FLAG_TOOL]), LOCAL_TOOLS[LOCAL_TOOLS.length - 1]];
}

function judged(windowSeconds) {
  const since = Date.now() - Math.min(Math.max(windowSeconds || config.agent.windowSeconds, 10), 600) * 1000;
  return db.prepare(`SELECT ts, ok, flags, user_id, source, error FROM events WHERE ts >= ? AND ${JUDGED}`).all(since);
}

function breakdown({ by, window_seconds }) {
  const rows = judged(window_seconds);
  const total = rows.length;
  const errors = rows.filter((r) => !r.ok).length;
  const head = `${total} requests, ${errors} errors (${pct(total ? errors / total : 0)}) in the last ${window_seconds || config.agent.windowSeconds}s.`;
  if (by === 'flag') {
    const g = {};
    for (const r of rows) {
      for (const [flag, on] of Object.entries(JSON.parse(r.flags))) {
        g[flag] ??= { on: [0, 0, new Set(), new Set()], off: [0, 0, new Set(), new Set()] };
        const s = on ? g[flag].on : g[flag].off;
        s[0]++; s[2].add(r.user_id);
        if (!r.ok) { s[1]++; s[3].add(r.user_id); }
      }
    }
    const lines = Object.entries(g).map(([f, { on, off }]) =>
      `${f}: ON ${on[1]}/${on[0]} requests failed (${pct(on[0] ? on[1] / on[0] : 0)}), ${on[3].size} of ${on[2].size} users affected | ` +
      `OFF ${off[1]}/${off[0]} failed (${pct(off[0] ? off[1] / off[0] : 0)}), ${off[3].size} of ${off[2].size} users affected`);
    return [head, ...lines].join('\n');
  }
  const key = { user: 'user_id', ip: 'source', error: 'error' }[by];
  const counts = new Map();
  for (const r of rows) if (!r.ok) counts.set(r[key] || 'unknown', (counts.get(r[key] || 'unknown') || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  return [head, `Errors by ${by} (top 10 of ${counts.size}):`, ...top.map(([k, n]) => `${k}: ${n} errors (${pct(errors ? n / errors : 0)} of errors)`)].join('\n');
}

function sample({ n, flag }) {
  const rows = judged(120).filter((r) => !r.ok && (!flag || JSON.parse(r.flags)[flag])).slice(-Math.min(n || 8, 20));
  if (!rows.length) return 'No failed requests in the last 2 minutes.';
  return rows.map((r) => `${new Date(r.ts).toISOString().slice(11, 19)} user=${r.user_id} ip=${r.source} flags=${r.flags} error="${r.error || 'unknown'}"`).join('\n');
}

function changes({ minutes }) {
  const since = Date.now() - (minutes || 30) * 60000;
  const rows = db.prepare('SELECT * FROM flag_history WHERE ts >= ? ORDER BY ts DESC LIMIT 20').all(since);
  if (!rows.length) return `No flag changes seen in the last ${minutes || 30} minutes.`;
  return rows.map((r) => `${Math.round((Date.now() - r.ts) / 1000)}s ago: ${r.flag} ${r.note || `enabled=${Boolean(r.enabled)}, segment overrides=${r.segment_overrides}`}`).join('\n');
}

async function userFlags({ user_id }) {
  const res = await fetch(`${config.appUrl}/api/shop/flags?user=${encodeURIComponent(user_id)}`, { signal: AbortSignal.timeout(5000) });
  return `Flags served to ${user_id}: ${JSON.stringify(await res.json())}`;
}

// Runs one tool call from Claude. Returns text. Errors are returned as text so Claude can recover.
export async function runTool(name, input) {
  try {
    if (name === 'error_breakdown') return breakdown(input);
    if (name === 'sample_errors') return sample(input);
    if (name === 'flag_changes') return changes(input);
    if (name === 'flags_for_user') return await userFlags(input);
    if (name === 'flag_state') {
      if (!config.flagsmith.watchedFlags.includes(input.flag)) return `Unknown flag "${input.flag}". Watched flags: ${config.flagsmith.watchedFlags.join(', ')}`;
      return JSON.stringify(await getFlagState(input.flag));
    }
    if (name.startsWith(PREFIX) && mcpConnected()) return await callMcpTool(name, input);
    return `Unknown tool ${name}`;
  } catch (err) {
    return `Tool error: ${err.message}`;
  }
}
