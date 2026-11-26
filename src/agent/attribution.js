// Pure maths, no AI: is something wrong, which flag explains it, and is it a bug or an attack?
//
// 1. For each flag, compare users who had it ON vs OFF: by requests AND by distinct users.
// 2. A real bug hurts many different users. If most errors come from a few users or IPs, it looks like abuse.
// 3. If a few noisy sources dominate, judge again without them: a real bug still shows up in everyone else.

const TOP_N = 3;

function count(events) {
  const total = events.length;
  const errors = events.filter((e) => !e.ok).length;
  return { total, errors, rate: total ? errors / total : 0 };
}

// Share of errors caused by the top N users and by the top N sources (IPs).
export function concentration(errorEvents) {
  const top = (key) => {
    const counts = new Map();
    for (const e of errorEvents) {
      const k = e[key] || 'unknown';
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_N);
    const n = sorted.reduce((s, [, c]) => s + c, 0);
    // "Heavy" = a source that alone caused at least 3 errors and 5% of all errors. One error each is just a user.
    const heavy = sorted.filter(([, c]) => c >= 3 && c >= 0.05 * errorEvents.length).map(([id]) => id);
    return { share: errorEvents.length ? n / errorEvents.length : 0, top: sorted.map(([id, errors]) => ({ id, errors })), heavy };
  };
  return { users: top('userId'), sources: top('source') };
}

function perFlag(events, opts) {
  const errors = events.filter((e) => !e.ok).length;
  const groups = {};
  for (const e of events) {
    for (const [flag, on] of Object.entries(e.flags)) {
      groups[flag] ??= { on: { total: 0, errors: 0, users: new Set(), failed: new Set() },
                         off: { total: 0, errors: 0, users: new Set(), failed: new Set() } };
      const side = on ? groups[flag].on : groups[flag].off;
      side.total++;
      side.users.add(e.userId);
      if (!e.ok) { side.errors++; side.failed.add(e.userId); }
    }
  }
  return Object.entries(groups).map(([flag, s]) => {
    const onRate = s.on.total ? s.on.errors / s.on.total : 0;
    const offRate = s.off.total ? s.off.errors / s.off.total : 0;
    // Floor the OFF rate at 0.5% so a perfect OFF group doesn't give an infinite ratio.
    const ratio = onRate / Math.max(offRate, 0.005);
    // The same comparison by people: share of distinct users who hit at least one error.
    const onUserRate = s.on.users.size ? s.on.failed.size / s.on.users.size : 0;
    const offUserRate = s.off.users.size ? s.off.failed.size / s.off.users.size : 0;
    const userRatio = onUserRate / Math.max(offUserRate, 0.005);
    const errorShare = errors ? s.on.errors / errors : 0;
    const enoughData = s.on.total >= opts.minRequestsPerGroup && s.off.total >= opts.minRequestsPerGroup;
    return {
      flag, onTotal: s.on.total, onErrors: s.on.errors, offTotal: s.off.total, offErrors: s.off.errors,
      onRate, offRate, ratio, errorShare, enoughData,
      onUsers: s.on.users.size, onAffectedUsers: s.on.failed.size,
      offUsers: s.off.users.size, offAffectedUsers: s.off.failed.size,
      onUserRate, offUserRate, userRatio,
    };
  });
}

// Is this flag guilty on these numbers? Requests AND people must both point at it.
const guiltyBy = (opts) => (c) =>
  c.enoughData && c.ratio >= opts.blameRatio && c.onRate >= opts.errorRateThreshold &&
  c.userRatio >= opts.blameRatio && c.onAffectedUsers >= opts.minAffectedUsers;

const looksGuilty = (opts) => (c) => c.enoughData && c.ratio >= opts.blameRatio && c.onRate >= opts.errorRateThreshold;
const rank = (a, b) => b.ratio * b.errorShare - a.ratio * a.errorShare;

export function analyse(events, opts) {
  const overall = count(events);
  if (overall.total < opts.minRequests || overall.rate < opts.errorRateThreshold) {
    return { alarm: false, overall };
  }

  const candidates = perFlag(events, opts);
  const errorEvents = events.filter((e) => !e.ok);
  const conc = concentration(errorEvents);
  const concentrated =
    (conc.users.share > opts.concentrationShare && conc.users.heavy.length > 0) ||
    (conc.sources.share > opts.concentrationShare && conc.sources.heavy.length > 0);

  if (concentrated) {
    // A few sources dominate. Judge again without them: a real bug still shows up among everyone else.
    const noisyUsers = new Set(conc.users.heavy);
    const noisySources = new Set(conc.sources.share > opts.concentrationShare ? conc.sources.heavy : []);
    const rest = events.filter((e) => !noisyUsers.has(e.userId) && !noisySources.has(e.source));
    const restCandidates = perFlag(rest, opts);
    const realBug = restCandidates.filter(guiltyBy(opts)).sort(rank)[0];
    const abuse = { ...conc, excludedUsers: [...noisyUsers], excludedSources: [...noisySources] };
    if (realBug) {
      // A real bug AND noisy sources at the same time: blame the flag, mention the noise.
      return { alarm: true, kind: 'bug', overall, candidates: restCandidates, suspect: realBug, abuse };
    }
    // Errors only from a few sources: possible abuse. Name the flag they hit, but don't recommend turning it off.
    const hit = candidates.filter(looksGuilty(opts)).sort(rank)[0] || null;
    return { alarm: true, kind: 'abuse', overall, candidates, suspect: hit, abuse };
  }

  const guilty = candidates.filter(guiltyBy(opts)).sort(rank)[0];
  if (guilty) return { alarm: true, kind: 'bug', overall, candidates, suspect: guilty };

  // No suspect yet. If some flag has both ON and OFF users but too few to judge, wait for more traffic
  // rather than wrongly reporting "no flag explains it". (A flag ON for 100% of users has no OFF group to wait for.)
  const needMoreData = candidates.some((c) =>
    (!c.enoughData && c.onTotal > 0 && c.offTotal > 0) ||
    (looksGuilty(opts)(c) && c.onAffectedUsers < opts.minAffectedUsers));
  if (needMoreData) return { alarm: true, waiting: true, overall, candidates, suspect: null };

  // Flags that are ON for everyone can't be judged by comparison: say so, so a human knows where to look.
  const unjudgeable = candidates.filter((c) => c.offTotal === 0 && c.onTotal > 0).map((c) => c.flag);
  return { alarm: true, kind: 'no_suspect', overall, candidates, suspect: null, unjudgeable };
}
