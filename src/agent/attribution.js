// Pure maths, no AI: is something wrong, and which flag explains it?
// For each flag, split recent requests into users who had it ON vs OFF and compare error rates.
// A flag is the suspect when ON users fail much more often than OFF users, with enough data on both sides.

export function analyse(events, opts) {
  const total = events.length;
  const errors = events.filter((e) => !e.ok).length;
  const overall = { total, errors, rate: total ? errors / total : 0 };

  if (total < opts.minRequests || overall.rate < opts.errorRateThreshold) {
    return { alarm: false, overall };
  }

  const perFlag = {};
  for (const e of events) {
    for (const [flag, on] of Object.entries(e.flags)) {
      perFlag[flag] ??= { on: { total: 0, errors: 0 }, off: { total: 0, errors: 0 } };
      const side = on ? perFlag[flag].on : perFlag[flag].off;
      side.total++;
      if (!e.ok) side.errors++;
    }
  }

  const candidates = Object.entries(perFlag).map(([flag, s]) => {
    const onRate = s.on.total ? s.on.errors / s.on.total : 0;
    const offRate = s.off.total ? s.off.errors / s.off.total : 0;
    // Floor the OFF rate at 0.5% so a perfect OFF group doesn't give an infinite ratio.
    const ratio = onRate / Math.max(offRate, 0.005);
    // Share of all errors that came from users with the flag ON.
    const errorShare = errors ? s.on.errors / errors : 0;
    const enoughData = s.on.total >= opts.minRequestsPerGroup && s.off.total >= opts.minRequestsPerGroup;
    return { flag, onTotal: s.on.total, onErrors: s.on.errors, offTotal: s.off.total, offErrors: s.off.errors,
             onRate, offRate, ratio, errorShare, enoughData };
  });

  const guilty = candidates
    .filter((c) => c.enoughData && c.ratio >= opts.blameRatio && c.onRate >= opts.errorRateThreshold)
    .sort((a, b) => b.ratio * b.errorShare - a.ratio * a.errorShare);

  if (guilty[0]) return { alarm: true, overall, candidates, suspect: guilty[0] };

  // No suspect yet. If some flag has both ON and OFF users but too few to judge, wait for more traffic
  // rather than wrongly reporting "no flag explains it". (A flag ON for 100% of users has no OFF group to wait for.)
  const needMoreData = candidates.some((c) => !c.enoughData && c.onTotal > 0 && c.offTotal > 0);
  if (needMoreData) return { alarm: true, waiting: true, overall, candidates, suspect: null };

  // Flags that are ON for everyone can't be judged by comparison: say so, so a human knows where to look.
  const unjudgeable = candidates.filter((c) => c.offTotal === 0 && c.onTotal > 0).map((c) => c.flag);
  return { alarm: true, overall, candidates, suspect: null, unjudgeable };
}
