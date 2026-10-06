// SQLite schema + seed. One file DB at ./data/crm.db
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const db = new Database(path.join(DATA_DIR, 'crm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
  languages TEXT DEFAULT '', method TEXT DEFAULT 'least_load', -- least_load | round_robin
  last_user_id INTEGER, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, phone TEXT,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'agent', -- admin | manager | agent
  team_id INTEGER REFERENCES teams(id), languages TEXT DEFAULT '',
  daily_capacity INTEGER DEFAULT 40, available INTEGER DEFAULT 1, active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), last_login TEXT
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  payment_id TEXT UNIQUE, advertiser_id TEXT,
  name TEXT, company TEXT, phone TEXT, alt_phone TEXT, email TEXT,
  city TEXT, district TEXT, state TEXT, language TEXT,
  package TEXT, amount REAL, paid_at TEXT,
  classified_id TEXT, classified_title TEXT, classified_url TEXT,
  source TEXT DEFAULT 'manual',
  stage TEXT DEFAULT 'new', -- new|contacted|docs_pending|classified_review|ready|onboarded|dropped
  pkg_explained INTEGER DEFAULT 0, docs_ok INTEGER DEFAULT 0,
  classified_status TEXT DEFAULT 'pending', -- pending|approved|needs_edit|rejected
  classified_note TEXT,
  assigned_to INTEGER REFERENCES users(id), team_id INTEGER REFERENCES teams(id), assigned_at TEXT,
  start_at TEXT,           -- TAT clock start = paid_at or ingest time
  first_call_at TEXT, first_connect_at TEXT, last_call_at TEXT,
  docs_verified_at TEXT, onboarded_at TEXT, dropped_at TEXT,
  next_followup_at TEXT, attempts INTEGER DEFAULT 0, last_disposition TEXT,
  priority INTEGER DEFAULT 0, raw TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_leads_assigned ON leads(assigned_to, stage);
CREATE INDEX IF NOT EXISTS ix_leads_phone ON leads(phone);
CREATE INDEX IF NOT EXISTS ix_leads_start ON leads(start_at);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL, file_name TEXT, file_path TEXT, url TEXT,
  status TEXT DEFAULT 'pending', reason TEXT,
  uploaded_by INTEGER, verified_by INTEGER, verified_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS dispositions (
  id INTEGER PRIMARY KEY, label TEXT NOT NULL,
  category TEXT NOT NULL, -- connected | not_connected
  marks_pkg_explained INTEGER DEFAULT 0, needs_followup INTEGER DEFAULT 0,
  auto_followup_min INTEGER DEFAULT 0, terminal INTEGER DEFAULT 0,
  sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY, lead_id INTEGER REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER, type TEXT NOT NULL, -- call|note|assign|doc|classified|stage|import|onboard
  disposition_id INTEGER, disposition TEXT, category TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now')), meta TEXT
);
CREATE INDEX IF NOT EXISTS ix_act_user ON activities(user_id, created_at);
CREATE INDEX IF NOT EXISTS ix_act_lead ON activities(lead_id);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY, name TEXT, priority INTEGER DEFAULT 10,
  field TEXT NOT NULL, op TEXT NOT NULL DEFAULT 'eq', -- eq|in|contains|gte|lte
  value TEXT NOT NULL, team_id INTEGER, user_id INTEGER, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL,
  mapping TEXT DEFAULT '{}', interval_min INTEGER DEFAULT 15, active INTEGER DEFAULT 1,
  last_run TEXT, last_status TEXT
);
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY, name TEXT, key TEXT UNIQUE, active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')), last_used TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

const defaults = {
  sla_first_call_min: '30',
  sla_onboard_hours: '24',
  required_docs: 'GST Certificate,PAN Card,Company ID Proof',
  doc_types: 'GST Certificate,PAN Card,Company ID Proof,Shop Establishment,Aadhaar (Owner),Other',
  packages: 'Basic,Premium,Premium Plus',
  max_attempts: '6',
  auto_reassign_min: '0', // 0 = off. Reassign if no first call within N min of assignment
};
const setDef = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
for (const [k, v] of Object.entries(defaults)) setDef.run(k, v);

if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const t = db.prepare('INSERT INTO teams(name,languages) VALUES (?,?)');
  t.run('Tamil', 'Tamil'); t.run('Telugu', 'Telugu'); t.run('Kannada', 'Kannada');
  t.run('Marathi / Hindi / Other', 'Marathi,Hindi,English,Malayalam');
  db.prepare(`INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)`)
    .run('Admin', process.env.ADMIN_EMAIL || 'admin@lokal.local',
      bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10), 'admin');
  const d = db.prepare(`INSERT INTO dispositions(label,category,marks_pkg_explained,needs_followup,auto_followup_min,terminal,sort) VALUES (?,?,?,?,?,?,?)`);
  [
    ['Package explained', 'connected', 1, 0, 0, 0, 1],
    ['Package explained – docs requested', 'connected', 1, 1, 240, 0, 2],
    ['Docs received on WhatsApp', 'connected', 0, 0, 0, 0, 3],
    ['Classified needs edit – informed', 'connected', 0, 1, 120, 0, 4],
    ['Callback requested', 'connected', 0, 1, 0, 0, 5],
    ['Language barrier – transfer', 'connected', 0, 1, 30, 0, 6],
    ['Not interested / refund asked', 'connected', 0, 0, 0, 1, 7],
    ['Ringing, no answer', 'not_connected', 0, 1, 120, 0, 10],
    ['Busy', 'not_connected', 0, 1, 60, 0, 11],
    ['Switched off / not reachable', 'not_connected', 0, 1, 180, 0, 12],
    ['Wrong / invalid number', 'not_connected', 0, 0, 0, 1, 13],
  ].forEach(r => d.run(...r));
}

const settings = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, r.value]));

module.exports = { db, settings, DATA_DIR };
