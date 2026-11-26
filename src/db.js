// SQLite store shared by the app (writes events) and the agent (reads events, tracks incidents).
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL'); // lets the app write while the agent reads
db.pragma('busy_timeout = 3000');

db.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,          -- epoch ms
  user_id TEXT NOT NULL,
  route TEXT NOT NULL,
  ok INTEGER NOT NULL,          -- 1 success, 0 error
  latency_ms INTEGER NOT NULL,
  flags TEXT NOT NULL           -- JSON {"new_checkout": true, ...} as this user saw them
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at INTEGER NOT NULL,
  flag TEXT,                    -- suspect flag, NULL if no clear cause
  status TEXT NOT NULL,         -- waiting_approval | approved | ignored | disabled | recovered | not_recovered | no_suspect | failed
  stats TEXT NOT NULL,          -- JSON of the numbers behind the decision
  explanation TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  disabled_at INTEGER,
  closed_at INTEGER,
  slack_ts TEXT
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);

-- Flag changes the agent saw in Flagsmith (it snapshots flag states every 30s).
CREATE TABLE IF NOT EXISTS flag_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  flag TEXT NOT NULL,
  enabled INTEGER,
  segment_overrides INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  incident_id INTEGER,
  step TEXT NOT NULL,
  detail TEXT
);
`);

// Added after the first version: when the OFF state actually reached the app.
for (const sql of [
  'ALTER TABLE incidents ADD COLUMN propagated_at INTEGER', // when the OFF state actually reached the app
  "ALTER TABLE incidents ADD COLUMN kind TEXT DEFAULT 'bug'", // bug | abuse | no_suspect
  'ALTER TABLE events ADD COLUMN status INTEGER',           // HTTP status: only 5xx counts as an error
  'ALTER TABLE events ADD COLUMN source TEXT',              // client IP
  'ALTER TABLE events ADD COLUMN error TEXT',               // error message, for the investigator
  'ALTER TABLE incidents ADD COLUMN trace TEXT',            // the investigator's steps (JSON)
  'ALTER TABLE incidents ADD COLUMN confidence TEXT',       // high | medium | low
  'ALTER TABLE incidents ADD COLUMN decided_by_agent TEXT', // 'claude' or 'maths' (fallback)
]) { try { db.exec(sql); } catch { /* column already there */ } }

// Requests the agent should judge: successes and server errors. Rejected input (4xx) is the caller's fault, not a bug.
export const JUDGED = '(status IS NULL OR status < 400 OR status >= 500)';

export function audit(incidentId, step, detail = '') {
  db.prepare('INSERT INTO audit_log (ts, incident_id, step, detail) VALUES (?, ?, ?, ?)')
    .run(Date.now(), incidentId, step, typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log(`[audit] #${incidentId ?? '-'} ${step} ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}

export const setKv = (k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
export const getKv = (k) => db.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v;
