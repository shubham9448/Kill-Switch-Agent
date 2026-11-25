// Reads flag values for a user. Real mode: Flagsmith SDK with local evaluation.
// Local test mode: data/local-flags.json, so the code can be tried without an account.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Flagsmith } from '@flagsmith/nodejs';
import { config } from './config.js';

export const LOCAL_FLAGS_FILE = 'data/local-flags.json';
const DEFAULT_LOCAL_FLAGS = {
  // enabled = environment default. holdoutPercent = share of users kept on the old version (like a Flagsmith segment override).
  new_checkout: { enabled: true, holdoutPercent: 20 },
  new_search_banner: { enabled: true, holdoutPercent: 50 },
};

export function readLocalFlags() {
  if (!fs.existsSync(LOCAL_FLAGS_FILE)) {
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(LOCAL_FLAGS_FILE, JSON.stringify(DEFAULT_LOCAL_FLAGS, null, 2));
  }
  return JSON.parse(fs.readFileSync(LOCAL_FLAGS_FILE, 'utf8'));
}

export function writeLocalFlags(flags) {
  fs.writeFileSync(LOCAL_FLAGS_FILE, JSON.stringify(flags, null, 2));
}

// Same idea as Flagsmith's % split: hash the user id into 0-99 so a user always lands in the same bucket.
function bucket(flagName, userId) {
  const h = crypto.createHash('md5').update(`${flagName}:${userId}`).digest();
  return h.readUInt32BE(0) % 100;
}

let client;
export function startFlags() {
  if (config.localTestMode) {
    readLocalFlags();
    console.log('[flags] LOCAL TEST MODE: reading data/local-flags.json (not Flagsmith)');
    return;
  }
  if (!config.flagsmith.serverKey?.startsWith('ser.')) {
    throw new Error('FLAGSMITH_SERVER_KEY must be a server-side key starting with "ser." (or set LOCAL_TEST_MODE=true)');
  }
  client = new Flagsmith({
    environmentKey: config.flagsmith.serverKey,
    apiUrl: config.flagsmith.apiUrl,
    enableLocalEvaluation: true, // download the environment once, evaluate flags in memory: fast and no per-request API call
    environmentRefreshIntervalSeconds: config.flagsmith.refreshSeconds, // how quickly a kill reaches the app
    // If Flagsmith can't be reached, fail safe: treat new features as OFF.
    defaultFlagHandler: () => ({ enabled: false, value: null, isDefault: true }),
  });
  console.log(`[flags] Flagsmith SDK started (local evaluation, refresh every ${config.flagsmith.refreshSeconds}s)`);
}

// Returns { flagName: true/false } for every watched flag, as this user sees them.
// Local test mode can imitate Flagsmith's delivery delay (LOCAL_PROPAGATION_DELAY_SECONDS) to test the agent.
const localDelayMs = Number(process.env.LOCAL_PROPAGATION_DELAY_SECONDS || 0) * 1000;
const snapshots = [];
function delayedLocalFlags() {
  const now = Date.now();
  if (!snapshots.length || now - snapshots[snapshots.length - 1].t > 1000) snapshots.push({ t: now, flags: readLocalFlags() });
  while (snapshots.length > 1 && now - snapshots[1].t >= localDelayMs) snapshots.shift();
  return snapshots[0].flags;
}

export async function getUserFlags(userId) {
  const names = config.flagsmith.watchedFlags;
  if (config.localTestMode) {
    const all = localDelayMs ? delayedLocalFlags() : readLocalFlags();
    return Object.fromEntries(names.map((n) => {
      const f = all[n];
      if (!f) return [n, false];
      return [n, Boolean(f.enabled) && bucket(n, userId) >= (f.holdoutPercent || 0)];
    }));
  }
  const flags = await client.getIdentityFlags(userId);
  return Object.fromEntries(names.map((n) => [n, flags.isFeatureEnabled(n)]));
}
