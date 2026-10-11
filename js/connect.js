// NOVA <-> nova-api bridge: session login, Connections, the command confirm step, sending, the Replies inbox.
// The session token lives in sessionStorage on screen 1 only (12h, HMAC-signed by the Worker). No API keys ever reach the browser.
// Screens 2 and 3 never call these routes: they get relayed data, and their Chat hands a confirmed command to screen 1.
// A paired phone (NOVA 2.3) has its own revocable device token instead (localStorage, 180 days, never the passphrase).
export const API = 'https://nova-api.tyler467890.workers.dev';
const SS = 'nova.api.session';
const LS_PASS = 'nova.passphrase';
const LS_DEV = 'nova.dev.v1';

const $ = (s, r = document) => r.querySelector(s);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; } };

export const TARGETS = [
  { id: 'grok', label: 'Grok Bot', integ: 'grok', hint: 'Message your Grok Bot' },
  { id: 'cursor', label: 'Cursor', integ: 'cursor', hint: 'Start a Cursor cloud agent', repo: true },
  { id: 'copilot', label: 'Copilot', integ: 'copilot', hint: 'Open a GitHub issue for Copilot', repo: true },
];
export const INTEGS = [
  ['grok', 'Grok Bot', 'Send commands to your Grok Bot and get replies in Chat'],
  ['cursor', 'Cursor', 'Launch and follow Cursor cloud agents'],
  ['copilot', 'GitHub Copilot', 'Assign GitHub issues to the Copilot agent'],
  ['github', 'GitHub', 'Create issues in your repos'],
  ['notion', 'Notion', 'Live task list from your Notion database'],
  ['inbox', 'Replies inbox', 'Where your bots post their answers'],
  ['brightspace', 'Brightspace', 'Assignments and due dates from your NSCC calendar'],
];

export const conn = { session: null, status: null, inbox: [], err: '', loading: false, inboxAt: 0, device: null };
try { const s = JSON.parse(sessionStorage.getItem(SS)); if (s && s.token && s.expiresAt > Date.now() + 60000) conn.session = s; } catch {}
if (document.documentElement.getAttribute('data-screen') === 'phone') { try { const d = JSON.parse(localStorage.getItem(LS_DEV)); if (d && d.token && d.expiresAt > Date.now()) conn.device = d; } catch {} }
const changed = () => window.dispatchEvent(new CustomEvent('nova:conn'));

// ---------- API (screen 1 only) ----------
export async function apiLogin(pass) {
  try {
    const r = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: pass }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.token) {
      conn.session = null; sessionStorage.removeItem(SS);
      conn.err = r.status === 429 ? 'Too many sign-in tries. Wait a few minutes.' : r.status === 401 ? 'The secure service didn’t accept the passphrase.' : 'Secure service unavailable.';
      return false;
    }
    conn.session = { token: d.token, expiresAt: d.expiresAt }; conn.err = '';
    sessionStorage.setItem(SS, JSON.stringify(conn.session));
    return true;
  } catch { conn.err = 'Can’t reach the secure service right now.'; return false; }
}
export function apiLogout() { conn.session = null; conn.status = null; conn.inbox = []; conn.inboxAt = 0; sessionStorage.removeItem(SS); }
async function ensureSession() {
  if (conn.session && conn.session.expiresAt > Date.now() + 60000) return true;
  if (conn.device) { if (conn.device.expiresAt > Date.now()) { conn.session = { token: conn.device.token, expiresAt: conn.device.expiresAt }; return true; } return false; }
  const pass = localStorage.getItem(LS_PASS);
  return pass ? apiLogin(pass) : false;
}
export const sessionToken = async () => ((await ensureSession()) ? conn.session.token : null);
// ---------- phone pairing ----------
export async function pairClaim(secret, name) {
  try {
    const r = await fetch(API + '/pair/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret, name }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.token) return { ok: false, msg: d.message || (r.status === 429 ? 'Too many tries. Wait a few minutes.' : 'That code didn’t work. Make a new one on your computer.') };
    conn.device = { token: d.token, expiresAt: d.expiresAt, id: d.device.id, name: d.device.name, pairedAt: Date.now() };
    localStorage.setItem(LS_DEV, JSON.stringify(conn.device)); conn.session = null;
    return { ok: true, device: d.device };
  } catch { return { ok: false, msg: 'Can’t reach NOVA’s secure service. Check your connection and try again.' }; }
}
export function forgetDevice() { conn.device = null; localStorage.removeItem(LS_DEV); apiLogout(); }
export async function api(path, opts = {}, retry = true) {
  if (!(await ensureSession())) throw Object.assign(new Error(conn.err || 'not signed in'), { status: 401 });
  const r = await fetch(API + path, { ...opts, headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), Authorization: 'Bearer ' + conn.session.token } });
  if (r.status === 401 && retry) { conn.session = null; sessionStorage.removeItem(SS); return api(path, opts, false); }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.message || d.error || 'HTTP ' + r.status), { status: r.status, data: d });
  return d;
}
export async function refreshConn() {
  conn.loading = true;
  try {
    const [s, i] = await Promise.all([api('/status'), api('/inbox')]);
    conn.status = s; conn.inbox = Array.isArray(i.items) ? i.items : []; conn.inboxAt = Date.now(); conn.err = '';
  } catch (e) { if (!conn.err) conn.err = 'Secure service unavailable.'; console.info('NOVA connections:', e.message); }
  conn.loading = false; changed();
}
// Chat replies: polled every 20 s by screen 1 while NOVA is unlocked
export async function pollInbox() {
  try { const i = await api('/inbox'); conn.inbox = Array.isArray(i.items) ? i.items : []; conn.inboxAt = Date.now(); if (conn.err) { conn.err = ''; } changed(); return true; }
  catch (e) { console.info('NOVA inbox:', e.message); return false; }
}
export const isOn = (integ) => !!(conn.status && conn.status.integrations && conn.status.integrations[integ] && conn.status.integrations[integ].configured);

// Sends one confirmed command (screen 1 only). Returns { msg, link, request_id }.
export async function sendDirect({ target, text, repo }) {
  const t = TARGETS.find((x) => x.id === target) || TARGETS[0];
  try {
    if (t.id === 'grok') { const d = await api('/grok/command', { method: 'POST', body: JSON.stringify({ text, target: 'grok' }) }); return { ok: true, msg: 'Sent to Grok Bot. The reply will appear in this chat.', request_id: d.request_id || null }; }
    if (t.id === 'cursor') { const d = await api('/cursor/agents', { method: 'POST', body: JSON.stringify({ prompt: text, repo, autoCreatePR: true }) }); return { ok: true, msg: 'Cursor agent started.', link: safeUrl((d.agent && d.agent.url) || '') }; }
    const title = text.split('\n')[0].slice(0, 120);
    const d = await api('/github/issue', { method: 'POST', body: JSON.stringify({ repo, title, body: text, assignCopilot: true }) });
    return { ok: true, msg: `Issue #${d.number} created${d.copilotAssigned ? ' and assigned to Copilot' : ' (Copilot couldn’t be assigned; check that it’s enabled for this repo)'}.`, link: safeUrl(d.url || '') };
  } catch (e) {
    const d = e.data || {};
    return { ok: false, msg: e.status === 503 ? 'Not connected yet.' : e.status === 429 ? (d.message || 'Daily limit reached.') : e.status === 423 ? 'Controls are switched off.' : e.status === 403 ? 'That repository isn’t allowed.' : 'Couldn’t send: ' + e.message };
  }
}

// ---------- modals ----------
export function modal(html, cls = '') {
  $('#modal') || document.body.insertAdjacentHTML('beforeend', '<div id="modal"></div>');
  $('#modal').innerHTML = `<div class="nmodal" data-mclose><div class="mbox ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  const f = $('#modal [autofocus]') || $('#modal button'); if (f) setTimeout(() => f.focus(), 30);
}
export const closeModal = () => { if ($('#modal')) $('#modal').innerHTML = ''; };
export function connRows() {
  const s = conn.status;
  return INTEGS.map(([k, n, d]) => {
    const on = isOn(k), needs = s && s.integrations && s.integrations[k] ? s.integrations[k].need || [] : [];
    return `<div class="crow"><span class="dot ${!s ? 'idle' : on ? 'ok' : 'idle'}"></span><div class="grow"><b>${n}</b><div class="mutedt sm">${d}${!on && needs.length ? ` · needs <span class="mono">${needs.map(esc).join(', ')}</span>` : ''}</div></div>
     ${!s ? '<span class="badge dim">Unknown</span>' : on ? '<span class="badge ok">Connected</span>' : '<span class="badge dim">Not connected</span>'}</div>`;
  }).join('');
}
export function openConnections() {
  const s = conn.status, off = s && s.controls_off;
  modal(`<div class="ph"><h3>Connections<small>secure service</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div>
   <div class="svc"><span class="dot ${conn.session ? 'ok' : 'warn'}"></span><span class="mutedt sm">${conn.session ? 'Signed in to the NOVA secure service' : esc(conn.err || 'Not signed in to the secure service')}</span></div>
   <div class="clist">${connRows()}</div>
   ${s ? `<div class="crow ctl"><div class="grow"><b>Remote controls</b><div class="mutedt sm">${off ? 'Off: NOVA can’t send commands to any bot.' : 'On: commands ask you to confirm before sending.'}</div></div><button class="btn sm ${off ? '' : 'danger'}" data-controls="${off ? 'on' : 'off'}">${off ? 'Turn on' : 'Turn off'}</button></div>` : ''}
   <div class="mutedt sm" style="margin-top:.875rem">Keys are stored only in the secure service, never in this site. Ask Grok Bot to connect one.</div>
   <div class="btns" style="margin-top:.875rem"><button class="btn" data-connrefresh>${conn.loading ? 'Checking…' : 'Check again'}</button><button class="btn" data-mclose>Close</button></div>`, 'conn');
}

// The confirm step. `send` does the work (directly on screen 1, relayed from screens 2 and 3) and resolves to { ok, msg, link }.
export function confirmCommand({ target, text, send, onDone }) {
  const t = TARGETS.find((x) => x.id === target) || TARGETS[0];
  if (!text) return;
  if (conn.status && !isOn(t.integ)) {
    modal(`<div class="ph"><h3>${esc(t.label)}<small>not connected</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div>
     <div class="notconn"><div><b>Not connected yet</b><div class="mutedt sm">${esc(t.label)} isn’t linked to NOVA yet, so nothing was sent. Ask Grok Bot to connect it, then try again.</div></div></div>
     <div class="btns" style="margin-top:1rem"><button class="btn" data-mclose>Close</button></div>`);
    return;
  }
  if (conn.status && conn.status.controls_off) { modal(`<div class="ph"><h3>Controls are off</h3><button class="x" data-mclose aria-label="Close">✕</button></div><div class="mutedt">Turn remote controls back on in Settings → Connections to send commands.</div><div class="btns" style="margin-top:1rem"><button class="btn" data-mclose>Close</button></div>`); return; }
  const repos = (conn.status && conn.status.repos) || ['tyler467890/student-day-planner', 'tyler467890/nova'];
  const lim = conn.status && conn.status.limits && conn.status.limits[t.id];
  const what = t.id === 'grok' ? 'This sends the message below to your Grok Bot.' : t.id === 'cursor' ? 'This starts a new Cursor cloud agent that can change code and open a pull request.' : 'This opens a GitHub issue and assigns it to Copilot, which then starts working on it.';
  modal(`<div class="ph"><h3>Confirm<small>${esc(t.label)}</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div>
   <div class="mutedt" style="margin-bottom:.75rem">${what}</div>
   ${t.repo ? `<label class="label" for="cmdrepo">Repository</label><select id="cmdrepo" class="msel">${repos.map((r) => `<option>${esc(r)}</option>`).join('')}</select>` : ''}
   <div class="label" style="margin-top:.75rem">Message</div><div class="quote">${esc(text)}</div>
   ${lim ? `<div class="mutedt sm" style="margin-top:.5rem">${esc(lim.used)} of ${esc(lim.cap)} used today</div>` : ''}
   <div class="cmderr" id="cmderr" role="alert"></div>
   <div class="btns" style="margin-top:1rem"><button class="btn pri" data-cmdconfirm autofocus>Send to ${esc(t.label)}</button><button class="btn" data-mclose>Cancel</button></div>`);
  const btn = $('#modal [data-cmdconfirm]');
  btn.addEventListener('click', async () => {
    const repo = $('#cmdrepo') ? $('#cmdrepo').value : null;
    btn.disabled = true; btn.textContent = 'Sending…';
    const r = await send({ target: t.id, text, repo });
    if (!r.ok) { const el = $('#cmderr'); if (el) el.textContent = r.msg; btn.disabled = false; btn.textContent = 'Send to ' + t.label; return; }
    if (onDone) onDone(r);
    const link = safeUrl(r.link || '');
    modal(`<div class="ph"><h3>Sent<small>${esc(t.label)}</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div><div>${esc(r.msg)}</div>${link ? `<div class="btns" style="margin-top:.875rem"><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open</a></div>` : ''}<div class="btns" style="margin-top:.875rem"><button class="btn" data-mclose autofocus>Done</button></div>`);
  });
}

// ---------- modal events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-mclose],[data-connrefresh],[data-controls]');
  if (!t) return;
  if (t.hasAttribute('data-mclose')) { if (e.target === t || e.target.closest('button[data-mclose]')) closeModal(); return; }
  if (t.hasAttribute('data-connrefresh')) { conn.loading = true; openConnections(); await refreshConn(); openConnections(); }
  else if (t.hasAttribute('data-controls')) {
    const off = t.getAttribute('data-controls') === 'off';
    if (off || confirm('Turn remote controls back on?')) { try { await api('/controls', { method: 'POST', body: JSON.stringify({ off }) }); } catch {} await refreshConn(); openConnections(); }
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal') && $('#modal').innerHTML) { closeModal(); e.stopPropagation(); } });
