// nova-api: secure backend for NOVA. Holds all integration keys; the NOVA site holds none.
// Secrets (set with `wrangler secret put`, never committed):
//   NOVA_PASSPHRASE_HASH  pbkdf2-sha256$<iter>$<salt b64>$<hash b64>
//   SESSION_KEY           HMAC key for 12h session tokens
//   INBOX_KEY             bearer key the Grok Bot uses for POST /inbox/result
//   GITHUB_TOKEN, CURSOR_API_KEY, GROK_WEBHOOK_URL, GROK_WEBHOOK_KEY, NOTION_TOKEN, NOTION_TASKS_DB (optional integrations)

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
async function makeSession(env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64u(enc.encode(JSON.stringify({ sub: 'tyler', iat: now, exp: now + SESSION_TTL, n: crypto.randomUUID() })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env.SESSION_KEY), enc.encode(payload));
  return { token: payload + '.' + b64u(sig), expiresAt: (now + SESSION_TTL) * 1000 };
}
async function verifySession(req, env) {
  if (!env.SESSION_KEY) fail(503, 'not_configured', { configured: false, need: 'SESSION_KEY' });
  const m = (req.headers.get('Authorization') || '').match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/);
  if (!m) fail(401, 'unauthorized');
  let ok = false;
  try { ok = await crypto.subtle.verify('HMAC', await hmacKey(env.SESSION_KEY), b64ud(m[2]), enc.encode(m[1])); } catch { ok = false; }
  if (!ok) fail(401, 'unauthorized');
  let p; try { p = JSON.parse(new TextDecoder().decode(b64ud(m[1]))); } catch { fail(401, 'unauthorized'); }
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now() / 1000) fail(401, 'session_expired');
  return p;
}

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
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = ip.includes(':') ? ip.split(':').slice(0, 3).join(':') + '::/48' : ip;
  const buckets = [['ip:' + bucket, LOGIN_MAX], ['global', LOGIN_GLOBAL_MAX]];
  const call = async (name, op, max) => (await env.LOGIN_LIMITER.get(env.LOGIN_LIMITER.idFromName(name)).fetch(`https://limiter/${op}?max=${max}`, { method: 'POST' })).json();
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

  // Everything below needs a valid session.
  const known = /^\/(status|audit|inbox|controls|github\/issue|github\/copilot-tasks|cursor\/agents(\/[^/]+(\/followup)?)?|grok\/command|notion\/tasks)$/.test(p);
  if (!known) fail(404, 'not_found');
  await verifySession(req, env);

  if (p === '/status' && m === 'GET') return status(env);
  if (p === '/audit' && m === 'GET') return { entries: await kvJson(env, 'audit', []) };
  if (p === '/inbox' && m === 'GET') return { items: await kvJson(env, 'inbox', []) };
  if (p === '/controls' && m === 'POST') {
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
      const out = await route(req, env, url);
      return json(out, 200, origin, env);
    } catch (e) {
      if (e instanceof HttpError) return json(e.body, e.status, origin, env, e.status === 429 && e.body.retry_after ? { 'Retry-After': String(e.body.retry_after) } : {});
      console.error('nova-api error', e && e.message); // message only, never request bodies or secrets
      return json({ error: 'internal_error' }, 500, origin, env);
    }
  },
};
