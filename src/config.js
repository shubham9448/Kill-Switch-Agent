// Loads settings from .env so every process (app, simulator, agent) shares one config.
import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export const config = {
  // LOCAL_TEST_MODE=true runs everything without Flagsmith or Slack (flags live in data/local-flags.json).
  // Use it only to try the code. The real demo must use Flagsmith.
  localTestMode: process.env.LOCAL_TEST_MODE === 'true',

  port: num(process.env.PORT, 3000),
  appUrl: process.env.APP_URL || `http://localhost:${num(process.env.PORT, 3000)}`,
  dbPath: process.env.DB_PATH || 'data/events.db',

  flagsmith: {
    // Server-side SDK key (starts with "ser."): the app uses it to READ flags with local evaluation.
    serverKey: process.env.FLAGSMITH_SERVER_KEY,
    // Environment key (the client-side ID of the environment): the Admin API uses it in URLs.
    environmentKey: process.env.FLAGSMITH_ENVIRONMENT_KEY,
    // Organisation Admin API key: lets the agent CHANGE flags. Keep it secret.
    adminApiKey: process.env.FLAGSMITH_ADMIN_API_KEY,
    projectId: process.env.FLAGSMITH_PROJECT_ID,
    apiUrl: (process.env.FLAGSMITH_API_URL || 'https://api.flagsmith.com/api/v1/').replace(/\/?$/, '/'),
    refreshSeconds: num(process.env.FLAGSMITH_REFRESH_SECONDS, 5),
    // Flags the app reports with every event. The agent can blame any of them.
    watchedFlags: list(process.env.WATCHED_FLAGS || 'new_checkout,new_search_banner'),
  },

  agent: {
    intervalSeconds: num(process.env.AGENT_INTERVAL_SECONDS, 10),
    windowSeconds: num(process.env.AGENT_WINDOW_SECONDS, 30),
    errorRateThreshold: num(process.env.ERROR_RATE_THRESHOLD, 0.05),
    minRequests: num(process.env.MIN_REQUESTS, 40),
    minRequestsPerGroup: num(process.env.MIN_REQUESTS_PER_GROUP, 20),
    blameRatio: num(process.env.BLAME_RATIO, 3),
    verifyAfterSeconds: num(process.env.VERIFY_AFTER_SECONDS, 30),
    snoozeMinutes: num(process.env.SNOOZE_MINUTES, 5),
  },

  slack: {
    botToken: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    channel: process.env.SLACK_CHANNEL_ID,
    approvers: list(process.env.SLACK_APPROVER_IDS),
  },

  // Backup approval buttons on the dashboard. Off when Slack is set up, so Slack (with its approver list) is the only way to approve.
  allowDashboardApproval:
    process.env.ALLOW_DASHBOARD_APPROVAL === 'true' ||
    !(process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN && process.env.SLACK_CHANNEL_ID),

  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.CLAUDE_MODEL || 'claude-haiku-5-5',
  },
};
