// NOVA ↔ nova-api bridge: session login, Connections panel, command bar, Replies.
// The session token lives in sessionStorage only (12h, HMAC-signed by the Worker). No API keys ever reach the browser.
export const API = 'https://nova-api.tyler467890.workers.dev';
const SS = 'nova.api.session';
const LS_PASS = 'nova.passphrase';
const LS_TARGET = 'nova.cmd.target';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : ''; } catch { return ''; } };
const svg = (p, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const I = {
  bolt: '<path d="M15 4 L7 16 H13 L12 24 L21 11 H15 Z"/>',
  send: '<path d="M5 14 L23 6 L17 23 L13 15 Z M13 15 L23 6"/>',
  plug: '<path d="M10 4 V9 M18 4 V9 M7 9 H21 V13 a7 7 0 0 1 -14 0 Z M14 20 V24"/>',
  reply: '<path d="M11 8 L5 14 L11 20 M5 14 H17 a6 6 0 0 1 6 6"/>',
};

export const TARGETS = [
  { id: 'grok', label: 'Grok Bot', integ: 'grok', hint: 'Send a task to your Grok Bot' },
  { id: 'cursor', label: 'Cursor', integ: 'cursor', hint: 'Launch a Cursor cloud agent', repo: true },
  { id: 'copilot', label: 'Copilot', integ: 'copilot', hint: 'Open a GitHub issue assigned to Copilot', repo: true },
];
const INTEGS = [
  ['grok', 'Grok Bot', 'Send commands to your Grok Bot and get replies here'],
  ['cursor', 'Cursor', 'Launch and follow Cursor cloud agents'],
  ['copilot', 'GitHub Copilot', 'Assign GitHub issues to the Copilot agent'],
  ['github', 'GitHub', 'Create issues in your repos'],
  ['notion', 'Notion', 'Live task list from your Notion database'],
  ['inbox', 'Replies inbox', 'Where your bots post their answers'],
];

export const conn = {
  session: null, status: null, inbox: [], err: '', loading: false,
  target: localStorage.getItem(LS_TARGET) || 'grok', draft: '', repo: 'tyler467890/student-day-planner',
};
try { const s = JSON.parse(sessionStorage.getItem(SS)); if (s && s.token && s.expiresAt > Date.now() + 60000) conn.session = s; } catch {}

const rerender = () => window.dispatchEvent(new CustomEvent('nova:conn'));

// ---------- API ----------
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
export function apiLogout() { conn.session = null; conn.status = null; conn.inbox = []; sessionStorage.removeItem(SS); }
async function ensureSession() {
  if (conn.session && conn.session.expiresAt > Date.now() + 60000) return true;
  const pass = localStorage.getItem(LS_PASS);
  return pass ? apiLogin(pass) : false;
}
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
    conn.status = s; conn.inbox = Array.isArray(i.items) ? i.items : []; conn.err = '';
  } catch (e) { if (!conn.err) conn.err = 'Secure service unavailable.'; console.info('NOVA connections:', e.message); }
  conn.loading = false; rerender();
}
export const isOn = (integ) => !!(conn.status && conn.status.integrations && conn.status.integrations[integ] && conn.status.integrations[integ].configured);
const tgt = () => TARGETS.find((t) => t.id === conn.target) || TARGETS[0];

// ---------- command bar ----------
export function cmdBar(short) {
  const t = tgt(), on = isOn(t.integ), known = !!conn.status;
  const note = !conn.session && !known ? (conn.err ? 'Offline' : 'Connecting…') : known && !on ? 'Not connected yet' : '';
  return `<form class="cmd cmdbar" id="cmdform" autocomplete="off">
   <span class="cmdic">${svg(I.bolt, short ? 18 : 22)}</span>
   <label class="vh" for="cmdtarget">Send to</label>
   <select id="cmdtarget" class="cmdtarget" aria-label="Send to">${TARGETS.map((x) => `<option value="${x.id}" ${x.id === t.id ? 'selected' : ''}>${x.label}${conn.status && !isOn(x.integ) ? ' ·  off' : ''}</option>`).join('')}</select>
   <input id="cmdtext" class="cmdtext" type="text" maxlength="4000" placeholder="${short ? 'Ask your team…' : 'Ask your team…  e.g. “What’s left before the Etsy launch?”'}" aria-label="Ask your team" value="${esc(conn.draft)}">
   ${note ? `<span class="cmdnote ${known && !on ? 'off' : ''}" data-conn title="Open Connections">${esc(note)}</span>` : ''}
   <button class="cmdsend" type="submit" aria-label="Review and send">${svg(I.send, short ? 18 : 20)}</button>
  </form>`;
}
export function repliesStrip() {
  if (!conn.session && !conn.status) return '';
  const x = conn.inbox[0];
  return `<div class="replies"><span class="label">${svg(I.reply, 13)} Replies</span>
   ${x ? `<span class="rt">${esc(ago(x.time))}</span><span class="rx" title="${esc(x.text)}">${esc(x.text)}</span>` : '<span class="rx empty2">No replies yet. Your bots’ answers show up here.</span>'}
   ${conn.inbox.length ? `<button class="lnkbtn" data-replies>All ${conn.inbox.length}</button>` : ''}</div>`;
}
function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s)) return '';
  if (s < 60) return 'now'; if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return Math.round(s / 3600) + 'h';
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Halifax', month: 'short', day: 'numeric' }).format(new Date(iso));
}

// ---------- modals ----------
function modal(html, cls = '') {
  $('#modal') || document.body.insertAdjacentHTML('beforeend', '<div id="modal"></div>');
  $('#modal').innerHTML = `<div class="nmodal" data-mclose><div class="panel mbox ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  const f = $('#modal [autofocus]') || $('#modal button'); if (f) setTimeout(() => f.focus(), 30);
}
export const closeModal = () => { if ($('#modal')) $('#modal').innerHTML = ''; };
export function openConnections() {
  const s = conn.status;
  const rows = INTEGS.map(([k, n, d]) => {
    const on = isOn(k), needs = s && s.integrations[k] ? s.integrations[k].need : [];
    return `<div class="crow"><span class="dot ${!s ? 'idle' : on ? 'ok' : 'idle'}"></span><div class="grow"><b>${n}</b><div class="mutedt sm">${d}${!on && needs.length ? ` · needs <span class="mono">${needs.map(esc).join(', ')}</span>` : ''}</div></div>
     ${!s ? '<span class="badge dim">Unknown</span>' : on ? '<span class="badge ok">Connected</span>' : '<span class="badge dim">Not connected</span>'}</div>`;
  }).join('');
  const off = s && s.controls_off;
  modal(`<div class="ph"><h3>Connections<small>secure service</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div>
   <div class="svc"><span class="dot ${conn.session ? 'ok' : 'warn'}"></span><span class="mutedt sm">${conn.session ? 'Signed in to the NOVA secure service' : esc(conn.err || 'Not signed in to the secure service')}</span></div>
   <div class="clist">${rows}</div>
   ${s ? `<div class="crow ctl"><div class="grow"><b>Remote controls</b><div class="mutedt sm">${off ? 'Off: NOVA can’t send commands to any bot.' : 'On: commands ask you to confirm before sending.'}</div></div><button class="btn sm ${off ? '' : 'danger'}" data-controls="${off ? 'on' : 'off'}">${off ? 'Turn on' : 'Turn off'}</button></div>` : ''}
   <div class="mutedt sm" style="margin-top:0.875rem">Keys are stored only in the secure service, never in this site. Ask Grok Bot to connect one.</div>
   <div class="btns" style="margin-top:0.875rem"><button class="btn" data-connrefresh>${conn.loading ? 'Checking…' : 'Check again'}</button><button class="btn" data-mclose>Close</button></div>`, 'conn');
}
function openReplies() {
  modal(`<div class="ph"><h3>Replies<small>from your bots</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div>
   <div class="clist">${conn.inbox.map((x) => `<div class="crow"><div class="grow"><div class="mutedt sm">${esc(new Date(x.time).toLocaleString('en-US', { timeZone: 'America/Halifax', dateStyle: 'medium', timeStyle: 'short' }))} AT${x.request_id ? ' · ' + esc(String(x.request_id).slice(0, 8)) : ''}</div><div class="rfull">${esc(x.text)}</div></div></div>`).join('') || '<div class="empty">No replies yet.</div>'}</div>
   <div class="btns" style="margin-top:0.875rem"><button class="btn" data-mclose>Close</button></div>`);
}
function reviewCommand() {
  const t = tgt(), text = conn.draft.trim();
  if (!text) { $('#cmdtext') && $('#cmdtext').focus(); return; }
  if (!isOn(t.integ)) {
    modal(`<div class="ph"><h3>${esc(t.label)}<small>not connected</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div>
     <div class="notconn">${svg(I.plug, 26)}<div><b>Not connected yet</b><div class="mutedt sm">${esc(t.label)} isn’t linked to NOVA yet, so nothing was sent. Ask Grok Bot to connect it, then try again.</div></div></div>
     <div class="btns" style="margin-top:1rem"><button class="btn" data-conn>Connections</button><button class="btn" data-mclose>Close</button></div>`);
    return;
  }
  if (conn.status && conn.status.controls_off) { modal(`<div class="ph"><h3>Controls are off</h3><button class="x" data-mclose>✕</button></div><div class="mutedt">Turn remote controls back on in Connections to send commands.</div><div class="btns" style="margin-top:1rem"><button class="btn" data-conn>Connections</button></div>`); return; }
  const repos = (conn.status && conn.status.repos) || ['tyler467890/student-day-planner', 'tyler467890/nova'];
  const lim = conn.status && conn.status.limits && conn.status.limits[t.id];
  const what = t.id === 'grok' ? 'This sends the message below to your Grok Bot.' : t.id === 'cursor' ? 'This starts a new Cursor cloud agent that can change code and open a pull request.' : 'This opens a GitHub issue and assigns it to Copilot, which then starts working on it.';
  modal(`<div class="ph"><h3>Confirm<small>${esc(t.label)}</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div>
   <div class="mutedt" style="margin-bottom:0.75rem">${what}</div>
   ${t.repo ? `<label class="label" for="cmdrepo">Repository</label><select id="cmdrepo" class="msel">${repos.map((r) => `<option ${r === conn.repo ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>` : ''}
   <div class="label" style="margin-top:0.75rem">Message</div><div class="quote">${esc(text)}</div>
   ${lim ? `<div class="mutedt sm" style="margin-top:0.5rem">${lim.used} of ${lim.cap} used today</div>` : ''}
   <div class="cmderr" id="cmderr" role="alert"></div>
   <div class="btns" style="margin-top:1rem"><button class="btn pri" data-cmdconfirm autofocus>Send to ${esc(t.label)}</button><button class="btn" data-mclose>Cancel</button></div>`);
}
async function sendCommand(btn) {
  const t = tgt(), text = conn.draft.trim();
  const repoSel = $('#cmdrepo'); if (repoSel) conn.repo = repoSel.value;
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    let d, msg;
    if (t.id === 'grok') { d = await api('/grok/command', { method: 'POST', body: JSON.stringify({ text, target: 'grok' }) }); msg = 'Sent to Grok Bot. The reply will show under Replies.'; }
    else if (t.id === 'cursor') { d = await api('/cursor/agents', { method: 'POST', body: JSON.stringify({ prompt: text, repo: conn.repo, autoCreatePR: true }) }); msg = 'Cursor agent started.'; d.link = d.agent && d.agent.url; }
    else { const title = text.split('\n')[0].slice(0, 120); d = await api('/github/issue', { method: 'POST', body: JSON.stringify({ repo: conn.repo, title, body: text, assignCopilot: true }) }); msg = `Issue #${d.number} created${d.copilotAssigned ? ' and assigned to Copilot' : ' (Copilot couldn’t be assigned; check that it’s enabled for this repo)'}.`; d.link = d.url; }
    conn.draft = '';
    const link = safeUrl(d.link || '');
    modal(`<div class="ph"><h3>Sent<small>${esc(t.label)}</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div><div>${esc(msg)}</div>${link ? `<div class="btns" style="margin-top:0.875rem"><a class="btn" href="${esc(link)}" target="_blank" rel="noopener">Open</a></div>` : ''}<div class="btns" style="margin-top:0.875rem"><button class="btn" data-mclose autofocus>Done</button></div>`);
    refreshConn();
  } catch (e) {
    const d = e.data || {};
    const m = e.status === 503 ? 'Not connected yet.' : e.status === 429 ? (d.message || 'Daily limit reached.') : e.status === 423 ? 'Controls are switched off.' : e.status === 403 ? 'That repository isn’t allowed.' : 'Couldn’t send: ' + e.message;
    const el = $('#cmderr'); if (el) el.textContent = m;
    btn.disabled = false; btn.textContent = 'Send to ' + t.label;
  }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-conn],[data-mclose],[data-replies],[data-connrefresh],[data-controls],[data-cmdconfirm]');
  if (!t) return;
  if (t.hasAttribute('data-mclose')) { if (e.target === t || e.target.closest('button[data-mclose]')) closeModal(); return; }
  if (t.hasAttribute('data-conn')) { e.preventDefault(); openConnections(); if (!conn.status) { await refreshConn(); if ($('#modal .conn')) openConnections(); } }
  else if (t.hasAttribute('data-replies')) openReplies();
  else if (t.hasAttribute('data-connrefresh')) { conn.loading = true; openConnections(); await refreshConn(); openConnections(); }
  else if (t.hasAttribute('data-controls')) {
    const off = t.getAttribute('data-controls') === 'off';
    if (off || confirm('Turn remote controls back on?')) { try { await api('/controls', { method: 'POST', body: JSON.stringify({ off }) }); } catch {} await refreshConn(); openConnections(); }
  } else if (t.hasAttribute('data-cmdconfirm')) sendCommand(t);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#modal') && $('#modal').innerHTML) closeModal(); });
document.addEventListener('input', (e) => { if (e.target.id === 'cmdtext') conn.draft = e.target.value; });
document.addEventListener('change', (e) => {
  if (e.target.id === 'cmdtarget') { conn.target = e.target.value; localStorage.setItem(LS_TARGET, conn.target); rerender(); setTimeout(() => $('#cmdtext') && $('#cmdtext').focus(), 0); }
  if (e.target.id === 'cmdrepo') conn.repo = e.target.value;
});
document.addEventListener('submit', (e) => { if (e.target.id === 'cmdform') { e.preventDefault(); conn.draft = $('#cmdtext').value; reviewCommand(); } });
