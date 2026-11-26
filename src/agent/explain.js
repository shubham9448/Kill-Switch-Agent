// Claude only writes the human explanation. The decision itself is the maths in attribution.js.
// If there is no API key or the call fails, a plain template is used, so the agent never blocks on AI.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

const pct = (x) => `${(x * 100).toFixed(1)}%`;

const who = (ab) => `${ab.excludedUsers.length} users (${ab.excludedUsers.join(', ')})` +
  (ab.excludedSources.length ? ` and ${ab.excludedSources.length} IP${ab.excludedSources.length > 1 ? 's' : ''} (${ab.excludedSources.join(', ')})` : '');

export function templateExplanation(a) {
  const s = a.suspect;
  if (a.kind === 'abuse') {
    const ab = a.abuse;
    return `Possible abuse, not a bug: ${pct(Math.max(ab.users.share, ab.sources.share))} of errors come from just ${who(ab)}` +
      (s ? `, all hitting ${s.flag}` : '') + `. Other users are not affected, so turning the flag off is not recommended. ` +
      `Consider blocking these sources.`;
  }
  if (!s) {
    return `Error rate is ${pct(a.overall.rate)} over ${a.overall.total} requests, but no single flag explains it. ` +
      `This looks like a wider problem; a human should investigate.` +
      (a.unjudgeable?.length ? ` Note: ${a.unjudgeable.join(', ')} is ON for every user, so it can't be compared; ` +
        `give it a small OFF holdout segment in Flagsmith so it can be checked.` : '');
  }
  return `Error rate is ${pct(a.overall.rate)} across ${a.overall.total} requests. ` +
    `Users with ${s.flag} ON fail ${pct(s.onRate)} of the time (${s.onErrors}/${s.onTotal}) vs ${pct(s.offRate)} with it OFF (${s.offErrors}/${s.offTotal}), ` +
    `so ${s.flag} accounts for ${pct(s.errorShare)} of errors across ${s.onAffectedUsers} affected users. ` +
    `Turning it off should bring errors back to about ${pct(s.offRate)}.` +
    (a.abuse ? ` (Errors from ${who(a.abuse)} were set aside as noise.)` : '');
}

let client;
export async function explain(a) {
  const fallback = templateExplanation(a);
  if (!config.claude.apiKey) return fallback;
  client ??= new Anthropic({ apiKey: config.claude.apiKey });
  const facts = {
    overall_error_rate: pct(a.overall.rate),
    requests_in_window: a.overall.total,
    suspect: a.suspect && {
      flag: a.suspect.flag,
      error_rate_flag_on: pct(a.suspect.onRate), requests_flag_on: a.suspect.onTotal,
      error_rate_flag_off: pct(a.suspect.offRate), requests_flag_off: a.suspect.offTotal,
      share_of_errors_from_flag_on_users: pct(a.suspect.errorShare),
    },
    verdict: a.kind === 'abuse' ? 'possible abuse: errors concentrated in a few users/IPs, do NOT recommend turning the flag off, suggest blocking them' : 'bug',
    affected_users_flag_on: a.suspect?.onAffectedUsers,
    concentrated_sources: a.abuse && { users: a.abuse.excludedUsers, ips: a.abuse.excludedSources,
      share_of_errors: pct(Math.max(a.abuse.users.share, a.abuse.sources.share)) },
    other_flags: a.candidates?.filter((c) => c.flag !== a.suspect?.flag)
      .map((c) => ({ flag: c.flag, on: pct(c.onRate), off: pct(c.offRate) })),
  };
  try {
    const msg = await client.messages.create({
      model: config.claude.model,
      max_tokens: 200,
      system:
        'You write incident alerts for on-call engineers. Use ONLY the numbers given. No guessing about root causes ' +
        'in code. At most 3 short sentences: what is happening, which feature flag is responsible and the evidence, ' +
        'and what switching it off is expected to do. If the verdict is possible abuse, say it looks like abuse from the named ' +
        'sources and recommend blocking them instead of turning the flag off. Plain text, no markdown headings.',
      messages: [{ role: 'user', content: JSON.stringify(facts) }],
    }, { timeout: 8000 });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text || fallback;
  } catch (err) {
    console.warn('[explain] Claude unavailable, using template:', err.message);
    return fallback;
  }
}
