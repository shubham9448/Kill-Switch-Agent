// npm run check : tests each connection one by one and says exactly what's wrong.
import { config } from './config.js';
import { Flagsmith } from '@flagsmith/nodejs';
import { findFeatureId, getFlagState } from './flagsmithAdmin.js';

const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);
const skip = (m) => console.log(`  SKIP  ${m}`);

console.log('\nKill Switch Agent: setup check\n');
if (config.localTestMode) console.log('  NOTE  LOCAL_TEST_MODE=true: the app will NOT use Flagsmith. Set it to false for the real demo.\n');

const f = config.flagsmith;
console.log('Flagsmith');
if (!f.serverKey?.startsWith('ser.')) bad('FLAGSMITH_SERVER_KEY missing or not a server-side key (must start with "ser.")');
else {
  try {
    const c = new Flagsmith({ environmentKey: f.serverKey, apiUrl: f.apiUrl });
    const flags = await c.getEnvironmentFlags();
    for (const name of f.watchedFlags) {
      try { flags.getFlag(name); ok(`SDK can read "${name}" (enabled=${flags.isFeatureEnabled(name)})`); }
      catch { bad(`SDK connected but flag "${name}" does not exist in this environment. Create it in Flagsmith.`); }
    }
  } catch (e) { bad(`SDK could not connect: ${e.message}`); }
}
if (!f.adminApiKey || !f.projectId || !f.environmentKey) bad('FLAGSMITH_ADMIN_API_KEY, FLAGSMITH_PROJECT_ID or FLAGSMITH_ENVIRONMENT_KEY missing');
else {
  for (const name of f.watchedFlags) {
    try {
      const id = await findFeatureId(name);
      const st = await getFlagState(name);
      ok(`Admin API sees "${name}" (id ${id}, default enabled=${st.enabled}, segment overrides=${st.segmentOverrides})`);
      if (st.segmentOverrides === 0) console.log(`        Tip: add a % split segment override (e.g. 20% OFF) so the agent can compare ON vs OFF users.`);
    } catch (e) { bad(`Admin API for "${name}": ${e.message}`); }
  }
}

console.log('\nSlack');
const s = config.slack;
if (!s.botToken || !s.appToken || !s.channel) skip('Not configured (alerts go to console, approve on dashboard)');
else {
  try {
    const r = await fetch('https://slack.com/api/auth.test', { method: 'POST', headers: { Authorization: `Bearer ${s.botToken}` } });
    const j = await r.json();
    j.ok ? ok(`Bot token works (bot: ${j.user}, workspace: ${j.team})`) : bad(`Bot token rejected: ${j.error}`);
    if (!s.appToken.startsWith('xapp-')) bad('SLACK_APP_TOKEN should start with "xapp-" (App-Level Token with connections:write)');
    else ok('App-level token format looks right');
  } catch (e) { bad(`Could not reach Slack: ${e.message}`); }
}

console.log('\nClaude');
if (!config.claude.apiKey) skip('No ANTHROPIC_API_KEY: plain template explanations will be used');
else {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const m = await new Anthropic({ apiKey: config.claude.apiKey }).messages.create({
      model: config.claude.model, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with OK' }] });
    ok(`Model ${config.claude.model} replied: ${m.content[0]?.text}`);
  } catch (e) { bad(`Claude call failed: ${e.message}`); }
}

console.log('\nInvestigator');
if (!config.claude.apiKey || !config.claude.investigator) skip('Off: alerts are raised from the numbers only');
else {
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    await new Anthropic({ apiKey: config.claude.apiKey }).messages.create({
      model: config.claude.investigatorModel, max_tokens: 10, messages: [{ role: 'user', content: 'Reply with OK' }] });
    ok(`Investigator model ${config.claude.investigatorModel} works`);
  } catch (e) { bad(`Investigator model ${config.claude.investigatorModel}: ${e.message} (set INVESTIGATOR_MODEL in .env)`); }
  if (!f.mcpUrl) skip('Flagsmith MCP turned off (FLAGSMITH_MCP_URL is empty): the investigator uses the Admin API');
  else {
    const { connectFlagsmithMcp, mcpToolsForClaude } = await import('./flagsmithMcp.js');
    await connectFlagsmithMcp();
    const t = mcpToolsForClaude();
    t.length ? ok(`Flagsmith MCP connected: ${t.length} read-only tools (${t.map((x) => x.name.replace('flagsmith_', '')).join(', ')})`)
      : bad('Flagsmith MCP did not connect; the investigator will use the Admin API instead (still works)');
  }
}
console.log('');
process.exit(0);
