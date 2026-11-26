// Connects to Flagsmith's MCP server (hosted at https://mcp.flagsmith.com) so the investigator can look things up
// in Flagsmith itself. Only READ tools are handed to Claude. Tools that change flags are never exposed:
// changes happen only through our own code, after a human approves.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { config } from './config.js';

// Flagsmith MCP tools Claude may use. Everything else (create_*, update_*, delete_*, publish_*) stays hidden.
export const READ_ONLY_TOOLS = [
  'get_feature_flag',
  'list_project_features',
  'list_feature_segments',
  'list_project_segments',
  'get_project_segment',
  'get_feature_evaluation_data',
  'get_feature_health_events',
];
export const PREFIX = 'flagsmith_';

let client = null;
let tools = [];

export async function connectFlagsmithMcp() {
  const url = config.flagsmith.mcpUrl;
  if (!url || config.localTestMode || !config.flagsmith.adminApiKey) return [];
  try {
    const c = new Client({ name: 'kill-switch-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Api-Key ${config.flagsmith.adminApiKey}` } },
    });
    await Promise.race([c.connect(transport), new Promise((_, r) => setTimeout(() => r(new Error('timeout after 15s')), 15000))]);
    const listed = await c.listTools();
    tools = listed.tools.filter((t) => READ_ONLY_TOOLS.includes(t.name));
    client = c;
    console.log(`[mcp] Connected to Flagsmith MCP: ${tools.length} read-only tools available to the investigator (${tools.map((t) => t.name).join(', ')})`);
    return tools;
  } catch (err) {
    console.warn(`[mcp] Flagsmith MCP not available (${err.message}). The investigator will use the Admin API instead.`);
    client = null;
    tools = [];
    return [];
  }
}

export const mcpConnected = () => Boolean(client);

// Tool definitions in the shape the Claude API expects.
export function mcpToolsForClaude() {
  return tools.map((t) => ({
    name: PREFIX + t.name,
    description: `[Flagsmith MCP, read-only] ${t.description || t.name}`.slice(0, 1000),
    input_schema: t.inputSchema || { type: 'object', properties: {} },
  }));
}

export async function callMcpTool(prefixedName, input) {
  const name = prefixedName.slice(PREFIX.length);
  if (!client || !READ_ONLY_TOOLS.includes(name)) throw new Error(`Tool ${name} is not available`);
  const res = await client.callTool({ name, arguments: input || {} });
  const text = (res.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return text.length > 6000 ? `${text.slice(0, 6000)}\n…(truncated)` : text;
}
