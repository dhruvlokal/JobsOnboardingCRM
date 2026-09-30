// Lokal Onboarding CRM — frontend (no build step)
let ME = null, S = {}, CACHE = {};
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STAGES = { new: 'New', contacted: 'Contacted', docs_pending: 'Docs pending', classified_review: 'Classified check', ready: 'Ready to onboard', onboarded: 'Onboarded', dropped: 'Dropped' };
const RAIL = ['new', 'contacted', 'docs_pending', 'classified_review', 'ready', 'onboarded'];
const TYPES = { import: 'Created', assign: 'Assigned', stage: 'Stage moved', doc: 'Document', classified: 'Classified', onboard: 'Onboarded', note: 'Note', call: 'Call' };
const isMgr = () => ME && ME.role !== 'agent';
const isAdmin = () => ME && ME.role === 'admin';

async function api(url, opt = {}) {
  const o = { method: opt.method || (opt.body ? 'POST' : 'GET'), headers: {} };
  if (opt.body instanceof FormData) o.body = opt.body;
  else if (opt.body) { o.body = JSON.stringify(opt.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, o);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.includes('login')) { ME = null; return renderLogin(); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
function toast(msg) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.append(t); setTimeout(() => t.remove(), 2600); }
const act = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

const IST = d => d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() + 330 * 60000 - n * 864e5).toISOString().slice(0, 10);
const dur = min => min == null ? '—' : min < 60 ? `${Math.round(min)}m` : min < 1440 ? `${(min / 60).toFixed(1)}h` : `${(min / 1440).toFixed(1)}d`;
const chip = s => `<span class="chip ${esc(s)}">${esc(STAGES[s] || String(s).replace('_', ' '))}</span>`;
const localInput = d => { const x = new Date(new Date(d).getTime() + 330 * 60000); return x.toISOString().slice(0, 16); };

// TAT clock: before first call it races the first-call SLA; after that it races the onboarding SLA.
function tat(l) {
  const start = new Date(l.start_at).getTime();
  if (l.stage === 'onboarded' || l.stage === 'dropped') {
    const m = ((new Date(l.onboarded_at || l.dropped_at).getTime()) - start) / 60000;
    return `<div class="tat"><span>${l.stage === 'onboarded' ? 'Done in ' + dur(m) : 'Closed'}</span></div>`;
  }
  let el, sla, label;
  if (!l.first_call_at) { el = (Date.now() - start) / 60000; sla = +S.sla_first_call_min; label = `${dur(el)} uncalled`; }
  else { el = (Date.now() - start) / 60000; sla = +S.sla_onboard_hours * 60; label = `${dur(el)} open`; }
  const p = el / sla, cls = p > 1 ? 'late' : p > .7 ? 'warn' : '';
  return `<div class="tat ${cls}" title="SLA ${dur(sla)}"><div class="bar"><div class="fill" style="width:${Math.min(p / 2, 1) * 100}%"></div><div class="sla"></div></div><span>${label}</span></div>`;
}

// ---------- shell ----------
async function boot() {
  try { ME = await api('/api/me'); S = ME.settings; } catch { return; }
  if (!ME) return;
  window.onhashchange = route; route();
}
function renderLogin() {
  $('#root').innerHTML = `<div class="login"><form id="lf">
    <h1>Lokal onboarding</h1><p>Log in with your work email.</p>
    <label class="f">Email<input name="email" type="email" required autofocus></label>
    <label class="f">Password<input name="password" type="password" required></label>
    <div class="err" id="le"></div><button class="btn pri">Log in</button></form></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault(); const f = new FormData(e.target);
    try { await api('/api/login', { body: Object.fromEntries(f) }); boot(); } catch (x) { $('#le').textContent = x.message; }
  };
}
function shell(active, html, counts = {}) {
  const L = (h, t, extra = '') => `<a href="#${h}" class="${active === h ? 'on' : ''}">${t}${extra}</a>`;
  $('#root').innerHTML = `<div class="app"><nav>
    <div class="brand">Lokal onboarding<small>Post-payment calling</small></div>
    ${L('/', ME.role === 'agent' ? 'My queue' : 'Overview')}
    ${L('/leads', 'Leads')}
    ${L('/followups', 'Follow-ups', counts.f ? ` <span class="badge">${counts.f}</span>` : '')}
    ${L('/reports', 'Reports')}
    ${isMgr() ? `<div class="grp">Manage</div>${L('/admin/users', 'Users')}` : ''}
    ${isAdmin() ? `${L('/admin/teams', 'Teams')}${L('/admin/rules', 'Assignment rules')}${L('/admin/dispositions', 'Dispositions')}${L('/admin/integrations', 'Data sources & API')}${L('/admin/settings', 'Settings')}` : ''}
    <div class="foot"><b>${esc(ME.name)}</b><div class="muted small">${esc(ME.role)}</div>
      ${ME.role === 'agent' ? `<label><input type="checkbox" id="avail" ${ME.available !== 0 ? 'checked' : ''}> Taking new leads</label>` : ''}
      <a href="#/password" style="padding:4px 0">Change password</a><a href="#" id="lo" style="padding:4px 0">Log out</a></div>
  </nav><main>${html}</main></div>`;
  $('#lo').onclick = async e => { e.preventDefault(); await api('/api/logout', { body: {} }); ME = null; renderLogin(); };
  $('#avail') && ($('#avail').onchange = act(async e => { await api('/api/me/available', { body: { available: e.target.checked } }); toast(e.target.checked ? 'You will get new leads' : 'New leads paused for you'); }));
}
async function route() {
  const h = (location.hash.slice(1) || '/').split('?')[0]; const [, a, b] = h.split('/');
  try {
    if (!a) return dashboard();
    if (a === 'leads') return leads();
    if (a === 'followups') return leads({ followup: 'due' }, '/followups');
    if (a === 'lead') return leadPage(b);
    if (a === 'reports') return reports();
    if (a === 'password') return passwordPage();
    if (a === 'admin') return admin(b);
  } catch (e) { toast(e.message); }
}

// ---------- dashboard ----------
async function dashboard() {
  const [d, q] = await Promise.all([api('/api/dashboard'), api('/api/leads?stage=open&sort=queue&limit=25')]);
  const st = (v, t, href, alert) => `<a class="stat ${alert && v ? 'alert' : ''}" href="#${href}"><b>${v ?? '—'}</b><span>${t}</span></a>`;
  const aging = ['<1h', '1–4h', '4–24h', '1–3d', '>3d'].map(k => `<td class="n">${(d.aging.find(x => x.b === k) || {}).n || 0}</td>`).join('');
  shell('/', `
    <h1>${ME.role === 'agent' ? 'My queue' : 'Overview'}</h1>
    <p class="sub">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} · first-call SLA ${S.sla_first_call_min} min · onboarding SLA ${S.sla_onboard_hours} h</p>
    <div class="stats">
      ${st(d.sla_breach, 'Past first-call SLA', '/leads?sla=breach', 1)}
      ${st(d.followups_due, 'Follow-ups due', '/followups', 1)}
      ${st(d.untouched, 'Not called yet', '/leads?stage=new')}
      ${st(d.open, 'Open', '/leads?stage=open')}
      ${d.unassigned != null ? st(d.unassigned, 'Unassigned', '/leads?agent=none', 1) : ''}
      ${st(d.calls_today + ' / ' + d.connected_today, 'Calls / connected today', '/reports')}
      ${st(d.onboarded_today, 'Onboarded today', '/leads?stage=onboarded')}
      ${st(dur(d.tat_first_call_today), 'Avg first-call TAT today', '/reports')}
    </div>
    <h2>Call next</h2>${leadTable(q.rows, false)}
    <div class="grid2" style="grid-template-columns:1fr 1fr;margin-top:20px">
        <div class="panel"><h2>Where open leads are</h2><table>${Object.keys(STAGES).filter(s => !['onboarded', 'dropped'].includes(s)).map(s => `<tr class="click" onclick="location.hash='/leads?stage=${s}'"><td>${chip(s)}</td><td class="n">${(d.stages.find(x => x.stage === s) || {}).n || 0}</td></tr>`).join('')}</table></div>
        <div class="panel"><h2>How long open leads have waited</h2><table><tr>${['<1h', '1–4h', '4–24h', '1–3d', '>3d'].map(k => `<th class="n">${k}</th>`).join('')}</tr><tr>${aging}</tr></table></div>
    </div>`, { f: d.followups_due });
  bindRows();
}

// ---------- lead list ----------
function leadTable(rows, selectable) {
  if (!rows.length) return `<div class="panel muted">Nothing here. New paid advertisers show up as soon as they sync in.</div>`;
  return `<div class="tbl"><table><thead><tr>${selectable ? '<th><input type="checkbox" id="all"></th>' : ''}<th>Advertiser</th><th>Language</th><th>Package</th><th>Stage</th><th>Agent</th><th>TAT</th><th>Follow-up</th><th class="n">Tries</th><th>Last disposition</th></tr></thead><tbody>
  ${rows.map(l => `<tr class="click" data-id="${l.id}">${selectable ? `<td onclick="event.stopPropagation()"><input type="checkbox" class="sel" value="${l.id}"></td>` : ''}
    <td><b>${esc(l.company || l.name || '—')}</b><div class="small muted">${esc(l.name && l.company ? l.name + ' · ' : '')}${esc(l.phone)}</div></td>
    <td>${esc(l.language || '—')}</td><td>${esc(l.package || '—')}${l.amount ? `<div class="small muted">₹${l.amount}</div>` : ''}</td>
    <td>${chip(l.stage)}</td><td>${esc(l.agent_name || '—')}<div class="small muted">${esc(l.team_name || '')}</div></td>
    <td>${tat(l)}</td><td class="small ${l.next_followup_at && new Date(l.next_followup_at) < new Date() ? 'err' : ''}">${IST(l.next_followup_at)}</td>
    <td class="n">${l.attempts}</td><td class="small">${esc(l.last_disposition || '')}</td></tr>`).join('')}
  </tbody></table></div>`;
}
function bindRows() { document.querySelectorAll('tr[data-id]').forEach(r => r.onclick = () => location.hash = '/lead/' + r.dataset.id); }

async function leads(preset = {}, navKey = '/leads') {
  const qs = new URLSearchParams(location.hash.split('?')[1] || '');
  const f = { stage: 'open', sort: 'queue', ...preset, ...Object.fromEntries(qs) };
  const [data, users, teams, dash] = await Promise.all([
    api('/api/leads?' + new URLSearchParams({ ...f, limit: 200 })),
    isMgr() ? api('/api/users') : [], api('/api/teams'), api('/api/dashboard')]);
  const opt = (v, t, cur) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(t)}</option>`;
  const agents = users.filter(u => u.role === 'agent' && u.active);
  shell(navKey, `
    <div class="row" style="justify-content:space-between"><h1>${navKey === '/followups' ? 'Follow-ups due' : 'Leads'}</h1>
      <div class="row">${isMgr() ? `<button class="btn" id="imp">Import CSV</button>` : ''}<button class="btn" id="add">Add lead</button><button class="btn" id="exp">Export CSV</button></div></div>
    <p class="sub">${data.total} leads</p>
    <form class="row panel" id="flt">
      <input name="q" placeholder="Phone, name, payment or classified ID" value="${esc(f.q || '')}" style="flex:1;min-width:220px">
      <select name="stage">${opt('open', 'All open', f.stage)}${opt('', 'Any stage', f.stage)}${Object.entries(STAGES).map(([k, v]) => opt(k, v, f.stage)).join('')}</select>
      ${isMgr() ? `<select name="agent">${opt('', 'Any agent', f.agent)}${opt('none', 'Unassigned', f.agent)}${agents.map(u => opt(u.id, u.name, f.agent)).join('')}</select>
      <select name="team">${opt('', 'Any team', f.team)}${teams.map(t => opt(t.id, t.name, f.team)).join('')}</select>` : ''}
      <select name="followup">${opt('', 'Any follow-up', f.followup)}${opt('due', 'Due now', f.followup)}${opt('today', 'Due today', f.followup)}</select>
      <select name="sla">${opt('', 'Any SLA', f.sla)}${opt('breach', 'Past first-call SLA', f.sla)}</select>
      <label class="f">Paid from<input type="date" name="from" value="${esc(f.from || '')}"></label><label class="f">to<input type="date" name="to" value="${esc(f.to || '')}"></label>
      <select name="sort">${opt('queue', 'Call order', f.sort)}${opt('oldest', 'Oldest first', f.sort)}${opt('newest', 'Newest first', f.sort)}</select>
      <button class="btn pri">Filter</button></form>
    ${isMgr() ? `<div class="row" style="margin-bottom:10px"><span class="muted small">Selected leads:</span>
      <select id="to"><option value="">Assign to…</option>${agents.map(u => `<option value="${u.id}">${esc(u.name)} (${u.open_cnt} open)</option>`).join('')}</select>
      <button class="btn sm" id="asg">Assign</button><button class="btn sm" id="auto">Auto-assign by rules</button><button class="btn sm" id="q">Assign unassigned queue</button></div>` : ''}
    ${leadTable(data.rows, isMgr())}`, { f: dash.followups_due });
  bindRows();
  $('#flt').onsubmit = e => { e.preventDefault(); const p = new URLSearchParams([...new FormData(e.target)].filter(([, v]) => v !== '')); location.hash = navKey + '?' + p; };
  $('#exp').onclick = () => location.href = '/api/export/leads?' + new URLSearchParams(f);
  $('#add').onclick = () => leadForm();
  if (isMgr()) {
    const sel = () => [...document.querySelectorAll('.sel:checked')].map(c => +c.value);
    $('#all') && ($('#all').onchange = e => document.querySelectorAll('.sel').forEach(c => c.checked = e.target.checked));
    $('#asg').onclick = act(async () => { if (!$('#to').value) return toast('Pick an agent'); const r = await api('/api/leads/assign', { body: { ids: sel(), user_id: +$('#to').value } }); toast(`Assigned ${r.assigned}`); route(); });
    $('#auto').onclick = act(async () => { const r = await api('/api/leads/assign', { body: { ids: sel(), auto: true } }); toast(`Re-routed ${r.assigned}`); route(); });
    $('#q').onclick = act(async () => { const r = await api('/api/assign-queue', { body: {} }); toast(`Assigned ${r.assigned} from queue`); route(); });
    $('#imp').onclick = () => modal(`<h2>Import leads from CSV</h2><p class="muted small">Headers like phone / mobile, name, company, language, package, amount, payment_id, paid_at, classified_id, classified_url are picked up automatically. Duplicates are skipped.</p>
      <form id="mf"><input type="file" name="file" accept=".csv" required><div class="row" style="margin-top:14px"><button class="btn pri">Import</button></div></form>`, async fd => {
      const r = await api('/api/leads/import', { body: fd }); toast(`${r.created} new, ${r.updated} updated, ${r.duplicate} duplicates, ${r.skipped} skipped`); route();
    }, true);
  }
}
function leadForm() {
  modal(`<h2>Add lead</h2><form id="mf" class="form">
    ${['name', 'company', 'phone', 'language', 'package', 'amount', 'payment_id', 'classified_id', 'classified_url', 'city'].map(k => `<label class="f">${k.replace('_', ' ')}<input name="${k}" ${k === 'phone' ? 'required' : ''}></label>`).join('')}
    <div><button class="btn pri">Add lead</button></div></form>`, async b => { const r = await api('/api/leads', { body: b }); toast(r.status === 'created' ? 'Lead added and assigned' : 'Already exists — ' + r.status); if (r.id) location.hash = '/lead/' + r.id; });
}
function modal(html, onSubmit, raw) {
  const d = document.createElement('dialog'); d.innerHTML = html + `<button class="btn sm" style="position:absolute;top:14px;right:14px" onclick="this.closest('dialog').close()">Close</button>`;
  document.body.append(d); d.showModal(); d.onclose = () => d.remove();
  const f = d.querySelector('#mf');
  if (f) f.onsubmit = act(async e => { e.preventDefault(); const fd = new FormData(f); await onSubmit(raw ? fd : Object.fromEntries(fd)); d.close(); });
  return d;
}

// ---------- lead page ----------
async function leadPage(id) {
  const [{ lead: l, docs, acts, others }, disp, dash] = await Promise.all([api('/api/leads/' + id), api('/api/dispositions'), api('/api/dashboard')]);
  const types = S.doc_types.split(',').map(s => s.trim()), req = S.required_docs.split(',').map(s => s.trim());
  const verified = new Set(docs.filter(d => d.status === 'verified').map(d => d.doc_type));
  const ci = RAIL.indexOf(l.stage);
  const wa = `https://wa.me/91${l.phone}`;
  const closed = ['onboarded', 'dropped'].includes(l.stage);
  const dOpts = ['connected', 'not_connected'].map(c => `<optgroup label="${c === 'connected' ? 'Connected' : 'Not connected'}">${disp.filter(d => d.active && d.category === c).map(d => `<option value="${d.id}" data-f="${d.needs_followup}" data-a="${d.auto_followup_min}">${esc(d.label)}</option>`).join('')}</optgroup>`).join('');
  shell('/leads', `
    <a href="#/leads" class="small">← Leads</a>
    <div class="row" style="justify-content:space-between;margin-top:8px">
      <div><h1>${esc(l.company || l.name || l.phone)}</h1><div class="muted">${esc(l.name || '')} · <a href="tel:+91${esc(l.phone)}">+91 ${esc(l.phone)}</a> · <a href="${wa}" target="_blank" rel="noopener">WhatsApp</a>${l.alt_phone ? ` · alt ${esc(l.alt_phone)}` : ''}</div></div>
      <div style="text-align:right">${chip(l.stage)}<div class="small muted" style="margin-top:6px">${esc(l.agent_name || 'Unassigned')} · ${esc(l.team_name || '')}</div></div>
    </div>
    ${l.stage === 'dropped' ? `<div class="panel" style="margin-top:12px;border-color:var(--red)">Dropped: ${esc(l.last_disposition)}</div>` :
      `<div class="rail">${RAIL.map((s, i) => `<div class="${i < ci ? 'done' : i === ci ? 'cur' : ''}"><i>${i + 1}</i>${STAGES[s]}</div>`).join('')}</div>`}
    <div class="row small muted" style="margin:6px 0 18px">Paid ${IST(l.start_at)} · first call ${l.first_call_at ? dur((new Date(l.first_call_at) - new Date(l.start_at)) / 60000) + ' after payment' : 'not yet'} · ${l.attempts} attempts${l.onboarded_at ? ' · onboarded in ' + dur((new Date(l.onboarded_at) - new Date(l.start_at)) / 60000) : ''}</div>
    <div class="grid2"><div>
      ${closed ? '' : `<div class="panel"><h2>Log this call</h2><form id="cf" class="form" style="grid-template-columns:1fr 1fr">
        <label class="f">Disposition<select name="disposition_id" id="dsel" required><option value="">Pick one</option>${dOpts}</select></label>
        <label class="f">Follow-up<input type="datetime-local" name="followup_at" id="fu"></label>
        <label class="f" style="grid-column:1/-1">Note<textarea name="note" placeholder="What did the advertiser say?"></textarea></label>
        <div><button class="btn pri">Save call</button></div></form></div>`}
      <div class="panel"><h2>Onboarding checklist</h2>
        <div class="check"><span>Package explained (${esc(l.package || 'package not set')})</span><label class="row"><input type="checkbox" id="pkg" ${l.pkg_explained ? 'checked' : ''} ${closed ? 'disabled' : ''}> Done</label></div>
        <div class="check"><span>Required documents verified <span class="small muted">${req.map(r => verified.has(r) ? '✓ ' + r : '○ ' + r).join(' · ')}</span></span>${l.docs_ok ? chip('verified') : chip('docs_pending')}</div>
        <div class="check"><span>Classified checked ${l.classified_url ? `<a href="${esc(l.classified_url)}" target="_blank" rel="noopener">Open post</a>` : ''}<div class="small muted">${esc(l.classified_title || l.classified_id || 'No classified linked')}${l.classified_note ? ' — ' + esc(l.classified_note) : ''}</div></span>
          <span class="row">${chip(l.classified_status)}${closed ? '' : `<select id="cls"><option value="">Change…</option><option value="approved">Approve</option><option value="needs_edit">Needs edit</option><option value="rejected">Reject</option><option value="pending">Back to pending</option></select>`}</span></div>
        <div class="row" style="margin-top:14px">
          ${l.stage === 'onboarded' ? `<span class="chip onboarded">Onboarded ${IST(l.onboarded_at)}</span>` : l.stage === 'dropped' ? '' : `<button class="btn go" id="onb" ${l.stage !== 'ready' ? 'disabled' : ''}>Mark onboarded</button>${isMgr() && l.stage !== 'ready' ? '<button class="btn sm" id="ovr">Onboard anyway (override)</button>' : ''}`}
          ${closed && isMgr() ? '<button class="btn sm" id="reo">Reopen</button>' : ''}
        </div></div>
      <div class="panel"><h2>Documents</h2>
        ${docs.length ? docs.map(d => `<div class="docrow"><div><b>${esc(d.doc_type)}</b> ${chip(d.status)}
            <div class="small muted">${d.file_path ? `<a href="/api/docs/${d.id}/file">${esc(d.file_name)}</a>` : ''}${d.url ? `<a href="${esc(d.url)}" target="_blank" rel="noopener">Open link</a>` : ''} · added ${IST(d.created_at)}${d.verified_by_name ? ` · ${d.status} by ${esc(d.verified_by_name)}` : ''}</div>
            ${d.reason ? `<div class="small err">${esc(d.reason)}</div>` : ''}</div>
          <div class="row">${d.status !== 'verified' ? `<button class="btn sm" data-v="${d.id}">Verify</button>` : ''}${d.status !== 'rejected' ? `<button class="btn sm warn" data-r="${d.id}">Reject</button>` : ''}</div></div>`).join('') : '<p class="muted">No documents yet. Ask the advertiser to share them on WhatsApp, then add them here.</p>'}
        <form id="df" class="row" style="margin-top:12px"><select name="doc_type" required><option value="">Document type</option>${types.map(t => `<option>${esc(t)}</option>`).join('')}</select>
          <input type="file" name="file" accept="image/*,.pdf"><input name="url" placeholder="or paste a link"><button class="btn">Add document</button></form></div>
    </div><div>
      <div class="panel"><h2>Details</h2><form id="ef" class="form" style="grid-template-columns:1fr 1fr">
        ${['name', 'company', 'alt_phone', 'email', 'city', 'district', 'state', 'language', 'package', 'amount', 'classified_id', 'classified_title', 'classified_url'].map(k => `<label class="f">${k.replace('_', ' ')}<input name="${k}" value="${esc(l[k])}"></label>`).join('')}
        <div class="small muted" style="grid-column:1/-1">Payment ${esc(l.payment_id || '—')} · source ${esc(l.source)}${l.advertiser_id ? ' · advertiser ' + esc(l.advertiser_id) : ''}</div>
        <div><button class="btn">Save details</button></div></form>
        ${others.length ? `<p class="small">Other payments from this number: ${others.map(o => `<a href="#/lead/${o.id}">${esc(o.package || o.payment_id || '#' + o.id)} (${esc(STAGES[o.stage])})</a>`).join(', ')}</p>` : ''}</div>
      <div class="panel"><h2>Timeline</h2><form id="nf" class="row" style="margin-bottom:10px"><input name="note" placeholder="Add a note" style="flex:1" required><button class="btn sm">Add</button></form>
        <ul class="tl">${acts.map(a => `<li class="${a.type}"><b>${esc(a.disposition || TYPES[a.type] || a.type)}</b>${a.note ? ' — ' + esc(a.note) : ''}<div class="small muted">${IST(a.created_at)} · ${esc(a.user_name || 'system')}</div></li>`).join('')}</ul></div>
    </div></div>`, { f: dash.followups_due });

  const reload = () => leadPage(id);
  if ($('#dsel')) $('#dsel').onchange = e => { const o = e.target.selectedOptions[0]; const a = +o.dataset.a; if (a) $('#fu').value = localInput(Date.now() + a * 60000); $('#fu').required = o.dataset.f === '1' && !a; };
  if ($('#cf')) $('#cf').onsubmit = act(async e => { e.preventDefault(); const b = Object.fromEntries(new FormData(e.target)); if (b.followup_at) b.followup_at = new Date(b.followup_at + ':00+05:30').toISOString(); await api(`/api/leads/${id}/call`, { body: b }); toast('Call saved'); reload(); });
  $('#pkg') && ($('#pkg').onchange = act(async e => { await api(`/api/leads/${id}/checklist`, { body: { pkg_explained: e.target.checked } }); reload(); }));
  $('#cls') && ($('#cls').onchange = act(async e => { const s = e.target.value; if (!s) return; let note = ''; if (s === 'needs_edit' || s === 'rejected') { note = prompt('What needs to change in the post?'); if (!note) return reload(); } await api(`/api/leads/${id}/classified`, { body: { status: s, note } }); reload(); }));
  $('#onb') && ($('#onb').onclick = act(async () => { await api(`/api/leads/${id}/onboard`, { body: {} }); toast('Onboarded'); reload(); }));
  $('#ovr') && ($('#ovr').onclick = act(async () => { if (!confirm('Onboard without finishing the checklist?')) return; await api(`/api/leads/${id}/onboard`, { body: { override: true } }); reload(); }));
  $('#reo') && ($('#reo').onclick = act(async () => { await api(`/api/leads/${id}/reopen`, { body: {} }); reload(); }));
  document.querySelectorAll('[data-v]').forEach(b => b.onclick = act(async () => { await api(`/api/docs/${b.dataset.v}/verify`, { body: { status: 'verified' } }); reload(); }));
  document.querySelectorAll('[data-r]').forEach(b => b.onclick = act(async () => { const reason = prompt('Why is it rejected? The advertiser needs to know what to resend.'); if (!reason) return; await api(`/api/docs/${b.dataset.r}/verify`, { body: { status: 'rejected', reason } }); reload(); }));
  $('#df').onsubmit = act(async e => { e.preventDefault(); await api(`/api/leads/${id}/docs`, { body: new FormData(e.target) }); toast('Document added'); reload(); });
  $('#ef').onsubmit = act(async e => { e.preventDefault(); await api(`/api/leads/${id}`, { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) }); toast('Details saved'); reload(); });
  $('#nf').onsubmit = act(async e => { e.preventDefault(); await api(`/api/leads/${id}/note`, { body: Object.fromEntries(new FormData(e.target)) }); reload(); });
}

// ---------- reports ----------
async function reports() {
  const qs = Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));
  const f = { from: qs.from || today(), to: qs.to || today(), period: qs.period || 'daily' };
  const p = new URLSearchParams(f);
  const [ag, tr, di, dash] = await Promise.all([api('/api/reports/agents?' + p), api('/api/reports/trend?' + p), api('/api/reports/dispositions?' + p), api('/api/dashboard')]);
  const tot = k => ag.reduce((s, r) => s + (r[k] || 0), 0);
  const labels = [...new Set(di.map(r => r.disposition))];
  const byAgent = {}; di.forEach(r => (byAgent[r.agent] = byAgent[r.agent] || {})[r.disposition] = r.n);
  const max = Math.max(1, ...tr.map(r => Math.max(r.new_leads || 0, r.onboarded || 0)));
  const preset = (t, from, to, period) => `<a class="btn sm" href="#/reports?${new URLSearchParams({ from, to, period })}">${t}</a>`;
  const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  shell('/reports', `
    <h1>Reports</h1><p class="sub">${f.from === f.to ? f.from : f.from + ' to ' + f.to}, IST. TAT runs from payment time.</p>
    <div class="row panel">
      ${preset('Today', today(), today(), 'daily')}${preset('Yesterday', daysAgo(1), daysAgo(1), 'daily')}${preset('Last 7 days', daysAgo(6), today(), 'daily')}
      ${preset('Last 8 weeks', daysAgo(55), today(), 'weekly')}${preset('Last 6 months', daysAgo(182), today(), 'monthly')}
      <form id="rf" class="row" style="margin-left:auto"><input type="date" name="from" value="${f.from}"><input type="date" name="to" value="${f.to}">
      <select name="period">${['daily', 'weekly', 'monthly'].map(x => `<option ${x === f.period ? 'selected' : ''}>${x}</option>`).join('')}</select><button class="btn pri">Show</button></form></div>
    <div class="stats">
      <div class="stat"><b>${tot('assigned')}</b><span>Assigned</span></div><div class="stat"><b>${tot('calls')}</b><span>Calls</span></div>
      <div class="stat"><b>${pct(tot('connected'), tot('calls'))}</b><span>Connect rate</span></div><div class="stat"><b>${tot('onboarded')}</b><span>Onboarded</span></div>
      <div class="stat ${tot('sla_breach_first_call') ? 'alert' : ''}"><b>${tot('sla_breach_first_call')}</b><span>First-call SLA misses</span></div>
      <div class="stat"><b>${pct(tot('onboarded_within_sla'), tot('onboarded'))}</b><span>Onboarded within ${S.sla_onboard_hours}h</span></div>
    </div>
    <div class="panel"><div class="row" style="justify-content:space-between"><h2>Agent scorecard</h2><div class="row">
      <a class="btn sm" href="/api/export/agents?${p}">Export scorecard</a><a class="btn sm" href="/api/export/tracker?${p}">Export onboarding tracker</a><a class="btn sm" href="/api/export/activities?${p}">Export call log</a></div></div>
      <div class="tbl"><table><thead><tr><th>Agent</th><th>Team</th><th class="n">Assigned</th><th class="n">Calls</th><th class="n">Connected</th><th class="n">Leads called</th><th class="n">Docs verified</th><th class="n">Onboarded</th><th class="n">Dropped</th><th class="n">Avg first call</th><th class="n">Avg onboard</th><th class="n">SLA misses</th><th class="n">Open now</th><th class="n">Overdue f/u</th></tr></thead><tbody>
      ${ag.map(r => `<tr><td><b>${esc(r.agent)}</b></td><td>${esc(r.team || '')}</td><td class="n">${r.assigned}</td><td class="n">${r.calls}</td><td class="n">${r.connected} <span class="muted small">${pct(r.connected, r.calls)}</span></td><td class="n">${r.leads_called}</td><td class="n">${r.docs_verified}</td><td class="n"><b>${r.onboarded}</b></td><td class="n">${r.dropped}</td>
        <td class="n">${dur(r.tat_first_call_min)}</td><td class="n">${r.tat_onboard_hr == null ? '—' : r.tat_onboard_hr + 'h'}</td><td class="n ${r.sla_breach_first_call ? 'err' : ''}">${r.sla_breach_first_call}</td><td class="n">${r.open_now}</td><td class="n ${r.overdue_followups ? 'err' : ''}">${r.overdue_followups}</td></tr>`).join('') || '<tr><td colspan="14" class="muted">No agents yet.</td></tr>'}
      </tbody></table></div></div>
    <div class="grid2">
      <div class="panel"><h2>Trend, ${f.period}</h2><div class="small muted">Blue: new paid leads · green: onboarded</div>
        <div class="bars">${tr.map(r => `<div class="b" title="${r.bucket}: ${r.new_leads || 0} new, ${r.onboarded || 0} onboarded"><div class="pair"><i style="height:${(r.new_leads || 0) / max * 100}%"></i><i style="height:${(r.onboarded || 0) / max * 100}%"></i></div>${esc(r.bucket.slice(-5))}</div>`).join('') || '<span class="muted">No data in this range.</span>'}</div>
        <div class="tbl" style="margin-top:12px"><table><tr><th>${f.period}</th><th class="n">New</th><th class="n">Calls</th><th class="n">Onboarded</th><th class="n">Avg first call</th><th class="n">Avg onboard</th></tr>
        ${tr.map(r => `<tr><td>${r.bucket}</td><td class="n">${r.new_leads || 0}</td><td class="n">${r.calls || 0}</td><td class="n">${r.onboarded || 0}</td><td class="n">${dur(r.tat_first_call_min)}</td><td class="n">${r.tat_onboard_hr == null ? '—' : r.tat_onboard_hr + 'h'}</td></tr>`).join('')}</table></div></div>
      <div class="panel"><h2>Dispositions by agent</h2><div class="tbl"><table><tr><th>Agent</th>${labels.map(l => `<th class="n" style="white-space:normal;min-width:80px">${esc(l)}</th>`).join('')}</tr>
        ${Object.entries(byAgent).map(([a, m]) => `<tr><td>${esc(a)}</td>${labels.map(l => `<td class="n">${m[l] || ''}</td>`).join('')}</tr>`).join('') || '<tr><td class="muted">No calls in this range.</td></tr>'}</table></div></div>
    </div>`, { f: dash.followups_due });
  $('#rf').onsubmit = e => { e.preventDefault(); location.hash = '/reports?' + new URLSearchParams(new FormData(e.target)); };
}

async function passwordPage() {
  shell('', `<h1>Change password</h1><form id="pf" class="panel form" style="max-width:420px;grid-template-columns:1fr">
    <label class="f">Current password<input type="password" name="current" required></label><label class="f">New password<input type="password" name="next" required minlength="6"></label>
    <div><button class="btn pri">Change password</button></div></form>`);
  $('#pf').onsubmit = act(async e => { e.preventDefault(); await api('/api/me/password', { body: Object.fromEntries(new FormData(e.target)) }); toast('Password changed'); location.hash = '/'; });
}

// ---------- admin ----------
const FIELDS = {
  teams: [['name', 'Team name'], ['languages', 'Languages it handles (comma separated)'], ['method', 'How leads are split', ['least_load', 'round_robin']], ['active', 'Active', 'bool']],
  dispositions: [['label', 'Label'], ['category', 'Call result', ['connected', 'not_connected']], ['marks_pkg_explained', 'Marks package as explained', 'bool'], ['needs_followup', 'Needs a follow-up time', 'bool'], ['auto_followup_min', 'Auto follow-up after (minutes, 0 = none)', 'num'], ['terminal', 'Closes the lead as dropped', 'bool'], ['sort', 'Order', 'num'], ['active', 'Active', 'bool']],
  rules: [['name', 'Rule name'], ['priority', 'Priority (lower runs first)', 'num'], ['field', 'When lead field', ['language', 'package', 'city', 'district', 'state', 'source', 'amount']], ['op', 'is', ['eq', 'in', 'contains', 'gte', 'lte']], ['value', 'Value (for "in", comma separated)'], ['team_id', 'Send to team', 'team'], ['user_id', 'Or straight to agent', 'agent'], ['active', 'Active', 'bool']],
  users: [['name', 'Name'], ['email', 'Email'], ['phone', 'Phone'], ['role', 'Role', ['agent', 'manager', 'admin']], ['team_id', 'Team', 'team'], ['languages', 'Languages spoken (comma separated)'], ['daily_capacity', 'Max new leads per day', 'num'], ['available', 'Taking new leads', 'bool'], ['active', 'Active (untick to deactivate and hand back open leads)', 'bool'], ['password', 'Password (leave blank to keep)', 'password']],
};
async function editForm(kind, row, teams, users) {
  const fl = FIELDS[kind];
  const input = ([k, t, type]) => {
    const v = row[k] ?? (type === 'bool' ? 1 : '');
    if (type === 'bool') return `<label class="row"><input type="checkbox" name="${k}" ${v ? 'checked' : ''}> ${t}</label>`;
    if (Array.isArray(type)) return `<label class="f">${t}<select name="${k}">${type.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select></label>`;
    if (type === 'team' || type === 'agent') { const list = type === 'team' ? teams : users.filter(u => u.role === 'agent'); return `<label class="f">${t}<select name="${k}"><option value="">—</option>${list.map(o => `<option value="${o.id}" ${o.id == v ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>`; }
    return `<label class="f">${t}<input name="${k}" type="${type === 'num' ? 'number' : type === 'password' ? 'password' : 'text'}" value="${type === 'password' ? '' : esc(v)}"></label>`;
  };
  modal(`<h2>${row.id ? 'Edit' : 'Add'} ${kind.replace(/s$/, '')}</h2><form id="mf" class="form">${fl.map(input).join('')}<div style="grid-column:1/-1"><button class="btn pri">Save</button></div></form>`, async b => {
    fl.filter(f => f[2] === 'bool').forEach(([k]) => b[k] = b[k] === 'on');
    await api('/api/' + kind, { body: { ...b, id: row.id } }); toast('Saved'); route();
  });
}
async function admin(tab) {
  const [teams, users, dash] = await Promise.all([api('/api/teams'), api('/api/users'), api('/api/dashboard')]);
  const nav = k => '/admin/' + k;
  if (tab === 'users') {
    shell(nav(tab), `<div class="row" style="justify-content:space-between"><h1>Users</h1>${isAdmin() ? '<button class="btn pri" id="new">Add user</button>' : ''}</div>
      <p class="sub">Agents only get leads while they are active, marked as taking leads, and under their daily cap.</p>
      <div class="tbl"><table><tr><th>Name</th><th>Role</th><th>Team</th><th>Languages</th><th class="n">Daily cap</th><th class="n">Open leads</th><th>Taking leads</th><th>Last login</th><th></th></tr>
      ${users.map(u => `<tr class="${u.active ? '' : 'muted'}"><td><b>${esc(u.name)}</b><div class="small muted">${esc(u.email)}</div></td><td>${u.role}</td><td>${esc(u.team_name || '—')}</td><td>${esc(u.languages)}</td><td class="n">${u.daily_capacity}</td><td class="n">${u.open_cnt}</td>
        <td>${u.role === 'agent' ? `<input type="checkbox" data-av="${u.id}" ${u.available ? 'checked' : ''}>` : ''}</td><td class="small">${IST(u.last_login)}</td><td>${isAdmin() ? `<button class="btn sm" data-ed="${u.id}">Edit</button>` : ''}</td></tr>`).join('')}</table></div>`, { f: dash.followups_due });
    $('#new') && ($('#new').onclick = () => editForm('users', { role: 'agent', daily_capacity: 40 }, teams, users));
    document.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => editForm('users', users.find(u => u.id == b.dataset.ed), teams, users));
    document.querySelectorAll('[data-av]').forEach(c => c.onchange = act(async () => { await api(`/api/users/${c.dataset.av}/available`, { body: { available: c.checked } }); toast('Updated'); }));
    return;
  }
  if (['teams', 'dispositions', 'rules'].includes(tab)) {
    const rows = await api('/api/' + tab);
    const help = { teams: 'Leads go to the team whose languages match the advertiser\'s language, unless a rule says otherwise.', dispositions: 'What agents pick after each call. Auto follow-up sets the next call time for them.', rules: 'Checked top to bottom before the language default. First match wins.' }[tab];
    const cols = FIELDS[tab].filter(f => f[2] !== 'password');
    const show = (r, [k, , t]) => t === 'bool' ? (r[k] ? 'Yes' : '') : t === 'team' ? esc(teams.find(x => x.id == r[k])?.name || '') : t === 'agent' ? esc(users.find(x => x.id == r[k])?.name || '') : esc(r[k]);
    shell(nav(tab), `<div class="row" style="justify-content:space-between"><h1>${{ teams: 'Teams', dispositions: 'Dispositions', rules: 'Assignment rules' }[tab]}</h1><button class="btn pri" id="new">Add</button></div><p class="sub">${help}</p>
      <div class="tbl"><table><tr>${cols.map(c => `<th>${c[1].split(' (')[0]}</th>`).join('')}<th></th></tr>${rows.map(r => `<tr class="${r.active ? '' : 'muted'}">${cols.map(c => `<td>${show(r, c)}</td>`).join('')}<td><button class="btn sm" data-ed="${r.id}">Edit</button></td></tr>`).join('')}</table></div>`, { f: dash.followups_due });
    $('#new').onclick = () => editForm(tab, {}, teams, users);
    document.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => editForm(tab, rows.find(r => r.id == b.dataset.ed), teams, users));
    return;
  }
  if (tab === 'integrations') {
    const [keys, srcs] = await Promise.all([api('/api/keys'), api('/api/sources')]);
    const host = location.origin;
    shell(nav(tab), `<h1>Data sources & API</h1><p class="sub">Paid advertisers come in three ways: a sheet or readsheet API link that refreshes on a schedule, a curl push from any system, or a CSV upload on the Leads page.</p>
      <div class="panel"><div class="row" style="justify-content:space-between"><h2>Sheet / API links that refresh</h2><button class="btn pri" id="ns">Add source</button></div>
        <p class="small muted">Paste a Google Sheet link (shared as "anyone with the link can view"), a published CSV link, or an Apps Script / readsheet API URL that returns JSON rows. Leave the column mapping empty unless your headers are unusual.</p>
        <div class="tbl"><table><tr><th>Name</th><th>URL</th><th class="n">Every</th><th>Last run</th><th></th></tr>
        ${srcs.map(s => `<tr class="${s.active ? '' : 'muted'}"><td><b>${esc(s.name)}</b></td><td class="small" style="max-width:280px;word-break:break-all">${esc(s.url)}</td><td class="n">${s.interval_min}m</td><td class="small">${IST(s.last_run)}<div class="${String(s.last_status).startsWith('error') ? 'err' : 'muted'}">${esc(s.last_status || '')}</div></td>
          <td class="row"><button class="btn sm" data-run="${s.id}">Sync now</button><button class="btn sm" data-es="${s.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No sources yet.</td></tr>'}</table></div></div>
      <div class="panel"><div class="row" style="justify-content:space-between"><h2>API keys for curl push</h2><button class="btn pri" id="nk">Create key</button></div>
        <table><tr><th>Name</th><th>Key</th><th>Last used</th><th></th></tr>${keys.map(k => `<tr class="${k.active ? '' : 'muted'}"><td>${esc(k.name)}</td><td class="small"><code>${esc(k.key.slice(0, 10))}…</code> <button class="btn sm" data-cp="${esc(k.key)}">Copy</button></td><td class="small">${IST(k.last_used)}</td><td>${k.active ? `<button class="btn sm warn" data-rv="${k.id}">Revoke</button>` : 'revoked'}</td></tr>`).join('')}</table>
        <h2 style="margin-top:16px">Push a paid advertiser</h2>
<pre class="code">curl -X POST ${host}/api/v1/leads \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: YOUR_KEY" \\
  -d '{"payment_id":"pay_123","name":"Ravi","company":"Sri Balaji Traders",
       "phone":"9876543210","language":"Telugu","package":"Premium",
       "amount":1499,"paid_at":"2026-09-26T10:15:00+05:30",
       "classified_id":"J-88213","classified_url":"https://…"}'</pre>
        <p class="small muted">Send one object or an array (up to a few thousand rows). Same payment_id twice is ignored, so retries are safe. Response: counts of created / updated / duplicate / skipped.</p></div>`, { f: dash.followups_due });
    const srcForm = s => modal(`<h2>${s.id ? 'Edit' : 'Add'} source</h2><form id="mf" class="form" style="grid-template-columns:1fr">
      <label class="f">Name<input name="name" value="${esc(s.name || '')}" required></label><label class="f">Sheet or API URL<input name="url" value="${esc(s.url || '')}" required></label>
      <label class="f">Refresh every (minutes)<input type="number" name="interval_min" value="${s.interval_min || 15}"></label>
      <label class="f">Column mapping, optional JSON<textarea name="mapping" placeholder='{"phone":"Advertiser Mobile","payment_id":"Order ID"}'>${esc(s.mapping && s.mapping !== '{}' ? s.mapping : '')}</textarea></label>
      <label class="row"><input type="checkbox" name="active" ${s.active !== 0 ? 'checked' : ''}> Active</label><div><button class="btn pri">Save source</button></div></form>`, async b => {
      b.active = b.active === 'on'; b.mapping = b.mapping || '{}'; JSON.parse(b.mapping); await api('/api/sources', { body: { ...b, id: s.id } }); toast('Saved'); route();
    });
    $('#ns').onclick = () => srcForm({});
    document.querySelectorAll('[data-es]').forEach(b => b.onclick = () => srcForm(srcs.find(s => s.id == b.dataset.es)));
    document.querySelectorAll('[data-run]').forEach(b => b.onclick = act(async () => { b.disabled = true; b.textContent = 'Syncing…'; try { const r = await api(`/api/sources/${b.dataset.run}/run`, { body: {} }); toast(`${r.created} new, ${r.updated} updated, ${r.duplicate} duplicates`); } finally { route(); } }));
    $('#nk').onclick = act(async () => { const name = prompt('What is this key for? e.g. payments webhook'); if (!name) return; const r = await api('/api/keys', { body: { name } }); await navigator.clipboard?.writeText(r.key).catch(() => {}); alert('Key created and copied:\n\n' + r.key); route(); });
    document.querySelectorAll('[data-cp]').forEach(b => b.onclick = () => { navigator.clipboard?.writeText(b.dataset.cp); toast('Copied'); });
    document.querySelectorAll('[data-rv]').forEach(b => b.onclick = act(async () => { if (!confirm('Revoke this key? Anything using it stops working.')) return; await api('/api/keys/' + b.dataset.rv, { method: 'DELETE' }); route(); }));
    return;
  }
  if (tab === 'settings') {
    const s = await api('/api/settings');
    const F = [['sla_first_call_min', 'First-call SLA (minutes after payment)'], ['sla_onboard_hours', 'Onboarding SLA (hours after payment)'], ['max_attempts', 'Max not-connected attempts before manager review'], ['auto_reassign_min', 'Reassign if not called within N minutes of assignment (0 = off)'], ['packages', 'Packages'], ['doc_types', 'Document types'], ['required_docs', 'Documents required to onboard']];
    shell(nav(tab), `<h1>Settings</h1><form id="sf" class="panel form" style="grid-template-columns:1fr;max-width:620px">${F.map(([k, t]) => `<label class="f">${t}<input name="${k}" value="${esc(s[k])}"></label>`).join('')}<div><button class="btn pri">Save settings</button></div></form>`, { f: dash.followups_due });
    $('#sf').onsubmit = act(async e => { e.preventDefault(); S = await api('/api/settings', { body: Object.fromEntries(new FormData(e.target)) }); toast('Settings saved'); });
  }
}

boot().then(() => { if (!ME) renderLogin(); });
