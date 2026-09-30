// Lokal Onboarding CRM — backend
require('fs').existsSync(__dirname + '/.env') && require('fs').readFileSync(__dirname + '/.env', 'utf8')
  .split('\n').forEach(l => { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; });

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const cron = require('node-cron');
const crypto = require('crypto');
const path = require('path');
const { parse: parseCSV } = require('csv-parse/sync');
const { db, settings, DATA_DIR } = require('./db');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.JWT_SECRET || 'change-me-' + require('os').hostname();
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ dest: path.join(DATA_DIR, 'uploads'), limits: { fileSize: 10 * 1024 * 1024 } });

const now = () => new Date().toISOString();
const q = (sql, ...p) => db.prepare(sql).all(...p);
const q1 = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const IST = "'+330 minutes'";
const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const wrap = fn => (req, res) => { try { const r = fn(req, res); if (r !== undefined) res.json(r); } catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.message }); } };
const fail = (status, msg) => { const e = new Error(msg); e.status = status; throw e; };
const log = (lead_id, user_id, type, extra = {}) =>
  run(`INSERT INTO activities(lead_id,user_id,type,disposition_id,disposition,category,note,meta,created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    lead_id, user_id, type, extra.disposition_id || null, extra.disposition || null, extra.category || null,
    extra.note || null, extra.meta ? JSON.stringify(extra.meta) : null, now());

// ---------- auth ----------
function auth(...roles) {
  return (req, res, next) => {
    try {
      const p = jwt.verify(req.cookies.tok || '', SECRET);
      const u = q1('SELECT id,name,email,role,team_id,available,active FROM users WHERE id=?', p.id);
      if (!u || !u.active) throw new Error();
      if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'You do not have access to this.' });
      req.user = u; next();
    } catch { res.status(401).json({ error: 'Log in to continue.' }); }
  };
}
app.post('/api/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const u = q1('SELECT * FROM users WHERE lower(email)=lower(?) AND active=1', email || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash)) fail(401, 'Email or password is wrong.');
  run('UPDATE users SET last_login=? WHERE id=?', now(), u.id);
  res.cookie('tok', jwt.sign({ id: u.id }, SECRET, { expiresIn: '12h' }), { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600e3 });
  return { id: u.id, name: u.name, role: u.role };
}));
app.post('/api/logout', (req, res) => { res.clearCookie('tok'); res.json({ ok: true }); });
app.get('/api/me', auth(), wrap(req => ({ ...req.user, settings: settings() })));
app.post('/api/me/password', auth(), wrap(req => {
  const u = q1('SELECT * FROM users WHERE id=?', req.user.id);
  if (!bcrypt.compareSync(req.body.current || '', u.password_hash)) fail(400, 'Current password is wrong.');
  if ((req.body.next || '').length < 6) fail(400, 'Use at least 6 characters.');
  run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(req.body.next, 10), u.id);
  return { ok: true };
}));
app.post('/api/me/available', auth(), wrap(req => {
  run('UPDATE users SET available=? WHERE id=?', req.body.available ? 1 : 0, req.user.id);
  if (req.body.available) assignQueue();
  return { ok: true };
}));

// Which leads a user can see
function scope(user, alias = 'l') {
  if (user.role === 'admin') return ['1=1', []];
  if (user.role === 'manager') return user.team_id ? [`${alias}.team_id=?`, [user.team_id]] : ['1=1', []];
  return [`${alias}.assigned_to=?`, [user.id]];
}
function getLead(user, id) {
  const [w, p] = scope(user);
  const l = q1(`SELECT l.* FROM leads l WHERE l.id=? AND ${w}`, id, ...p);
  if (!l) fail(404, 'Lead not found or not assigned to you.');
  return l;
}

// ---------- stage logic ----------
function recompute(id) {
  const l = q1('SELECT * FROM leads WHERE id=?', id);
  const req = settings().required_docs.split(',').map(s => s.trim()).filter(Boolean);
  const verified = new Set(q(`SELECT doc_type FROM documents WHERE lead_id=? AND status='verified'`, id).map(r => r.doc_type));
  const docs_ok = req.every(t => verified.has(t)) ? 1 : 0;
  let stage;
  if (l.onboarded_at) stage = 'onboarded';
  else if (l.dropped_at) stage = 'dropped';
  else if (!l.first_connect_at) stage = 'new';
  else if (!l.pkg_explained) stage = 'contacted';
  else if (!docs_ok) stage = 'docs_pending';
  else if (l.classified_status !== 'approved') stage = 'classified_review';
  else stage = 'ready';
  run(`UPDATE leads SET docs_ok=?, stage=?, docs_verified_at=CASE WHEN ?=1 THEN coalesce(docs_verified_at,?) ELSE NULL END, updated_at=? WHERE id=?`,
    docs_ok, stage, docs_ok, now(), now(), id);
  if (stage !== l.stage) log(id, null, 'stage', { note: `${l.stage} → ${stage}` });
}

// ---------- assignment engine ----------
const lc = s => String(s ?? '').trim().toLowerCase();
function ruleMatch(r, lead) {
  const v = lead[r.field]; const val = r.value;
  switch (r.op) {
    case 'eq': return lc(v) === lc(val);
    case 'in': return val.split(',').map(lc).includes(lc(v));
    case 'contains': return lc(v).includes(lc(val));
    case 'gte': return Number(v) >= Number(val);
    case 'lte': return Number(v) <= Number(val);
  }
  return false;
}
function pickAgent(teamId, lead, excludeId) {
  const team = q1('SELECT * FROM teams WHERE id=?', teamId);
  let agents = q(`SELECT u.*,
      (SELECT count(*) FROM leads WHERE assigned_to=u.id AND stage NOT IN ('onboarded','dropped')) open_cnt,
      (SELECT count(*) FROM leads WHERE assigned_to=u.id AND date(assigned_at,${IST})=?) today_cnt
    FROM users u WHERE u.team_id=? AND u.role='agent' AND u.active=1 AND u.available=1 AND u.id IS NOT ?`,
    todayIST(), teamId, excludeId ?? null).filter(a => a.today_cnt < a.daily_capacity);
  if (!agents.length) return null;
  const skilled = agents.filter(a => a.languages && a.languages.split(',').map(lc).includes(lc(lead.language)));
  if (skilled.length) agents = skilled;
  if (team.method === 'round_robin') {
    agents.sort((a, b) => a.id - b.id);
    const next = agents.find(a => a.id > (team.last_user_id || 0)) || agents[0];
    run('UPDATE teams SET last_user_id=? WHERE id=?', next.id, teamId);
    return next;
  }
  agents.sort((a, b) => a.open_cnt - b.open_cnt || a.today_cnt - b.today_cnt || a.id - b.id);
  return agents[0];
}
function autoAssign(leadId, opts = {}) {
  const lead = q1('SELECT * FROM leads WHERE id=?', leadId);
  let teamId = opts.keepTeam ? lead.team_id : null, userId = null, why = 'default';
  if (!teamId) {
    for (const r of q('SELECT * FROM rules WHERE active=1 ORDER BY priority, id')) {
      if (ruleMatch(r, lead)) { teamId = r.team_id; userId = r.user_id; why = `rule: ${r.name || r.field}`; break; }
    }
  }
  if (userId) {
    const u = q1('SELECT * FROM users WHERE id=? AND active=1', userId);
    if (!u) userId = null; else teamId = u.team_id;
  }
  if (!teamId) {
    const t = q('SELECT * FROM teams WHERE active=1').find(t => t.languages.split(',').map(lc).includes(lc(lead.language)));
    teamId = t ? t.id : q1(`SELECT id FROM teams WHERE active=1 AND lower(name) LIKE '%other%'`)?.id || null;
    why = t ? `language: ${lead.language}` : 'fallback team';
  }
  if (!userId && teamId) userId = pickAgent(teamId, lead, opts.exclude)?.id || null;
  run('UPDATE leads SET team_id=?, assigned_to=?, assigned_at=?, updated_at=? WHERE id=?',
    teamId, userId, userId ? now() : null, now(), leadId);
  log(leadId, opts.by || null, 'assign', { note: userId ? `Auto-assigned (${why})` : `Queued in team, no agent free (${why})`, meta: { teamId, userId } });
  return userId;
}
function assignQueue() {
  const ids = q(`SELECT id FROM leads WHERE assigned_to IS NULL AND stage NOT IN ('onboarded','dropped') ORDER BY start_at LIMIT 500`);
  let n = 0; for (const { id } of ids) if (autoAssign(id, { keepTeam: true })) n++;
  return n;
}

// ---------- ingest (API, sheet, CSV) ----------
const ALIASES = {
  payment_id: ['payment_id', 'order_id', 'transaction_id', 'txn_id', 'razorpay_payment_id'],
  advertiser_id: ['advertiser_id', 'adv_id', 'user_id'],
  name: ['name', 'advertiser_name', 'contact_name', 'customer_name'],
  company: ['company', 'company_name', 'business_name'],
  phone: ['phone', 'mobile', 'mobile_number', 'adv_mobile_no', 'contact_no', 'phone_number'],
  alt_phone: ['alt_phone', 'alternate_number', 'whatsapp'],
  email: ['email', 'email_id'],
  city: ['city', 'town'], district: ['district'], state: ['state'],
  language: ['language', 'locale', 'lang'],
  package: ['package', 'plan', 'package_name', 'plan_name'],
  amount: ['amount', 'paid_amount', 'deal_amount', 'price'],
  paid_at: ['paid_at', 'payment_date', 'payment_time', 'date', 'created_at'],
  classified_id: ['classified_id', 'job_id', 'post_id', 'sub_id'],
  classified_title: ['classified_title', 'job_title', 'title'],
  classified_url: ['classified_url', 'job_url', 'post_url', 'link'],
};
const LOCALES = { ta: 'Tamil', te: 'Telugu', kn: 'Kannada', mr: 'Marathi', hi: 'Hindi', ml: 'Malayalam', en: 'English' };
const normPhone = p => { const d = String(p || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };
function toISO(v) {
  if (!v) return null;
  if (/^\d{12,13}$/.test(String(v))) return new Date(Number(v)).toISOString();
  let s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(.*)$/); // dd/mm/yyyy [time] — assumed IST
  if (m) s = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}${m[4] ? 'T' + m[4].trim() : 'T00:00:00'}+05:30`;
  else if (/^\d{4}-\d{2}-\d{2}( |T)\d{1,2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + '+05:30';
  const d = new Date(s); return isNaN(d) ? null : d.toISOString();
}
function normalize(row, mapping = {}) {
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [lc(k).replace(/\s+/g, '_'), v]));
  const out = {};
  for (const [f, al] of Object.entries(ALIASES)) {
    const src = mapping[f] ? lc(mapping[f]).replace(/\s+/g, '_') : al.find(a => lower[a] !== undefined && lower[a] !== '');
    if (src && lower[src] !== undefined && lower[src] !== '') out[f] = String(lower[src]).trim();
  }
  out.phone = normPhone(out.phone);
  if (out.alt_phone) out.alt_phone = normPhone(out.alt_phone);
  if (out.language && LOCALES[lc(out.language).slice(0, 2)] && out.language.length <= 5) out.language = LOCALES[lc(out.language).slice(0, 2)];
  if (out.amount) out.amount = Number(String(out.amount).replace(/[^\d.]/g, '')) || null;
  out.paid_at = toISO(out.paid_at);
  return out;
}
function upsertLead(row, source, mapping) {
  const d = normalize(row, mapping);
  if (!d.phone || d.phone.length < 10) return { status: 'skipped', reason: 'no valid phone' };
  let ex = null;
  if (d.payment_id) ex = q1('SELECT * FROM leads WHERE payment_id=?', d.payment_id);
  if (!ex && d.classified_id) ex = q1('SELECT * FROM leads WHERE phone=? AND classified_id=?', d.phone, d.classified_id);
  if (!ex && !d.payment_id) ex = q1(`SELECT * FROM leads WHERE phone=? AND stage NOT IN ('onboarded','dropped') ORDER BY id DESC`, d.phone);
  if (ex) { // fill blanks only, never overwrite work done in the CRM
    const sets = Object.keys(d).filter(k => d[k] != null && (ex[k] == null || ex[k] === ''));
    if (sets.length) run(`UPDATE leads SET ${sets.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`, ...sets.map(k => d[k]), now(), ex.id);
    return { status: sets.length ? 'updated' : 'duplicate', id: ex.id };
  }
  const cols = Object.keys(d).filter(k => d[k] != null);
  const info = run(`INSERT INTO leads(${cols.join(',')},source,start_at,raw,created_at,updated_at) VALUES (${cols.map(() => '?').join(',')},?,?,?,?,?)`,
    ...cols.map(k => d[k]), source, d.paid_at || now(), JSON.stringify(row), now(), now());
  const id = info.lastInsertRowid;
  log(id, null, 'import', { note: `Created from ${source}` });
  autoAssign(id);
  return { status: 'created', id };
}
function ingestMany(rows, source, mapping) {
  const res = { created: 0, updated: 0, duplicate: 0, skipped: 0, errors: [] };
  db.transaction(() => rows.forEach((r, i) => {
    try { const o = upsertLead(r, source, mapping); res[o.status]++; if (o.status === 'skipped') res.errors.push({ row: i + 1, reason: o.reason }); }
    catch (e) { res.skipped++; res.errors.push({ row: i + 1, reason: e.message }); }
  }))();
  res.errors = res.errors.slice(0, 50);
  return res;
}
function rowsFromPayload(text, ctype = '') {
  const t = text.trim();
  if (ctype.includes('json') || t.startsWith('[') || t.startsWith('{')) {
    let j = JSON.parse(t);
    if (!Array.isArray(j)) j = j.data || j.rows || j.leads || j.values || [j];
    if (Array.isArray(j[0])) { const [h, ...rest] = j; return rest.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); }
    return j;
  }
  return parseCSV(t, { columns: true, skip_empty_lines: true, trim: true, bom: true });
}
function sheetURL(u) {
  const m = u.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (!m || u.includes('/export') || u.includes('output=csv')) return u;
  const gid = (u.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
async function runSource(src) {
  try {
    const r = await fetch(sheetURL(src.url), { redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const rows = rowsFromPayload(await r.text(), r.headers.get('content-type') || '');
    const res = ingestMany(rows, src.name, JSON.parse(src.mapping || '{}'));
    const msg = `ok: ${rows.length} rows · ${res.created} new · ${res.updated} updated · ${res.duplicate} dup · ${res.skipped} skipped`;
    run('UPDATE sources SET last_run=?, last_status=? WHERE id=?', now(), msg, src.id);
    return res;
  } catch (e) {
    run('UPDATE sources SET last_run=?, last_status=? WHERE id=?', now(), 'error: ' + e.message, src.id);
    throw e;
  }
}

// Public ingest endpoint for curl / Apps Script / payment webhook
app.post('/api/v1/leads', wrap(req => {
  const key = req.get('x-api-key') || req.query.key;
  const k = key && q1('SELECT * FROM api_keys WHERE key=? AND active=1', key);
  if (!k) fail(401, 'Invalid API key');
  run('UPDATE api_keys SET last_used=? WHERE id=?', now(), k.id);
  const rows = Array.isArray(req.body) ? req.body : (req.body.leads || req.body.data || [req.body]);
  return ingestMany(rows, `api:${k.name}`, {});
}));

// ---------- leads ----------
const SORTS = { queue: `CASE WHEN l.next_followup_at<=? THEN 0 WHEN l.first_call_at IS NULL THEN 1 ELSE 2 END, coalesce(l.next_followup_at,l.start_at)`, newest: 'l.start_at DESC', oldest: 'l.start_at' };
function leadFilter(req) {
  const [w, p] = scope(req.user); const where = [w], params = [...p]; const f = req.query;
  if (f.stage === 'open') where.push(`l.stage NOT IN ('onboarded','dropped')`);
  else if (f.stage) { where.push('l.stage=?'); params.push(f.stage); }
  if (f.agent) { if (f.agent === 'none') where.push('l.assigned_to IS NULL'); else { where.push('l.assigned_to=?'); params.push(f.agent); } }
  if (f.team) { where.push('l.team_id=?'); params.push(f.team); }
  if (f.language) { where.push('l.language=?'); params.push(f.language); }
  if (f.from) { where.push(`date(l.start_at,${IST})>=?`); params.push(f.from); }
  if (f.to) { where.push(`date(l.start_at,${IST})<=?`); params.push(f.to); }
  if (f.followup === 'due') { where.push(`l.next_followup_at<=? AND l.stage NOT IN ('onboarded','dropped')`); params.push(now()); }
  if (f.followup === 'today') { where.push(`date(l.next_followup_at,${IST})=?`); params.push(todayIST()); }
  if (f.sla === 'breach') { where.push(`l.first_call_at IS NULL AND l.stage='new' AND (julianday('now')-julianday(l.start_at))*1440 > ?`); params.push(+settings().sla_first_call_min); }
  if (f.q) { where.push(`(l.phone LIKE ? OR l.name LIKE ? OR l.company LIKE ? OR l.payment_id LIKE ? OR l.classified_id LIKE ?)`); params.push(...Array(5).fill(`%${f.q}%`)); }
  return [where.join(' AND '), params];
}
const LEAD_COLS = `l.*, u.name agent_name, t.name team_name`;
const LEAD_JOIN = `FROM leads l LEFT JOIN users u ON u.id=l.assigned_to LEFT JOIN teams t ON t.id=l.team_id`;
app.get('/api/leads', auth(), wrap(req => {
  const [w, p] = leadFilter(req);
  const sort = SORTS[req.query.sort] || SORTS.queue;
  const sp = sort === SORTS.queue ? [now()] : [];
  const limit = Math.min(+req.query.limit || 100, 1000), offset = +req.query.offset || 0;
  const rows = q(`SELECT ${LEAD_COLS} ${LEAD_JOIN} WHERE ${w} ORDER BY ${sort} LIMIT ? OFFSET ?`, ...p, ...sp, limit, offset);
  const total = q1(`SELECT count(*) c ${LEAD_JOIN} WHERE ${w}`, ...p).c;
  return { rows, total };
}));
app.post('/api/leads', auth(), wrap(req => upsertLead(req.body, `manual:${req.user.name}`, {})));
app.post('/api/leads/import', auth('admin', 'manager'), upload.single('file'), wrap(req => {
  const text = require('fs').readFileSync(req.file.path, 'utf8'); require('fs').unlinkSync(req.file.path);
  return ingestMany(rowsFromPayload(text), `csv:${req.file.originalname}`, {});
}));
app.get('/api/leads/:id', auth(), wrap(req => {
  getLead(req.user, req.params.id);
  const lead = q1(`SELECT ${LEAD_COLS} ${LEAD_JOIN} WHERE l.id=?`, req.params.id);
  const docs = q(`SELECT d.*, v.name verified_by_name FROM documents d LEFT JOIN users v ON v.id=d.verified_by WHERE lead_id=? ORDER BY d.id DESC`, req.params.id);
  const acts = q(`SELECT a.*, u.name user_name FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE lead_id=? ORDER BY a.id DESC`, req.params.id);
  const others = q(`SELECT id, payment_id, package, stage, start_at FROM leads WHERE phone=? AND id<>?`, lead.phone, lead.id);
  return { lead, docs, acts, others };
}));
app.patch('/api/leads/:id', auth(), wrap(req => {
  getLead(req.user, req.params.id);
  const ok = ['name', 'company', 'alt_phone', 'email', 'city', 'district', 'state', 'language', 'package', 'amount', 'classified_id', 'classified_title', 'classified_url', 'priority'];
  const keys = Object.keys(req.body).filter(k => ok.includes(k));
  if (keys.length) run(`UPDATE leads SET ${keys.map(k => k + '=?').join(',')}, updated_at=? WHERE id=?`, ...keys.map(k => req.body[k]), now(), req.params.id);
  log(req.params.id, req.user.id, 'note', { note: `Edited: ${keys.join(', ')}` });
  return { ok: true };
}));
app.post('/api/leads/:id/call', auth(), wrap(req => {
  const l = getLead(req.user, req.params.id);
  const d = q1('SELECT * FROM dispositions WHERE id=?', req.body.disposition_id);
  if (!d) fail(400, 'Pick a disposition.');
  const t = now(), connected = d.category === 'connected';
  let follow = req.body.followup_at ? toISO(req.body.followup_at) || new Date(req.body.followup_at).toISOString() : null;
  if (!follow && d.auto_followup_min) follow = new Date(Date.now() + d.auto_followup_min * 60000).toISOString();
  if (d.needs_followup && !follow) fail(400, 'This disposition needs a follow-up time.');
  const attempts = l.attempts + 1;
  let note = req.body.note || null;
  if (!connected && attempts >= +settings().max_attempts && !d.terminal) { follow = null; note = (note ? note + ' · ' : '') + 'Max attempts reached, needs manager review'; }
  run(`UPDATE leads SET attempts=?, last_call_at=?, first_call_at=coalesce(first_call_at,?),
      first_connect_at=CASE WHEN ? THEN coalesce(first_connect_at,?) ELSE first_connect_at END,
      pkg_explained=CASE WHEN ? THEN 1 ELSE pkg_explained END, last_disposition=?, next_followup_at=?,
      dropped_at=CASE WHEN ? THEN ? ELSE dropped_at END, updated_at=? WHERE id=?`,
    attempts, t, t, connected ? 1 : 0, t, d.marks_pkg_explained, d.label, d.terminal ? null : follow, d.terminal, t, t, l.id);
  log(l.id, req.user.id, 'call', { disposition_id: d.id, disposition: d.label, category: d.category, note, meta: { followup: follow } });
  recompute(l.id); return { ok: true };
}));
app.post('/api/leads/:id/note', auth(), wrap(req => { getLead(req.user, req.params.id); log(req.params.id, req.user.id, 'note', { note: req.body.note }); return { ok: true }; }));
app.post('/api/leads/:id/checklist', auth(), wrap(req => {
  const l = getLead(req.user, req.params.id);
  run('UPDATE leads SET pkg_explained=?, updated_at=? WHERE id=?', req.body.pkg_explained ? 1 : 0, now(), l.id);
  log(l.id, req.user.id, 'note', { note: `Package explained: ${req.body.pkg_explained ? 'yes' : 'no'}` });
  recompute(l.id); return { ok: true };
}));
app.post('/api/leads/:id/classified', auth(), wrap(req => {
  const l = getLead(req.user, req.params.id);
  if (!['pending', 'approved', 'needs_edit', 'rejected'].includes(req.body.status)) fail(400, 'Unknown status');
  if (req.body.status !== 'approved' && req.body.status !== 'pending' && !req.body.note) fail(400, 'Add what needs to change.');
  run('UPDATE leads SET classified_status=?, classified_note=?, updated_at=? WHERE id=?', req.body.status, req.body.note || null, now(), l.id);
  log(l.id, req.user.id, 'classified', { note: `Classified ${req.body.status.replace('_', ' ')}${req.body.note ? ': ' + req.body.note : ''}` });
  recompute(l.id); return { ok: true };
}));
app.post('/api/leads/:id/onboard', auth(), wrap(req => {
  const l = getLead(req.user, req.params.id); recompute(l.id);
  const f = q1('SELECT * FROM leads WHERE id=?', l.id);
  if (f.stage !== 'ready' && !(req.body.override && req.user.role !== 'agent'))
    fail(400, 'Finish the checklist first: package explained, required documents verified, classified approved.');
  run(`UPDATE leads SET onboarded_at=?, next_followup_at=NULL, stage='onboarded', updated_at=? WHERE id=?`, now(), now(), l.id);
  log(l.id, req.user.id, 'onboard', { note: req.body.override ? 'Onboarded with manager override' : 'Onboarded' });
  return { ok: true };
}));
app.post('/api/leads/:id/reopen', auth('admin', 'manager'), wrap(req => {
  const l = getLead(req.user, req.params.id);
  run('UPDATE leads SET onboarded_at=NULL, dropped_at=NULL, updated_at=? WHERE id=?', now(), l.id);
  log(l.id, req.user.id, 'note', { note: 'Reopened' }); recompute(l.id); return { ok: true };
}));
app.post('/api/leads/assign', auth('admin', 'manager'), wrap(req => {
  const { ids = [], user_id, auto } = req.body; let n = 0;
  for (const id of ids) {
    getLead(req.user, id);
    if (auto) { autoAssign(id, { by: req.user.id }); n++; continue; }
    const u = q1('SELECT * FROM users WHERE id=? AND active=1', user_id); if (!u) fail(400, 'Pick an agent.');
    run('UPDATE leads SET assigned_to=?, team_id=coalesce(?,team_id), assigned_at=?, updated_at=? WHERE id=?', u.id, u.team_id, now(), now(), id);
    log(id, req.user.id, 'assign', { note: `Assigned to ${u.name} by ${req.user.name}` }); n++;
  }
  return { assigned: n };
}));
app.post('/api/assign-queue', auth('admin', 'manager'), wrap(() => ({ assigned: assignQueue() })));

// ---------- documents ----------
app.post('/api/leads/:id/docs', auth(), upload.single('file'), wrap(req => {
  const l = getLead(req.user, req.params.id);
  if (!req.body.doc_type) fail(400, 'Pick a document type.');
  if (!req.file && !req.body.url) fail(400, 'Attach a file or paste a link.');
  run(`INSERT INTO documents(lead_id,doc_type,file_name,file_path,url,uploaded_by,created_at) VALUES (?,?,?,?,?,?,?)`,
    l.id, req.body.doc_type, req.file?.originalname || null, req.file?.filename || null, req.body.url || null, req.user.id, now());
  log(l.id, req.user.id, 'doc', { note: `${req.body.doc_type} added` });
  recompute(l.id); return { ok: true };
}));
app.post('/api/docs/:id/verify', auth(), wrap(req => {
  const d = q1('SELECT * FROM documents WHERE id=?', req.params.id); if (!d) fail(404, 'Document not found');
  getLead(req.user, d.lead_id);
  if (!['verified', 'rejected', 'pending'].includes(req.body.status)) fail(400, 'Unknown status');
  if (req.body.status === 'rejected' && !req.body.reason) fail(400, 'Add a rejection reason the advertiser can act on.');
  run('UPDATE documents SET status=?, reason=?, verified_by=?, verified_at=? WHERE id=?', req.body.status, req.body.reason || null, req.user.id, now(), d.id);
  log(d.lead_id, req.user.id, 'doc', { note: `${d.doc_type} ${req.body.status}${req.body.reason ? ': ' + req.body.reason : ''}`, meta: { status: req.body.status } });
  recompute(d.lead_id); return { ok: true };
}));
app.get('/api/docs/:id/file', auth(), (req, res) => {
  try {
    const d = q1('SELECT * FROM documents WHERE id=?', req.params.id); getLead(req.user, d.lead_id);
    res.download(path.join(DATA_DIR, 'uploads', d.file_path), d.file_name);
  } catch { res.status(404).send('Not found'); }
});

// ---------- dashboard & reports ----------
app.get('/api/dashboard', auth(), wrap(req => {
  const [w, p] = scope(req.user); const s = settings(); const T = todayIST();
  const aw = req.user.role === 'agent' ? 'a.user_id=?' : req.user.role === 'manager' && req.user.team_id ? 'u.team_id=?' : '1=1';
  const ap = aw === '1=1' ? [] : [req.user.role === 'agent' ? req.user.id : req.user.team_id];
  const c = sql => q1(sql, ...p).c;
  return {
    new_today: q1(`SELECT count(*) c FROM leads l WHERE ${w} AND date(start_at,${IST})=?`, ...p, T).c,
    onboarded_today: q1(`SELECT count(*) c FROM leads l WHERE ${w} AND date(onboarded_at,${IST})=?`, ...p, T).c,
    open: c(`SELECT count(*) c FROM leads l WHERE ${w} AND stage NOT IN ('onboarded','dropped')`),
    untouched: c(`SELECT count(*) c FROM leads l WHERE ${w} AND stage='new' AND first_call_at IS NULL`),
    sla_breach: q1(`SELECT count(*) c FROM leads l WHERE ${w} AND first_call_at IS NULL AND stage='new' AND (julianday('now')-julianday(start_at))*1440 > ?`, ...p, +s.sla_first_call_min).c,
    followups_due: q1(`SELECT count(*) c FROM leads l WHERE ${w} AND next_followup_at<=? AND stage NOT IN ('onboarded','dropped')`, ...p, now()).c,
    unassigned: req.user.role === 'agent' ? null : c(`SELECT count(*) c FROM leads l WHERE ${w} AND assigned_to IS NULL AND stage NOT IN ('onboarded','dropped')`),
    calls_today: q1(`SELECT count(*) c FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.type='call' AND ${aw} AND date(a.created_at,${IST})=?`, ...ap, T).c,
    connected_today: q1(`SELECT count(*) c FROM activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.type='call' AND a.category='connected' AND ${aw} AND date(a.created_at,${IST})=?`, ...ap, T).c,
    tat_first_call_today: q1(`SELECT round(avg((julianday(first_call_at)-julianday(start_at))*1440),1) c FROM leads l WHERE ${w} AND date(first_call_at,${IST})=?`, ...p, T).c,
    stages: q(`SELECT stage, count(*) n FROM leads l WHERE ${w} GROUP BY stage`, ...p),
    aging: q(`SELECT CASE WHEN h<1 THEN '<1h' WHEN h<4 THEN '1–4h' WHEN h<24 THEN '4–24h' WHEN h<72 THEN '1–3d' ELSE '>3d' END b, count(*) n
      FROM (SELECT (julianday('now')-julianday(start_at))*24 h FROM leads l WHERE ${w} AND stage NOT IN ('onboarded','dropped')) GROUP BY b`, ...p),
  };
}));

function range(req) {
  const to = req.query.to || todayIST();
  const from = req.query.from || to;
  return [from, to];
}
function agentReport(req) {
  const [from, to] = range(req); const s = settings();
  const uw = req.user.role === 'agent' ? 'u.id=' + req.user.id : req.user.role === 'manager' && req.user.team_id ? 'u.team_id=' + req.user.team_id : '1=1';
  const D = (col) => `date(${col},${IST}) BETWEEN '${from}' AND '${to}'`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) fail(400, 'Bad date');
  return q(`SELECT u.id, u.name agent, t.name team,
    (SELECT count(*) FROM leads WHERE assigned_to=u.id AND ${D('assigned_at')}) assigned,
    (SELECT count(*) FROM activities WHERE user_id=u.id AND type='call' AND ${D('created_at')}) calls,
    (SELECT count(*) FROM activities WHERE user_id=u.id AND type='call' AND category='connected' AND ${D('created_at')}) connected,
    (SELECT count(DISTINCT lead_id) FROM activities WHERE user_id=u.id AND type='call' AND ${D('created_at')}) leads_called,
    (SELECT count(*) FROM activities WHERE user_id=u.id AND type='doc' AND meta LIKE '%"verified"%' AND ${D('created_at')}) docs_verified,
    (SELECT count(*) FROM leads WHERE assigned_to=u.id AND ${D('onboarded_at')}) onboarded,
    (SELECT count(*) FROM leads WHERE assigned_to=u.id AND dropped_at IS NOT NULL AND ${D('dropped_at')}) dropped,
    (SELECT round(avg((julianday(first_call_at)-julianday(start_at))*1440),1) FROM leads WHERE assigned_to=u.id AND ${D('first_call_at')}) tat_first_call_min,
    (SELECT round(avg((julianday(onboarded_at)-julianday(start_at))*24),1) FROM leads WHERE assigned_to=u.id AND ${D('onboarded_at')}) tat_onboard_hr,
    (SELECT count(*) FROM leads WHERE assigned_to=u.id AND ${D('start_at')} AND
       ((first_call_at IS NULL AND (julianday('now')-julianday(start_at))*1440 > ${+s.sla_first_call_min}) OR
        (julianday(first_call_at)-julianday(start_at))*1440 > ${+s.sla_first_call_min})) sla_breach_first_call,
    (SELECT count(*) FROM leads WHERE assigned_to=u.id AND onboarded_at IS NOT NULL AND ${D('onboarded_at')} AND
       (julianday(onboarded_at)-julianday(start_at))*24 <= ${+s.sla_onboard_hours}) onboarded_within_sla,
    (SELECT count(*) FROM leads WHERE assigned_to=u.id AND stage NOT IN ('onboarded','dropped')) open_now,
    (SELECT count(*) FROM leads WHERE assigned_to=u.id AND next_followup_at<='${now()}' AND stage NOT IN ('onboarded','dropped')) overdue_followups
    FROM users u LEFT JOIN teams t ON t.id=u.team_id WHERE u.role='agent' AND u.active=1 AND ${uw} ORDER BY t.name, u.name`);
}
app.get('/api/reports/agents', auth(), wrap(req => agentReport(req)));
app.get('/api/reports/trend', auth(), wrap(req => {
  const [from, to] = range(req); const [w, p] = scope(req.user);
  const g = { daily: '%Y-%m-%d', weekly: '%Y-W%W', monthly: '%Y-%m' }[req.query.period] || '%Y-%m-%d';
  const B = col => `strftime('${g}', ${col}, ${IST})`;
  const within = col => `date(${col},${IST}) BETWEEN ? AND ?`;
  const m = {};
  const add = (rows, k) => rows.forEach(r => { m[r.b] = m[r.b] || { bucket: r.b }; m[r.b][k] = r.v; });
  add(q(`SELECT ${B('start_at')} b, count(*) v FROM leads l WHERE ${w} AND ${within('start_at')} GROUP BY b`, ...p, from, to), 'new_leads');
  add(q(`SELECT ${B('first_call_at')} b, round(avg((julianday(first_call_at)-julianday(start_at))*1440),1) v FROM leads l WHERE ${w} AND ${within('first_call_at')} GROUP BY b`, ...p, from, to), 'tat_first_call_min');
  add(q(`SELECT ${B('onboarded_at')} b, count(*) v FROM leads l WHERE ${w} AND ${within('onboarded_at')} GROUP BY b`, ...p, from, to), 'onboarded');
  add(q(`SELECT ${B('onboarded_at')} b, round(avg((julianday(onboarded_at)-julianday(start_at))*24),1) v FROM leads l WHERE ${w} AND ${within('onboarded_at')} GROUP BY b`, ...p, from, to), 'tat_onboard_hr');
  add(q(`SELECT ${B('a.created_at')} b, count(*) v FROM activities a JOIN leads l ON l.id=a.lead_id WHERE a.type='call' AND ${w} AND ${within('a.created_at')} GROUP BY b`, ...p, from, to), 'calls');
  return Object.values(m).sort((a, b) => a.bucket.localeCompare(b.bucket));
}));
app.get('/api/reports/dispositions', auth(), wrap(req => {
  const [from, to] = range(req);
  const uw = req.user.role === 'agent' ? 'u.id=' + req.user.id : req.user.role === 'manager' && req.user.team_id ? 'u.team_id=' + req.user.team_id : '1=1';
  return q(`SELECT u.name agent, a.disposition, count(*) n FROM activities a JOIN users u ON u.id=a.user_id
    WHERE a.type='call' AND ${uw} AND date(a.created_at,${IST}) BETWEEN ? AND ? GROUP BY u.name, a.disposition ORDER BY u.name`, from, to);
}));
app.get('/api/reports/tracker', auth(), wrap(req => { // onboarding tracker: every lead started in range with its milestones
  const [from, to] = range(req); const [w, p] = scope(req.user);
  return q(`SELECT l.id, l.payment_id, l.name, l.company, l.phone, l.language, l.package, l.amount, u.name agent, t.name team, l.stage,
    l.start_at, l.first_call_at, l.first_connect_at, l.docs_verified_at, l.classified_status, l.onboarded_at, l.attempts, l.last_disposition,
    round((julianday(l.first_call_at)-julianday(l.start_at))*1440,1) tat_first_call_min,
    round((julianday(coalesce(l.onboarded_at, datetime('now')))-julianday(l.start_at))*24,1) age_or_tat_hr
    ${LEAD_JOIN} WHERE ${w} AND date(l.start_at,${IST}) BETWEEN ? AND ? ORDER BY l.start_at`, ...p, from, to);
}));

// CSV export for any report or lead list
const toCSV = rows => {
  if (!rows.length) return '';
  const h = Object.keys(rows[0]).filter(k => k !== 'raw');
  const e = v => v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return '\uFEFF' + [h.join(','), ...rows.map(r => h.map(k => e(r[k])).join(','))].join('\n');
};
app.get('/api/export/:what', auth(), (req, res) => {
  try {
    let rows;
    if (req.params.what === 'leads') { const [w, p] = leadFilter(req); rows = q(`SELECT ${LEAD_COLS} ${LEAD_JOIN} WHERE ${w} ORDER BY l.start_at DESC`, ...p); }
    else if (req.params.what === 'agents') rows = agentReport(req);
    else if (req.params.what === 'activities') {
      const [from, to] = range(req); const [w, p] = scope(req.user);
      rows = q(`SELECT a.created_at, u.name agent, l.phone, l.name, a.type, a.disposition, a.category, a.note FROM activities a JOIN leads l ON l.id=a.lead_id LEFT JOIN users u ON u.id=a.user_id
        WHERE ${w} AND date(a.created_at,${IST}) BETWEEN ? AND ? ORDER BY a.id`, ...p, from, to);
    }
    if (req.params.what === 'tracker') {
      const [from, to] = range(req); const [w, p] = scope(req.user);
      rows = q(`SELECT l.payment_id, l.name, l.company, l.phone, l.language, l.package, l.amount, u.name agent, t.name team, l.stage, l.start_at, l.first_call_at, l.docs_verified_at, l.classified_status, l.onboarded_at, l.attempts, l.last_disposition,
        round((julianday(l.first_call_at)-julianday(l.start_at))*1440,1) tat_first_call_min, round((julianday(l.onboarded_at)-julianday(l.start_at))*24,1) tat_onboard_hr
        ${LEAD_JOIN} WHERE ${w} AND date(l.start_at,${IST}) BETWEEN ? AND ? ORDER BY l.start_at`, ...p, from, to);
    }
    if (!rows) return res.status(404).send('Unknown export');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.what}-${todayIST()}.csv"`);
    res.send(toCSV(rows));
  } catch (e) { res.status(500).send(e.message); }
});

// ---------- admin: users, teams, dispositions, rules, sources, keys, settings ----------
app.get('/api/users', auth(), wrap(req => {
  const w = req.user.role === 'manager' && req.user.team_id ? `WHERE u.team_id=${+req.user.team_id}` : '';
  return q(`SELECT u.id,u.name,u.email,u.phone,u.role,u.team_id,u.languages,u.daily_capacity,u.available,u.active,u.last_login,t.name team_name,
    (SELECT count(*) FROM leads WHERE assigned_to=u.id AND stage NOT IN ('onboarded','dropped')) open_cnt
    FROM users u LEFT JOIN teams t ON t.id=u.team_id ${w} ORDER BY u.active DESC, u.role, u.name`);
}));
app.post('/api/users', auth('admin'), wrap(req => {
  const b = req.body; if (!b.name || !b.email) fail(400, 'Name and email are needed.');
  if (b.id) {
    run(`UPDATE users SET name=?,email=?,phone=?,role=?,team_id=?,languages=?,daily_capacity=?,available=?,active=? WHERE id=?`,
      b.name, b.email, b.phone || null, b.role, b.team_id || null, b.languages || '', +b.daily_capacity || 40, b.available ? 1 : 0, b.active ? 1 : 0, b.id);
    if (b.password) run('UPDATE users SET password_hash=? WHERE id=?', bcrypt.hashSync(b.password, 10), b.id);
    if (!b.active) { // hand back their open leads
      const ids = q(`SELECT id FROM leads WHERE assigned_to=? AND stage NOT IN ('onboarded','dropped')`, b.id);
      ids.forEach(({ id }) => autoAssign(id, { keepTeam: true, exclude: b.id, by: req.user.id }));
    }
    return { id: b.id };
  }
  if (!b.password || b.password.length < 6) fail(400, 'Set a password of at least 6 characters.');
  return { id: run(`INSERT INTO users(name,email,phone,password_hash,role,team_id,languages,daily_capacity) VALUES (?,?,?,?,?,?,?,?)`,
    b.name, b.email, b.phone || null, bcrypt.hashSync(b.password, 10), b.role || 'agent', b.team_id || null, b.languages || '', +b.daily_capacity || 40).lastInsertRowid };
}));
app.post('/api/users/:id/available', auth('admin', 'manager'), wrap(req => { run('UPDATE users SET available=? WHERE id=?', req.body.available ? 1 : 0, req.params.id); if (req.body.available) assignQueue(); return { ok: true }; }));

const crud = (table, fields, roles = ['admin']) => {
  app.get(`/api/${table}`, auth(), wrap(() => q(`SELECT * FROM ${table} ORDER BY ${fields.includes('sort') ? 'sort,' : fields.includes('priority') ? 'priority,' : ''} id`)));
  app.post(`/api/${table}`, auth(...roles), wrap(req => {
    const b = req.body; const vals = fields.map(f => b[f] === '' ? null : typeof b[f] === 'boolean' ? +b[f] : b[f] ?? null);
    if (b.id) { run(`UPDATE ${table} SET ${fields.map(f => f + '=?').join(',')} WHERE id=?`, ...vals, b.id); return { id: b.id }; }
    return { id: run(`INSERT INTO ${table}(${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, ...vals).lastInsertRowid };
  }));
  app.delete(`/api/${table}/:id`, auth(...roles), wrap(req => { run(`UPDATE ${table} SET active=0 WHERE id=?`, req.params.id); return { ok: true }; }));
};
crud('teams', ['name', 'languages', 'method', 'active']);
crud('dispositions', ['label', 'category', 'marks_pkg_explained', 'needs_followup', 'auto_followup_min', 'terminal', 'sort', 'active']);
crud('rules', ['name', 'priority', 'field', 'op', 'value', 'team_id', 'user_id', 'active']);
crud('sources', ['name', 'url', 'mapping', 'interval_min', 'active']);
app.post('/api/sources/:id/run', auth('admin', 'manager'), async (req, res) => {
  try { res.json(await runSource(q1('SELECT * FROM sources WHERE id=?', req.params.id))); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/keys', auth('admin'), wrap(() => q('SELECT * FROM api_keys ORDER BY id DESC')));
app.post('/api/keys', auth('admin'), wrap(req => ({ key: run('INSERT INTO api_keys(name,key) VALUES (?,?)', req.body.name || 'key', 'lk_' + crypto.randomBytes(20).toString('hex')) && q1('SELECT key FROM api_keys ORDER BY id DESC').key })));
app.delete('/api/keys/:id', auth('admin'), wrap(req => { run('UPDATE api_keys SET active=0 WHERE id=?', req.params.id); return { ok: true }; }));
app.get('/api/settings', auth(), wrap(() => settings()));
app.post('/api/settings', auth('admin'), wrap(req => { for (const [k, v] of Object.entries(req.body)) run('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)', k, String(v)); return settings(); }));

// ---------- schedulers ----------
cron.schedule('* * * * *', async () => {
  const minute = new Date().getMinutes() + new Date().getHours() * 60;
  for (const s of q('SELECT * FROM sources WHERE active=1')) if (minute % Math.max(1, s.interval_min) === 0) runSource(s).catch(() => {});
  assignQueue();
  const n = +settings().auto_reassign_min;
  if (n > 0) q(`SELECT id, assigned_to FROM leads WHERE stage='new' AND first_call_at IS NULL AND assigned_to IS NOT NULL AND (julianday('now')-julianday(assigned_at))*1440 > ?`, n)
    .forEach(l => autoAssign(l.id, { keepTeam: true, exclude: l.assigned_to }));
});

app.use((req, res) => req.path.startsWith('/api/') ? res.status(404).json({ error: 'Not found' }) : res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`Lokal Onboarding CRM on http://localhost:${PORT}`));
module.exports = { app, normalize, upsertLead };
