// The agent's write access to Flagsmith: find a feature and switch it off for the whole environment.
// Uses the Admin API with an Organisation API key ("Authorization: Api-Key ...").
import { config } from './config.js';
import { readLocalFlags, writeLocalFlags } from './flags.js';

const fs = config.flagsmith;

async function call(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Api-Key ${fs.adminApiKey}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// API root without the version, e.g. https://api.flagsmith.com/api/
const apiRoot = () => fs.apiUrl.replace(/v1\/$/, '');

const featureIds = new Map(); // feature ids never change, so look each up once
export async function findFeatureId(name) {
  if (featureIds.has(name)) return featureIds.get(name);
  const data = await call('GET', `${fs.apiUrl}projects/${fs.projectId}/features/?search=${encodeURIComponent(name)}`);
  const match = (data.results || []).find((f) => f.name === name);
  if (!match) throw new Error(`Feature "${name}" not found in project ${fs.projectId}`);
  featureIds.set(name, match.id);
  return match.id;
}

export async function getFlagState(name) {
  if (config.localTestMode) return { enabled: Boolean(readLocalFlags()[name]?.enabled) };
  const id = await findFeatureId(name);
  const data = await call('GET', `${apiRoot()}__future__/environments/${fs.environmentKey}/features/${id}/`);
  return { enabled: data.environment_default?.enabled, segmentOverrides: data.segment_overrides?.length || 0 };
}

// Sets the flag ON/OFF for everyone in the environment (environment default).
// Tries the current endpoint first, then the older v1 feature-states endpoint.
async function setEnabled(name, enabled) {
  if (config.localTestMode) {
    const all = readLocalFlags();
    all[name] = { ...(all[name] || {}), enabled };
    writeLocalFlags(all);
    return { method: 'local-file' };
  }
  const id = await findFeatureId(name);
  try {
    await call('PATCH', `${apiRoot()}__future__/environments/${fs.environmentKey}/features/${id}/`, {
      environment_default: { enabled },
    });
    return { method: 'Admin API (environment feature PATCH)', featureId: id };
  } catch (err) {
    console.warn('[flagsmith] __future__ endpoint failed, trying v1 featurestates:', err.message);
    const list = await call('GET', `${fs.apiUrl}environments/${fs.environmentKey}/featurestates/?feature=${id}`);
    const state = (list.results || []).find((s) => !s.feature_segment && !s.identity);
    if (!state) throw new Error(`No environment feature state found for "${name}"`);
    await call('PATCH', `${fs.apiUrl}environments/${fs.environmentKey}/featurestates/${state.id}/`, { enabled });
    return { method: 'Admin API (v1 featurestates PATCH)', featureId: id };
  }
}

// The kill switch: turns the flag off for everyone in the environment.
export const disableFlag = (name) => setEnabled(name, false);

// Used by the demo reset: switch the flag back on.
export async function enableFlag(name) {
  return setEnabled(name, true);
}
