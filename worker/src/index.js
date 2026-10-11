// nova-api: secure backend for NOVA. Holds all integration keys; the NOVA site holds none.
// Secrets (set with `wrangler secret put`, never committed):
//   NOVA_PASSPHRASE_HASH  pbkdf2-sha256$<iter>$<salt b64>$<hash b64>
//   SESSION_KEY           HMAC key for 12h session tokens
//   INBOX_KEY             bearer key the Grok Bot uses for POST /inbox/result
//   GITHUB_TOKEN, CURSOR_API_KEY, GROK_WEBHOOK_URL, GROK_WEBHOOK_KEY, NOTION_TOKEN, NOTION_TASKS_DB (optional integrations)
//   BRIGHTSPACE_ICAL_URL  private NSCC Brightspace calendar feed (.ics) for GET /school/assignments
// Phone (NOVA 2.3): POST /pair/start -> one-time pairing token (5 min) shown as a QR on the desktop; the phone trades it at
// POST /pair/claim for its own revocable device token. GET /sync is a WebSocket into the NovaRoom Durable Object, which
// relays the desktop's screen messages to the phone and back (hibernation API, nothing stored but the device list).

const SESSION_TTL = 12 * 3600;            // seconds
const LOGIN_MAX = 5, LOGIN_WINDOW = 900;  // 5 wrong tries per 15 minutes per IP (IPv6: per /48)
const LOGIN_GLOBAL_MAX = 20;              // and 20 wrong tries per 15 minutes in total, from anywhere
const INBOX_MAX = 50, AUDIT_MAX = 200;
const MAX_TEXT = 8000;
const TZ = 'America/Halifax';

const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64u = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64ud = (s) => b64d(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
const normPass = (p) => String(p || '').trim().toLowerCase().replace(/\s+/g, '-');

class HttpError extends Error { constructor(status, body) { super(body.error || 'error'); this.status = status; this.body = body; } }
const fail = (status, error, extra = {}) => { throw new HttpError(status, { error, ...extra }); };

// ---------- CORS ----------
function originAllowed(origin, env) {
  if (!origin) return false;
  if (origin === (env.ALLOWED_ORIGIN || 'https://tyler467890.github.io')) return true;
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}
function corsHeaders(origin, env) {
  if (!originAllowed(origin, env)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}
function json(body, status, origin, env, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...corsHeaders(origin, env), ...extra,
    },
  });
}

// ---------- crypto helpers ----------
function timingSafeEq(a, b) {
  const x = typeof a === 'string' ? enc.encode(a) : new Uint8Array(a);
  const y = typeof b === 'string' ? enc.encode(b) : new Uint8Array(b);
  if (x.byteLength !== y.byteLength) { crypto.subtle.timingSafeEqual(x, x); return false; }
  return crypto.subtle.timingSafeEqual(x, y);
}
async function pbkdf2(pass, salt, iter) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, k, 256);
}
async function checkPassphrase(pass, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2-sha256' || !iter || !salt || !hash) fail(503, 'not_configured', { configured: false, need: 'NOVA_PASSPHRASE_HASH' });
  const got = await pbkdf2(normPass(pass), b64d(salt), Number(iter));
  return timingSafeEq(got, b64d(hash));
}
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
async function makeSession(env, extra = null, ttl = SESSION_TTL) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(enc.encode(JSON.stringify({ sub: 'tyler', iat: now, exp: now + ttl, n: crypto.randomUUID(), ...(extra || {}) })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_KEY), enc.encode(payload));
  return { token: payload + '.' + b64u(sig), expiresAt: (now + ttl) * 1000 };
}
async function verifyToken(tok, env) {
  if (!env.SESSION_KEY) fail(503, 'not_configured', { configured: false, need: 'SESSION_KEY' });
  const m = String(tok || '').match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) fail(401, 'unauthorized');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_KEY), b64ud(m[2]), enc.encode(m[1])); } catch { ok = false; }
  if (!ok) fail(401, 'unauthorized');
  let p; try { p = JSON.parse(new TextDecoder().decode(b64ud(m[1]))); } catch { fail(401, 'unauthorized'); }
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now() / 1000) fail(401, 'session_expired');
  // a phone's device token is only good while the device is still paired (revocable in Settings > Devices)
  if (p.typ === 'dev') { const d = await roomCall(env, '/device/check', { id: p.dev }); if (!d.ok) fail(401, 'device_revoked'); }
  else if (p.typ) fail(401, 'unauthorized');
  return p;
}
async function verifySession(req, env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (\S+)$/);
  if (!m) fail(401, 'unauthorized');
  return verifyToken(m[1], env);
}
// pairing, device management and remote controls need the full (passphrase) session, not a phone's device token
const requireDesktop = (p) => { if (p.typ === 'dev') fail(403, 'desktop_only', { message: 'Do this from NOVA on your computer.' }); };

// ---------- KV helpers ----------
const kvJson = async (env, key, dflt) => { try { return (await env.NOVA_KV.get(key, 'json')) ?? dflt; } catch { return dflt; } };
async function pushList(env, key, item, max) {
  const list = await kvJson(env, key, []);
  list.unshift(item);
  await env.NOVA_KV.put(key, JSON.stringify(list.slice(0, max)));
}
const audit = (env, route, summary) => pushList(env, 'audit', { route, time: new Date().toISOString(), summary: String(summary).slice(0, 200) }, AUDIT_MAX);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
async function takeDaily(env, name, cap) {
  const key = `cap:${name}:${today()}`;
  const n = Number(await env.NOVA_KV.get(key)) || 0;
  if (n >= cap) fail(429, 'daily_cap_reached', { cap, used: n, message: `Daily limit of ${cap} reached. Try again tomorrow.` });
  await env.NOVA_KV.put(key, String(n + 1), { expirationTtl: 2 * 86400 });
  return n + 1;
}
async function usedDaily(env, name) { return Number(await env.NOVA_KV.get(`cap:${name}:${today()}`)) || 0; }

// ---------- request helpers ----------
async function body(req) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (len > 64 * 1024) fail(413, 'too_large');
  const t = await req.text();
  if (t.length > 64 * 1024) fail(413, 'too_large');
  try { return t ? JSON.parse(t) : {}; } catch { fail(400, 'invalid_json'); }
}
const str = (v, name, max = MAX_TEXT, req = true) => {
  if (v == null || v === '') { if (req) fail(400, 'missing_' + name); return ''; }
  if (typeof v !== 'string') fail(400, 'invalid_' + name);
  const s = v.trim(); if (req && !s) fail(400, 'missing_' + name);
  if (s.length > max) fail(400, name + '_too_long', { max });
  return s;
};
const allowlist = (env) => String(env.REPO_ALLOWLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
function repoOk(env, repo) {
  const r = String(repo || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '').toLowerCase();
  if (!allowlist(env).includes(r)) fail(403, 'repo_not_allowed', { allowed: allowlist(env) });
  return r;
}
const need = (env, ...names) => { const miss = names.filter((n) => !env[n]); if (miss.length) fail(503, 'not_configured', { configured: false, need: miss[0], missing: miss }); };
async function requireControlsOn(env) { if ((await env.NOVA_KV.get('controls_off')) === '1') fail(423, 'controls_off', { message: 'Controls are switched off. Turn them back on in NOVA to send commands.' }); }
async function upstream(r, name) {
  const text = await r.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
  if (!r.ok) fail(r.status === 404 ? 404 : 502, name + '_error', { status: r.status, detail: (data && (data.message || data.error)) || null });
  return data;
}

// ---------- GitHub ----------
const ghHeaders = (env) => ({ Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'nova-api' });
async function githubIssue(req, env) {
  need(env, 'GITHUB_TOKEN'); await requireControlsOn(env);
  const b = await body(req);
  const repo = repoOk(env, b.repo), title = str(b.title, 'title', 256), text = str(b.body, 'body', MAX_TEXT, false);
  const copilot = b.assignCopilot === true;
  if (copilot) await takeDaily(env, 'copilot', Number(env.COPILOT_DAILY_CAP) || 10);
  const payload = { title, body: (text ? text + '\n\n' : '') + '_Sent from NOVA._' };
  if (copilot) {
    payload.assignees = ['copilot-swe-agent[bot]'];
    payload.agent_assignment = { target_repo: repo, base_branch: 'main', custom_instructions: '', custom_agent: '', model: '' };
  }
  const r = await fetch(`https://api.github.com/repos/${repo}/issues`, { method: 'POST', headers: { ...ghHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const d = await upstream(r, 'github');
  const assigned = (d.assignees || []).map((a) => a.login);
  await audit(env, 'POST /github/issue', `${repo}#${d.number} ${copilot ? '(Copilot) ' : ''}${title}`);
  return { ok: true, number: d.number, url: d.html_url, assignees: assigned, copilotAssigned: copilot ? assigned.some((l) => /copilot/i.test(l)) : false };
}
async function repoIds(env) {
  let ids = await kvJson(env, 'gh:repoids', null);
  if (ids) return ids;
  ids = {};
  for (const r of allowlist(env)) {
    try { const x = await fetch('https://api.github.com/repos/' + r, { headers: ghHeaders(env) }); if (x.ok) ids[(await x.json()).id] = r; } catch {}
  }
  await env.NOVA_KV.put('gh:repoids', JSON.stringify(ids), { expirationTtl: 86400 });
  return ids;
}
async function copilotTasks(env) {
  need(env, 'GITHUB_TOKEN');
  const allowed = allowlist(env);
  try {
    const r = await fetch('https://api.github.com/agents/tasks?per_page=30', { headers: ghHeaders(env) });
    if (r.ok) {
      const d = await r.json(), ids = await repoIds(env);
      const list = Array.isArray(d) ? d : d.tasks || d.items || [];
      return { source: 'agent_tasks', tasks: list.map((t) => {
        const rid = t.repository && t.repository.id, art = (t.artifacts || []).find((a) => a && (a.html_url || a.url));
        return { id: t.id, state: t.state, title: t.name || '', repo: (t.repository && t.repository.full_name) || ids[rid] || '', repo_id: rid || 0, url: art ? (art.html_url || art.url) : '', updated_at: t.updated_at || t.created_at || '' };
      }).filter((t) => !t.repo_id || ids[t.repo_id] || allowed.includes(String(t.repo).toLowerCase())) };
    }
  } catch {}
  const q = encodeURIComponent('is:pr author:app/copilot-swe-agent ' + allowed.map((x) => 'repo:' + x).join(' '));
  const r = await fetch(`https://api.github.com/search/issues?q=${q}&sort=updated&order=desc&per_page=20`, { headers: ghHeaders(env) });
  const d = await upstream(r, 'github');
  return { source: 'pull_requests', tasks: (d.items || []).map((p) => ({ id: p.number, state: p.state + (p.draft ? ' (draft)' : ''), title: p.title, repo: (p.repository_url || '').split('/repos/')[1] || '', url: p.html_url, updated_at: p.updated_at })) };
}

// ---------- Cursor ----------
const cursorHeaders = (env) => ({ Authorization: 'Bearer ' + env.CURSOR_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'nova-api' });
const CURSOR = 'https://api.cursor.com/v1';
const agentId = (id) => { if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) fail(400, 'invalid_agent_id'); return id; };
async function cursorList(env) {
  need(env, 'CURSOR_API_KEY');
  const d = await upstream(await fetch(CURSOR + '/agents?limit=20', { headers: cursorHeaders(env) }), 'cursor');
  return { agents: (d.items || []).map((a) => ({ id: a.id, name: a.name, status: a.status, url: a.url, updatedAt: a.updatedAt, latestRunId: a.latestRunId })), used_today: await usedDaily(env, 'cursor'), cap: Number(env.CURSOR_DAILY_CAP) || 10 };
}
async function cursorGet(env, id) {
  need(env, 'CURSOR_API_KEY');
  const a = await upstream(await fetch(`${CURSOR}/agents/${agentId(id)}`, { headers: cursorHeaders(env) }), 'cursor');
  let run = null;
  if (a.latestRunId) { try { run = await upstream(await fetch(`${CURSOR}/agents/${agentId(id)}/runs/${encodeURIComponent(a.latestRunId)}`, { headers: cursorHeaders(env) }), 'cursor'); } catch {} }
  return { agent: a, run };
}
async function cursorCreate(req, env) {
  need(env, 'CURSOR_API_KEY'); await requireControlsOn(env);
  const b = await body(req);
  const prompt = str(b.prompt, 'prompt'), repo = repoOk(env, b.repo);
  await takeDaily(env, 'cursor', Number(env.CURSOR_DAILY_CAP) || 10);
  const payload = { prompt: { text: prompt }, repos: [{ url: 'https://github.com/' + repo, startingRef: 'main' }], autoCreatePR: b.autoCreatePR !== false };
  const d = await upstream(await fetch(CURSOR + '/agents', { method: 'POST', headers: cursorHeaders(env), body: JSON.stringify(payload) }), 'cursor');
  await audit(env, 'POST /cursor/agents', `${repo}: ${prompt.slice(0, 120)}`);
  return { ok: true, agent: d.agent, run: d.run };
}
async function cursorFollowup(req, env, id) {
  need(env, 'CURSOR_API_KEY'); await requireControlsOn(env);
  const b = await body(req); const prompt = str(b.prompt, 'prompt');
  const d = await upstream(await fetch(`${CURSOR}/agents/${agentId(id)}/runs`, { method: 'POST', headers: cursorHeaders(env), body: JSON.stringify({ prompt: { text: prompt } }) }), 'cursor');
  await audit(env, 'POST /cursor/agents/:id/followup', `${id}: ${prompt.slice(0, 120)}`);
  return { ok: true, run: d.run };
}

// ---------- Grok Bot ----------
async function grokCommand(req, env) {
  need(env, 'GROK_WEBHOOK_URL', 'GROK_WEBHOOK_KEY'); await requireControlsOn(env);
  const b = await body(req);
  const text = str(b.text, 'text'), target = str(b.target, 'target', 100, false) || 'grok';
  let url; try { url = new URL(env.GROK_WEBHOOK_URL); } catch { fail(503, 'not_configured', { configured: false, need: 'GROK_WEBHOOK_URL' }); }
  if (url.protocol !== 'https:') fail(503, 'not_configured', { configured: false, need: 'GROK_WEBHOOK_URL' });
  await takeDaily(env, 'grok', Number(env.GROK_DAILY_CAP) || 50);
  const request_id = crypto.randomUUID();
  const r = await fetch(url.href, { method: 'POST', headers: { Authorization: 'Bearer ' + env.GROK_WEBHOOK_KEY, 'Content-Type': 'application/json', 'User-Agent': 'nova-api' }, body: JSON.stringify({ task: text, request_id, from: 'nova', target }) });
  if (!r.ok) fail(502, 'grok_error', { status: r.status });
  await audit(env, 'POST /grok/command', `${request_id.slice(0, 8)} → ${target}: ${text.slice(0, 120)}`);
  return { ok: true, request_id };
}
async function inboxResult(req, env) {
  if (!env.INBOX_KEY) fail(503, 'not_configured', { configured: false, need: 'INBOX_KEY' });
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (!m || !timingSafeEq(m[1], env.INBOX_KEY)) fail(401, 'unauthorized');
  const b = await body(req);
  const item = { request_id: str(b.request_id, 'request_id', 100, false) || null, text: str(b.text, 'text'), time: new Date().toISOString() };
  await pushList(env, 'inbox', item, INBOX_MAX);
  try { await roomCall(env, '/notify', { t: 'inbox', time: item.time }); } catch {} // push: connected screens refetch /inbox now
  return { ok: true };
}

// ---------- Notion ----------
async function notionTasks(env) {
  need(env, 'NOTION_TOKEN', 'NOTION_TASKS_DB');
  const db = String(env.NOTION_TASKS_DB).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(db)) fail(503, 'not_configured', { configured: false, need: 'NOTION_TASKS_DB' });
  const r = await fetch(`https://api.notion.com/v1/databases/${db}/query`, { method: 'POST', headers: { Authorization: 'Bearer ' + env.NOTION_TOKEN, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: JSON.stringify({ page_size: 50 }) });
  const d = await upstream(r, 'notion');
  const tasks = (d.results || []).map((p) => {
    const props = p.properties || {};
    let title = '', status = '';
    const entries = Object.entries(props);
    for (const [, v] of entries) if (v.type === 'title') title = (v.title || []).map((t) => t.plain_text).join('');
    const st = entries.find(([, v]) => v.type === 'status') || entries.find(([k, v]) => v.type === 'select' && /status/i.test(k));
    if (st) status = st[1].type === 'status' ? (st[1].status ? st[1].status.name : '') : (st[1].select ? st[1].select.name : '');
    else { const cb = entries.find(([, v]) => v.type === 'checkbox'); if (cb) status = cb[1].checkbox ? 'Done' : 'To do'; }
    return { title, status, url: p.url };
  });
  return { tasks };
}

// ---------- School: Brightspace calendar feed (iCal) ----------
// The feed URL is a secret (it carries a private token). Parsed items are cached in KV for 30 minutes; the URL never leaves the Worker.
const SCHOOL_TTL = 30 * 60 * 1000, SCHOOL_RECENT_DAYS = 30, SCHOOL_AHEAD_DAYS = 180;
const BS_HOST = /(^|\.)brightspace\.com$/i;
function icsUnescape(v) { return String(v).replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c)); }
// UTC offset (minutes) of a time zone at a given instant
function tzOffset(tz, ms) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = (t) => +parts.find((p) => p.type === t).value;
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000) / 60000;
}
// wall-clock time in `tz` -> epoch ms (two passes to settle across DST changes)
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let ms = guess - tzOffset(tz, guess) * 60000;
  ms = guess - tzOffset(tz, ms) * 60000;
  return ms;
}
const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
// -> { ms, allDay, date } ; date is YYYY-MM-DD for all-day values
function icsDate(value, params) {
  const v = String(value || '').trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m || params.VALUE === 'DATE') {
    m = m || v.match(/^(\d{4})(\d{2})(\d{2})/); if (!m) return null;
    // an all-day item counts as due at the end of that day, Halifax time
    return { ms: zonedToUtc(+m[1], +m[2], +m[3], 23, 59, 0, TZ), allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/); if (!m) return null;
  const [y, mo, d, h, mi, s = '0'] = m.slice(1, 7).map((x) => +x || 0);
  if (m[7]) return { ms: Date.UTC(y, mo - 1, d, h, mi, s), allDay: false };
  let tz = String(params.TZID || '').replace(/^"|"$/g, '').replace(/^\/[^/]*\//, '');
  if (!tz || !validTz(tz)) tz = TZ; // floating times (or an unknown zone) are read as Halifax time
  return { ms: zonedToUtc(y, mo, d, h, mi, s, tz), allDay: false };
}
function parseIcs(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n'); // unfold folded lines
  const events = []; let cur = null, calName = '';
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    const i = line.search(/[:;]/); if (i < 1) continue;
    const name = line.slice(0, i).toUpperCase();
    // params up to the first ':' that isn't inside quotes
    let j = i, q = false; for (; j < line.length; j++) { const c = line[j]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
    const params = {}; line.slice(i, j).split(';').slice(1).forEach((p) => { const k = p.indexOf('='); if (k > 0) params[p.slice(0, k).toUpperCase()] = p.slice(k + 1); });
    const value = line.slice(j + 1);
    if (!cur) { if (name === 'X-WR-CALNAME') calName = icsUnescape(value); continue; }
    if (!(name in cur)) cur[name] = { value, params };
  }
  return { calName, events };
}
const bsUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && BS_HOST.test(x.hostname) ? x.href : ''; } catch { return ''; } };
function schoolItem(ev) {
  const val = (k) => (ev[k] ? icsUnescape(ev[k].value) : '');
  const start = ev.DTSTART ? icsDate(ev.DTSTART.value, ev.DTSTART.params) : null;
  const end = ev.DTEND ? icsDate(ev.DTEND.value, ev.DTEND.params) : null;
  const due = end && start && !start.allDay ? (end.ms >= start.ms ? end : start) : start || end; // Brightspace due items have DTSTART = DTEND
  if (!due) return null;
  const summary = val('SUMMARY').trim();
  const km = summary.match(/\s+-\s+(Due|Available|Availability Ends|Start Date|End Date|Starts|Ends)$/i);
  const title = km ? summary.slice(0, km.index).trim() : summary;
  // NSCC LOCATION looks like "WEBD1000/2795/Website Development(B)/Kristiansen,David"
  const loc = val('LOCATION').trim(), parts = loc.split('/');
  let course = null;
  if (parts.length >= 3 && /^[A-Z]{2,6}\s?\d{3,5}[A-Z]?$/i.test(parts[0].trim())) {
    const raw = parts[2].trim(), sm = raw.match(/^(.*?)\s*\(([A-Z0-9]{1,3})\)$/);
    course = { code: parts[0].trim(), name: sm ? sm[1] : raw, section: sm ? sm[2] : '', instructor: (parts[3] || '').split(',').reverse().join(' ').trim() };
  } else if (loc) course = { code: '', name: loc, section: '', instructor: '' };
  let desc = val('DESCRIPTION');
  let url = bsUrl(val('URL'));
  const vm = desc.match(/View event - (https:\/\/\S+)/); if (!url && vm) url = bsUrl(vm[1]);
  desc = desc.replace(/\n*View event - https:\/\/\S+\s*$/, '').replace(/\n{3,}/g, '\n\n').trim();
  const om = (url || desc).match(/[?&]ou=(\d{1,10})/);
  if (course && om) course.ou = om[1];
  return {
    id: val('UID').slice(0, 120) || summary.slice(0, 120), title: title.slice(0, 300), kind: km ? km[1].replace(/\b\w/g, (c) => c.toUpperCase()) : '',
    due: new Date(due.ms).toISOString().replace(/\.\d{3}Z$/, 'Z'), allDay: !!due.allDay, ...(due.allDay ? { date: due.date } : {}),
    course, description: desc.slice(0, 2000), url,
  };
}
async function schoolFetch(env) {
  let u; try { u = new URL(env.BRIGHTSPACE_ICAL_URL); } catch { fail(503, 'not_configured', { configured: false, need: 'BRIGHTSPACE_ICAL_URL' }); }
  if (u.protocol !== 'https:' || !BS_HOST.test(u.hostname)) fail(503, 'not_configured', { configured: false, need: 'BRIGHTSPACE_ICAL_URL' });
  let r; try { r = await fetch(u.href, { headers: { 'User-Agent': 'nova-api', Accept: 'text/calendar' }, redirect: 'follow' }); } catch { fail(502, 'brightspace_error', { status: 0 }); }
  if (!r.ok) fail(502, 'brightspace_error', { status: r.status });
  const text = await r.text();
  if (!/BEGIN:VCALENDAR/.test(text.slice(0, 2000))) fail(502, 'brightspace_error', { status: r.status, detail: 'not a calendar' });
  const { calName, events } = parseIcs(text.slice(0, 2 * 1024 * 1024));
  const items = events.map(schoolItem).filter(Boolean);
  return { at: Date.now(), calendar: calName.slice(0, 200), items };
}
async function schoolAssignments(env, url) {
  need(env, 'BRIGHTSPACE_ICAL_URL');
  let c = await kvJson(env, 'school:bs', null), stale = false, err = null;
  const fresh = url.searchParams.get('fresh') === '1' && (!c || Date.now() - c.at > 2 * 60 * 1000); // forced refresh at most every 2 min
  if (!c || fresh || Date.now() - c.at > SCHOOL_TTL) {
    try { c = await schoolFetch(env); await env.NOVA_KV.put('school:bs', JSON.stringify(c), { expirationTtl: 7 * 86400 }); }
    catch (e) { if (!c) throw e; stale = true; err = (e.body && e.body.error) || 'brightspace_error'; } // serve the last good copy
  }
  const now = Date.now(), lo = now - SCHOOL_RECENT_DAYS * 864e5, hi = now + SCHOOL_AHEAD_DAYS * 864e5;
  const t = (x) => Date.parse(x.due);
  const items = c.items.map((x) => ({ ...x, due: String(x.due).replace(/\.\d{3}Z$/, 'Z') })).filter((x) => t(x) >= lo && t(x) <= hi).sort((a, b) => t(a) - t(b) || a.title.localeCompare(b.title));
  const upcoming = items.filter((x) => t(x) >= now), recent = items.filter((x) => t(x) < now).reverse();
  const within = (d) => upcoming.filter((x) => t(x) <= now + d * 864e5 && /^(due|)$/i.test(x.kind)).length;
  const courses = {}; c.items.forEach((x) => { if (x.course && x.course.code && !courses[x.course.code]) courses[x.course.code] = x.course; });
  return {
    source: 'brightspace', calendar: c.calendar, fetchedAt: new Date(c.at).toISOString(), stale, ...(err ? { error: err } : {}),
    timezone: TZ, now: new Date(now).toISOString(),
    counts: { total: c.items.length, upcoming: upcoming.length, recent: recent.length, due_3d: within(3), due_7d: within(7), due_14d: within(14) },
    courses: Object.values(courses).sort((a, b) => a.code.localeCompare(b.code)),
    upcoming, recent,
  };
}
// The bot (NOVA command intake) may read assignments with the INBOX_KEY instead of a session. Read-only, this route only.
async function schoolAuth(req, env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer (.+)$/);
  if (m && env.INBOX_KEY && !m[1].includes('.') && timingSafeEq(m[1], env.INBOX_KEY)) return 'bot';
  await verifySession(req, env); return 'session';
}

// ---------- status ----------
async function status(env) {
  const has = (...n) => n.every((k) => !!env[k]);
  return {
    configured: true,
    integrations: {
      github: { configured: has('GITHUB_TOKEN'), need: ['GITHUB_TOKEN'] },
      copilot: { configured: has('GITHUB_TOKEN'), need: ['GITHUB_TOKEN'] },
      cursor: { configured: has('CURSOR_API_KEY'), need: ['CURSOR_API_KEY'] },
      grok: { configured: has('GROK_WEBHOOK_URL', 'GROK_WEBHOOK_KEY'), need: ['GROK_WEBHOOK_URL', 'GROK_WEBHOOK_KEY'] },
      notion: { configured: has('NOTION_TOKEN', 'NOTION_TASKS_DB'), need: ['NOTION_TOKEN', 'NOTION_TASKS_DB'] },
      inbox: { configured: has('INBOX_KEY'), need: ['INBOX_KEY'] },
      brightspace: { configured: has('BRIGHTSPACE_ICAL_URL'), need: ['BRIGHTSPACE_ICAL_URL'] },
    },
    controls_off: (await env.NOVA_KV.get('controls_off')) === '1',
    repos: allowlist(env),
    limits: {
      cursor: { used: await usedDaily(env, 'cursor'), cap: Number(env.CURSOR_DAILY_CAP) || 10 },
      copilot: { used: await usedDaily(env, 'copilot'), cap: Number(env.COPILOT_DAILY_CAP) || 10 },
      grok: { used: await usedDaily(env, 'grok'), cap: Number(env.GROK_DAILY_CAP) || 50 },
    },
    time: new Date().toISOString(),
  };
}


// ---------- Phone: pairing, devices and the sync room (one NovaRoom Durable Object for Tyler) ----------
const PAIR_TTL = 5 * 60 * 1000;            // a pairing QR / code works once, for 5 minutes
const DEVICE_TTL = 180 * 86400;            // a phone's device token lasts 180 days unless revoked sooner
const MAX_DEVICES = 5, MAX_SOCKETS = 12, MAX_MSG = 512 * 1024;
const PAIR_FAIL_MAX = 10;                  // wrong pairing codes per 15 min per IP
const PAIR_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 8 typed characters (40 bits), no 0/O/1/I
const RELAY = new Set(['snap', 'layout', 'flash', 'ping', 'scr', 'chat', 'hello']); // the BroadcastChannel messages that cross devices
const DESKTOP_ONLY = new Set(['snap', 'scr']);
const sha = async (s) => b64u(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
const roomStub = (env) => env.NOVA_ROOM.get(env.NOVA_ROOM.idFromName('tyler'));
async function roomCall(env, path, data) {
  const r = await roomStub(env).fetch('https://room' + path, { method: 'POST', body: JSON.stringify(data || {}) });
  return r.json();
}
const devName = (v) => String(v || '').replace(/[^\w .,'()+-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Phone';
const limiter = async (env, name, op, max) => (await env.LOGIN_LIMITER.get(env.LOGIN_LIMITER.idFromName(name)).fetch(`https://limiter/${op}?max=${max}`, { method: 'POST' })).json();
const ipBucket = (req) => { const ip = req.headers.get('CF-Connecting-IP') || 'unknown'; return ip.includes(':') ? ip.split(':').slice(0, 3).join(':') + '::/48' : ip; };

export class NovaRoom {
  constructor(state, env) {
    this.state = state; this.env = env;
    // keep-alive pings are answered without waking the object (hibernation stays cheap)
    try { state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch {}
  }
  async devices() { return (await this.state.storage.get('devices')) || {}; }
  online() { return this.state.getWebSockets().filter((w) => w.readyState === 1).map((w) => ({ w, a: w.deserializeAttachment() || {} })); }
  send(w, m) { try { w.send(typeof m === 'string' ? m : JSON.stringify(m)); } catch {} }
  broadcast(m, skip = []) { const s = JSON.stringify(m); for (const { w } of this.online()) if (!skip.includes(w)) this.send(w, s); }
  presence(skip = []) {
    const live = this.online().filter(({ w }) => !skip.includes(w)), seen = new Set(), phones = [];
    live.forEach(({ a }) => { if (a.kind === 'phone' && !seen.has(a.dev)) { seen.add(a.dev); phones.push({ id: a.dev, name: a.name }); } });
    const m = JSON.stringify({ t: 'presence', desktop: live.filter(({ a }) => a.kind === 'desktop').length, phones });
    live.forEach(({ w }) => this.send(w, m));
  }
  kick(dev) {
    const gone = this.state.getWebSockets('dev:' + dev);
    gone.forEach((w) => { this.send(w, { t: 'revoked' }); try { w.close(4001, 'revoked'); } catch {} });
    return gone;
  }
  async fetch(req) {
    const op = new URL(req.url).pathname, st = this.state.storage, now = Date.now();
    if (op === '/ws') return this.accept(req);
    const b = await req.json().catch(() => ({}));
    if (op === '/pair/start') {
      const pairs = ((await st.get('pairs')) || []).filter((x) => x.exp > now).slice(-2); // at most 3 open codes
      const token = b64u(crypto.getRandomValues(new Uint8Array(32)));
      const code = [...crypto.getRandomValues(new Uint8Array(8))].map((x) => PAIR_ALPHA[x & 31]).join('');
      pairs.push({ th: await sha(token), ch: await sha(code), exp: now + PAIR_TTL });
      await st.put('pairs', pairs);
      return Response.json({ token, code, expiresAt: now + PAIR_TTL });
    }
    if (op === '/pair/claim') {
      const pairs = ((await st.get('pairs')) || []).filter((x) => x.exp > now), h = await sha(b.secret || '');
      const i = pairs.findIndex((x) => timingSafeEq(x.th, h) | timingSafeEq(x.ch, h));
      if (i >= 0) pairs.splice(i, 1); // one use only
      await st.put('pairs', pairs);
      if (i < 0) return Response.json({ ok: false });
      const devs = await this.devices();
      for (const [k, d] of Object.entries(devs)) if (d.exp < now) delete devs[k];
      const ids = Object.keys(devs).sort((x, y) => devs[x].lastSeen - devs[y].lastSeen);
      const kicked = [];
      while (ids.length >= MAX_DEVICES) { const old = ids.shift(); delete devs[old]; kicked.push(...this.kick(old)); }
      const id = b64u(crypto.getRandomValues(new Uint8Array(9)));
      devs[id] = { name: devName(b.name), created: now, lastSeen: now, exp: now + DEVICE_TTL * 1000 };
      await st.put('devices', devs);
      if (kicked.length) this.presence(kicked);
      this.broadcast({ t: 'paired', device: { id, name: devs[id].name } });
      return Response.json({ ok: true, id, name: devs[id].name });
    }
    if (op === '/device/check') {
      const devs = await this.devices(), d = devs[b.id];
      if (!d || d.exp < now) return Response.json({ ok: false });
      if (now - d.lastSeen > 10 * 60 * 1000) { d.lastSeen = now; await st.put('devices', devs); }
      return Response.json({ ok: true });
    }
    if (op === '/devices') {
      const devs = await this.devices(), on = new Set(this.online().filter(({ a }) => a.kind === 'phone').map(({ a }) => a.dev));
      return Response.json({ devices: Object.entries(devs).filter(([, d]) => d.exp > now).map(([id, d]) => ({ id, name: d.name, created: d.created, lastSeen: on.has(id) ? now : d.lastSeen, expires: d.exp, online: on.has(id) })).sort((x, y) => y.created - x.created),
        desktop: this.online().filter(({ a }) => a.kind === 'desktop').length });
    }
    if (op === '/devices/revoke') {
      const devs = await this.devices(), had = !!devs[b.id];
      delete devs[b.id]; await st.put('devices', devs);
      const gone = this.kick(b.id); this.presence(gone);
      return Response.json({ ok: true, had });
    }
    if (op === '/notify') { this.broadcast({ t: b.t === 'inbox' ? 'inbox' : 'notice', time: String(b.time || '') }); return Response.json({ ok: true }); }
    return new Response('not found', { status: 404 });
  }
  async accept(req) {
    const kind = req.headers.get('X-Nova-Kind') === 'phone' ? 'phone' : 'desktop', dev = kind === 'phone' ? req.headers.get('X-Nova-Dev') || '' : 'desktop';
    let name = 'Computer';
    if (kind === 'phone') {
      const devs = await this.devices(), d = devs[dev];
      if (!d) return new Response('revoked', { status: 401 });
      name = d.name; d.lastSeen = Date.now(); await this.state.storage.put('devices', devs);
      // the same phone reconnecting: drop its older socket so it isn't counted twice
      this.state.getWebSockets('dev:' + dev).forEach((w) => { try { w.close(4000, 'replaced'); } catch {} });
    }
    const stale = kind === 'phone' ? this.state.getWebSockets('dev:' + dev) : [];
    const live = this.state.getWebSockets().filter((w) => !stale.includes(w));
    if (live.length >= MAX_SOCKETS) return new Response('busy', { status: 429 });
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server, [kind, 'dev:' + dev]);
    server.serializeAttachment({ kind, dev, name, at: Date.now() });
    this.presence(stale);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'nova-sync' } });
  }
  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > MAX_MSG) return;
    let m; try { m = JSON.parse(msg); } catch { return; }
    if (!m || typeof m !== 'object' || !RELAY.has(m.t)) return;
    const a = ws.deserializeAttachment() || {};
    if (DESKTOP_ONLY.has(m.t) && a.kind !== 'desktop') return;
    m.from = a.kind === 'phone' ? 'phone' : 'desktop';
    const out = JSON.stringify(m);
    for (const { w } of this.online()) if (w !== ws) this.send(w, out);
  }
  async webSocketClose(ws, code) { try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {} this.presence([ws]); }
  async webSocketError(ws) { this.presence([ws]); }
}
async function pairClaim(req, env) {
  if (!env.SESSION_KEY) fail(503, 'not_configured', { configured: false, need: 'SESSION_KEY' });
  const bucket = 'pair:' + ipBucket(req), chk = await limiter(env, bucket, 'check', PAIR_FAIL_MAX);
  if (chk.blocked) throw new HttpError(429, { error: 'too_many_attempts', retry_after: chk.retry_after, message: 'Too many wrong codes. Wait a few minutes and try again.' });
  const b = await body(req);
  let secret = str(b.secret, 'secret', 100);
  if (secret.length <= 12) secret = secret.toUpperCase().replace(/[^A-Z0-9]/g, ''); // typed code: "abcd-efgh" works too
  const r = await roomCall(env, '/pair/claim', { secret, name: typeof b.name === 'string' ? b.name : '' });
  if (!r.ok) { await limiter(env, bucket, 'fail', PAIR_FAIL_MAX); fail(400, 'invalid_or_expired', { message: 'That pairing code didn’t work. Codes last 5 minutes and work once. Make a new one on your computer.' }); }
  const t = await makeSession(env, { typ: 'dev', dev: r.id }, DEVICE_TTL);
  await audit(env, 'POST /pair/claim', 'Phone paired: ' + r.name);
  return { token: t.token, expiresAt: t.expiresAt, device: { id: r.id, name: r.name } };
}
async function syncUpgrade(req, env) {
  if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') fail(426, 'expected_websocket');
  if (!originAllowed(req.headers.get('Origin'), env)) fail(403, 'origin_not_allowed');
  // the token rides in the WebSocket subprotocol header, never in the URL
  const protos = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((x) => x.trim());
  if (!protos.includes('nova-sync')) fail(400, 'bad_protocol');
  const p = await verifyToken((protos.find((x) => x.startsWith('tok.')) || '').slice(4), env);
  return roomStub(env).fetch('https://room/ws', { headers: { Upgrade: 'websocket', 'X-Nova-Kind': p.typ === 'dev' ? 'phone' : 'desktop', 'X-Nova-Dev': p.typ === 'dev' ? p.dev : '' } });
}

// ---------- login ----------
// Login attempts are counted in a Durable Object per IP (strongly consistent, unlike KV).
export class LoginLimiter {
  constructor(state) { this.state = state; }
  async fetch(req) {
    const u = new URL(req.url), op = u.pathname, now = Date.now(), max = Number(u.searchParams.get('max')) || LOGIN_MAX;
    let rec = (await this.state.storage.get('r')) || { n: 0, until: 0 };
    if (rec.until <= now) rec = { n: 0, until: 0 };
    if (op === '/check') return Response.json({ blocked: rec.n >= max, retry_after: Math.max(0, Math.ceil((rec.until - now) / 1000)), n: rec.n });
    if (op === '/fail') { if (!rec.until) rec.until = now + LOGIN_WINDOW * 1000; rec.n++; await this.state.storage.put('r', rec); await this.state.storage.setAlarm(rec.until); return Response.json({ n: rec.n }); }
    if (op === '/reset') { await this.state.storage.deleteAll(); return Response.json({ ok: true }); }
    return new Response('not found', { status: 404 });
  }
  async alarm() { await this.state.storage.deleteAll(); }
}
async function login(req, env) {
  if (!env.SESSION_KEY) fail(503, 'not_configured', { configured: false, need: 'SESSION_KEY' });
  // Bucket by IP; IPv6 by /48 so rotating addresses in one network share a bucket.
  const buckets = [['ip:' + ipBucket(req), LOGIN_MAX], ['global', LOGIN_GLOBAL_MAX]];
  const call = (name, op, max) => limiter(env, name, op, max);
  const sts = await Promise.all(buckets.map(([n, m]) => call(n, 'check', m)));
  const blocked = sts.find((x) => x.blocked);
  if (blocked) throw new HttpError(429, { error: 'too_many_attempts', retry_after: blocked.retry_after, message: 'Too many tries. Wait a few minutes and try again.' });
  const b = await body(req);
  const pass = typeof b.passphrase === 'string' ? b.passphrase : '';
  const ok = pass.length > 0 && pass.length <= 256 && await checkPassphrase(pass, env.NOVA_PASSPHRASE_HASH);
  if (!ok) { const rs = await Promise.all(buckets.map(([n, m]) => call(n, 'fail', m))); fail(401, 'wrong_passphrase', { tries_left: Math.max(0, Math.min(...rs.map((r, i) => buckets[i][1] - r.n))) }); }
  if (sts[0].n) await call(buckets[0][0], 'reset', LOGIN_MAX);
  return makeSession(env);
}

// ---------- router ----------
async function route(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/', m = req.method;
  if (p === '/health' && m === 'GET') return { ok: true, service: 'nova-api', time: new Date().toISOString() };
  if (p === '/auth/login' && m === 'POST') return login(req, env);
  if (p === '/inbox/result' && m === 'POST') return inboxResult(req, env);
  if (p === '/pair/claim' && m === 'POST') return pairClaim(req, env);
  if (p === '/school/assignments') { if (m !== 'GET') fail(405, 'method_not_allowed'); await schoolAuth(req, env); return schoolAssignments(env, url); }

  // Everything below needs a valid session.
  const known = /^\/(status|audit|inbox|controls|github\/issue|github\/copilot-tasks|cursor\/agents(\/[^/]+(\/followup)?)?|grok\/command|notion\/tasks|pair\/start|devices|devices\/revoke)$/.test(p);
  if (!known) fail(404, 'not_found');
  const sess = await verifySession(req, env);

  if (p === '/pair/start' && m === 'POST') { requireDesktop(sess); const r = await roomCall(env, '/pair/start'); await audit(env, 'POST /pair/start', 'Phone pairing code created'); return r; }
  if (p === '/devices' && m === 'GET') { const r = await roomCall(env, '/devices'); return { devices: r.devices || [], desktop: r.desktop || 0, you: sess.typ === 'dev' ? sess.dev : null }; }
  if (p === '/devices/revoke' && m === 'POST') {
    const b = await body(req), id = str(b.id, 'id', 40);
    if (sess.typ === 'dev' && sess.dev !== id) fail(403, 'desktop_only'); // a phone may only unpair itself
    const r = await roomCall(env, '/devices/revoke', { id });
    await audit(env, 'POST /devices/revoke', (sess.typ === 'dev' ? 'Phone unpaired itself: ' : 'Phone revoked: ') + id);
    return { ok: true, removed: !!r.had };
  }

  if (p === '/status' && m === 'GET') return status(env);
  if (p === '/audit' && m === 'GET') return { entries: await kvJson(env, 'audit', []) };
  if (p === '/inbox' && m === 'GET') return { items: await kvJson(env, 'inbox', []) };
  if (p === '/controls' && m === 'POST') {
    requireDesktop(sess);
    const b = await body(req); if (typeof b.off !== 'boolean') fail(400, 'invalid_off');
    if (b.off) await env.NOVA_KV.put('controls_off', '1'); else await env.NOVA_KV.delete('controls_off');
    await audit(env, 'POST /controls', b.off ? 'Controls switched OFF' : 'Controls switched ON');
    return { ok: true, controls_off: b.off };
  }
  if (p === '/github/issue' && m === 'POST') return githubIssue(req, env);
  if (p === '/github/copilot-tasks' && m === 'GET') return copilotTasks(env);
  if (p === '/cursor/agents' && m === 'GET') return cursorList(env);
  if (p === '/cursor/agents' && m === 'POST') return cursorCreate(req, env);
  let x = p.match(/^\/cursor\/agents\/([^/]+)$/);
  if (x && m === 'GET') return cursorGet(env, decodeURIComponent(x[1]));
  x = p.match(/^\/cursor\/agents\/([^/]+)\/followup$/);
  if (x && m === 'POST') return cursorFollowup(req, env, decodeURIComponent(x[1]));
  if (p === '/grok/command' && m === 'POST') return grokCommand(req, env);
  if (p === '/notion/tasks' && m === 'GET') return notionTasks(env);
  fail(405, 'method_not_allowed');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    if (req.method === 'OPTIONS') {
      if (!originAllowed(origin, env)) return new Response(null, { status: 403, headers: { Vary: 'Origin' } });
      return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    }
    // Browsers from other sites get no CORS headers (so they can't read responses); block their writes outright.
    if (origin && !originAllowed(origin, env) && req.method !== 'GET') return json({ error: 'origin_not_allowed' }, 403, origin, env);
    try {
      if (url.pathname === '/sync') return await syncUpgrade(req, env);
      const out = await route(req, env, url);
      return json(out, 200, origin, env);
    } catch (e) {
      if (e instanceof HttpError) return json(e.body, e.status, origin, env, e.status === 429 && e.body.retry_after ? { 'Retry-After': String(e.body.retry_after) } : {});
      console.error('nova-api error', e && e.message); // message only, never request bodies or secrets
      return json({ error: 'internal_error' }, 500, origin, env);
    }
  },
};
