// NOVA 2 — a minimal home (only the grid and, on screen 1, the 3D core). Every tab lives in the core as a node.
// Open a node and its tab appears as a panel; throw panels to the left, centre or right screen.
// Vanilla JS, no build step. Private data lives only in data/status.enc.json (AES-GCM, PBKDF2-SHA256 key from a passphrase).
// Live data: the public GitHub REST API and the public Calo site. Screen 1 alone signs in to nova-api and relays to the others.
import { conn, api, apiLogin, apiLogout, refreshConn, pollInbox, isOn, sendDirect, confirmCommand, openConnections, connRows, modal, closeModal, TARGETS, esc } from './connect.js';
import { drawGrid } from './grid.js';

const VERSION = '2.0.0';
const REPO = 'tyler467890/student-day-planner';
const CALO = 'https://tyler467890.github.io/student-day-planner/';
const TZ = 'America/Halifax';
const NOTION_TASKS = 'https://app.notion.com/p/3e6c427ef5e0803083c0d095c0f01120';
const REFRESH_MS = 5 * 60 * 1000, INBOX_MS = 20 * 1000;
const AAD = new TextEncoder().encode('nova-status:v1');
const LS = { pass: 'nova.passphrase', gh: 'nova.github.v1', calo: 'nova.calo.v1', layout: 'nova.layout.v2', prefs: 'nova.prefs', auto: 'nova.perf.auto',
  sent: 'nova.chat.sent', seen: 'nova.chat.seen', draft: 'nova.chat.draft', target: 'nova.cmd.target', assign: 'nova.scr.assign' };

const $ = (s, r = document) => r.querySelector(s);
const safeUrl = (u) => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const root = document.documentElement;

// ---------- screens: which window this is and where it sits ----------
const SCR = +root.getAttribute('data-screen') || 1;   // 1 holds the core and the session · 2 · 3
const SEC = SCR !== 1;
const POS = ['left', 'centre', 'right'];
const POS_NAME = { left: 'Left', centre: 'Centre', right: 'Right' };

// ---------- state ----------
const state = {
  status: null, statusErr: '', statusLoadedAt: 0,
  gh: lsGet(LS.gh) || { cache: {}, prs: null, run: null, commit: null, fetchedAt: 0, error: '', rateResetAt: 0 },
  calo: lsGet(LS.calo) || { checkedAt: 0, online: null },
};
window.NOVA = { state, conn, version: VERSION, get screen() { return SCR; }, get layout() { return L; }, get position() { return posOf(SCR); } }; // read-only hook for tests

// ---------- time (Halifax) ----------
const fmt = (o) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o });
const fTime = fmt({ hour: 'numeric', minute: '2-digit' });
const fDay = fmt({ month: 'short', day: 'numeric' });
const fYmd = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
const fZone = fmt({ timeZoneName: 'short' });
function clockParts(d = new Date()) {
  const t = fTime.formatToParts(d);
  const hm = t.filter((p) => ['hour', 'literal', 'minute'].includes(p.type)).map((p) => p.value).join('').trim();
  const ap = (t.find((p) => p.type === 'dayPeriod') || {}).value || '';
  const zone = (fZone.formatToParts(d).find((p) => p.type === 'timeZoneName') || {}).value || 'AT';
  return { hm, ap, zone };
}
function ago(iso) {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (isNaN(t)) return String(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) { const h = Math.round(s / 3600); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
  if (s < 172800) return 'yesterday';
  return fDay.format(new Date(t));
}
function dayLabel(iso) {
  if (!iso) return '';
  const t = Date.parse(iso.length === 10 ? iso + 'T12:00:00-03:00' : iso);
  if (isNaN(t)) return String(iso);
  const d = new Date(t), today = fYmd.format(new Date()), y = fYmd.format(new Date(Date.now() - 864e5));
  const day = fYmd.format(d) === today ? 'Today' : fYmd.format(d) === y ? 'Yesterday' : fDay.format(d);
  return iso.length === 10 ? day : day + ', ' + fTime.format(d);
}
function stamp(iso) { // chat bubble time: "11:42 AM AT" today, "Oct 9 · 3:10 PM AT" otherwise
  const t = Date.parse(iso); if (isNaN(t)) return '';
  const d = new Date(t), z = clockParts(d).zone;
  return (fYmd.format(d) === fYmd.format(new Date()) ? '' : fDay.format(d) + ' · ') + fTime.format(d) + ' ' + z;
}

// ---------- icons ----------
const Rn = (n) => Math.round(n * 100) / 100;
const polar = (cx, cy, r, deg) => { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
const arc = (cx, cy, r, a0, a1) => { const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1); return `M${Rn(x0)} ${Rn(y0)} A${r} ${r} 0 ${(a1 - a0) > 180 ? 1 : 0} 1 ${Rn(x1)} ${Rn(y1)}`; };
const ICONS = {
  code: '<path d="M10 9 L5 14 L10 19 M18 9 L23 14 L18 19 M15.5 7 L12.5 21"/>',
  blender: '<circle cx="15" cy="15" r="5.5"/><circle cx="15" cy="15" r="2"/><path d="M4 8 L13 11 M6 17 L10 15"/>',
  cursor: '<path d="M8 6 L21 13 L15 15 L12 21 Z"/>',
  branch: '<circle cx="9" cy="7" r="2.3"/><circle cx="9" cy="21" r="2.3"/><circle cx="19" cy="10" r="2.3"/><path d="M9 9.3 V18.7 M19 12.3 C19 16 9 15 9 18.7"/>',
  notes: '<rect x="7" y="5" width="14" height="18" rx="2"/><path d="M10.5 10 H17.5 M10.5 14 H17.5 M10.5 18 H15"/>',
  spark: '<path d="M14 4 L16 12 L24 14 L16 16 L14 24 L12 16 L4 14 L12 12 Z"/>',
  mail: '<rect x="5" y="8" width="18" height="13" rx="2"/><path d="M5 9 L14 16 L23 9"/>',
  bolt: '<path d="M15 4 L7 16 H13 L12 24 L21 11 H15 Z"/>',
  users: '<circle cx="11" cy="10" r="3.5"/><path d="M4 22 C4 16 18 16 18 22"/><circle cx="19" cy="10" r="2.5"/><path d="M19 15 C22 15 24 17 24 21"/>',
  chart: '<path d="M5 22 H23 M8 18 V13 M13 18 V8 M18 18 V11"/>',
  rabbit: '<ellipse cx="11" cy="8" rx="2.2" ry="5"/><ellipse cx="17" cy="8" rx="2.2" ry="5"/><circle cx="14" cy="17" r="6"/>',
  check: '<path d="M6 14 L12 20 L22 8"/>',
  clock: '<circle cx="14" cy="14" r="9"/><path d="M14 9 V14 L17.5 16"/>',
  lock: '<rect x="7" y="13" width="14" height="10" rx="2"/><path d="M10 13 V10 a4 4 0 0 1 8 0 V13"/>',
  ext: '<path d="M12 7 H7 V21 H21 V16 M15 7 H21 V13 M21 7 L13 15"/>',
  alert: '<path d="M14 5 L24 22 H4 Z M14 12 V16 M14 19 V19.5"/>',
  commit: '<circle cx="14" cy="14" r="4"/><path d="M4 14 H10 M18 14 H24"/>',
  full: '<path d="M5 11 V5 H11 M17 5 H23 V11 M23 17 V23 H17 M11 23 H5 V17"/>',
  gear: '<circle cx="14" cy="14" r="3.5"/><path d="M14 4 V7 M14 21 V24 M4 14 H7 M21 14 H24 M6.9 6.9 L9 9 M19 19 L21.1 21.1 M6.9 21.1 L9 19 M19 9 L21.1 6.9"/>',
  monitor: '<rect x="4" y="6" width="20" height="13" rx="1.5"/><path d="M10 23 H18 M14 19 V23"/>',
  chat: '<path d="M5 7 H23 V18 H13 L8 22 V18 H5 Z"/>',
  grid: '<rect x="5" y="5" width="7" height="7"/><rect x="16" y="5" width="7" height="7"/><rect x="5" y="16" width="7" height="7"/><rect x="16" y="16" width="7" height="7"/>',
  send: '<path d="M5 14 L23 6 L17 23 L13 15 Z M13 15 L23 6"/>',
  menu: '<path d="M6 9 H22 M6 14 H22 M6 19 H22"/>',
  clear: '<path d="M7 7 L21 21 M21 7 L7 21"/>',
};
const ic = (n, s = 24, col = 'currentColor', sw = 1.6) => `<svg width="${s}" height="${s}" viewBox="0 0 28 28" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n] || ''}</svg>`;
const hexIc = (n) => `<div class="ic"><svg class="hex" viewBox="0 0 52 52" fill="none"><path d="M26 2 L47 14 L47 38 L26 50 L5 38 L5 14 Z" stroke="var(--acc)" stroke-width="1.3" fill="rgba(64,214,255,.07)"/></svg>${ic(n, 28, 'var(--acc)')}</div>`;
const COL = { ok: 'rgb(84,232,170)', warn: 'rgb(255,184,77)', bad: 'rgb(255,107,107)', acc: 'rgb(64,214,255)', dim: 'rgba(64,214,255,.25)' };
// SVG ring, used for the lock screen and as the core when WebGL isn't available
function coreRing() {
  let ticks = '';
  for (let i = 0; i < 72; i++) { const d = i * 5, long = i % 6 === 0; const [x0, y0] = polar(200, 200, 192, d), [x1, y1] = polar(200, 200, long ? 182 : 187, d);
    ticks += `<line x1="${Rn(x0)}" y1="${Rn(y0)}" x2="${Rn(x1)}" y2="${Rn(y1)}" stroke="var(--acc)" stroke-width="${long ? 1.6 : 1}" opacity="${long ? .8 : .35}"/>`; }
  let segIn = ''; for (let i = 0; i < 10; i++) { const d = i * 36 + 4; segIn += `<path d="${arc(200, 200, 128, d, d + 28)}" stroke="var(--acc)" stroke-width="10" fill="none" opacity=".55"/>`; }
  return `<svg viewBox="0 0 400 400" fill="none" aria-hidden="true"><circle cx="200" cy="200" r="198" fill="url(#cg)"/>
   <defs><radialGradient id="cg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="rgba(64,214,255,.25)"/><stop offset=".6" stop-color="rgba(64,214,255,.06)"/><stop offset="1" stop-color="rgba(64,214,255,0)"/></radialGradient></defs>${ticks}
   <circle cx="200" cy="200" r="178" stroke="var(--acc)" stroke-width="1" opacity=".3"/><path d="${arc(200, 200, 168, -55, 55)}" stroke="var(--acc)" stroke-width="8" stroke-linecap="round" opacity=".8"/><path d="${arc(200, 200, 168, 65, 175)}" stroke="var(--acc)" stroke-width="8" stroke-linecap="round" opacity=".8"/><path d="${arc(200, 200, 168, 185, 295)}" stroke="var(--acc)" stroke-width="8" stroke-linecap="round" opacity=".8"/>
   <circle cx="200" cy="200" r="148" stroke="var(--acc)" stroke-width="1" stroke-dasharray="2 6" opacity=".6"/>${segIn}<circle cx="200" cy="200" r="110" stroke="var(--acc)" stroke-width="1.5" opacity=".8"/></svg>`;
}
function miniRing(pct, st, center) {
  const col = st === 'ok' ? COL.ok : st === 'warn' ? COL.warn : st === 'bad' ? COL.bad : COL.acc;
  const C = 2 * Math.PI * 31, p = Math.max(0, Math.min(100, pct ?? 100));
  return `<div class="tring"><svg width="74" height="74" viewBox="0 0 74 74" aria-hidden="true"><circle cx="37" cy="37" r="31" stroke="rgba(64,214,255,.15)" stroke-width="6" fill="none"/>
  <circle cx="37" cy="37" r="31" stroke="${col}" stroke-width="6" fill="none" stroke-dasharray="${Rn(C * p / 100)} ${Rn(C)}" stroke-linecap="round" transform="rotate(-90 37 37)"/></svg><span class="c">${center}</span></div>`;
}

// ---------- derived ----------
const agents = () => (state.status && Array.isArray(state.status.agents) ? state.status.agents : []);
const tasks = () => (state.status && Array.isArray(state.status.tasks) ? state.status.tasks : []);
const updates = () => (state.status && Array.isArray(state.status.updates) ? state.status.updates : []);
const KIND = { 'Bot': 'Bot', 'Cloud': 'Cloud', 'VS Code': 'VS Code' };
const ST = { working: { dot: 'pulse', label: 'Working', badge: 'acc' }, idle: { dot: 'idle', label: 'Idle', badge: 'dim' }, needs_you: { dot: 'warn', label: 'Needs you', badge: 'warn' }, done: { dot: 'ok', label: 'Done', badge: 'ok' } };
const stOf = (a) => ST[a.status] || ST.idle;
function counts() { const a = agents(); return { total: a.length, working: a.filter((x) => x.status === 'working').length, need: a.filter((x) => x.status === 'needs_you').length }; }
function runState() { const r = state.gh.run; if (!r) return 'pending'; if (r.status !== 'completed') return 'warn'; return r.conclusion === 'success' ? 'ok' : 'bad'; }

// ---------- tabs (the core's nodes) ----------
const AREAS = [
  { id: 'chat', label: 'Chat', angle: 90, primary: true, icon: 'chat' },
  { id: 'team', label: 'AI Team', angle: 50, icon: 'users' },
  { id: 'agents', label: 'Agents', sub: 'Cursor · Copilot', angle: 10, icon: 'cursor' },
  { id: 'github', label: 'GitHub', angle: -30, icon: 'branch' },
  { id: 'calo', label: 'Calo App', angle: -70, icon: 'rabbit' },
  { id: 'tasks', label: 'Tasks', angle: -110, icon: 'check' },
  { id: 'business', label: 'Business', sub: 'After launch', muted: true, angle: -150, icon: 'chart' },
  { id: 'launch', label: 'Quick Launch', angle: 170, icon: 'grid' },
  { id: 'settings', label: 'Settings', angle: 130, icon: 'gear' },
];
const AREA = Object.fromEntries(AREAS.map((a) => [a.id, a]));

// ---------- prefs + screen order ----------
const DEFAULT_ORDER = { left: 2, centre: 1, right: 3 };
const prefs = () => Object.assign({ perf: 'auto', fps: false }, lsGet(LS.prefs) || {});
function order() { const o = prefs().order || {}; return [o.left, o.centre, o.right].slice().sort().join() === '1,2,3' ? o : DEFAULT_ORDER; }
const posOf = (n) => { const o = order(); return o.left === n ? 'left' : o.right === n ? 'right' : 'centre'; };
const scrAt = (p) => order()[p];

// ---------- who is open: heartbeats every 2 s over a BroadcastChannel (also kept in localStorage for new windows) ----------
const chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nova-screens') : { postMessage() {}, set onmessage(f) {} };
const peers = {};
const liveKey = (n) => 'nova.scr.' + n;
function alive(n) {
  if (n === SCR) return true;
  const b = peers[n] || lsGet(liveKey(n));
  return !!b && Date.now() - b.t < (b.h ? 75000 : 6500); // a minimised window beats slowly, so give it longer
}
const winCentre = () => ({ x: window.screenX + window.outerWidth / 2, y: window.screenY + window.outerHeight / 2 });
let closing = false;
function beat() {
  if (closing) return;
  const b = { t: Date.now(), h: document.hidden, w: innerWidth, hh: innerHeight };
  lsSet(liveKey(SCR), b);
  chan.postMessage({ t: 'beat', s: SCR, h: b.h, w: b.w, hh: b.hh, c: winCentre() });
}
let liveSig = '';
function checkScreens() {
  const sig = [1, 2, 3].map((n) => +alive(n)).join('');
  if (sig !== liveSig) { liveSig = sig; if (unlocked()) { renderTiles(); updateUnread(); } redrawGrid(); }
}
setInterval(() => { beat(); checkScreens(); }, 2000);
document.addEventListener('visibilitychange', () => { beat(); if (!document.hidden) markSeen(); });
window.addEventListener('pagehide', () => { closing = true; chan.postMessage({ t: 'bye', s: SCR }); try { localStorage.removeItem(liveKey(SCR)); } catch (e) {} });
window.addEventListener('pageshow', () => { closing = false; beat(); });

// ---------- grid background (static 2D canvas; continuous across the three screens) ----------
let gridSig = '';
function centreAspect() {
  const n = scrAt('centre'); if (n === SCR) return innerWidth / innerHeight;
  const b = peers[n] || lsGet(liveKey(n)); return b && b.w && b.hh ? b.w / b.hh : 16 / 9;
}
function redrawGrid(force) {
  const pos = posOf(SCR), ca = centreAspect(), minimal = root.getAttribute('data-n3d-mode') === 'minimal';
  root.setAttribute('data-pos', pos);
  const sig = [innerWidth, innerHeight, pos, ca.toFixed(3), minimal, window.devicePixelRatio].join();
  if (!force && sig === gridSig) return; gridSig = sig;
  drawGrid($('#grid'), { pos, centreAspect: ca, minimal });
}
// the scan band drifts down the floor every 14 s; every window uses the wall clock so the band lines up across screens
const SCAN_S = 14;
function syncScan() { const el = $('.scan'); if (el) el.style.animationDelay = (-(Date.now() % (SCAN_S * 1000)) / 1000).toFixed(2) + 's'; }
let rzT = 0;
window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { redrawGrid(); beat(); layoutTiles(); }, 120); });

// ---------- layout: which tabs are open, and on which screen ----------
// { seq, tabs: [{ id, pos }] } in localStorage, announced over the BroadcastChannel. pos = left | centre | right.
// A tab whose screen isn't open shows on screen 1 instead (and goes back when that screen opens again).
let L = (() => { const x = lsGet(LS.layout); return x && Array.isArray(x.tabs) ? { seq: +x.seq || 0, tabs: x.tabs.filter((t) => AREA[t.id] && POS.includes(t.pos)) } : { seq: 0, tabs: [] }; })();
function setLayout(tabs) {
  L = { seq: Math.max(Date.now(), L.seq + 1), tabs };
  lsSet(LS.layout, L); chan.postMessage({ t: 'layout', L });
  renderTiles(); updateUnread();
}
function takeLayout(x) { if (!x || !Array.isArray(x.tabs) || !(x.seq > L.seq)) return; L = { seq: x.seq, tabs: x.tabs.filter((t) => AREA[t.id] && POS.includes(t.pos)) }; renderTiles(); updateUnread(); }
const available = () => POS.filter((p) => alive(scrAt(p)));
function effScreen(t) {
  const s = scrAt(t.pos); if (alive(s)) return s;
  if (alive(1)) return 1;
  return [1, 2, 3].find(alive) || SCR;
}
const mine = () => { const m = L.tabs.filter((t) => effScreen(t) === SCR); return m.filter((t) => t.id === 'chat').concat(m.filter((t) => t.id !== 'chat')); };
function defaultPos() { return alive(scrAt('centre')) ? 'centre' : posOf(SCR); }
function openTab(id, pos) {
  if (!AREA[id]) return;
  const ex = L.tabs.find((t) => t.id === id);
  if (ex && (!pos || ex.pos === pos)) { flashTab(id); chan.postMessage({ t: 'flash', id }); return; }
  const tabs = L.tabs.filter((t) => t.id !== id); tabs.push({ id, pos: pos || defaultPos() });
  setLayout(tabs);
  if (id === 'agents' && !SEC) refreshCode();
  setTimeout(() => { const el = tileEl(id); if (el) { el.classList.add('arrive'); setActive(id); } }, 0);
}
function sendTab(id, pos) {
  if (!POS.includes(pos)) return;
  if (!available().includes(pos)) { note(`<b>${POS_NAME[pos]} screen isn’t open</b><span class="mutedt">Open it with Set up screens on screen 1.</span>`); return; }
  const t = L.tabs.find((x) => x.id === id); if (!t || t.pos === pos && effScreen(t) === scrAt(pos)) return;
  const el = tileEl(id), from = POS.indexOf(posOf(SCR)), to = POS.indexOf(pos);
  const go = () => setLayout(L.tabs.map((x) => (x.id === id ? { id, pos } : x)));
  if (el && to !== from && !prefersReduced()) { el.classList.add(to < from ? 'throw-l' : 'throw-r'); setTimeout(go, 170); } else go();
}
function closeTab(id) { setLayout(L.tabs.filter((t) => t.id !== id)); }
function clearScreens() { setLayout([]); closeMenu(); }
const prefersReduced = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- tab contents ----------
function agentCard(a) {
  const s = stOf(a), need = a.status === 'needs_you', u = safeUrl(a.link);
  const p = typeof a.progress === 'number' ? Math.max(0, Math.min(100, a.progress)) : null;
  const right = need ? '<span class="badge warn">Needs you</span>' : a.status === 'idle' ? '<span class="badge dim">Idle</span>' : a.status === 'done' ? '<span class="badge ok">Done</span>' : p != null ? `<span class="pct">${p}%</span>` : '<span class="badge acc">Working</span>';
  const bar = a.status === 'working' && p == null ? '<div class="bar indet"><i></i></div>' : `<div class="bar ${need ? 'warn' : a.status === 'done' ? 'ok' : ''}"><i style="width:${p ?? (a.status === 'done' ? 100 : 0)}%"></i></div>`;
  const inner = `<span class="dot ${s.dot}"></span><div class="nm">${esc(a.name)}<small>${esc(KIND[a.kind] || a.kind || '')}</small></div>${right}<div class="tk">${esc(a.task || (a.status === 'idle' ? 'Standing by' : ''))}</div>${bar}`;
  return u ? `<a class="agent ${need ? 'need' : ''}" href="${esc(u)}" target="_blank" rel="noopener" title="${need ? 'Review' : 'Open'}">${inner}</a>` : `<div class="agent ${need ? 'need' : ''}">${inner}</div>`;
}
const kvs = (items) => `<div class="kv">${items.map(([k, v, cls = '']) => `<div><div class="label">${k}</div><div class="big ${cls}">${v}</div></div>`).join('')}</div>`;
const wait = () => `<div class="empty">${state.statusErr ? esc(state.statusErr) : 'Decrypting…'}</div>`;
function tabTeam() {
  const a = agents(), c = counts(); if (!state.status) return wait();
  const order = { needs_you: 0, working: 1, done: 2, idle: 3 };
  const list = a.slice().sort((p, q) => (order[p.status] ?? 4) - (order[q.status] ?? 4)).map(agentCard).join('');
  return kvs([['Working', c.working], ['Need you', c.need, c.need ? 'warnc' : ''], ['Agents', c.total]]) +
    `<div class="alist">${list || '<div class="empty">No agents yet</div>'}</div><div class="tfoot">${state.status.updatedAt ? 'Updated ' + esc(ago(state.status.updatedAt)) + ' · ' : ''}Encrypted feed</div>`;
}
function ghTop() {
  const g = state.gh, r = g.run, rs = runState();
  const center = rs === 'ok' ? ic('check', 28, COL.ok, 2.4) : rs === 'bad' ? ic('alert', 26, COL.bad, 2) : rs === 'warn' ? ic('clock', 26, COL.warn, 2) : '<span class="mono dimt">…</span>';
  const runTitle = !r ? (g.error ? 'GitHub unavailable' : 'Loading…') : r.status !== 'completed' ? 'Deploying now…' : r.conclusion === 'success' ? 'Pages deploy live' : 'Deploy ' + esc(r.conclusion || 'failed');
  return `<a class="deploy" href="${esc(safeUrl(r && r.html_url) || 'https://github.com/' + REPO + '/actions')}" target="_blank" rel="noopener">${miniRing(100, rs === 'pending' ? 'acc' : rs, center)}
    <div class="grow"><div class="label">Latest deploy${r ? ' · ' + esc(r.name || 'workflow') : ''}</div><div class="dtitle">${runTitle}</div>
     <div class="mutedt sm">${r ? `<span data-ago="${esc(r.updated_at)}">${esc(ago(r.updated_at))}</span> · run #${esc(r.run_number)}` : '&nbsp;'}</div></div></a>`;
}
const prRow = (p) => `<a class="row" href="${esc(safeUrl(p.html_url))}" target="_blank" rel="noopener"><span class="num acc">#${esc(p.number)}</span><div class="grow"><b class="ell">${esc(p.title)}</b><div class="mutedt sm">Updated <span data-ago="${esc(p.updated_at)}">${esc(ago(p.updated_at))}</span></div></div>${p.draft ? '<span class="badge dim">Draft</span>' : '<span class="badge acc">Ready</span>'}</a>`;
function tabGitHub() {
  const g = state.gh, prs = g.prs || [], runs = g.runs || (g.run ? [g.run] : []), cms = g.commits || (g.commit ? [g.commit] : []);
  const runRow = (r) => { const st = r.status !== 'completed' ? 'warn' : r.conclusion === 'success' ? 'ok' : 'bad';
    return `<a class="row" href="${esc(safeUrl(r.html_url))}" target="_blank" rel="noopener"><span class="dot ${st}"></span><div class="grow"><b class="ell">${esc(r.name || 'workflow')} #${esc(r.run_number)}</b><div class="mutedt sm">${r.status !== 'completed' ? 'Running' : esc(r.conclusion || '')} · <span data-ago="${esc(r.updated_at)}">${esc(ago(r.updated_at))}</span></div></div></a>`; };
  const cmRow = (c) => `<a class="row" href="${esc(safeUrl(c.html_url))}" target="_blank" rel="noopener">${ic('commit', 18, 'var(--acc)')}<div class="grow"><b class="ell">${esc(c.message)}</b><div class="mutedt sm"><span class="mono">${esc(c.sha)}</span> · ${esc(c.author || '')} · <span data-ago="${esc(c.date)}">${esc(ago(c.date))}</span></div></div></a>`;
  return `${ghTop()}
   <div class="label gl">Open pull requests · ${g.prs ? prs.length : '…'}</div>${g.prs ? (prs.length ? prs.map(prRow).join('') : '<div class="empty">No open pull requests</div>') : '<div class="empty">Loading…</div>'}
   <div class="label gl">Deploys</div>${runs.length ? runs.slice(0, 3).map(runRow).join('') : '<div class="empty">No deploys yet</div>'}
   <div class="label gl">Commits</div>${cms.length ? cms.slice(0, 5).map(cmRow).join('') : '<div class="empty">Loading…</div>'}
   ${g.error ? `<div class="mutedt sm">${esc(g.error)}</div>` : ''}
   <div class="tfoot"><a class="lnk" href="https://github.com/${REPO}" target="_blank" rel="noopener">${REPO}</a>${g.fetchedAt ? ' · synced <span data-ago="' + g.fetchedAt + '">' + esc(ago(g.fetchedAt)) + '</span>' : ''} · every 5 min</div>`;
}
function tabCalo() {
  const c = state.calo, up = updates().slice(0, 5);
  const badge = !c.checkedAt ? '<span class="badge dim">Checking…</span>' : c.online ? '<span class="badge ok">● Online</span>' : '<span class="badge bad">● Offline</span>';
  return `<div class="hrow"><b class="hname">${esc(c.name || 'Calo')} App</b>${badge}</div>
   ${kvs([['Version', esc(c.version || '—')], ['Response', c.ms ? esc(c.ms) + ' ms' : '—'], ['Checked', c.checkedAt ? `<span data-ago="${c.checkedAt}">${esc(ago(c.checkedAt))}</span>` : '…']])}
   <div class="mutedt sm" style="margin:.6rem 0">Live at <a class="lnk" href="${CALO}" target="_blank" rel="noopener">tyler467890.github.io/student-day-planner</a>${c.cache ? ' · build <span class="mono">' + esc(c.cache) + '</span>' : ''}</div>
   <div class="label gl">Recent updates</div>${up.length ? up.map((u) => `<div class="row"><span class="dot"></span><div class="grow"><b class="ell">${esc(u.title)}</b><div class="mutedt sm">${esc(dayLabel(u.time))}</div></div></div>`).join('') : '<div class="empty">No updates yet</div>'}
   <div class="btns"><a class="btn sm" href="${CALO}" target="_blank" rel="noopener">Open Calo ${ic('ext', 14)}</a><button class="btn sm" data-recheck>Check again</button></div>`;
}
function tabTasks() {
  const t = tasks(); if (!state.status) return wait();
  const done = t.filter((x) => x.done).length;
  const rows = t.map((x) => { const u = safeUrl(x.link); const inner = `<span class="chk ${x.done ? 'done' : ''}"></span><span class="grow ${x.done ? 'strike' : ''}">${esc(x.title)}</span>`;
    return u ? `<a class="row" href="${esc(u)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="row">${inner}</div>`; }).join('');
  return kvs([['Done', `${done} / ${t.length}`], ['Left', t.length - done]]) + `<div class="tl">${rows || '<div class="empty">No tasks yet</div>'}</div><div class="tfoot"><a class="lnk" href="${NOTION_TASKS}" target="_blank" rel="noopener">Open tasks in Notion</a></div>`;
}
function tabBusiness() {
  return `<p class="mutedt" style="margin-bottom:.8rem">Sales, profit, ads and email fill in once Calo is on Etsy. Nothing is connected yet, so there are no numbers.</p>
   <div class="bk">${[['Sales', 'Etsy orders and revenue', 'chart'], ['Profit', 'After fees and ads', 'chart'], ['Ads', 'Spend, clicks, sales', 'bolt'], ['Email', 'Support inbox', 'mail']].map(([k, sub, i]) => `<div class="bcell">${ic(i, 22, 'var(--acc)')}<div class="grow"><div class="label">${k}</div><div class="big dimt">—</div><div class="mutedt sm">${sub}</div></div><span class="soon">After launch</span></div>`).join('')}</div>`;
}
const TOOLS = [
  ['code', 'VS Code', 'https://vscode.dev', 'Open VS Code for the Web'],
  ['blender', 'Blender', 'https://www.blender.org', 'Blender can’t be launched from a browser, so this opens blender.org'],
  ['cursor', 'Cursor', 'https://cursor.com/agents', 'Cursor agents'],
  ['branch', 'GitHub', 'https://github.com/' + REPO, 'Calo repository'],
  ['notes', 'Notion', 'https://app.notion.com', 'Notion'],
  ['rabbit', 'Calo', CALO, 'The live Calo app'],
  ['spark', 'Muse', '', 'Muse link not set yet'],
];
function tabLaunch() {
  return `<div class="dock">${TOOLS.map(([i, l, u, t]) => u ? `<a class="tool" href="${u}" target="_blank" rel="noopener" title="${esc(t)}">${hexIc(i)}<span>${l}</span></a>` : `<span class="tool off" title="${esc(t)}">${hexIc(i)}<span>${l}</span><em class="tag">Soon</em></span>`).join('')}</div>`;
}
const CODE_ST = (v) => { const x = String(v || '').toLowerCase();
  if (/run|progress|creat|queue|pending|working|open/.test(x) && !/draft/.test(x)) return ['pulse', 'acc', x.includes('queue') || x.includes('pending') ? 'Queued' : 'Working'];
  if (/finish|complet|done|success|merged|closed/.test(x)) return ['ok', 'ok', 'Done'];
  if (/error|fail|cancel|expired/.test(x)) return ['bad', 'bad', 'Failed'];
  if (/draft/.test(x)) return ['', 'acc', 'Draft PR'];
  return ['idle', 'dim', x ? x.replace(/_/g, ' ') : 'Idle']; };
function codeRows(kind) {
  const integ = kind === 'cursor' ? isOn('cursor') : isOn('copilot') || isOn('github'), d = conn[kind];
  if (!conn.status) return `<div class="empty">${SEC && !alive(1) ? 'Open NOVA on screen 1 to load these.' : conn.err ? esc(conn.err) : 'Connecting…'}</div>`;
  if (!integ) return '<div class="empty">Not connected yet.</div>';
  if (!d) return '<div class="empty">Loading…</div>';
  const items = d.items || [];
  if (!items.length) return `<div class="empty">${d.err ? esc(d.err) : kind === 'cursor' ? 'No Cursor agents yet.' : 'No Copilot tasks yet.'}</div>`;
  return items.slice(0, 12).map((x) => {
    const [dot, badge, label] = CODE_ST(kind === 'cursor' ? x.status : x.state), u = safeUrl(x.url), when = x.updatedAt || x.updated_at;
    const sub = [kind === 'cursor' ? '' : String(x.repo || '').split('/')[1] || '', when ? ago(when) : ''].filter(Boolean).map(esc).join(' · ');
    const inner = `<span class="dot ${dot}"></span><div class="grow"><b class="ell">${esc(x.name || x.title || 'Untitled')}</b>${sub ? `<div class="mutedt sm">${sub}</div>` : ''}</div><span class="badge ${badge}">${esc(label)}</span>`;
    return u ? `<a class="row" href="${esc(u)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="row">${inner}</div>`;
  }).join('') + (d.err ? `<div class="mutedt sm">${esc(d.err)}</div>` : '');
}
function tabAgents() {
  const cu = conn.cursor;
  return `<div class="label gl first">Cursor${cu && cu.cap ? ` <span class="dimt">· ${esc(cu.used ?? 0)} of ${esc(cu.cap)} started today</span>` : ''}<a class="lnk" href="https://cursor.com/agents" target="_blank" rel="noopener">Open ${ic('ext', 12)}</a></div>${codeRows('cursor')}
   <div class="label gl">GitHub Copilot<a class="lnk" href="https://github.com/copilot/agents" target="_blank" rel="noopener">Open ${ic('ext', 12)}</a></div>${codeRows('copilot')}
   <div class="tfoot">Start a new Cursor or Copilot job from Chat: pick the target above the message box.</div>`;
}
const MODE_NAME = { smooth: 'Smooth', full: 'Full effects', minimal: 'Minimal' };
function tabSettings() {
  const p = prefs(), s = N3 ? N3.state : null, o = order(), auto = lsGet(LS.auto);
  const opt = (name, val, cur, title, desc) => `<label class="opt ${String(cur) === val ? 'on' : ''}"><input type="radio" name="${name}-${SCR}" value="${val}" data-pref="${name}" ${String(cur) === val ? 'checked' : ''}><div><b>${title}</b><div class="mutedt sm">${desc}</div></div></label>`;
  const now = SEC ? 'This screen draws only the grid (no 3D), so it costs almost nothing.' : !s ? 'The 3D core is off on this device.' : `Right now: ${MODE_NAME[s.mode]} · ${s.fps} fps drawn${s.busyFps ? ` · ${s.busyFps} fps while you move it` : ''} · resolution ${s.pixelRatio}x`;
  const sel = (p2) => `<label class="osel"><span class="label">${POS_NAME[p2]}</span><select data-order="${p2}">${[1, 2, 3].map((n) => `<option value="${n}" ${o[p2] === n ? 'selected' : ''}>Screen ${n}${n === 1 ? ' (core)' : ''}${alive(n) ? '' : ' · closed'}</option>`).join('')}</select></label>`;
  const off = conn.status && conn.status.controls_off;
  return `<div class="sgroup"><div class="label">Performance</div>
    ${opt('perf', 'auto', p.perf, 'Smooth (recommended)', 'Light glow, 1x resolution, full speed only while you move the core. Drops to Minimal by itself if your computer struggles.')}
    ${opt('perf', 'full', p.perf, 'Full effects', 'Sharper and more particles, faster idle spin. Needs a strong graphics card.')}
    ${opt('perf', 'minimal', p.perf, 'Minimal', 'A still core and no scan line. The lightest option.')}
    <div class="mutedt sm" style="margin-top:.5rem" data-perfnow>${esc(now)}${p.perf === 'auto' && auto && auto.mode === 'minimal' ? ' · <button class="lnkbtn" data-perfretry>Try Smooth again</button>' : ''}</div></div>
   <div class="sgroup"><div class="label">Screens</div>
    <div class="mutedt sm">Which window sits on which monitor. The grid lines up across them and “send to” uses these names.</div>
    <div class="orow">${sel('left')}${sel('centre')}${sel('right')}</div>
    <div class="btns wrap">${SEC ? (canPlace() ? '<button class="btn sm" data-place>Place on monitor</button>' : '') : '<button class="btn sm" data-setup>Set up screens</button>'}<button class="btn sm" data-ident>Identify screens</button><button class="btn sm" data-fullscreen>${isFs() ? 'Exit full screen' : 'Full screen'}</button><button class="btn sm" data-clear>Clear screens</button></div></div>
   <div class="sgroup"><div class="label">Connections</div><div class="clist">${connRows()}</div>
    ${SEC ? '<div class="mutedt sm">Manage connections on screen 1.</div>' : `<div class="btns wrap"><button class="btn sm" data-conn>Manage connections</button>${conn.status ? `<span class="mutedt sm">Remote controls: ${off ? 'off' : 'on'}</span>` : ''}</div>`}</div>
   <div class="sgroup"><div class="label">Lock</div><div class="btns wrap"><button class="btn sm danger" data-lock>${ic('lock', 15)} Lock NOVA on every screen</button></div>
    <div class="mutedt sm">Forgets the passphrase on this computer.</div></div>
   <div class="tfoot">NOVA ${VERSION} · screen ${SCR} · ${POS_NAME[posOf(SCR)]}</div>`;
}

// ---------- Chat ----------
const target = () => { const t = localStorage.getItem(LS.target); return TARGETS.some((x) => x.id === t) ? t : 'grok'; };
const replyKey = (r) => (r.request_id || '') + '|' + r.time;
const newGlow = new Map(); // reply key -> until (ms): bubbles that just arrived glow for a few seconds
function seenAt() { return Date.parse(localStorage.getItem(LS.seen) || '') || 0; }
function unreadCount() { const s = seenAt(); return (conn.inbox || []).filter((r) => Date.parse(r.time) > s).length; }
function linkify(s) { return esc(s).replace(/https:\/\/[^\s<>"']+[^\s<>"'.,;:!?)]/g, (u) => `<a class="lnk" href="${u}" target="_blank" rel="noopener">${u}</a>`); }
function chatLog() {
  const sent = (lsGet(LS.sent) || []).map((x) => ({ me: true, ...x })), rep = (conn.inbox || []).map((x) => ({ me: false, ...x }));
  const byId = new Map(sent.filter((x) => x.id).map((x) => [x.id, x])), answered = new Set(rep.map((r) => r.request_id).filter(Boolean));
  const items = sent.concat(rep).sort((a, b) => (Date.parse(a.time) || 0) - (Date.parse(b.time) || 0));
  if (!items.length) return `<div class="cempty">${ic('chat', 40, 'var(--acc)', 1.3)}<b>No messages yet</b><span>Pick Grok Bot, Cursor or Copilot below and type a message. Replies from your bots land here, newest at the bottom.</span></div>`;
  const now = Date.now();
  return items.map((m) => {
    if (m.me) {
      const t = TARGETS.find((x) => x.id === m.target) || TARGETS[0];
      const st = m.target === 'grok' ? (m.id && answered.has(m.id) ? 'Answered' : 'Sent · waiting for a reply') : 'Started';
      return `<div class="msg me"><div class="mh"><span class="src">You → ${esc(t.label)}</span><time>${esc(stamp(m.time))}</time></div><div class="mt">${linkify(m.text)}</div><div class="mst">${st}${m.link ? ` · <a class="lnk" href="${esc(safeUrl(m.link))}" target="_blank" rel="noopener">Open</a>` : ''}</div></div>`;
    }
    const k = replyKey(m), fresh = (newGlow.get(k) || 0) > now, re = m.request_id && byId.get(m.request_id);
    const src = m.source || m.from || 'Grok Bot';
    return `<div class="msg bot${fresh ? ' new' : ''}" data-k="${esc(k)}"><div class="mh"><span class="src">${ic('bolt', 14, 'var(--acc)')} ${esc(src)}</span><time>${esc(stamp(m.time))}</time></div>${re ? `<div class="mref">↳ ${esc(String(re.text).slice(0, 90))}${String(re.text).length > 90 ? '…' : ''}</div>` : ''}<div class="mt">${linkify(m.text)}</div></div>`;
  }).join('');
}
function chatPick() {
  const cur = target();
  return TARGETS.map((t) => { const off = conn.status && !isOn(t.integ); return `<button type="button" role="radio" aria-checked="${t.id === cur}" class="tp ${t.id === cur ? 'on' : ''} ${off ? 'off' : ''}" data-target="${t.id}" title="${esc(t.hint)}${off ? ' (not connected)' : ''}">${esc(t.label)}${off ? ' <small>off</small>' : ''}</button>`; }).join('');
}
function chatNote() {
  const t = TARGETS.find((x) => x.id === target());
  if (SEC) return alive(1) ? `Sends through screen 1 after you confirm · replies refresh every 20 s` : 'Open NOVA on screen 1 to send messages and get replies';
  if (!conn.session && !conn.status) return conn.err ? esc(conn.err) : 'Connecting to the secure service…';
  if (conn.status && !isOn(t.integ)) return `${esc(t.label)} isn’t connected yet`;
  return `Enter to review and send · Shift+Enter for a new line · replies refresh every 20 s${conn.inboxAt ? ` · checked <span data-ago="${conn.inboxAt}">${esc(ago(conn.inboxAt))}</span>` : ''}`;
}
function buildChat(body) {
  body.classList.add('chatbody');
  body.innerHTML = `<div class="chatlog scroll" role="log" aria-live="polite" aria-label="Replies from your bots"></div>
   <button type="button" class="jump" hidden>New reply ↓</button>
   <form class="chatin" autocomplete="off">
    <div class="tpick" role="radiogroup" aria-label="Send to"></div>
    <div class="inrow"><textarea rows="2" maxlength="4000" aria-label="Message"></textarea><button class="csend" type="submit" aria-label="Review and send">${ic('send', 22)}<span>Send</span></button></div>
    <div class="cnote"></div>
   </form>`;
  const ta = body.querySelector('textarea'); ta.value = localStorage.getItem(LS.draft) || '';
  body.querySelector('.chatlog').addEventListener('scroll', (e) => { const lg = e.currentTarget; if (lg.scrollHeight - lg.scrollTop - lg.clientHeight < 40) body.querySelector('.jump').hidden = true; }, { passive: true });
  body.querySelector('.jump').addEventListener('click', () => { const lg = body.querySelector('.chatlog'); lg.scrollTop = lg.scrollHeight; body.querySelector('.jump').hidden = true; });
  ta.addEventListener('input', () => { clearTimeout(ta._t); ta._t = setTimeout(() => { localStorage.setItem(LS.draft, ta.value); chan.postMessage({ t: 'draft' }); }, 300); });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatSubmit(body); } });
  body.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); chatSubmit(body); });
  body.querySelector('.tpick').addEventListener('click', (e) => { const b = e.target.closest('[data-target]'); if (!b) return; localStorage.setItem(LS.target, b.dataset.target); chan.postMessage({ t: 'target' }); renderTiles(); ta.focus(); });
  body._fresh = true;
}
function fillChat(body) {
  const lg = body.querySelector('.chatlog'), atBottom = body._fresh || lg.scrollHeight - lg.scrollTop - lg.clientHeight < 60;
  const before = lg.__html; patch(lg, chatLog());
  patch(body.querySelector('.tpick'), chatPick()); patch(body.querySelector('.cnote'), chatNote());
  const t = TARGETS.find((x) => x.id === target()), ta = body.querySelector('textarea');
  const ph = `Message ${t.label}…`; if (ta.placeholder !== ph) ta.placeholder = ph;
  if (atBottom) lg.scrollTop = lg.scrollHeight; else if (before !== lg.__html) body.querySelector('.jump').hidden = false;
  body._fresh = false;
}
function chatSubmit(body) {
  const ta = body.querySelector('textarea'), text = ta.value.trim(), tg = target();
  if (!text) { ta.focus(); return; }
  confirmCommand({ target: tg, text, send: SEC ? relaySend : sendDirect, onDone: (r) => {
    const list = (lsGet(LS.sent) || []).concat({ id: r.request_id || null, text: text.slice(0, 4000), target: tg, time: new Date().toISOString(), link: r.link || '' }).slice(-60);
    lsSet(LS.sent, list); ta.value = ''; localStorage.removeItem(LS.draft); chan.postMessage({ t: 'sent' }); renderTiles();
  } });
}
// what's new since you last looked: the window showing Chat (and visible) marks replies as seen
function markSeen() {
  if (!unlocked() || document.hidden || !mine().some((t) => t.id === 'chat')) return;
  const s = seenAt(), list = conn.inbox || [];
  const newest = list.reduce((m, r) => Math.max(m, Date.parse(r.time) || 0), 0);
  if (newest <= s) return;
  const until = Date.now() + 8000;
  if (s) list.forEach((r) => { if (Date.parse(r.time) > s) newGlow.set(replyKey(r), until); });
  localStorage.setItem(LS.seen, new Date(newest).toISOString()); chan.postMessage({ t: 'seen' });
  setTimeout(() => renderTiles(), 8100);
  renderTiles(); updateUnread();
}
function updateUnread() {
  const n = unlocked() ? unreadCount() : 0;
  if (N3) N3.setUnread('chat', n);
  const fb = $('#corenav [data-open="chat"] .nb'); if (fb) { fb.hidden = !n; fb.textContent = n > 9 ? '9+' : String(n); }
  document.title = (n ? `(${n}) ` : '') + 'NOVA' + (SEC ? ` · ${POS_NAME[posOf(SCR)]}` : '');
}
let lastNewest = -1;
function noticeReplies() { // a new reply arrived: glow the Chat node and the Chat panel wherever it is
  const newest = (conn.inbox || []).reduce((m, r) => Math.max(m, Date.parse(r.time) || 0), 0);
  if (lastNewest >= 0 && newest > lastNewest) { if (N3) N3.flash('chat'); pingTab('chat'); }
  lastNewest = newest; markSeen(); updateUnread();
}

// ---------- tiles: the open tabs on this screen ----------
// 1 tab = full, 2 = side by side, 3 = one big + two stacked, 4+ = grid. On screen 1 the core keeps a column on the left.
const BODY = { team: tabTeam, agents: tabAgents, github: tabGitHub, calo: tabCalo, tasks: tabTasks, business: tabBusiness, launch: tabLaunch, settings: tabSettings };
const tileEl = (id) => $(`#tiles > .tile[data-tab="${id}"]`);
let activeTab = null;
function setActive(id) { activeTab = id; document.querySelectorAll('#tiles > .tile').forEach((el) => el.classList.toggle('active', el.dataset.tab === id)); }
function tileHead(id) {
  const a = AREA[id], here = posOf(SCR), av = available();
  const btn = (p) => `<button type="button" class="st ${p === here ? 'on' : ''}" data-sendto="${p}" ${p === here ? 'aria-pressed="true" disabled' : ''} title="${p === here ? 'On this screen' : 'Send to the ' + POS_NAME[p].toLowerCase() + ' screen'} (key ${POS.indexOf(p) + 1})">${p === 'left' ? '◀ ' : ''}${POS_NAME[p]}${p === 'right' ? ' ▶' : ''}</button>`;
  return `<span class="tglyph">${ic(a.icon, 20, 'var(--acc)')}</span><h2>${esc(a.label)}${a.sub ? `<small>${esc(a.sub)}</small>` : ''}</h2>
   ${av.length > 1 ? `<nav class="sendto" aria-label="Send ${esc(a.label)} to a screen">${POS.filter((p) => av.includes(p)).map(btn).join('')}</nav>` : ''}
   <button type="button" class="tx" data-closetab title="Close ${esc(a.label)}" aria-label="Close ${esc(a.label)}">${ic('clear', 18, 'currentColor', 2)}</button>`;
}
function createTile(id) {
  const el = document.createElement('section'); el.className = 'tile' + (id === 'chat' ? ' primary' : ''); el.dataset.tab = id;
  el.setAttribute('aria-label', AREA[id].label); el.tabIndex = -1;
  el.innerHTML = `<header class="thead" title="Drag off the left or right edge to throw it to that screen"></header><div class="tbody ${id === 'chat' ? '' : 'scroll'}"></div><i class="tc tl" aria-hidden="true"></i><i class="tc br" aria-hidden="true"></i>`;
  if (id === 'chat') buildChat(el.querySelector('.tbody'));
  el.addEventListener('pointerdown', () => setActive(id), true);
  el.addEventListener('focusin', () => setActive(id));
  el.addEventListener('animationend', () => el.classList.remove('arrive', 'ping', 'flash'));
  return el;
}
function renderTiles() {
  const box = $('#tiles'); if (!box) return;
  if (!unlocked()) { box.replaceChildren(); root.classList.remove('has-tiles'); return; }
  const list = mine(), ids = list.map((t) => t.id);
  [...box.children].forEach((el) => { if (!ids.includes(el.dataset.tab)) el.remove(); });
  list.forEach((t, i) => {
    let el = tileEl(t.id);
    if (!el) { el = createTile(t.id); box.appendChild(el); el.classList.add('arrive'); }
    if (el.style.order !== String(i)) el.style.order = String(i);
    patch(el.querySelector('.thead'), tileHead(t.id));
    if (t.id === 'chat') fillChat(el.querySelector('.tbody')); else patch(el.querySelector('.tbody'), BODY[t.id]());
  });
  if (activeTab && !ids.includes(activeTab)) activeTab = null;
  layoutTiles();
  if (ids.includes('chat')) queueMicrotask(markSeen);
}
let tileSig = '';
function layoutTiles() {
  const box = $('#tiles'), n = box ? box.children.length : 0;
  const had = root.classList.contains('has-tiles'); root.classList.toggle('has-tiles', n > 0);
  if (!box) return;
  const narrow = innerWidth < 760, w = box.clientWidth || innerWidth, h = box.clientHeight || innerHeight;
  let cols = 1, rows = 1, span = false;
  if (narrow) { cols = 1; rows = n; }
  else if (n === 2) { if (w / h < 1.0) { rows = 2; } else cols = 2; }
  else if (n === 3) { cols = 2; rows = 2; span = true; }
  else if (n >= 4) { cols = n <= 4 ? 2 : 3; rows = Math.ceil(n / cols); }
  const sig = [n, cols, rows, span, narrow].join();
  if (sig !== tileSig) {
    tileSig = sig; box.dataset.n = n;
    box.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    box.style.gridTemplateRows = narrow ? '' : `repeat(${rows}, minmax(0, 1fr))`;
    [...box.children].forEach((el) => { el.style.gridRow = ''; });
  }
  const first = [...box.children].sort((a, b) => +a.style.order - +b.style.order)[0];
  [...box.children].forEach((el) => { const want = span && el === first ? 'span 2' : ''; if (el.style.gridRow !== want) el.style.gridRow = want; });
  if (N3 && had !== n > 0) N3.relayout(500);
}
function flashTab(id) { const el = tileEl(id); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); setActive(id); try { el.focus({ preventScroll: true }); } catch (e) {} } }
function pingTab(id) { const el = tileEl(id); if (el) { el.classList.remove('ping'); void el.offsetWidth; el.classList.add('ping'); } chan.postMessage({ t: 'ping', id }); }

// tile clicks: send to a screen, close
document.addEventListener('click', (e) => {
  const t = e.target.closest('#tiles [data-sendto],#tiles [data-closetab]'); if (!t) return;
  const id = t.closest('.tile').dataset.tab;
  if (t.hasAttribute('data-closetab')) closeTab(id); else sendTab(id, t.getAttribute('data-sendto'));
});
// keyboard: 1 / 2 / 3 send the active tab to the left / centre / right screen
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || !unlocked() || $('#modal .nmodal')) return;
  if (e.target.closest && e.target.closest('input,textarea,select,[contenteditable]')) return;
  const k = ['1', '2', '3'].indexOf(e.key); if (k < 0) return;
  const list = mine(), id = activeTab && list.some((t) => t.id === activeTab) ? activeTab : list.length === 1 ? list[0].id : null;
  if (!id) return;
  e.preventDefault(); sendTab(id, POS[k]);
});
// drag a tile by its header off the left or right edge to throw it to the neighbouring screen
(function dragThrow() {
  let d = null;
  const neighbour = (dir) => { const i = POS.indexOf(posOf(SCR)) + dir, p = POS[i]; return p && available().includes(p) ? p : null; };
  const zone = (x) => (x < 70 ? neighbour(-1) && -1 : x > innerWidth - 70 ? neighbour(1) && 1 : 0) || 0;
  const edges = (z) => { $('#edgeL').classList.toggle('on', z === -1); $('#edgeR').classList.toggle('on', z === 1); };
  document.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('#tiles .thead'); if (!h || e.target.closest('button,a,select,input') || e.button !== 0 || innerWidth < 760) return;
    const el = h.closest('.tile'); d = { el, id: el.dataset.tab, x0: e.clientX, y0: e.clientY, moved: false, pid: e.pointerId };
    try { h.setPointerCapture(e.pointerId); } catch (_) {}
    const l = neighbour(-1), r = neighbour(1);
    $('#edgeL span').textContent = l ? `Send to ${POS_NAME[l].toLowerCase()} screen` : ''; $('#edgeR span').textContent = r ? `Send to ${POS_NAME[r].toLowerCase()} screen` : '';
  });
  document.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.pid) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 6) return;
    if (!d.moved) { d.moved = true; d.el.classList.add('dragging'); root.classList.add('dragging-tile'); }
    d.el.style.transform = `translate(${dx}px,${dy}px) scale(.97)`; edges(zone(e.clientX));
  });
  const end = (e) => {
    if (!d || e.pointerId !== d.pid) return;
    const z = d.moved ? zone(e.clientX) : 0, { el, id } = d; d = null; edges(0);
    el.classList.remove('dragging'); root.classList.remove('dragging-tile'); el.style.transform = '';
    if (z) sendTab(id, neighbour(z));
  };
  document.addEventListener('pointerup', end); document.addEventListener('pointercancel', end);
})();

// ---------- in-place DOM updates (keeps scroll position, focus and typed text) ----------
function sameKind(a, b) { if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false; return a.nodeType !== 1 || a.id === b.id; }
function morphAttrs(from, to) {
  for (const a of [...from.attributes]) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name);
  for (const a of [...to.attributes]) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
  if ((from.tagName === 'INPUT' || from.tagName === 'SELECT') && document.activeElement !== from) {
    if (from.type === 'radio' || from.type === 'checkbox') from.checked = to.hasAttribute('checked');
    else { const v = from.tagName === 'SELECT' ? (to.querySelector('option[selected]') || to.querySelector('option') || {}).value : to.getAttribute('value') || ''; if (v != null && from.value !== v) from.value = v; }
  }
}
function morphKids(from, toParent) {
  const live = [...from.childNodes], next = [...toParent.childNodes];
  next.forEach((n, i) => {
    const cur = live[i];
    if (!cur) { from.appendChild(n); return; }
    if (!sameKind(cur, n)) { from.replaceChild(n, cur); return; }
    if (cur.nodeType === 3 || cur.nodeType === 8) { if (cur.nodeValue !== n.nodeValue) cur.nodeValue = n.nodeValue; return; }
    morphAttrs(cur, n); morphKids(cur, n);
  });
  for (let i = next.length; i < live.length; i++) live[i].remove();
}
const tpl = document.createElement('template');
function patch(el, html) { if (!el || el.__html === html) return; el.__html = html; tpl.innerHTML = html; morphKids(el, tpl.content); }
function tick() {
  const c = clockParts();
  document.querySelectorAll('[data-clock]').forEach((e) => { if (e.textContent !== c.hm) e.textContent = c.hm; });
  document.querySelectorAll('[data-ampm]').forEach((e) => { const v = `${c.ap} · ${c.zone}`; if (e.textContent !== v) e.textContent = v; });
}
function tickAgo() { document.querySelectorAll('[data-ago]').forEach((e) => { const v = e.getAttribute('data-ago'); if (v) e.textContent = ago(/^\d+$/.test(v) ? +v : v); }); }
function render() { if (!unlocked()) return; renderTiles(); updateUnread(); sync3D(); relay(); }

// ---------- crypto (encrypted status feed) ----------
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const keyCache = new Map();
const normPass = (p) => String(p || '').trim().toLowerCase().replace(/\s+/g, '-');
async function deriveKey(pass, saltB64, iter) {
  const id = saltB64 + ':' + iter + ':' + pass;
  if (keyCache.has(id)) return keyCache.get(id);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64d(saltB64), iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  keyCache.clear(); keyCache.set(id, key);
  return key;
}
class WrongPass extends Error {}
async function fetchStatus(pass) {
  const r = await fetch('data/status.enc.json?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('Status file missing (' + r.status + ')');
  const env = await r.json();
  if (env.v !== 1 || env.alg !== 'AES-256-GCM' || env.kdf !== 'PBKDF2-SHA256' || !(env.iter >= 300000)) throw new Error('Unknown status file format');
  const key = await deriveKey(pass, env.salt, env.iter);
  let pt;
  try { pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.iv), additionalData: AAD, tagLength: 128 }, key, b64d(env.ct)); }
  catch { throw new WrongPass('wrong passphrase'); }
  return JSON.parse(new TextDecoder().decode(pt));
}
async function refreshStatus() {
  const pass = localStorage.getItem(LS.pass); if (!pass) return;
  try { state.status = await fetchStatus(pass); state.statusErr = ''; state.statusLoadedAt = Date.now(); }
  catch (e) {
    if (e instanceof WrongPass) { lock('The passphrase changed. Enter the new one.'); return; }
    state.statusErr = navigator.onLine === false ? 'Offline: status not refreshed' : 'Couldn’t load the status file';
    console.info('NOVA status:', e.message);
  }
  render();
}

// ---------- GitHub (public API, no token) ----------
async function ghGet(path) {
  const cache = state.gh.cache || (state.gh.cache = {}), c = cache[path], headers = { Accept: 'application/vnd.github+json' };
  if (c && c.etag) headers['If-None-Match'] = c.etag; // 304s don't count against the rate limit
  const r = await fetch('https://api.github.com/repos/' + REPO + path, { headers, cache: 'no-store' });
  if (r.status === 304 && c) return c.data;
  if (r.status === 403 || r.status === 429) { const e = new Error('rate'); e.reset = +r.headers.get('x-ratelimit-reset') * 1000 || Date.now() + 15 * 60 * 1000; throw e; }
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const data = await r.json(); cache[path] = { etag: r.headers.get('etag'), data }; return data;
}
async function refreshGitHub(force) {
  const g = state.gh, now = Date.now();
  if (!force && now - (g.fetchedAt || 0) < REFRESH_MS - 5000) return;
  if (g.rateResetAt && now < g.rateResetAt) return;
  try {
    const [prs, runs, commits] = await Promise.all([ghGet('/pulls?state=open&per_page=20'), ghGet('/actions/runs?per_page=5'), ghGet('/commits?per_page=6')]);
    g.prs = prs.map((p) => ({ number: p.number, title: p.title, draft: !!p.draft, html_url: p.html_url, updated_at: p.updated_at }));
    g.runs = (runs.workflow_runs || []).slice(0, 5).map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion, updated_at: run.updated_at, html_url: run.html_url, run_number: run.run_number }));
    g.run = g.runs[0] || null;
    g.commits = (Array.isArray(commits) ? commits : []).slice(0, 6).map((cm) => ({ sha: cm.sha.slice(0, 7), message: (cm.commit.message || '').split('\n')[0], author: (cm.author && cm.author.login) || cm.commit.author.name, date: cm.commit.author.date, html_url: cm.html_url }));
    g.commit = g.commits[0] || null; g.fetchedAt = now; g.error = ''; g.rateResetAt = 0;
  } catch (e) {
    if (e.reset) { g.rateResetAt = e.reset; g.error = 'GitHub rate limit reached, showing saved data. Retrying at ' + fTime.format(new Date(e.reset)) + '.'; }
    else g.error = g.fetchedAt ? 'GitHub unreachable, showing saved data.' : 'GitHub unreachable right now.';
  }
  lsSet(LS.gh, g); render();
}

// ---------- Calo live check ----------
async function getText(path) { const r = await fetch(CALO + path + (path.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error(path + ' ' + r.status); return r.text(); }
async function checkCalo(force) {
  const c = state.calo;
  if (!force && Date.now() - (c.checkedAt || 0) < REFRESH_MS - 5000) return;
  const t0 = performance.now();
  const [m, sw, cfg] = await Promise.allSettled([getText('manifest.webmanifest'), getText('sw.js'), getText('js/config.js')]);
  const next = { checkedAt: Date.now(), online: false };
  if (m.status === 'fulfilled') { try { const j = JSON.parse(m.value); next.online = true; next.name = j.short_name || j.name; next.description = j.description; } catch {} next.ms = Math.round(performance.now() - t0); }
  if (sw.status === 'fulfilled') { const x = sw.value.match(/const\s+CACHE\s*=\s*['"`]([^'"`]+)['"`]/); if (x) next.cache = x[1]; }
  if (cfg.status === 'fulfilled') { const x = cfg.value.match(/APP_VERSION\s*=\s*['"`]([^'"`]+)['"`]/); if (x) next.version = x[1]; }
  state.calo = next; lsSet(LS.calo, next); render();
}

// ---------- Cursor agents and Copilot tasks (screen 1 only, read-only GET routes on nova-api) ----------
async function refreshCode() {
  if (SEC || !conn.session || !conn.status || !L.tabs.some((t) => t.id === 'agents')) return;
  const at = Date.now(), why = (e) => e.status === 503 ? 'Not connected yet.' : e.status === 429 ? 'Busy, trying again soon.' : e.status === 401 ? 'Not signed in to the secure service.' : 'Couldn’t load right now.';
  const keep = (k) => (conn[k] && conn[k].items) || [], str = (v, n = 200) => String(v ?? '').slice(0, n), jobs = [];
  if (isOn('cursor')) jobs.push(api('/cursor/agents').then((d) => { conn.cursor = { at, used: d.used_today, cap: d.cap, items: (d.agents || []).slice(0, 20).map((a) => ({ name: str(a.name), status: str(a.status, 40), url: str(a.url, 500), updatedAt: str(a.updatedAt, 40) })) }; }, (e) => { conn.cursor = { at, items: keep('cursor'), err: why(e) }; }));
  else conn.cursor = null;
  if (isOn('copilot') || isOn('github')) jobs.push(api('/github/copilot-tasks').then((d) => { conn.copilot = { at, source: d.source, items: (d.tasks || []).slice(0, 20).map((t) => ({ title: str(t.title), state: str(t.state, 40), repo: str(t.repo, 100), url: str(t.url, 500), updated_at: str(t.updated_at, 40) })) }; }, (e) => { conn.copilot = { at, items: keep('copilot'), err: why(e) }; }));
  else conn.copilot = null;
  await Promise.all(jobs); render();
}
const refreshConnAll = () => refreshConn().then(refreshCode);

// ---------- relay: screen 1 -> screens 2 and 3 (decrypted status, GitHub, Calo, replies, agent lists; never a token) ----------
let snapKey = '', relayAt = 0;
function snapshot() {
  const g = state.gh;
  return { status: state.status, statusErr: state.statusErr, calo: state.calo,
    gh: { prs: g.prs, run: g.run, runs: g.runs, commit: g.commit, commits: g.commits, fetchedAt: g.fetchedAt, error: g.error, rateResetAt: g.rateResetAt },
    conn: { signed: !!conn.session, err: conn.err, status: conn.status, inbox: conn.inbox, inboxAt: conn.inboxAt, cursor: conn.cursor || null, copilot: conn.copilot || null } };
}
function relay(force) {
  if (SEC || !unlocked()) return;
  if (!force && !alive(2) && !alive(3)) return;
  const d = snapshot(), k = JSON.stringify(d);
  if (!force && k === snapKey) return;
  snapKey = k; chan.postMessage({ t: 'snap', d });
}
function takeSnap(d) {
  if (!d || !unlocked()) return;
  relayAt = Date.now();
  if (d.status) { state.status = d.status; state.statusLoadedAt = Date.now(); }
  state.statusErr = d.status ? '' : d.statusErr || state.statusErr;
  Object.assign(state.gh, d.gh || {}); if (d.calo) state.calo = d.calo;
  const c = d.conn || {};
  conn.status = c.status || null; conn.inbox = c.inbox || []; conn.inboxAt = c.inboxAt || 0; conn.err = c.err || ''; conn.cursor = c.cursor; conn.copilot = c.copilot;
  render(); noticeReplies();
}
const relayAlive = () => SEC && alive(1) && relayAt > 0;
// screens 2 and 3 hand a confirmed command to screen 1, which sends it with its session and answers
const waiting = new Map();
function relaySend(payload) {
  if (!alive(1)) return Promise.resolve({ ok: false, msg: 'Open NOVA on screen 1 (the core) to send messages.' });
  const id = Math.random().toString(36).slice(2);
  return new Promise((res) => {
    const tm = setTimeout(() => { waiting.delete(id); res({ ok: false, msg: 'Screen 1 didn’t answer. Check that NOVA is unlocked there.' }); }, 30000);
    waiting.set(id, (r) => { clearTimeout(tm); res(r); });
    chan.postMessage({ t: 'cmd', id, p: { target: String(payload.target), text: String(payload.text).slice(0, 4000), repo: payload.repo ? String(payload.repo) : null } });
  });
}
async function onRelayedCmd(m) {
  if (SEC || !unlocked() || !m.p) return;
  const r = await sendDirect(m.p);
  chan.postMessage({ t: 'cmdres', id: m.id, r });
  if (r.ok) setTimeout(() => pollInbox(), 4000);
}
chan.onmessage = (e) => {
  const m = e.data || {};
  if (m.t === 'beat' && m.s !== SCR) { const was = alive(m.s); peers[m.s] = { t: Date.now(), h: !!m.h, c: m.c, w: m.w, hh: m.hh }; if (!was) { relay(true); checkScreens(); } if (scrAt('centre') === m.s) redrawGrid(); }
  else if (m.t === 'bye') { delete peers[m.s]; checkScreens(); }
  else if (m.t === 'hello') relay(true);
  else if (m.t === 'snap' && SEC) takeSnap(m.d);
  else if (m.t === 'layout') takeLayout(m.L);
  else if (m.t === 'flash') flashTab(m.id);
  else if (m.t === 'ping') { const el = tileEl(m.id); if (el) { el.classList.remove('ping'); void el.offsetWidth; el.classList.add('ping'); } }
  else if (m.t === 'seen' || m.t === 'sent' || m.t === 'target') { renderTiles(); updateUnread(); }
  else if (m.t === 'draft') { const ta = $('#tiles .tile[data-tab="chat"] textarea'); if (ta && document.activeElement !== ta) ta.value = localStorage.getItem(LS.draft) || ''; }
  else if (m.t === 'cmd') onRelayedCmd(m);
  else if (m.t === 'cmdres' && waiting.has(m.id)) { waiting.get(m.id)(m.r || { ok: false, msg: 'No answer' }); waiting.delete(m.id); }
  else if (m.t === 'pollnow' && !SEC && unlocked()) pollInbox();
  else if (m.t === 'recheck' && !SEC && unlocked()) checkCalo(true);
  else if (m.t === 'fs-ask' && SEC && !isFs()) fsAsk();
  else if (m.t === 'ident') showScreenLabel();
  else if (m.t === 'prefs') applyPrefs();
};
window.addEventListener('storage', (e) => {
  if (e.key === LS.layout) { try { takeLayout(JSON.parse(e.newValue)); } catch {} }
  else if (e.key === LS.prefs) applyPrefs();
  else if (e.key === LS.pass) { if (!e.newValue && unlocked()) lock(); else if (e.newValue && !unlocked()) autoUnlock(); } // lock / unlock every screen together
});

// ---------- the 3D core (screen 1 only; loaded on demand so screens 2 and 3 never parse three.js) ----------
let N3 = null, agentsKey = '', runKey = '';
function load3D() {
  if (SEC) return;
  const cv = document.createElement('canvas'); cv.id = 'nova-3d'; cv.setAttribute('aria-hidden', 'true'); document.body.appendChild(cv);
  const s = document.createElement('script'); s.src = '3d/nova-3d.min.js';
  s.onload = () => {
    try {
      N3 = window.NOVA3D; N3.init({ areas: AREAS });
      if (!N3.state || !document.querySelector('.n3d-node-label')) { root.classList.add('n3d-no-webgl'); N3 = null; }
    } catch (e) { console.info('NOVA 3D unavailable:', e.message); N3 = null; root.classList.add('n3d-no-webgl'); }
    if (!N3) fallbackCore(); else { root.classList.add('n3d-on'); agentsKey = ''; sync3D(); updateUnread(); applyPrefs(); N3.setPaused(!unlocked()); }
  };
  s.onerror = () => { root.classList.add('n3d-no-webgl'); fallbackCore(); };
  document.body.appendChild(s);
}
document.addEventListener('nova:open', (e) => openTab(e.detail.area));
document.addEventListener('nova:perf', (e) => {
  const d = e.detail; if (d.auto) lsSet(LS.auto, { mode: d.mode, lowDpr: d.lowDpr });
  root.setAttribute('data-n3d-mode', d.mode); redrawGrid();
  if (d.reason === 'minimal') note(`<b>Switched to Minimal effects</b><span class="mutedt">The core was drawing ${d.fps} fps here, so NOVA turned it down to stay smooth. Change it in Settings.</span>`, 12000);
});
function sync3D() {
  if (!N3) return;
  const a = agents(), working = a.filter((x) => x.status === 'working').length, need = a.some((x) => x.status === 'needs_you');
  const list = a.map((x) => ({ name: x.name, status: x.status === 'needs_you' || x.status === 'working' ? x.status : 'idle' }));
  const key = JSON.stringify(list);
  if (key !== agentsKey) { agentsKey = key; N3.setAgents(list); N3.setActivity(working, Math.max(1, a.length)); }
  // the core stays blue; an agent that needs you shows as an amber badge on the AI Team node instead
  N3.setStatus(working ? 'busy' : 'normal'); N3.setUnread('team', a.filter((x) => x.status === 'needs_you').length);
  const r = state.gh.run, rk = r ? r.run_number + ':' + r.status : '';
  if (runKey && rk && rk !== runKey) N3.pulse(); if (rk) runKey = rk;
}
// no WebGL: the same nodes as plain buttons around an SVG ring
function fallbackCore() {
  const nav = $('#corenav'); if (!nav) return;
  root.classList.add('n3d-fallback');
  nav.innerHTML = `<div class="fring">${coreRing()}</div>` + AREAS.map((a) => { const r = a.angle * Math.PI / 180; return `<button type="button" class="fnode ${a.muted ? 'muted' : ''} ${a.primary ? 'primary' : ''}" data-open="${a.id}" style="left:${(50 + Math.cos(r) * 41).toFixed(1)}%;top:${(50 - Math.sin(r) * 41).toFixed(1)}%">${ic(a.icon, 18)}<span>${esc(a.label)}</span><b class="nb" hidden></b></button>`; }).join('');
  updateUnread();
}
document.addEventListener('click', (e) => { const b = e.target.closest('#corenav [data-open]'); if (b) openTab(b.dataset.open); });

// ---------- the tiny menu (top-right corner, fades in when the mouse moves) ----------
const isFs = () => !!document.fullscreenElement;
const canPlace = () => 'getScreenDetails' in window;
let idleT = 0;
document.addEventListener('pointermove', () => { if (!root.classList.contains('awake')) root.classList.add('awake'); clearTimeout(idleT); idleT = setTimeout(() => { if ($('#menu').hidden) root.classList.remove('awake'); }, 2600); }, { passive: true });
$('#menuBtn').innerHTML = ic('menu', 20, 'currentColor', 1.8);
function openMenu() {
  const m = $('#menu');
  const item = (attr, icon, text, sub = '') => `<button type="button" role="menuitem" ${attr}>${ic(icon, 17)}<span>${text}${sub ? `<small>${sub}</small>` : ''}</span></button>`;
  m.innerHTML = [
    item('data-open-tab="chat"', 'chat', 'Chat'),
    item('data-fullscreen', 'full', isFs() ? 'Exit full screen' : 'Full screen'),
    SEC ? (canPlace() ? item('data-place', 'monitor', 'Place on monitor') : '') : item('data-setup', 'monitor', 'Set up screens', 'Opens the left and right screens'),
    item('data-clear', 'clear', 'Clear screens', 'Close every open tab'),
    item('data-open-tab="settings"', 'gear', 'Settings'),
    item('data-ident', 'grid', 'Identify screens'),
    item('data-lock', 'lock', 'Lock'),
  ].join('');
  m.hidden = false; $('#menuBtn').setAttribute('aria-expanded', 'true'); root.classList.add('awake');
  const f = m.querySelector('button'); if (f) f.focus();
}
function closeMenu() { const m = $('#menu'); if (m.hidden) return; m.hidden = true; $('#menuBtn').setAttribute('aria-expanded', 'false'); }
$('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); if ($('#menu').hidden) openMenu(); else closeMenu(); });
document.addEventListener('click', (e) => { if (!e.target.closest('#menu,#menuBtn')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// global actions (menu, Settings tab, toasts)
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-open-tab],[data-fullscreen],[data-place],[data-setup],[data-clear],[data-ident],[data-lock],[data-conn],[data-recheck],[data-perfretry],[data-fsgo],[data-fsno],[data-openmore],[data-notex]');
  if (!t) return;
  if (t.closest('#menu')) closeMenu();
  if (t.hasAttribute('data-open-tab')) openTab(t.getAttribute('data-open-tab'), t.getAttribute('data-open-tab') === 'settings' ? posOf(SCR) : undefined);
  else if (t.hasAttribute('data-fullscreen')) toggleFs();
  else if (t.hasAttribute('data-place')) placeOnOther();
  else if (t.hasAttribute('data-setup')) setupScreens();
  else if (t.hasAttribute('data-clear')) clearScreens();
  else if (t.hasAttribute('data-ident')) { showScreenLabel(); chan.postMessage({ t: 'ident' }); }
  else if (t.hasAttribute('data-lock')) lock();
  else if (t.hasAttribute('data-conn')) { if (!SEC) { openConnections(); if (!conn.status) refreshConn().then(() => { if ($('#modal .conn')) openConnections(); }); } }
  else if (t.hasAttribute('data-recheck')) { if (SEC && alive(1)) chan.postMessage({ t: 'recheck' }); else checkCalo(true); }
  else if (t.hasAttribute('data-perfretry')) { localStorage.removeItem(LS.auto); if (N3) N3.setMode('smooth', { auto: true }); renderTiles(); }
  else if (t.hasAttribute('data-fsgo')) { $('#fsask') && $('#fsask').remove(); goFull(); }
  else if (t.hasAttribute('data-fsno')) { $('#fsask') && $('#fsask').remove(); }
  else if (t.hasAttribute('data-openmore')) { hideNote(); openPending(); }
  else if (t.hasAttribute('data-notex')) hideNote();
});
// Settings tab inputs: performance mode and the screen order
document.addEventListener('change', (e) => {
  const p = e.target.closest('[data-pref]');
  if (p) { setPref({ [p.getAttribute('data-pref')]: p.type === 'checkbox' ? p.checked : p.value }); return; }
  const o = e.target.closest('[data-order]');
  if (o) {
    const cur = { ...order() }, slot = o.getAttribute('data-order'), n = +o.value, other = POS.find((x) => cur[x] === n);
    if (other && other !== slot) cur[other] = cur[slot]; cur[slot] = n;
    setPref({ order: cur });
  }
});
function setPref(p) {
  const next = Object.assign(prefs(), p); lsSet(LS.prefs, next);
  if (p.perf) localStorage.removeItem(LS.auto);
  applyPrefs(); chan.postMessage({ t: 'prefs' });
}
function applyPrefs() {
  const p = prefs();
  if (N3) {
    if (p.perf === 'auto') { const a = lsGet(LS.auto); if (!N3.state.modeAuto) N3.setMode(a && a.mode ? a.mode : 'smooth', { auto: true, silent: true }); }
    else if (N3.state.mode !== p.perf || N3.state.modeAuto) N3.setMode(p.perf, { auto: false, silent: true });
    root.setAttribute('data-n3d-mode', N3.state.mode);
  } else root.setAttribute('data-n3d-mode', p.perf === 'auto' ? 'smooth' : p.perf);
  redrawGrid(); renderTiles(); updateUnread();
}
setInterval(() => { const el = $('#tiles [data-perfnow]'); if (el && N3) { const s = N3.state; const v = `Right now: ${MODE_NAME[s.mode]} · ${s.fps} fps drawn${s.busyFps ? ` · ${s.busyFps} fps while you move it` : ''} · resolution ${s.pixelRatio}x`; if (el.firstChild && el.firstChild.nodeType === 3 && el.firstChild.nodeValue !== v) el.firstChild.nodeValue = v; } }, 2000);

// ---------- small notes (bottom centre; only for things you asked for) ----------
let noteTm = 0;
function note(html, ms = 9000) {
  hideNote();
  document.body.insertAdjacentHTML('beforeend', `<div class="ntoast" id="ntoast" role="status"><div class="nt">${html}</div><button class="x" data-notex aria-label="Dismiss">✕</button></div>`);
  clearTimeout(noteTm); if (ms) noteTm = setTimeout(hideNote, ms);
}
function hideNote() { const t = $('#ntoast'); if (t) t.remove(); }

// ---------- full screen + Set up screens (Window Management API) ----------
async function toggleFs() { if (document.fullscreenElement) { try { await document.exitFullscreen(); } catch (e) {} return; } goFull(); }
async function goFull() {
  let target = null; try { target = await targetMonitor(false); } catch (e) {}
  try { await root.requestFullscreen(target ? { screen: target, navigationUI: 'hide' } : { navigationUI: 'hide' }); }
  catch (e) { note('<b>Full screen didn’t start</b><span class="mutedt">Press <kbd class="k">F11</kbd> instead. It does the same thing.</span>', 8000); }
}
document.addEventListener('fullscreenchange', () => { root.classList.toggle('is-fs', isFs()); $('#fsask') && isFs() && $('#fsask').remove(); renderTiles(); });
let screenSD = null;
async function screenDetails(ask) {
  if (!canPlace()) return null;
  try {
    if (!ask) { const st = await navigator.permissions.query({ name: 'window-management' }).catch(() => null); if (!st || st.state !== 'granted') return null; }
    screenSD = await window.getScreenDetails(); screenSD.onscreenschange = () => checkScreens(); return screenSD;
  } catch (e) { return null; }
}
const inside = (s, p) => !!p && p.x >= s.left && p.x < s.left + s.width && p.y >= s.top && p.y < s.top + s.height;
const placeFeat = (s) => `popup,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`;
const plainFeat = (n) => `popup,left=${Math.round((screen.availLeft || 0) + 60 * n)},top=${Math.round((screen.availTop || 0) + 50 * n)},width=${Math.round(Math.min(1600, screen.availWidth * 0.75))},height=${Math.round(Math.min(900, screen.availHeight * 0.75))}`;
function scrUrl(n, setup) { const u = new URL(location.href); u.hash = ''; u.searchParams.delete('setup'); u.searchParams.set('screen', String(n)); if (setup) u.searchParams.set('setup', '1'); return u.href; }
// monitors, left to right, become the left / centre / right screens; screen 1 stays where it is
function monitorsFor(sd) {
  const out = {}; if (!sd || !sd.screens || sd.screens.length < 2) return out;
  const mons = [...sd.screens].sort((a, b) => a.left - b.left || a.top - b.top), here = mons.find((s) => inside(s, winCentre())) || sd.currentScreen;
  const mine1 = POS.indexOf(posOf(1)), hi = mons.indexOf(here), others = [2, 3];
  others.forEach((n) => { const want = hi + (POS.indexOf(posOf(n)) - mine1); if (mons[want] && mons[want] !== here) out[n] = mons[want]; });
  const free = mons.filter((m) => m !== here && !Object.values(out).includes(m));
  others.forEach((n) => { if (!out[n] && free.length && sd.screens.length >= 3) out[n] = free.shift(); });
  return out;
}
let pendingScr = [], setupMons = {};
async function setupScreens() {
  if (SEC) return;
  hideNote();
  const sd = canPlace() ? await screenDetails(true) : null, nMon = sd ? sd.screens.length : 0;
  if (nMon === 1) { note('<b>Only one monitor found</b><span class="mutedt">Connect your other screens (on Windows press <kbd class="k">Win</kbd>+<kbd class="k">P</kbd> and pick <b>Extend</b>), then try again.</span>', 12000); return; }
  setupMons = sd ? monitorsFor(sd) : {};
  const want = sd ? Object.keys(setupMons).map(Number) : [2, 3];
  const assign = {}; Object.keys(setupMons).forEach((n) => { const m = setupMons[n]; if (m) assign[n] = { x: m.left + m.width / 2, y: m.top + m.height / 2 }; });
  lsSet(LS.assign, assign);
  pendingScr = (want.length ? want : [2, 3]).sort();
  showScreenLabel(); chan.postMessage({ t: 'ident' });
  openPending();
}
function openPending() {
  const left = [];
  for (const n of pendingScr) {
    const m = setupMons[n] || null; let w = null;
    try { w = window.open(scrUrl(n, true), 'nova-screen-' + n, m ? placeFeat(m) : plainFeat(n)); } catch (e) {}
    if (!w) { left.push(n); continue; }
    if (m) { try { w.moveTo(m.availLeft, m.availTop); w.resizeTo(m.availWidth, m.availHeight); } catch (e) {} }
  }
  pendingScr = left;
  if (left.length) { note(`<b>One more click for screen ${left[0]}</b><span class="mutedt">Your browser opens one window per click. Allow pop-ups for NOVA to open them all at once next time.</span><button class="btn sm" data-openmore>Open screen ${left[0]}</button>`, 30000); return; }
  const placed = Object.values(setupMons).some(Boolean);
  note(`<b>Screens are open</b><span class="mutedt">${placed ? 'Each one is on its own monitor. Click <b>Full screen</b> on each.' : 'Drag each window to its monitor (the big label shows which is which), then press F11 or use the menu’s Full screen.'}</span>`, 12000);
}
async function targetMonitor(ask) {
  if (!SEC || !canPlace()) return null;
  const sd = screenSD || await screenDetails(ask); if (!sd || sd.screens.length < 2) return null;
  const a = (lsGet(LS.assign) || {})[SCR]; if (a) { const s = sd.screens.find((x) => inside(x, a)); if (s) return s; }
  const avoid = [1, 2, 3].filter((n) => n !== SCR && peers[n] && alive(n)).map((n) => peers[n].c);
  return sd.screens.find((x) => !avoid.some((p) => inside(x, p))) || null;
}
async function placeOnOther() {
  const sd = await screenDetails(true);
  if (!sd || sd.screens.length < 2) { note('<b>Couldn’t place this window</b><span class="mutedt">Allow “Window management” when Chrome or Edge asks, or drag the window over and press F11.</span>', 10000); return; }
  const o = (await targetMonitor(false)) || sd.currentScreen;
  try { await root.requestFullscreen({ screen: o, navigationUI: 'hide' }); }
  catch (e) { note('<b>One more click</b><span class="mutedt">Chrome needs a fresh click after the permission prompt.</span><button class="btn sm" data-place>Place on monitor</button>', 15000); }
}
function showScreenLabel() {
  document.querySelectorAll('.scrlabel').forEach((x) => x.remove());
  const el = document.createElement('div'); el.className = 'scrlabel'; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<b>${SCR}</b><span>${POS_NAME[posOf(SCR)]} screen${SCR === 1 ? ' · core' : ''}</span>`;
  document.body.appendChild(el); setTimeout(() => el.remove(), 4600);
}
function fsAsk() {
  if ($('#fsask') || isFs()) return;
  document.body.insertAdjacentHTML('beforeend', `<div class="fsask" id="fsask"><button class="btn" data-fsgo>${ic('full', 18, 'currentColor', 2)} Fill this screen</button><button class="lnkbtn" data-fsno>Not now</button></div>`);
}

// ---------- lock / unlock ----------
let timers = [];
const unlocked = () => !!window.__novaShown && $('#lock').hidden;
function startLive() {
  stopLive();
  timers.push(setInterval(tickAgo, 30000));
  if (SEC) {
    // screens 2 and 3 get their data from screen 1; they fetch the public feeds themselves only when screen 1 isn't open
    chan.postMessage({ t: 'hello', s: SCR });
    timers.push(setTimeout(() => { if (!relayAlive()) { refreshGitHub(); checkCalo(); } }, 4000));
    timers.push(setInterval(() => { if (!relayAlive()) { refreshGitHub(); checkCalo(); refreshStatus(); } }, REFRESH_MS));
    return;
  }
  refreshGitHub(); checkCalo();
  timers.push(setInterval(() => { refreshGitHub(); checkCalo(); refreshStatus(); }, REFRESH_MS));
  timers.push(setInterval(() => { if (conn.session || localStorage.getItem(LS.pass)) pollInbox(); }, INBOX_MS));       // Chat replies
  timers.push(setInterval(() => { if (document.visibilityState === 'visible') refreshConnAll(); }, 120000)); // connections + agent lists
}
function stopLive() { timers.forEach((t) => { clearInterval(t); clearTimeout(t); }); timers = []; }
function lock(msg) {
  window.__novaShown = false; apiLogout(); conn.cursor = undefined; conn.copilot = undefined; closeModal(); closeMenu();
  localStorage.removeItem(LS.pass); keyCache.clear(); state.status = null; relayAt = 0; stopLive();
  if (!SEC) { localStorage.removeItem(LS.sent); localStorage.removeItem(LS.draft); }
  $('#tiles').replaceChildren(); root.classList.remove('has-tiles'); tileSig = '';
  if (N3) { N3.setPaused(true); N3.setUnread('chat', 0); }
  hideNote(); $('#fsask') && $('#fsask').remove();
  root.classList.add('locked'); $('#lock').hidden = false; $('#stage').setAttribute('aria-hidden', 'true'); $('#menuBtn').hidden = true;
  const m = $('#lockmsg'); m.textContent = msg || (SEC ? 'Unlock NOVA on screen 1, or enter your passphrase here.' : 'Locked. Enter your passphrase to open NOVA.'); m.className = 'lockmsg' + (msg ? ' err' : '');
  $('#pass').value = ''; setTimeout(() => $('#pass').focus(), 50);
}
const SETUP = new URLSearchParams(location.search).get('setup') === '1';
if (SETUP) { const u = new URL(location.href); u.searchParams.delete('setup'); history.replaceState(null, '', u.href); }
function showApp() {
  window.__novaShown = true; root.classList.remove('locked'); $('#lock').hidden = true; $('#stage').removeAttribute('aria-hidden'); $('#menuBtn').hidden = false;
  if (N3) N3.setPaused(false);
  render(); startLive();
  if (SEC) { showScreenLabel(); if (SETUP && !isFs()) fsAsk(); }
}
async function autoUnlock() {
  const pass = localStorage.getItem(LS.pass); if (!pass || unlocked()) return;
  try { state.status = await fetchStatus(pass); state.statusErr = ''; state.statusLoadedAt = Date.now(); showApp(); if (!SEC) apiLogin(pass).then(refreshConnAll); } catch (e) {}
}
$('#lockring').innerHTML = coreRing();
$('#lockform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = normPass($('#pass').value), btn = $('#go'), m = $('#lockmsg');
  if (!pass) return;
  btn.disabled = true; btn.textContent = 'Unlocking…'; m.className = 'lockmsg'; m.textContent = 'Deriving key…';
  try {
    state.status = await fetchStatus(pass); state.statusErr = ''; state.statusLoadedAt = Date.now();
    localStorage.setItem(LS.pass, pass); m.textContent = ''; showApp();
    if (!SEC) apiLogin(pass).then(refreshConnAll); // silent sign-in to the secure service (nova-api), screen 1 only
  } catch (err) {
    m.className = 'lockmsg err';
    m.textContent = err instanceof WrongPass ? 'That passphrase didn’t work. Check the words and dashes.' : 'Couldn’t reach the status file. Check your connection.';
  } finally { btn.disabled = false; btn.textContent = 'Unlock'; }
});
window.addEventListener('nova:conn', () => { if (unlocked()) { render(); noticeReplies(); } });

// ---------- boot ----------
redrawGrid(true); syncScan(); tick(); setInterval(tick, 1000); beat();
load3D();
(async () => {
  const pass = localStorage.getItem(LS.pass);
  if (!pass) { lock(); $('#lockmsg').className = 'lockmsg'; $('#lockmsg').textContent = SEC ? 'Unlock NOVA on screen 1, or enter your passphrase here.' : 'Remembered on this device until you press Lock.'; if (SEC) showScreenLabel(); return; }
  showApp();
  if (!SEC) refreshConnAll();
  await refreshStatus();
})();
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.info('SW', e.message)));
window.NOVA.pollNow = () => (SEC ? chan.postMessage({ t: 'pollnow' }) : pollInbox());
