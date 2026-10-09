// NOVA command center v1 — vanilla JS, no build step.
// Private data lives only in data/status.enc.json (AES-GCM, PBKDF2-SHA256 key from a passphrase).
// Live data: public GitHub REST API (no token) and the public Calo site.

import { cmdBar, repliesStrip, apiLogin, apiLogout, refreshConn, openConnections, conn } from './connect.js';

const REPO = 'tyler467890/student-day-planner';
const CALO = 'https://tyler467890.github.io/student-day-planner/';
const TZ = 'America/Halifax';
const NOTION_TASKS = 'https://app.notion.com/p/3e6c427ef5e0803083c0d095c0f01120';
const GROK_APP_URL = ''; // set when a Grok Bot app deep link is known; empty = "coming soon" tooltip
const REFRESH_MS = 5 * 60 * 1000;
const AAD = new TextEncoder().encode('nova-status:v1');
const LS = { pass: 'nova.passphrase', gh: 'nova.github.v1', calo: 'nova.calo.v1' };

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : ''; } catch { return ''; } };
const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------- state ----------
const state = {
  view: 'overview', selAgent: 0, teamFilter: 'all',
  status: null, statusErr: '', statusLoadedAt: 0,
  gh: lsGet(LS.gh) || { cache: {}, prs: null, run: null, commit: null, fetchedAt: 0, error: '', rateResetAt: 0 },
  calo: lsGet(LS.calo) || { checkedAt: 0, online: null },
};
window.NOVA = { state, conn, version: '1.3.0' }; // read-only hook for add-on layers (e.g. a 3D renderer)
const emit = (name, detail) => window.dispatchEvent(new CustomEvent('nova:' + name, { detail }));

// ---------- time ----------
const fmt = (o) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...o });
const fTime = fmt({ hour: 'numeric', minute: '2-digit' });
const fHour = fmt({ hour: 'numeric', hourCycle: 'h23' });
const fDate = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
const fZone = fmt({ timeZoneName: 'short' });
const fDay = fmt({ month: 'short', day: 'numeric' });
const fYmd = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
function clockParts(d = new Date()) {
  const t = fTime.formatToParts(d);
  const hm = t.filter((p) => ['hour', 'literal', 'minute'].includes(p.type)).map((p) => p.value).join('').trim();
  const ap = (t.find((p) => p.type === 'dayPeriod') || {}).value || '';
  const zone = (fZone.formatToParts(d).find((p) => p.type === 'timeZoneName') || {}).value || 'AT';
  return { hm, ap, zone, date: fDate.format(d).replace(',', ''), hour: +fHour.format(d) % 24 };
}
function greeting() { const h = clockParts().hour; return h >= 5 && h < 12 ? 'Good morning' : h >= 12 && h < 17 ? 'Good afternoon' : 'Good evening'; }
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

// ---------- icons & svg parts ----------
const R = (n) => Math.round(n * 100) / 100;
const polar = (cx, cy, r, deg) => { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
const arc = (cx, cy, r, a0, a1) => { const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1); return `M${R(x0)} ${R(y0)} A${r} ${r} 0 ${(a1 - a0) > 180 ? 1 : 0} 1 ${R(x1)} ${R(y1)}`; };
const ICONS = {
  code: '<path d="M10 9 L5 14 L10 19 M18 9 L23 14 L18 19 M15.5 7 L12.5 21"/>',
  blender: '<circle cx="15" cy="15" r="5.5"/><circle cx="15" cy="15" r="2"/><path d="M4 8 L13 11 M6 17 L10 15"/>',
  cursor: '<path d="M8 6 L21 13 L15 15 L12 21 Z"/>',
  branch: '<circle cx="9" cy="7" r="2.3"/><circle cx="9" cy="21" r="2.3"/><circle cx="19" cy="10" r="2.3"/><path d="M9 9.3 V18.7 M19 12.3 C19 16 9 15 9 18.7"/>',
  notes: '<rect x="7" y="5" width="14" height="18" rx="2"/><path d="M10.5 10 H17.5 M10.5 14 H17.5 M10.5 18 H15"/>',
  spark: '<path d="M14 4 L16 12 L24 14 L16 16 L14 24 L12 16 L4 14 L12 12 Z"/>',
  mic: '<rect x="11" y="5" width="6" height="11" rx="3"/><path d="M8 13 C8 20 20 20 20 13 M14 19.5 V23"/>',
  mail: '<rect x="5" y="8" width="18" height="13" rx="2"/><path d="M5 9 L14 16 L23 9"/>',
  bolt: '<path d="M15 4 L7 16 H13 L12 24 L21 11 H15 Z"/>',
  home: '<path d="M5 13 L14 5 L23 13 M8 11 V22 H20 V11"/>',
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
  exitfull: '<path d="M11 5 V11 H5 M23 11 H17 V5 M17 23 V17 H23 M5 17 H11 V23"/>',
  gear: '<circle cx="14" cy="14" r="3.5"/><path d="M14 4 V7 M14 21 V24 M4 14 H7 M21 14 H24 M6.9 6.9 L9 9 M19 19 L21.1 21.1 M6.9 21.1 L9 19 M19 9 L21.1 6.9"/>',
  monitor: '<rect x="4" y="6" width="20" height="13" rx="1.5"/><path d="M10 23 H18 M14 19 V23"/>',
};
const ic = (n, s = 24, col = 'var(--acc)', sw = 1.6) => `<svg width="${s}" height="${s}" viewBox="0 0 28 28" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const hexIc = (n) => `<div class="ic"><svg class="hex" viewBox="0 0 52 52" fill="none"><path d="M26 2 L47 14 L47 38 L26 50 L5 38 L5 14 Z" stroke="var(--acc)" stroke-width="1.3" fill="rgba(64,214,255,.07)"/></svg>${ic(n, 26)}</div>`;
const brandMark = (s = 34) => `<svg class="mark" width="${s}" height="${s}" viewBox="0 0 40 40" fill="none" aria-hidden="true">
 <path d="M20 2 L36 11 L36 29 L20 38 L4 29 L4 11 Z" stroke="var(--acc)" stroke-width="1.5" opacity=".9"/>
 <circle cx="20" cy="20" r="8" stroke="var(--acc)" stroke-width="1.5"/><circle cx="20" cy="20" r="3.5" fill="var(--acc)" style="filter:drop-shadow(0 0 0.25rem var(--acc))"/>
 <path d="M20 2 V8 M36 29 L31 26 M4 29 L9 26" stroke="var(--acc)" stroke-width="1.5" opacity=".7"/></svg>`;
const COL = { ok: 'rgb(84,232,170)', warn: 'rgb(255,184,77)', bad: 'rgb(255,107,107)', acc: 'rgb(64,214,255)', dim: 'rgba(64,214,255,.25)' };

// Arc-reactor core ring. arcs = [{state:'ok'|'warn'|'bad'|'pending', title}]
function coreRing(arcs, withClock = true) {
  let ticks = '';
  for (let i = 0; i < 72; i++) { const d = i * 5, long = i % 6 === 0; const [x0, y0] = polar(200, 200, 192, d), [x1, y1] = polar(200, 200, long ? 182 : 187, d);
    ticks += `<line x1="${R(x0)}" y1="${R(y0)}" x2="${R(x1)}" y2="${R(y1)}" stroke="var(--acc)" stroke-width="${long ? 1.6 : 1}" opacity="${long ? .8 : .35}"/>`; }
  const segs = [[-55, 55], [65, 175], [185, 295]];
  let a = '';
  segs.forEach(([a0, a1], i) => {
    const st = (arcs[i] || {}).state || 'pending';
    const col = st === 'ok' ? COL.acc : st === 'warn' ? COL.warn : st === 'bad' ? COL.bad : COL.dim;
    a += `<g><title>${esc((arcs[i] || {}).title || '')}</title><path d="${arc(200, 200, 168, a0, a1)}" stroke="rgba(64,214,255,.15)" stroke-width="8" fill="none" stroke-linecap="round"/>`;
    if (st !== 'pending') a += `<path d="${arc(200, 200, 168, a0, a1)}" stroke="${col}" stroke-width="8" fill="none" stroke-linecap="round" style="filter:drop-shadow(0 0 0.375rem ${col})"/>`;
    a += '</g>';
  });
  let segIn = '';
  for (let i = 0; i < 10; i++) { const d = i * 36 + 4; segIn += `<path d="${arc(200, 200, 128, d, d + 28)}" stroke="var(--acc)" stroke-width="10" fill="none" opacity=".55"/>`; }
  const c = clockParts();
  const inner = withClock ? `<text data-clock x="200" y="190" text-anchor="middle" font-family="Orbitron" font-weight="600" font-size="46" fill="#e2f6ff" style="filter:drop-shadow(0 0 0.625rem rgba(64,214,255,.6))">${c.hm}</text>
    <text data-ampm x="200" y="222" text-anchor="middle" font-family="JetBrains Mono" font-size="13" letter-spacing="3" fill="#9beaff">${c.ap} · ${c.zone}</text>
    <text x="200" y="244" text-anchor="middle" font-family="JetBrains Mono" font-size="11" letter-spacing="2.5" fill="#7f9db3">HALIFAX</text>` : '';
  return `<svg viewBox="0 0 400 400" fill="none" role="img" aria-label="System status ring">
   <defs><radialGradient id="cg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="rgba(64,214,255,.30)"/><stop offset=".6" stop-color="rgba(64,214,255,.07)"/><stop offset="1" stop-color="rgba(64,214,255,0)"/></radialGradient></defs>
   <circle cx="200" cy="200" r="198" fill="url(#cg)"/>${ticks}
   <circle cx="200" cy="200" r="178" stroke="var(--acc)" stroke-width="1" opacity=".3"/>${a}
   <circle cx="200" cy="200" r="148" stroke="var(--acc)" stroke-width="1" stroke-dasharray="2 6" opacity=".6"/>${segIn}
   <circle cx="200" cy="200" r="110" stroke="var(--acc)" stroke-width="1.5" opacity=".8"/>
   <circle cx="200" cy="200" r="104" fill="rgba(3,8,15,.55)"/><circle cx="200" cy="200" r="104" stroke="var(--acc)" stroke-width="1" opacity=".3"/>${inner}</svg>`;
}
function bunny(w = 170) {
  let scan = ''; for (let y = 40; y < 175; y += 7) scan += `<line x1="20" y1="${y}" x2="180" y2="${y}" stroke="var(--acc)" stroke-width=".6" opacity=".12"/>`;
  return `<svg width="${w}" height="${w}" viewBox="0 0 200 200" fill="none" aria-hidden="true">
  <defs><linearGradient id="bf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(64,214,255,.28)"/><stop offset="1" stop-color="rgba(64,214,255,.04)"/></linearGradient>
  <linearGradient id="beam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="rgba(64,214,255,.25)"/><stop offset="1" stop-color="rgba(64,214,255,0)"/></linearGradient></defs>
  <path d="M40 176 L70 40 L130 40 L160 176 Z" fill="url(#beam)" opacity=".5"/>${scan}
  <g stroke="var(--acc)" stroke-width="1.6" fill="url(#bf)" style="filter:drop-shadow(0 0 0.3125rem rgba(64,214,255,.7))">
   <ellipse cx="86" cy="62" rx="11" ry="34" transform="rotate(-12 86 62)"/><ellipse cx="112" cy="60" rx="11" ry="34" transform="rotate(14 112 60)"/>
   <ellipse cx="100" cy="138" rx="38" ry="34"/><circle cx="100" cy="100" r="28"/><ellipse cx="128" cy="150" rx="10" ry="9"/></g>
  <ellipse cx="86" cy="62" rx="4" ry="20" transform="rotate(-12 86 62)" stroke="var(--acc)" opacity=".5"/><ellipse cx="112" cy="60" rx="4" ry="20" transform="rotate(14 112 60)" stroke="var(--acc)" opacity=".5"/>
  <circle cx="90" cy="98" r="3" fill="#e2f6ff"/><circle cx="110" cy="98" r="3" fill="#e2f6ff"/><path d="M97 108 Q100 111 103 108" stroke="#e2f6ff" stroke-width="1.4"/>
  <ellipse cx="100" cy="176" rx="62" ry="10" stroke="var(--acc)" stroke-width="1.4" opacity=".8"/><ellipse cx="100" cy="176" rx="44" ry="6" stroke="var(--acc)" stroke-width="1" opacity=".5"/>
  <ellipse cx="100" cy="176" rx="80" ry="14" stroke="var(--acc)" stroke-width=".8" stroke-dasharray="3 5" opacity=".5"/></svg>`;
}
function miniRing(pct, st, center) {
  const col = st === 'ok' ? COL.ok : st === 'warn' ? COL.warn : st === 'bad' ? COL.bad : COL.acc;
  const C = 2 * Math.PI * 31, p = Math.max(0, Math.min(100, pct ?? 100));
  return `<div class="tring"><svg width="74" height="74" viewBox="0 0 74 74" aria-hidden="true"><circle cx="37" cy="37" r="31" stroke="rgba(64,214,255,.15)" stroke-width="6" fill="none"/>
  <circle cx="37" cy="37" r="31" stroke="${col}" stroke-width="6" fill="none" stroke-dasharray="${R(C * p / 100)} ${R(C)}" stroke-linecap="round" transform="rotate(-90 37 37)" style="filter:drop-shadow(0 0 0.25rem ${col})"/></svg><span class="c">${center}</span></div>`;
}

// ---------- derived ----------
const agents = () => (state.status && Array.isArray(state.status.agents) ? state.status.agents : []);
const tasks = () => (state.status && Array.isArray(state.status.tasks) ? state.status.tasks : []);
const updates = () => (state.status && Array.isArray(state.status.updates) ? state.status.updates : []);
const KIND = { 'Bot': 'Bot', 'Cloud': 'Cloud', 'VS Code': 'VS Code' };
const ST = {
  working: { dot: 'pulse', label: 'Working', badge: 'acc' },
  idle: { dot: 'idle', label: 'Idle', badge: 'dim' },
  needs_you: { dot: 'warn', label: 'Needs you', badge: 'warn' },
  done: { dot: 'ok', label: 'Done', badge: 'ok' },
};
const stOf = (a) => ST[a.status] || ST.idle;
function counts() {
  const a = agents();
  return { total: a.length, working: a.filter((x) => x.status === 'working').length, need: a.filter((x) => x.status === 'needs_you').length };
}
function runState() {
  const r = state.gh.run; if (!r) return 'pending';
  if (r.status !== 'completed') return 'warn';
  return r.conclusion === 'success' ? 'ok' : 'bad';
}
function systems() {
  const issues = [];
  if (state.calo.checkedAt && state.calo.online === false) issues.push('Calo is offline');
  if (runState() === 'bad') issues.push('Last deploy failed');
  if (state.statusErr) issues.push('Status file unavailable');
  const caloSt = !state.calo.checkedAt ? 'pending' : state.calo.online ? 'ok' : 'bad';
  const teamSt = !state.status ? (state.statusErr ? 'bad' : 'pending') : counts().need ? 'warn' : 'ok';
  return { issues, arcs: [
    { state: caloSt, title: 'Calo app: ' + (caloSt === 'ok' ? 'online' : caloSt) },
    { state: runState() === 'warn' ? 'ok' : runState(), title: 'GitHub deploy' },
    { state: teamSt, title: 'AI team' + (counts().need ? ': ' + counts().need + ' need you' : '') },
  ] };
}

// ---------- panels ----------
function agentCard(a, i) {
  const s = stOf(a), need = a.status === 'needs_you';
  const p = typeof a.progress === 'number' ? Math.max(0, Math.min(100, a.progress)) : null;
  const right = need ? '<span class="badge warn">Needs you</span>' : a.status === 'idle' ? '<span class="badge dim">Idle</span>' : a.status === 'done' ? '<span class="badge ok">Done</span>' : p != null ? `<span class="pct">${p}%</span>` : '<span class="badge acc">Working</span>';
  const bar = a.status === 'working' && p == null ? '<div class="bar indet"><i></i></div>' : `<div class="bar ${need ? 'warn' : a.status === 'done' ? 'ok' : ''}"><i style="width:${p ?? (a.status === 'done' ? 100 : 0)}%"></i></div>`;
  return `<button class="agent ${need ? 'need' : ''}" data-agent="${i}"><span class="dot ${s.dot}"></span><div class="nm">${esc(a.name)}<small>${esc(KIND[a.kind] || a.kind || '')}</small></div>${right}
   <div class="tk">${esc(a.task || (a.status === 'idle' ? 'Standing by' : ''))}</div>${bar}</button>`;
}
function updatedFoot() {
  const u = state.status && state.status.updatedAt;
  return `<div class="foot"><span data-updated>${u ? 'Updated ' + esc(ago(u)) : state.statusErr ? '<span class="badc">' + esc(state.statusErr) + '</span>' : 'Loading…'}</span><span>Encrypted feed</span></div>`;
}
function teamPanel() {
  const c = counts(), a = agents();
  return `<section class="panel team">
  <div class="ph"><h3>AI Team<small>${c.total} agents</small></h3><span class="meta"><span class="acc">${c.working} working</span>${c.need ? ` · <span class="warnc">${c.need} need${c.need === 1 ? 's' : ''} you</span>` : ''}</span></div>
  <div class="alist scroll">${a.length ? a.map(agentCard).join('') : `<div class="empty">${state.statusErr ? esc(state.statusErr) : 'Decrypting team status…'}</div>`}</div>
  ${updatedFoot()}</section>`;
}
function caloStats() {
  const c = state.calo;
  const badge = !c.checkedAt ? '<span class="badge dim">Checking…</span>' : c.online ? '<span class="badge ok">● Online</span>' : '<span class="badge bad">● Offline</span>';
  return { badge, version: c.version || (c.online ? '—' : '—') };
}
function caloPanel() {
  const c = state.calo, s = caloStats();
  const up = updates().slice(0, 3);
  return `<div class="panel calo">
   <div class="bun"><div class="holo" data-holo-slot>${bunny(150)}</div><span class="label">Calo guide${n3d.webgl ? ' · drag' : ''}</span></div>
   <div class="cstats">
    <div class="ph" style="margin-bottom:0.75rem"><h3>${esc(c.name || 'Calo')} App</h3>${s.badge}</div>
    <div class="kv"><div><div class="label">Version</div><div class="big">${esc(s.version)}</div></div>
     <div title="No analytics connected yet"><div class="label">Installs</div><div class="big soonv">Coming soon</div></div>
     <div title="No analytics connected yet"><div class="label">Active today</div><div class="big soonv">Coming soon</div></div></div>
    <div class="mutedt sm phone-only">v${esc(s.version)} · ${c.checkedAt ? 'checked ' + esc(ago(c.checkedAt)) : 'checking'}</div>
    <div class="mutedt livelink" style="font-size:0.8125rem;margin-top:0.875rem">Live at <a class="lnk" href="${CALO}" target="_blank" rel="noopener">tyler467890.github.io/student-day-planner</a>${c.checkedAt ? ` · checked <span data-ago="${c.checkedAt}">${esc(ago(c.checkedAt))}</span>` : ''}</div>
   </div>
   <div class="updates"><div class="label" style="margin-bottom:0.5rem">Recent updates</div>
    ${up.length ? up.map((u) => `<div class="row"><span class="dot"></span><div class="grow"><b>${esc(u.title)}</b><div class="mutedt sm">${esc(dayLabel(u.time))}</div></div></div>`).join('') : '<div class="empty">No updates yet</div>'}
   </div></div>`;
}
function ghPanel(full = false) {
  const g = state.gh, r = g.run, cm = g.commit;
  const rs = runState();
  const center = rs === 'ok' ? ic('check', 28, COL.ok, 2.4) : rs === 'bad' ? ic('alert', 26, COL.bad, 2) : rs === 'warn' ? ic('clock', 26, COL.warn, 2) : '<span class="mono dimt">…</span>';
  const runTitle = !r ? (g.error ? 'GitHub unavailable' : 'Loading…') : r.status !== 'completed' ? 'Deploying now…' : r.conclusion === 'success' ? 'Pages deploy live' : 'Deploy ' + esc(r.conclusion || 'failed');
  const prs = g.prs || [];
  const err = g.error ? `<div class="mutedt sm" style="margin-top:0.625rem">${ic('alert', 14, COL.warn)} ${esc(g.error)}</div>` : '';
  return `<div class="panel gh">
   <div class="ph"><h3>GitHub<small>student-day-planner</small></h3><a href="https://github.com/${REPO}" target="_blank" rel="noopener" title="Open repo on GitHub">${ic('branch', 20)}</a></div>
   <a class="deploy hov" href="${esc(safeUrl(r && r.html_url) || 'https://github.com/' + REPO + '/actions')}" target="_blank" rel="noopener">
    ${miniRing(100, rs === 'pending' ? 'acc' : rs, center)}
    <div class="grow"><div class="label">Latest deploy${r ? ' · ' + esc(r.name || 'workflow') : ''}</div>
     <div style="font-family:var(--font-hd);font-weight:700;font-size:1.375rem;margin:0.25rem 0 2px">${runTitle}</div>
     <div class="mutedt sm">${r ? `<span data-ago="${esc(r.updated_at)}">${esc(ago(r.updated_at))}</span> · run #${esc(r.run_number)}` : '&nbsp;'}</div></div></a>
   ${cm ? `<a class="row hov" style="border-top:1px solid rgba(64,214,255,.09);margin-top:0.875rem" href="${esc(safeUrl(cm.html_url))}" target="_blank" rel="noopener">${ic('commit', 18)}<div class="grow"><b class="ell" style="display:block">${esc(cm.message)}</b><div class="mutedt sm"><span class="mono">${esc(cm.sha)}</span> · ${esc(cm.author || '')} · <span data-ago="${esc(cm.date)}">${esc(ago(cm.date))}</span></div></div></a>` : ''}
   <div class="label" style="margin:1rem 0 0.25rem">Open pull requests · ${g.prs ? prs.length : '…'}</div>
   <div class="prs scroll" ${full ? 'style="max-height:none"' : ''}>
    ${g.prs ? (prs.length ? prs.map((p) => `<a class="row pr hov" href="${esc(safeUrl(p.html_url))}" target="_blank" rel="noopener"><span class="num acc">#${esc(p.number)}</span><div class="grow"><b class="ell" style="display:block">${esc(p.title)}</b><div class="mutedt sm">Updated <span data-ago="${esc(p.updated_at)}">${esc(ago(p.updated_at))}</span></div></div>${p.draft ? '<span class="badge dim">Draft</span>' : '<span class="badge acc">Ready</span>'}</a>`).join('') : '<div class="empty">No open pull requests</div>') : '<div class="empty">Loading…</div>'}
   </div>
   ${err}
   <div class="foot"><span>${g.fetchedAt ? 'Synced <span data-ago="' + g.fetchedAt + '">' + esc(ago(g.fetchedAt)) + '</span>' : ''}</span><span>Refreshes every 5 min</span></div>
  </div>`;
}
function tasksPanel(limit) {
  const t = tasks(), done = t.filter((x) => x.done).length;
  const list = limit ? t.filter((x) => !x.done).slice(0, limit) : t;
  return `<div class="panel tasks">
   <div class="ph"><h3>Today<small>Notion tasks</small></h3><span class="meta">${t.length ? `${done} of ${t.length} done` : ''}</span></div>
   <div class="tl scroll">${t.length ? list.map((x) => { const u = safeUrl(x.link); const inner = `<span class="chk ${x.done ? 'done' : ''}"></span><span class="${x.done ? 'strike' : ''}">${esc(x.title)}</span>`;
      return u ? `<a class="row hov" href="${esc(u)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="row">${inner}</div>`; }).join('') : `<div class="empty">${state.statusErr ? esc(state.statusErr) : 'Decrypting tasks…'}</div>`}</div>
   <a class="row addt desk-only" href="${NOTION_TASKS}" target="_blank" rel="noopener"><span class="acc" style="font-size:1.25rem;line-height:1">+</span><span class="mutedt">Open tasks in Notion</span></a>
  </div>`;
}
const TOOLS = [
  ['code', 'VS Code', 'https://vscode.dev', 'Open VS Code for the Web'],
  ['blender', 'Blender', 'https://www.blender.org', 'Blender can’t be launched from a browser, so this opens blender.org'],
  ['cursor', 'Cursor', 'https://cursor.com/agents', 'Cursor agents'],
  ['branch', 'GitHub', 'https://github.com/' + REPO, 'Calo repository'],
  ['notes', 'Notion', 'https://app.notion.com', 'Notion'],
  ['spark', 'Muse', '', 'Muse link not set yet (placeholder)'],
];
function dock() {
  return `<div class="panel dock"><div class="label vlabel">Quick launch</div>
   ${TOOLS.map(([i, l, u, t]) => u ? `<a class="tool" href="${u}" target="_blank" rel="noopener" title="${esc(t)}">${hexIc(i)}<span>${l}</span></a>` : `<span class="tool ph-link" title="${esc(t)}">${hexIc(i)}<span>${l}</span><em class="tag">Soon</em></span>`).join('')}
  </div>`;
}
function futureCards() {
  return [['Sales & Profit', 'chart', 'Etsy revenue · orders'], ['Ads', 'bolt', 'Spend · clicks · conversions'], ['Email', 'mail', 'Unread · top messages']].map(([t, i, s]) => `
  <a class="panel fut" href="#business" title="Preview of how this looks after launch"><div class="future fx">${ic(i, 30)}<div><div class="ft">${t}</div><div class="mutedt sm">${s}</div></div></div>
   <div class="fb"><span class="soon">Coming after launch</span><svg class="future spark" width="120" height="30" viewBox="0 0 120 30" fill="none" aria-hidden="true"><path d="M2 26 L20 20 L38 22 L56 14 L74 16 L92 8 L118 3" stroke="var(--acc)" stroke-width="1.5" stroke-dasharray="4 4"/></svg></div></a>`).join('');
}
function askBar(short) { return cmdBar(short) + repliesStrip(); }
function needPanel() {
  const n = agents().filter((a) => a.status === 'needs_you');
  if (!n.length) return '';
  return `<div class="panel needp" style="border-color:rgba(255,184,77,.45);background:rgba(255,184,77,.05)">
   <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.375rem"><span class="badge warn">${n.length} need${n.length === 1 ? 's' : ''} you</span><span class="mutedt" style="font-size:0.75rem">Tap to review</span></div>
   ${n.map((a) => `<button class="row" style="width:100%;border:0;padding:0.3125rem 0;text-align:left" data-agent="${agents().indexOf(a)}"><span class="dot warn"></span><b style="font-family:var(--font-hd);font-size:1rem;white-space:nowrap">${esc(a.name)}</b><span class="mutedt ell" style="margin-left:auto;font-size:0.7812rem">${esc(a.task || '')}</span></button>`).join('')}
  </div>`;
}

// ---------- views ----------
function viewOverview() {
  const c = counts(), sys = systems(), cs = caloStats();
  const sub = sys.issues.length ? 'Heads up: ' + sys.issues.join(' · ') + '.' : c.need ? `${c.need === 1 ? 'One thing needs' : c.need + ' things need'} you. Everything else is on track.` : 'Everything is on track.';
  const r = state.gh.run, rs = runState();
  const hs = (k, v, s, cls = '') => `<div class="hstat"><div class="label">${k}</div><div class="hv ${cls}">${v}</div><div class="hs">${s}</div></div>`;
  return `<div class="ov">
  ${teamPanel()}
  <section class="center">
   <div class="core" data-n3d-container>
    <div class="greet"><h1 class="glow"><span data-greet>${greeting()}</span>, Tyler</h1><p>${esc(sub)}</p></div>
    <div class="ringwrap">
     <div class="side l">${hs('Agents', state.status ? `${c.working} / ${c.total}` : '—', 'working right now')}${hs('Needs you', state.status ? c.need : '—', 'waiting on you', c.need ? 'warnc' : '')}</div>
     <div class="ring" id="core-ring" data-n3d-core title="Drag to rotate · scroll or pinch to zoom · pick a node for details">${coreRing(sys.arcs)}${clock3d()}</div>
     <div class="side r">${hs('Calo app', !state.calo.checkedAt ? '…' : state.calo.online ? 'Online' : 'Offline', state.calo.online ? 'v' + esc(cs.version) + ' · live site' : 'live site', state.calo.online ? 'okc' : state.calo.checkedAt ? 'badc' : '')}
      ${hs('Last deploy', rs === 'ok' ? 'Success' : rs === 'bad' ? 'Failed' : rs === 'warn' ? 'Running' : '…', r ? esc(ago(r.updated_at)) : 'GitHub Pages', rs === 'ok' ? 'okc' : rs === 'bad' ? 'badc' : '')}</div>
     <div class="mini"><div><div class="label">Agents</div><b>${state.status ? `${c.working} / ${c.total}` : '—'}</b></div><div><div class="label">Calo</div><b class="${state.calo.online ? 'okc' : 'badc'}">${!state.calo.checkedAt ? '…' : state.calo.online ? 'Online' : 'Offline'}</b></div><div><div class="label">Deploy</div><b class="${rs === 'ok' ? 'okc' : ''}">${rs === 'ok' ? 'Live' : rs === 'bad' ? 'Failed' : rs === 'warn' ? 'Running' : '…'}</b></div></div>
    </div>
    ${askBar(false)}
   </div>
   ${needPanel()}
   ${caloPanel()}
  </section>
  <section class="rightcol">${ghPanel()}${tasksPanel()}</section>
  <section class="bottom">${dock()}${futureCards()}</section>
 </div>`;
}
function filteredAgents() {
  return agents().map((a, i) => [a, i]).filter(([a]) => state.teamFilter === 'all' || (state.teamFilter === 'working' ? a.status === 'working' : a.status === 'needs_you'));
}
function agentDetail(a) {
  if (!a) return `<div class="panel head"><div class="empty">${state.statusErr ? esc(state.statusErr) : 'Decrypting team status…'}</div></div>`;
  const s = stOf(a), p = typeof a.progress === 'number' ? a.progress : null, u = safeUrl(a.link);
  const ringSt = a.status === 'needs_you' ? 'warn' : a.status === 'done' ? 'ok' : 'acc';
  const center = p != null ? `<span style="font-family:var(--font-dp);font-weight:600;font-size:1.0625rem">${p}%</span>` : a.status === 'needs_you' ? ic('alert', 26, COL.warn, 2) : a.status === 'done' ? ic('check', 26, COL.ok, 2.4) : ic(a.status === 'idle' ? 'clock' : 'bolt', 26, a.status === 'idle' ? COL.dim : COL.acc, 2);
  return `<div class="panel head">
   ${miniRing(p ?? (a.status === 'idle' ? 0 : 100), ringSt, center).replace('class="tring"', 'class="tring" style="width:6.875rem;height:6.875rem"').replace('width="74" height="74"', 'width="110" height="110"')}
   <div class="grow"><div class="label">Agent · ${esc(KIND[a.kind] || a.kind || '')}</div>
    <div class="title">${esc(a.name)}</div>
    <div class="mutedt" style="font-size:1.0625rem;margin-top:0.25rem">${esc(a.task || 'Standing by')}</div>
    ${u ? `<div class="btns"><a class="btn ${a.status === 'needs_you' ? 'pri' : ''}" href="${esc(u)}" target="_blank" rel="noopener">${a.status === 'needs_you' ? 'Review now' : 'Open'} ${ic('ext', 16, a.status === 'needs_you' ? '#1a1206' : 'var(--acc)')}</a></div>` : ''}
   </div>
   <div class="facts"><div><div class="label">Status</div><div class="fv ${a.status === 'needs_you' ? 'warnc' : a.status === 'done' ? 'okc' : ''}">${s.label}</div></div><div><div class="label">Kind</div><div class="fv">${esc(KIND[a.kind] || a.kind || '—')}</div></div><div><div class="label">Progress</div><div class="fv">${p != null ? p + '%' : '—'}</div></div></div>
  </div>`;
}
function activityPanel(a) {
  const ev = [];
  if (a) ev.push([state.status && state.status.updatedAt ? fTime.format(new Date(state.status.updatedAt)) : '', a.status === 'needs_you' ? 'warn' : a.status === 'done' ? 'ok' : a.status === 'working' ? '' : 'idle', stOf(a).label + (a.task ? ': ' + a.task : ''), 'Latest status from the encrypted feed']);
  return `<div class="panel tlp">
   <div class="ph"><h3>Activity<small>latest status</small></h3><span class="meta" data-updated>${state.status ? 'Updated ' + esc(ago(state.status.updatedAt)) : ''}</span></div>
   ${ev.map(([t, s, x, y]) => `<div class="ev"><span class="tt">${esc(t)}</span><span class="node"><span class="dot ${s}"></span></span><div><div class="ea">${esc(x)}</div><div class="eb">${esc(y)}</div></div></div>`).join('')}
   <div class="nolog">${ic('clock', 22)}<div>A live step-by-step log isn’t connected yet. For now NOVA shows each agent’s latest status, task and link.</div></div>
  </div>`;
}
function viewAgents() {
  const a = agents(), sel = a[state.selAgent] || a[0], c = counts();
  const list = filteredAgents();
  const need = a.filter((x) => x.status === 'needs_you');
  return `<div class="ag">
   <div class="pteam"><div class="label">NOVA · Team</div><h1>Your AI team</h1></div>
   <div class="filters" role="tablist">${[['all', 'All ' + c.total], ['working', 'Working ' + c.working], ['need', 'Needs you ' + c.need]].map(([k, l]) => `<button class="${state.teamFilter === k ? 'on' : ''} ${k === 'need' && c.need ? 'w' : ''}" data-filter="${k}">${l}</button>`).join('')}</div>
   <aside class="panel side">
    <div class="ph"><h3>AI Team</h3><span class="meta">${c.total}</span></div>
    <div class="desk-only scroll" style="flex:1;min-height:0">${a.map((x, i) => `<button class="li ${x === sel ? 'sel' : ''}" data-select="${i}"><span class="dot ${stOf(x).dot}"></span><div class="grow"><div class="ln ell">${esc(x.name)}</div><div class="ls">${x.status === 'needs_you' ? '<span class="warnc">Needs you</span>' : x.status === 'working' ? (typeof x.progress === 'number' ? x.progress + '% · working' : 'Working') : stOf(x).label}</div></div></button>`).join('') || `<div class="empty">${state.statusErr ? esc(state.statusErr) : 'Decrypting…'}</div>`}</div>
    <div class="alist phone-only">${list.map(([x, i]) => agentCard(x, i)).join('') || '<div class="empty">Nobody here right now</div>'}</div>
    <div class="desk-only">${updatedFoot()}</div>
   </aside>
   <section class="mid">${agentDetail(sel)}${activityPanel(sel)}</section>
   <section class="rcol">
    <div class="panel"><div class="ph"><h3>Needs you</h3><span class="meta">${need.length}</span></div>
     ${need.length ? need.map((x) => `<div class="approve"><div class="label warnc">● ${esc(x.name)}</div><div class="aq">${esc(x.task || 'Waiting on you')}</div><div class="am">${esc(KIND[x.kind] || '')} agent</div>${safeUrl(x.link) ? `<div class="btns"><a class="btn pri" href="${esc(safeUrl(x.link))}" target="_blank" rel="noopener">Review</a></div>` : ''}</div>`).join('') : '<div class="empty">Nothing is waiting on you.</div>'}
    </div>
    <div class="panel" style="flex:1;min-height:0"><div class="ph"><h3>Recent updates</h3></div>
     ${updates().map((u) => `<div class="row"><span class="dot"></span><div class="grow"><b style="font-weight:600">${esc(u.title)}</b><div class="mutedt sm">${esc(dayLabel(u.time))}</div></div></div>`).join('') || '<div class="empty">No updates yet</div>'}
     <div class="nolog" style="margin-top:1.125rem">${ic('users', 22)}<div>Send commands to Grok Bot, Cursor or Copilot from the Ask bar on the Overview. Replies show under it.</div></div>
    </div>
   </section>
  </div>`;
}
function viewCalo() {
  const c = state.calo, s = caloStats();
  return `<div class="cv">
   <div class="stack">
    <div class="panel cbig">
     <div class="bun"><div class="holo big" data-holo-slot>${bunny(220)}</div></div>
     <div>
      <div class="ph" style="margin-bottom:0.375rem"><h3 style="font-size:1.5rem">${esc(c.name || 'Calo')} App</h3>${s.badge}</div>
      <div class="mutedt" style="font-size:0.9375rem">${esc(c.description || 'Live check of the public Calo site.')}</div>
      <div class="facts2">
       <div><div class="label">Version</div><div class="fv">${esc(s.version)}</div></div>
       <div><div class="label">Cache build</div><div class="fv mono" style="font-size:1rem">${esc(c.cache || '—')}</div></div>
       <div><div class="label">Response</div><div class="fv">${c.ms ? esc(c.ms) + ' ms' : '—'}</div></div>
       <div title="No analytics connected yet"><div class="label">Installs</div><div class="fv dimt">Coming soon</div></div>
       <div title="No analytics connected yet"><div class="label">Active users</div><div class="fv dimt">Coming soon</div></div>
       <div><div class="label">Last check</div><div class="fv"><span data-ago="${c.checkedAt || ''}">${c.checkedAt ? esc(ago(c.checkedAt)) : '…'}</span></div></div>
      </div>
      <div class="btns"><a class="btn" href="${CALO}" target="_blank" rel="noopener">Open Calo ${ic('ext', 16)}</a><button class="btn" data-recheck>Check again</button></div>
     </div>
    </div>
    <div class="panel"><div class="ph"><h3>Recent updates</h3></div>
     ${updates().map((u) => `<div class="row"><span class="dot"></span><div class="grow"><b style="font-weight:600">${esc(u.title)}</b><div class="mutedt sm">${esc(dayLabel(u.time))}</div></div></div>`).join('') || '<div class="empty">No updates yet</div>'}
    </div>
   </div>
   <div class="stack">${ghPanel(true)}</div>
  </div>`;
}
function viewBusiness() {
  const kpi = (k, sub) => `<div class="panel kpi"><div class="label">${k}</div><div class="big dimt">—</div><div class="mutedt sm">${sub}</div></div>`;
  let grid = ''; for (let i = 0; i < 5; i++) grid += `<line x1="40" y1="${30 + i * 50}" x2="880" y2="${30 + i * 50}" stroke="rgba(64,214,255,.08)"/>`;
  return `<div class="biz">
   <div class="wm" aria-hidden="true"><span>PREVIEW</span></div>
   <div class="bhead"><div><h1>Business</h1><div class="mutedt" style="margin-top:0.375rem">Calo on Etsy · nothing connected yet</div></div><span class="prevtag">Preview · how this looks after launch · no real data</span></div>
   <div class="kpis">${kpi('Revenue', 'Etsy sales')}${kpi('Net profit', 'After fees and ads')}${kpi('Orders', 'This month')}${kpi('Ad spend', 'All campaigns')}${kpi('Return on ads', 'Revenue per $1')}</div>
   <div class="brow">
    <div class="panel"><div class="ph"><h3>Sales<small>Etsy revenue and orders</small></h3><span class="soon">Coming after launch</span></div>
     <svg class="ghost" viewBox="0 0 900 240" width="100%" height="240" preserveAspectRatio="none" aria-hidden="true">${grid}
      <path d="M40 220 C150 210 220 200 300 170 S470 150 560 120 S760 70 880 50" stroke="var(--acc)" stroke-width="2" stroke-dasharray="6 7" fill="none" opacity=".6"/></svg>
     <div class="mutedt sm" style="text-align:center;margin-top:0.375rem">Example shape only. Real sales appear here once Etsy is connected.</div></div>
    <div class="panel"><div class="ph"><h3>Where the money goes</h3></div>
     <div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap"><svg class="ghost" width="170" height="170" viewBox="0 0 170 170" aria-hidden="true"><circle cx="85" cy="85" r="62" fill="none" stroke="rgba(64,214,255,.25)" stroke-width="18" stroke-dasharray="6 6"/><text x="85" y="92" text-anchor="middle" font-family="Rajdhani" font-weight="700" font-size="26" fill="#4b6477">$ —</text></svg>
      <div style="flex:1;min-width:9.375rem">${['Net profit', 'Ads', 'Etsy fees', 'Processing & tax'].map((l) => `<div class="row"><span class="grow mutedt">${l}</span><span class="dimt mono">—</span></div>`).join('')}</div></div></div>
   </div>
   <div class="brow3">
    <div class="panel"><div class="ph"><h3>Ads</h3><span class="soon">After launch</span></div><table class="tbl"><tr><th>Campaign</th><th>Spend</th><th>Clicks</th><th>Sales</th></tr><tr><td>No campaigns yet</td><td>—</td><td>—</td><td>—</td></tr></table></div>
    <div class="panel"><div class="ph"><h3>Inbox<small>support</small></h3><span class="soon">After launch</span></div><div class="empty">Support email will show here once it’s connected.</div></div>
    <div class="panel"><div class="ph"><h3>Recent orders</h3><span class="soon">After launch</span></div><div class="empty">Etsy orders and unlock codes sent will show here.</div></div>
   </div>
  </div>`;
}

// ---------- shell ----------
const VIEWS = [['overview', 'Overview', 'home', 'Home'], ['agents', 'Agents', 'users', 'Team'], ['calo', 'Calo', 'rabbit', 'Calo'], ['business', 'Business', 'chart', 'Business']];
function renderTop() {
  const c = clockParts(), sys = systems();
  patch($('#topbar'), `<a class="brand" href="#overview">${brandMark()}<div class="name">NOVA</div><div class="sub">Command Center</div></a>
   <nav class="nav">${VIEWS.map(([k, l]) => `<a href="#${k}" class="${state.view === k ? 'on' : ''}">${l}</a>`).join('')}</nav>
   <div class="tright"><span class="pill ${sys.issues.length ? 'warn' : ''}" title="${esc(sys.issues.join(', ') || 'Calo online, deploy OK, team feed decrypted')}"><span class="dot ${sys.issues.length ? 'warn' : 'ok'}"></span>${sys.issues.length ? sys.issues.length + (sys.issues.length === 1 ? ' issue' : ' issues') : 'All systems normal'}</span>
    <span class="clk" data-topclock>${esc(c.date.toUpperCase())} · ${esc(c.hm)} ${esc(c.ap)} ${esc(c.zone)}</span>${fpsTag()}
    ${fsButton()}
    <button class="lockbtn s2btn" data-screen2 title="Open Screen 2 (operations) in its own window for your other monitor">${ic('ext', 15, 'currentColor')}<span class="lt">Screen 2</span></button>
    <button class="lockbtn setbtn" data-settings title="Settings: performance, glass effect, two-screen setup">${ic('gear', 15, 'currentColor')}<span class="lt">Settings</span></button>
    <button class="lockbtn connbtn" data-conn title="Connections: which tools are linked to NOVA">${ic('bolt', 15, 'currentColor')}<span class="lt">Connections</span></button>
    <button class="lockbtn" data-lock title="Lock NOVA and forget the passphrase on this device">${ic('lock', 15, 'currentColor')}<span class="lt">Lock</span></button><div class="avatar" title="Tyler Fennell">TF</div></div>`);
  patch($('#tabs'), VIEWS.map(([k, , i, l]) => `<a class="tab ${state.view === k ? 'on' : ''}" href="#${k}">${ic(i, 24, state.view === k ? 'var(--acc)' : 'var(--muted)')}<span>${l}</span></a>`).join(''));
}
// ---------- in-place DOM updates ----------
// Data refreshes re-run the templates, then only the nodes that actually changed are touched, so panels,
// their 3D tilt state, the hologram and the command bar (focus, caret, typed text) stay put.
const baseCls = (el) => (el.getAttribute('class') || '').split(/\s+/).filter((c) => c && !c.startsWith('n3d-')).sort().join(' ');
const isRuntime = (n) => n.nodeType === 1 && (n.classList.contains('n3d-fx') || n.classList.contains('holo-host'));
function sameKind(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) return false;
  if (a.nodeType !== 1) return true;
  if (a.__n3d || a.classList.contains('panel') || b.classList.contains('panel') || a.parentElement === $('#view')) return baseCls(a) === baseCls(b);
  return a.id === b.id;
}
function morphAttrs(from, to) {
  for (const a of [...from.attributes]) {
    if (a.name === 'class' || a.name === 'style' || to.hasAttribute(a.name)) continue;
    if (a.name.startsWith('aria-') || a.name === 'role' || a.name === 'tabindex') { if (from.classList.contains('n3d-holo-host')) continue; }
    from.removeAttribute(a.name);
  }
  for (const a of [...to.attributes]) {
    if (a.name === 'class') { const keep = [...from.classList].filter((c) => c.startsWith('n3d-')); const want = [a.value, ...keep].join(' ').trim(); if (from.getAttribute('class') !== want) from.setAttribute('class', want); continue; }
    if (a.name === 'style') continue;
    if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value);
  }
  if (!to.hasAttribute('class') && from.hasAttribute('class')) { const keep = [...from.classList].filter((c) => c.startsWith('n3d-')).join(' '); if (keep) from.setAttribute('class', keep); else from.removeAttribute('class'); }
  // inline style from the template; the 3D layer owns transform/clip/opacity on panels
  const ts = to.getAttribute('style') || '';
  if (from.__n3d) { if (from.__tpl !== undefined && from.__tpl !== ts) { from.setAttribute('style', ts); from.__n3d.tf = null; } from.__tpl = ts; }
  else if ((from.getAttribute('style') || '') !== ts) { if (ts) from.setAttribute('style', ts); else from.removeAttribute('style'); }
  if ((from.tagName === 'INPUT' || from.tagName === 'SELECT') && document.activeElement !== from) {
    const v = from.tagName === 'SELECT' ? (to.querySelector('option[selected]') || to.querySelector('option') || {}).value : to.getAttribute('value') || '';
    if (v != null && from.value !== v) from.value = v;
  }
}
function morphKids(from, toParent) {
  if (from.hasAttribute && from.hasAttribute('data-holo-slot') && from.querySelector('.holo-host')) return; // live hologram lives here
  const live = [...from.childNodes].filter((n) => !isRuntime(n)), next = [...toParent.childNodes];
  const anchor = [...from.childNodes].find(isRuntime) || null;
  next.forEach((n, i) => {
    const cur = live[i];
    if (!cur) { from.insertBefore(n, anchor); return; }
    if (!sameKind(cur, n)) { from.replaceChild(n, cur); return; }
    if (cur.nodeType === 3 || cur.nodeType === 8) { if (cur.nodeValue !== n.nodeValue) cur.nodeValue = n.nodeValue; return; }
    morphAttrs(cur, n); morphKids(cur, n);
  });
  for (let i = next.length; i < live.length; i++) live[i].remove();
}
const tpl = document.createElement('template');
function patch(el, html) {
  if (!el) return;
  if (el.__html === html) return; // nothing changed at all
  el.__html = html; tpl.innerHTML = html; morphKids(el, tpl.content);
}
function render() {
  renderTop();
  const v = state.view;
  patch($('#view'), v === 'agents' ? viewAgents() : v === 'calo' ? viewCalo() : v === 'business' ? viewBusiness() : viewOverview());
  document.title = SCREEN2 ? 'NOVA · Screen 2' : 'NOVA · ' + (VIEWS.find((x) => x[0] === v) || VIEWS[0])[1];
  renderS2(); after3D();
  emit('render', { view: v });
}
function tick() {
  const c = clockParts();
  document.querySelectorAll('[data-clock]').forEach((e) => { e.textContent = c.hm; });
  document.querySelectorAll('[data-ampm]').forEach((e) => { e.textContent = `${c.ap} · ${c.zone}`; });
  document.querySelectorAll('[data-greet]').forEach((e) => { e.textContent = greeting(); });
  const tc = $('[data-topclock]'); if (tc) tc.textContent = `${c.date.toUpperCase()} · ${c.hm} ${c.ap} ${c.zone}`;
}
function tickAgo() {
  document.querySelectorAll('[data-ago]').forEach((e) => { const v = e.getAttribute('data-ago'); if (v) e.textContent = ago(/^\d+$/.test(v) ? +v : v); });
  document.querySelectorAll('[data-updated]').forEach((e) => { if (state.status) e.textContent = 'Updated ' + ago(state.status.updatedAt); });
}
function route() {
  const h = (location.hash || '#overview').slice(1).split('/');
  state.view = VIEWS.some((v) => v[0] === h[0]) ? h[0] : 'overview';
  if (h[0] === 'agents' && h[1] != null && !isNaN(+h[1])) state.selAgent = +h[1];
  render(); window.scrollTo(0, 0);
}
function openAgent(i) {
  if (SCREEN2) return;
  if (matchMedia('(max-width:760px)').matches) openSheet(i); else { state.selAgent = i; location.hash = '#agents/' + i; }
}
function openSheet(i) {
  const a = agents()[i]; if (!a) return;
  $('#sheet').innerHTML = `<div class="sheet" data-close><div class="panel">${agentDetail(a)}<div class="btns" style="margin-top:1rem"><button class="btn" data-close>Close</button></div></div></div>`;
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-agent],[data-select],[data-filter],[data-lock],[data-ask],[data-recheck],[data-close],[data-screen2]');
  screenClicks(e);
  if (!t) return;
  if (t.hasAttribute('data-close')) { if (e.target === t || e.target.closest('button[data-close]')) $('#sheet').innerHTML = ''; return; }
  if (t.hasAttribute('data-screen2')) { openScreen2(); return; }
  if (t.hasAttribute('data-agent')) openAgent(+t.getAttribute('data-agent')); else if (t.hasAttribute('data-select')) { state.selAgent = +t.getAttribute('data-select'); render(); }
  else if (t.hasAttribute('data-filter')) { state.teamFilter = t.getAttribute('data-filter'); render(); }
  else if (t.hasAttribute('data-lock')) lock();
  else if (t.hasAttribute('data-ask')) { t.classList.add('show'); clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('show'), 2200); }
  else if (t.hasAttribute('data-recheck')) checkCalo(true);
});
window.addEventListener('hashchange', route);

// ---------- crypto ----------
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
  try { state.status = await fetchStatus(pass); state.statusErr = ''; state.statusLoadedAt = Date.now(); emit('data', { source: 'status' }); }
  catch (e) {
    if (e instanceof WrongPass) { lock('The passphrase changed. Enter the new one.'); return; }
    state.statusErr = navigator.onLine === false ? 'Offline: status not refreshed' : 'Couldn’t load the status file';
    console.warn('NOVA status:', e.message);
  }
  render();
}

// ---------- GitHub (public API, no token) ----------
async function ghGet(path) {
  const cache = state.gh.cache || (state.gh.cache = {});
  const c = cache[path];
  const headers = { Accept: 'application/vnd.github+json' };
  if (c && c.etag) headers['If-None-Match'] = c.etag; // 304s don't count against the rate limit
  const r = await fetch('https://api.github.com/repos/' + REPO + path, { headers, cache: 'no-store' });
  if (r.status === 304 && c) return c.data;
  if (r.status === 403 || r.status === 429) {
    const reset = +r.headers.get('x-ratelimit-reset') * 1000 || Date.now() + 15 * 60 * 1000;
    const e = new Error('rate'); e.reset = reset; throw e;
  }
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const data = await r.json();
  cache[path] = { etag: r.headers.get('etag'), data };
  return data;
}
async function refreshGitHub(force) {
  const g = state.gh, now = Date.now();
  if (!force && now - (g.fetchedAt || 0) < REFRESH_MS - 5000) return;
  if (g.rateResetAt && now < g.rateResetAt) return;
  try {
    const [prs, runs, commits] = await Promise.all([ghGet('/pulls?state=open&per_page=20'), ghGet('/actions/runs?per_page=5'), ghGet('/commits?per_page=1')]);
    g.prs = prs.map((p) => ({ number: p.number, title: p.title, draft: !!p.draft, html_url: p.html_url, updated_at: p.updated_at }));
    const run = (runs.workflow_runs || [])[0];
    g.run = run ? { name: run.name, status: run.status, conclusion: run.conclusion, updated_at: run.updated_at, html_url: run.html_url, run_number: run.run_number } : null;
    const cm = commits[0];
    g.commit = cm ? { sha: cm.sha.slice(0, 7), message: (cm.commit.message || '').split('\n')[0], author: (cm.author && cm.author.login) || cm.commit.author.name, date: cm.commit.author.date, html_url: cm.html_url } : null;
    g.fetchedAt = now; g.error = ''; g.rateResetAt = 0;
  } catch (e) {
    if (e.reset) { g.rateResetAt = e.reset; g.error = 'GitHub rate limit reached, showing saved data. Retrying at ' + fTime.format(new Date(e.reset)) + '.'; }
    else g.error = g.fetchedAt ? 'GitHub unreachable, showing saved data.' : 'GitHub unreachable right now.';
  }
  lsSet(LS.gh, g); emit('data', { source: 'github' }); render();
}

// ---------- Calo live check (same origin) ----------
async function getText(path) { const r = await fetch(CALO + path + (path.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' }); if (!r.ok) throw new Error(path + ' ' + r.status); return r.text(); }
async function checkCalo(force) {
  const c = state.calo;
  if (!force && Date.now() - (c.checkedAt || 0) < REFRESH_MS - 5000) return;
  const t0 = performance.now();
  const [m, sw, cfg] = await Promise.allSettled([getText('manifest.webmanifest'), getText('sw.js'), getText('js/config.js')]);
  const next = { checkedAt: Date.now(), online: false };
  if (m.status === 'fulfilled') {
    try { const j = JSON.parse(m.value); next.online = true; next.name = j.short_name || j.name; next.description = j.description; } catch {}
    next.ms = Math.round(performance.now() - t0);
  }
  if (sw.status === 'fulfilled') { const x = sw.value.match(/const\s+CACHE\s*=\s*['"`]([^'"`]+)['"`]/); if (x) next.cache = x[1]; }
  if (cfg.status === 'fulfilled') { const x = cfg.value.match(/APP_VERSION\s*=\s*['"`]([^'"`]+)['"`]/); if (x) next.version = x[1]; }
  if (next.online) next.lastOnlineAt = next.checkedAt; else next.lastOnlineAt = c.lastOnlineAt;
  state.calo = next; lsSet(LS.calo, next); emit('data', { source: 'calo' }); render();
}

// ---------- 3D layer (3d/nova-3d.min.js) ----------
const N3 = window.NOVA3D || null;
const SCREEN2 = document.documentElement.getAttribute('data-n3d-screen') === '2';
const BUNNY = '3d/assets/calo-bunny.glb';
const n3d = { shown: false, webgl: false, booted: false, holo: null, agentsKey: '', runKey: '' };
function clock3d() {
  const c = clockParts();
  return `<div class="clock3d" aria-hidden="true"><b data-clock>${c.hm}</b><span data-ampm>${c.ap} · ${c.zone}</span><small>Halifax</small></div>`;
}
function sync3D() {
  if (!N3) return;
  const a = agents(), working = a.filter((x) => x.status === 'working').length, need = a.some((x) => x.status === 'needs_you');
  const list = a.map((x) => ({ name: x.name, status: x.status === 'needs_you' || x.status === 'working' ? x.status : 'idle' }));
  const key = JSON.stringify(list);
  if (key !== n3d.agentsKey) { n3d.agentsKey = key; N3.setAgents(list); N3.setActivity(working, Math.max(1, a.length)); }
  const st = need ? 'alert' : working ? 'busy' : 'normal';
  if (N3.state.status !== st) N3.setStatus(st);
  const r = state.gh.run, rk = r ? r.run_number + ':' + r.status : '';
  if (n3d.runKey && rk && rk !== n3d.runKey) N3.pulse(); // new deploy activity
  if (rk) n3d.runKey = rk;
}
function placeHolo() {
  if (!N3 || !n3d.webgl) return;
  const slot = $('#view [data-holo-slot]'); if (!slot) return;
  if (!n3d.holo) {
    n3d.holo = document.createElement('div'); n3d.holo.className = 'holo-host';
    slot.replaceChildren(n3d.holo);
    N3.mountHologram(n3d.holo, BUNNY, { label: 'Calo the bunny, holographic 3D model. Drag to spin.' });
  } else if (n3d.holo.parentElement !== slot) slot.replaceChildren(n3d.holo); // re-use one WebGL context across re-renders
}
function after3D() {
  if (!N3) return;
  N3.attachPanels('#view .panel, #s2 .panel', { boot: !n3d.booted });
  n3d.booted = true;
  placeHolo(); sync3D(); refreshFocus();
}
function reset3D() {
  if (!N3) return;
  N3.back(); n3d.booted = false; n3d.agentsKey = ''; N3.setAgents([]); N3.setActivity(0, 1); N3.setStatus('normal');
}
// focus detail: real data per area
const drow = (dot, title, sub, right = '', href = '', attrs = '') => {
  const inner = `<span class="dot ${dot}"></span><div class="grow"><b class="ell" style="display:block">${title}</b>${sub ? `<div class="mutedt sm">${sub}</div>` : ''}</div>${right}`;
  const u = safeUrl(href);
  return u ? `<a class="row hov" href="${esc(u)}" target="_blank" rel="noopener">${inner}</a>` : attrs ? `<button class="row drow" ${attrs}>${inner}</button>` : `<div class="row">${inner}</div>`;
};
const kvs = (items) => `<div class="kv dkv">${items.map(([k, v, cls = '']) => `<div><div class="label">${k}</div><div class="big ${cls}">${v}</div></div>`).join('')}</div>`;
function renderArea(area) {
  const wait = `<div class="empty">${state.statusErr ? esc(state.statusErr) : 'Decrypting…'}</div>`;
  if (area === 'team') {
    const a = agents(), c = counts(); if (!state.status) return wait;
    const order = { needs_you: 0, working: 1, done: 2, idle: 3 };
    const rows = a.map((x, i) => [x, i]).sort((p, q) => (order[p[0].status] ?? 4) - (order[q[0].status] ?? 4)).map(([x, i]) => {
      const s = stOf(x), right = `<span class="badge ${s.badge}">${s.label}</span>`;
      return drow(s.dot, `${esc(x.name)} <small class="mutedt">${esc(KIND[x.kind] || x.kind || '')}</small>`, esc(x.task || (x.status === 'idle' ? 'Standing by' : '')), right, '', SCREEN2 ? '' : `data-agent="${i}"`);
    }).join('');
    return kvs([['Working', c.working], ['Need you', c.need, c.need ? 'warnc' : ''], ['Agents', c.total]]) + `<div class="dlist">${rows || '<div class="empty">No agents yet</div>'}</div>` + `<div class="dfoot mutedt sm">${state.status.updatedAt ? 'Updated ' + esc(ago(state.status.updatedAt)) + ' · ' : ''}Encrypted feed</div>`;
  }
  if (area === 'github') {
    const g = state.gh, r = g.run, cm = g.commit, rs = runState(), prs = g.prs || [];
    const dep = rs === 'ok' ? ['Live', 'okc'] : rs === 'bad' ? ['Failed', 'badc'] : rs === 'warn' ? ['Running', 'warnc'] : ['…', ''];
    let h = kvs([['Deploy', dep[0], dep[1]], ['Open PRs', g.prs ? prs.length : '…'], ['Last commit', cm ? esc(ago(cm.date)) : '…']]);
    h += '<div class="dlist">';
    if (r) h += drow(rs === 'ok' ? 'ok' : rs === 'bad' ? 'bad' : 'warn', 'Latest deploy · ' + esc(r.name || 'workflow'), `${r.status !== 'completed' ? 'Deploying now' : esc(r.conclusion || '')} · run #${esc(r.run_number)} · ${esc(ago(r.updated_at))}`, '', r.html_url);
    if (cm) h += drow('', esc(cm.message), `<span class="mono">${esc(cm.sha)}</span> · ${esc(cm.author || '')} · ${esc(ago(cm.date))}`, '', cm.html_url);
    h += '</div><div class="label" style="margin:0.75rem 0 2px">Open pull requests</div><div class="dlist">';
    h += g.prs ? (prs.length ? prs.map((p) => drow('', `#${esc(p.number)} ${esc(p.title)}`, 'Updated ' + esc(ago(p.updated_at)), p.draft ? '<span class="badge dim">Draft</span>' : '<span class="badge acc">Ready</span>', p.html_url)).join('') : '<div class="empty">No open pull requests</div>') : '<div class="empty">Loading…</div>';
    h += '</div>';
    if (g.error) h += `<div class="mutedt sm" style="margin-top:0.5rem">${esc(g.error)}</div>`;
    return h + `<div class="dfoot mutedt sm"><a class="lnk" href="https://github.com/${REPO}" target="_blank" rel="noopener">${REPO}</a>${g.fetchedAt ? ' · synced ' + esc(ago(g.fetchedAt)) : ''}</div>`;
  }
  if (area === 'tasks') {
    const t = tasks(); if (!state.status) return wait;
    const done = t.filter((x) => x.done).length;
    const rows = t.map((x) => { const u = safeUrl(x.link); const inner = `<span class="chk ${x.done ? 'done' : ''}"></span><span class="grow ${x.done ? 'strike' : ''}">${esc(x.title)}</span>`;
      return u ? `<a class="row hov" href="${esc(u)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="row">${inner}</div>`; }).join('');
    return kvs([['Done', `${done} / ${t.length}`], ['Left', t.length - done]]) + `<div class="dlist">${rows || '<div class="empty">No tasks yet</div>'}</div>` + `<div class="dfoot mutedt sm"><a class="lnk" href="${NOTION_TASKS}" target="_blank" rel="noopener">Open tasks in Notion</a></div>`;
  }
  if (area === 'calo') {
    const c = state.calo, s = caloStats(), up = updates().slice(0, 4);
    const stv = !c.checkedAt ? ['…', ''] : c.online ? ['Online', 'okc'] : ['Offline', 'badc'];
    let h = kvs([['Version', esc(s.version)], ['Status', stv[0], stv[1]], ['Response', c.ms ? esc(c.ms) + ' ms' : '—']]);
    h += `<div class="mutedt sm" style="margin:2px 0 0.5rem">Live at <a class="lnk" href="${CALO}" target="_blank" rel="noopener">tyler467890.github.io/student-day-planner</a>${c.checkedAt ? ' · checked ' + esc(ago(c.checkedAt)) : ''}${c.cache ? ' · build <span class="mono">' + esc(c.cache) + '</span>' : ''}</div>`;
    h += '<div class="label" style="margin:0.375rem 0 2px">Recent updates</div><div class="dlist">' + (up.length ? up.map((u) => drow('', esc(u.title), esc(dayLabel(u.time)))).join('') : '<div class="empty">No updates yet</div>') + '</div>';
    return h;
  }
  if (area === 'business') {
    return `<p class="mutedt" style="margin-bottom:0.75rem">Sales, profit, ads and email show up here once Calo is on Etsy. Nothing is connected yet, so there are no numbers to show.</p>
      <div class="dlist">${[['Sales & profit', 'Etsy revenue and orders'], ['Ads', 'Spend, clicks and conversions'], ['Email', 'Support inbox']].map(([a, b]) => drow('idle', a, b, '<span class="soon">After launch</span>')).join('')}</div>`;
  }
  return '';
}
function fillFocus(area, body) {
  if (!area || !body || body.querySelector('.n3d-remote-note')) return;
  const top = body.scrollTop; body.innerHTML = renderArea(area); body.scrollTop = top;
}
function refreshFocus() {
  if (!N3 || !N3.state.focus) return;
  fillFocus(N3.state.focus, document.querySelector('.n3d-detail-body'));
}
function renderS2() {
  if (!$('#s2')) return;
  const c = counts(), a = agents(), clk = clockParts();
  const wide = document.documentElement.getAttribute('data-n3d-layout') === 'wide' && !SCREEN2;
  patch($('#s2bar'), `<div class="brand">${brandMark()}<div class="name">NOVA</div><div class="sub">Screen 2 · Operations</div></div>
   <div class="tright"><span class="pill link" data-peer><span class="dot idle"></span><span class="linktxt">${wide ? 'Wide mode · both screens' : 'Looking for screen 1…'}</span></span>
   <span class="clk" data-topclock2>${esc(clk.date.toUpperCase())} · ${esc(clk.hm)} ${esc(clk.ap)} ${esc(clk.zone)}</span>
   ${fpsTag()}${fsButton()}${SCREEN2 && canPlace() ? `<button class="lockbtn placebtn" data-place title="Move this window to your other monitor and make it full screen">${ic('monitor', 15, 'currentColor')}<span class="lt">Place on other monitor</span></button>` : ''}
   <button class="lockbtn setbtn" data-settings title="Settings">${ic('gear', 15, 'currentColor')}<span class="lt">Settings</span></button>
   ${SCREEN2 ? `<button class="lockbtn" data-lock title="Lock NOVA and forget the passphrase on this device">${ic('lock', 15, 'currentColor')}<span class="lt">Lock</span></button>` : ''}</div>`);
  const upd = state.status && state.status.updatedAt ? fTime.format(new Date(state.status.updatedAt)) : '';
  patch($('#s2-feed'), `<div class="ph"><h3>Agent activity<small>latest status</small></h3><span class="meta"><span class="acc">${c.working} working</span>${c.need ? ` · <span class="warnc">${c.need} need${c.need === 1 ? 's' : ''} you</span>` : ''}</span></div>
   <div class="scroll s2list">${a.length ? a.map((x) => `<div class="ev2"><span class="tt">${esc(upd)}</span><span class="dot ${stOf(x).dot}"></span><div class="grow"><div class="ea">${esc(x.name)} <small class="mutedt">${esc(KIND[x.kind] || x.kind || '')}</small></div><div class="eb">${esc(stOf(x).label)}${x.task ? ' · ' + esc(x.task) : ''}</div></div></div>`).join('') : `<div class="empty">${state.statusErr ? esc(state.statusErr) : 'Decrypting team status…'}</div>`}</div>`);
  const ev = [];
  const g = state.gh;
  if (g.run) ev.push([g.run.updated_at, runState() === 'ok' ? 'ok' : runState() === 'bad' ? 'bad' : 'warn', 'deploy', `${g.run.name || 'workflow'} #${g.run.run_number} · ${g.run.status !== 'completed' ? 'running' : g.run.conclusion}`]);
  if (g.commit) ev.push([g.commit.date, 'acc', 'commit', `${g.commit.sha} ${g.commit.message}`]);
  (g.prs || []).slice(0, 4).forEach((p) => ev.push([p.updated_at, 'acc', 'pr', `#${p.number} ${p.title}${p.draft ? ' (draft)' : ''}`]));
  updates().forEach((u) => ev.push([u.time, 'acc', 'update', u.title]));
  (conn.inbox || []).slice(0, 3).forEach((x) => ev.push([x.time, 'ok', 'reply', x.text]));
  if (state.calo.checkedAt) ev.push([state.calo.checkedAt, state.calo.online ? 'ok' : 'bad', 'uptime', `Calo ${state.calo.online ? 'online' : 'offline'}${state.calo.ms ? ' · ' + state.calo.ms + ' ms' : ''}`]);
  const tms = (v) => { const t = typeof v === 'number' ? v : Date.parse(v && v.length === 10 ? v + 'T12:00:00-03:00' : v); return isNaN(t) ? 0 : t; };
  ev.sort((x, y) => tms(y[0]) - tms(x[0]));
  patch($('#s2-logs'), `<div class="ph"><h3>Activity log<small>GitHub · Calo · team</small></h3><span class="meta">Halifax time</span></div>
   <div class="scroll s2list">${ev.length ? ev.slice(0, 14).map(([t, k, kind, m]) => `<div class="lg"><span class="lt">${tms(t) ? esc(fYmd.format(new Date(tms(t))) === fYmd.format(new Date()) ? fTime.format(new Date(tms(t))) : fDay.format(new Date(tms(t)))) : ''}</span><span class="lk ${k}">${esc(kind)}</span><span class="lm" title="${esc(m)}">${esc(m)}</span></div>`).join('') : '<div class="empty">Loading…</div>'}</div>`);
  patch($('#s2-biz'), `<div class="ph"><h3>Business<small>after launch</small></h3><span class="soon">Coming after launch</span></div>
   <p class="mutedt" style="font-size:0.875rem">Etsy sales, profit, ads and email appear here after Calo launches. Nothing is connected yet.</p>
   <div class="bk">${['Sales', 'Profit', 'Ads', 'Email'].map((k) => `<div class="future"><div class="label">${k}</div><div class="big dimt">—</div></div>`).join('')}</div>`);
  const bl = $('#s2-baylbl'); if (bl) bl.textContent = `Calo${state.calo.version ? ' v' + state.calo.version : ''} · phone + guide preview`;
  updatePeer();
}
function updatePeer() {
  const p = $('[data-peer]'); if (!p || !N3) return;
  const wide = document.documentElement.getAttribute('data-n3d-layout') === 'wide' && !SCREEN2, on = wide || N3.state.peer;
  p.classList.toggle('on', on);
  p.querySelector('.linktxt').textContent = wide ? 'Wide mode · both screens' : on ? (SCREEN2 ? 'Linked to screen 1' : 'Linked to screen 2') : (SCREEN2 ? 'Open NOVA on screen 1' : 'Screen 2 not open');
}
if (N3) {
  document.addEventListener('nova:3d-ready', (e) => {
    n3d.webgl = !!e.detail.webgl;
    document.documentElement.classList.toggle('n3d-on', n3d.webgl);
  });
  document.addEventListener('nova:focus', (e) => fillFocus(e.detail.area, e.detail.body));
  document.addEventListener('nova:agent-select', (e) => openAgent(e.detail.index));
  document.addEventListener('nova:layout', (e) => { wideSplit(); if (n3d.shown) render(); if (e.detail.layout === 'wide') wideTip(); });
  window.addEventListener('hashchange', () => { if (N3.state.focus) N3.back(); });
  setInterval(updatePeer, 2000);
  setInterval(() => { const t = $('[data-topclock2]'); if (t) { const c = clockParts(); t.textContent = `${c.date.toUpperCase()} · ${c.hm} ${c.ap} ${c.zone}`; } }, 1000);
}

// ---------- screens: Full screen, Screen 2, Place on other monitor, Settings ----------
const PREFS_KEY = 'nova.prefs', AUTO_KEY = 'nova.perf.auto';
const prefs = () => Object.assign({ perf: 'auto', glass: false, fps: false, wide: 'auto' }, lsGet(PREFS_KEY) || {});
const isFs = () => !!document.fullscreenElement;
const canPlace = () => 'getScreenDetails' in window;
let screenSD = null; // ScreenDetails once the browser has allowed window management
let s2win = null;
function fsButton() {
  const on = isFs();
  return `<button class="lockbtn fsbtn" data-fullscreen title="${on ? 'Leave full screen (Esc)' : 'Fill this monitor: hides the browser bars (same as F11)'}">${ic(on ? 'exitfull' : 'full', 16, 'currentColor', 2)}<span class="lt">${on ? 'Exit full screen' : 'Full screen'}</span></button>`;
}
function fpsTag() {
  if (!prefs().fps || !N3) return '';
  const s = N3.state; return `<span class="fpsread" data-fps>${fpsText(s)}</span>`;
}
const MODE_NAME = { smooth: 'Smooth', full: 'Full effects', minimal: 'Minimal' };
function fpsText(s) { return `${s.fps} fps · ${MODE_NAME[s.mode] || s.mode}${s.lowDpr ? ' · 1x' : ''}`; }
async function toggleFs() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (e) { toast(`<div><b>Full screen didn’t start</b><div class="mutedt sm">Press <kbd class="k">F11</kbd> instead. It does the same thing.</div></div>`, 8000); }
}
document.addEventListener('fullscreenchange', () => {
  document.documentElement.classList.toggle('is-fs', isFs());
  if (isFs()) { lsSet('nova.tip.fs.' + (SCREEN2 ? 2 : 1), 1); hideToast('fs'); }
  if ($('#lock').hidden) render();
  wideSplit();
});
function s2url() { const u = new URL(location.href); u.hash = ''; u.searchParams.set('screen', '2'); return u.href; }
async function screenDetails(ask) {
  if (!canPlace()) return null;
  try {
    if (!ask) { const st = await navigator.permissions.query({ name: 'window-management' }).catch(() => null); if (!st || st.state !== 'granted') return null; }
    screenSD = await window.getScreenDetails();
    screenSD.onscreenschange = () => wideSplit();
    return screenSD;
  } catch (e) { return null; }
}
const inside = (s, p) => p.x >= s.left && p.x < s.left + s.width && p.y >= s.top && p.y < s.top + s.height;
const winCentre = () => ({ x: window.screenX + window.outerWidth / 2, y: window.screenY + window.outerHeight / 2 });
// the monitor that isn't showing `avoid` (screen 1's window); falls back to any screen but this one
function otherScreen(sd, avoid) {
  const list = (sd && sd.screens) || []; if (list.length < 2) return null;
  return (avoid && list.find((s) => !inside(s, avoid))) || list.find((s) => s !== sd.currentScreen) || null;
}
const placeFeat = (s) => `popup,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`;
function openScreen2() {
  const o = screenSD && otherScreen(screenSD, winCentre());
  const feat = o ? placeFeat(o) : `popup,width=${Math.round(Math.min(1600, screen.availWidth * 0.8))},height=${Math.round(Math.min(900, screen.availHeight * 0.8))}`;
  s2win = window.open(s2url(), 'nova-screen-2', feat);
  if (!s2win) { toast(`<div><b>Your browser blocked the new window</b><div class="mutedt sm">Allow pop-ups for this site (icon at the right of the address bar), then click Screen 2 again.</div></div>`, 10000); return; }
  if (o) { chan.postMessage({ t: 'fs-ask' }); toast(`<div><b>Screen 2 opened on your other monitor</b><div class="mutedt sm">Click it once to make it full screen.</div></div>`, 8000); return; }
  toast(`<div><b>Screen 2 is open</b><div class="mutedt sm">${canPlace() ? 'Click <b>Place on other monitor</b>, or drag' : 'Drag'} the new window onto your other monitor, then click <b>Full screen</b> on it.</div></div>
   ${canPlace() ? '<button class="btn" data-place>Place on other monitor</button>' : ''}`, 20000, 's2');
}
// screen 1: move the Screen 2 window to the other monitor; screen 2: go full screen on the other monitor
async function placeOnOther() {
  const sd = await screenDetails(true);
  if (!sd) { toast(`<div><b>Couldn’t reach your monitors</b><div class="mutedt sm">Allow “Window management” when Chrome or Edge asks, or drag the window over and click Full screen.</div></div>`, 10000); return; }
  if (sd.screens.length < 2) { toast(`<div><b>Only one monitor found</b><div class="mutedt sm">On Windows press <kbd class="k">Win</kbd>+<kbd class="k">P</kbd> and pick <b>Extend</b>, then try again.</div></div>`, 12000); return; }
  if (SCREEN2) {
    const o = otherScreen(sd, peerCentre) || sd.currentScreen;
    try { await document.documentElement.requestFullscreen({ screen: o, navigationUI: 'hide' }); }
    catch (e) { toast(`<div><b>One more click</b><div class="mutedt sm">Chrome needs a fresh click after the permission prompt.</div></div><button class="btn" data-place>Place on other monitor</button>`, 15000, 'place'); }
    return;
  }
  const o = otherScreen(sd, winCentre());
  if (!s2win || s2win.closed) { s2win = window.open(s2url(), 'nova-screen-2', placeFeat(o)); if (!s2win) { toast(`<div><b>Almost there</b><div class="mutedt sm">Click to open Screen 2 on your other monitor.</div></div><button class="btn" data-screen2>Open Screen 2</button>`, 15000, 's2'); return; } }
  else { try { s2win.moveTo(o.availLeft, o.availTop); s2win.resizeTo(o.availWidth, o.availHeight); } catch (e) {} }
  chan.postMessage({ t: 'fs-ask' });
  toast(`<div><b>Screen 2 is on your other monitor</b><div class="mutedt sm">Click it once to make it full screen.</div></div>`, 8000, 's2');
}
// screens talk over a BroadcastChannel: screen 1 says where it is, screen 2 offers a one-click full screen
const chan = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('nova-screens') : { postMessage() {}, set onmessage(f) {} };
let peerCentre = null;
chan.onmessage = (e) => {
  const m = e.data || {};
  if (m.t === 'where' && !SCREEN2) chan.postMessage({ t: 'here', c: winCentre() });
  if (m.t === 'here' && SCREEN2) peerCentre = m.c;
  if (m.t === 'fs-ask' && SCREEN2 && !isFs()) fsAsk();
  if (m.t === 'prefs') applyPrefs(false);
};
if (SCREEN2) chan.postMessage({ t: 'where' });
function fsAsk() {
  if ($('#fsask')) return;
  document.body.insertAdjacentHTML('beforeend', `<div class="nmodal" id="fsask"><div class="panel mbox" style="text-align:center;width:min(30rem,100%)"><h3 class="ph" style="justify-content:center"><span style="font-family:var(--font-hd);letter-spacing:.14em;text-transform:uppercase;color:var(--acc2)">Screen 2</span></h3>
   <p class="mutedt" style="margin-bottom:1rem">Click below to fill this monitor.</p><button class="btn" data-fsgo style="font-size:1.2rem;padding:.9rem 1.6rem">${ic('full', 18, 'currentColor', 2)} Full screen</button>
   <div style="margin-top:.8rem"><button class="lnkbtn" data-fsno>Not now</button></div></div></div>`);
}
function screenClicks(e) {
  const t = e.target.closest('[data-fullscreen],[data-place],[data-settings],[data-fsgo],[data-fsno],[data-tipx],[data-pref],[data-perfretry],[data-twowin]');
  if (!t) return;
  if (t.hasAttribute('data-fullscreen')) toggleFs();
  else if (t.hasAttribute('data-place')) { hideToast(); placeOnOther(); }
  else if (t.hasAttribute('data-settings')) openSettings();
  else if (t.hasAttribute('data-fsgo')) { $('#fsask') && $('#fsask').remove(); toggleFs(); }
  else if (t.hasAttribute('data-fsno')) { $('#fsask') && $('#fsask').remove(); }
  else if (t.hasAttribute('data-tipx')) hideToast();
  else if (t.hasAttribute('data-perfretry')) { localStorage.removeItem(AUTO_KEY); if (N3) N3.setMode('smooth', { auto: true, lowDpr: false }); openSettings(); }
  else if (t.hasAttribute('data-twowin')) { setPref({ wide: 'off' }); hideToast(); openScreen2(); }
}
document.addEventListener('change', (e) => { const t = e.target.closest('[data-pref]'); if (!t) return; const k = t.getAttribute('data-pref'); setPref({ [k]: t.type === 'checkbox' ? t.checked : t.value }); });
function setPref(p) {
  const next = Object.assign(prefs(), p); lsSet(PREFS_KEY, next);
  if (p.perf) localStorage.removeItem(AUTO_KEY);
  applyPrefs(true); chan.postMessage({ t: 'prefs' });
  if ($('#modal .settings')) openSettings();
}
function applyPrefs(local) {
  const p = prefs(), root = document.documentElement;
  root.classList.toggle('glass', !!p.glass);
  if (N3) {
    if (p.perf === 'auto') { const a = lsGet(AUTO_KEY); if (!local || N3.state.modeAuto === false) N3.setMode(a && a.mode ? a.mode : 'smooth', { auto: true, lowDpr: !!(a && a.lowDpr) }); }
    else N3.setMode(p.perf, { auto: false });
    N3.setWide(p.wide);
  }
  if ($('#lock').hidden) render();
}
window.addEventListener('storage', (e) => { if (e.key === PREFS_KEY) applyPrefs(false); });
function openSettings() {
  const p = prefs(), s = N3 ? N3.state : null, auto = lsGet(AUTO_KEY);
  const opt = (name, val, cur, title, desc) => `<label class="opt ${cur === val ? 'on' : ''}"><input type="radio" name="${name}" value="${val}" data-pref="${name}" ${cur === val ? 'checked' : ''}><div><b>${title}</b><div class="mutedt sm">${desc}</div></div></label>`;
  const chk = (key, title, desc) => `<label class="opt ${p[key] ? 'on' : ''}"><input type="checkbox" data-pref="${key}" ${p[key] ? 'checked' : ''}><div><b>${title}</b><div class="mutedt sm">${desc}</div></div></label>`;
  const now = s ? `Right now: ${MODE_NAME[s.mode]}${s.lowDpr ? ' at 1x resolution' : ''} · ${s.fps} fps drawn${s.busyFps ? ` · ${s.busyFps} fps while moving` : ''}` : '3D is off on this device';
  const dropped = p.perf === 'auto' && auto && auto.mode === 'minimal';
  document.getElementById('modal') || document.body.insertAdjacentHTML('beforeend', '<div id="modal"></div>');
  $('#modal').innerHTML = `<div class="nmodal" data-mclose><div class="panel mbox settings" role="dialog" aria-modal="true" aria-label="Settings">
   <div class="ph"><h3>Settings<small>this device</small></h3><button class="x" data-mclose aria-label="Close">✕</button></div>
   <div class="sgroup"><div class="label">Performance</div>
    ${opt('perf', 'auto', p.perf, 'Smooth (recommended)', 'Lighter glow, full speed only while you move things. Switches itself to Minimal if your computer struggles.')}
    ${opt('perf', 'full', p.perf, 'Full effects', 'Bloom glow, sharper edges, faster idle animation. Needs a strong graphics card.')}
    ${opt('perf', 'minimal', p.perf, 'Minimal', 'No 3D background and a still core. The lightest option.')}
    <div class="mutedt sm" style="margin-top:.5rem">${esc(now)}${dropped ? ' · <button class="lnkbtn" data-perfretry>Try Smooth again</button>' : ''}</div>
    ${chk('glass', 'Frosted glass blur', 'Blurs the 3D scene behind every panel. Looks nice, but it’s the slowest effect.')}
    ${chk('fps', 'Show frame rate', 'Adds a small fps counter to the top bar.')}
   </div>
   <div class="sgroup"><div class="label">Two screens</div>
    <ol class="steps"><li>Use NOVA on your monitor and click <b>Screen 2</b>.</li><li>${canPlace() ? 'Click <b>Place on other monitor</b> (allow “Window management” once), or drag' : 'Drag'} the new window onto your laptop screen.</li><li>Click <b>Full screen</b> on each window (or press <kbd class="k">F11</kbd>).</li></ol>
    <div class="btns">${SCREEN2 ? '' : '<button class="btn sm" data-screen2>Open Screen 2</button>'}${canPlace() ? '<button class="btn sm" data-place>Place on other monitor</button>' : ''}<button class="btn sm" data-fullscreen>${isFs() ? 'Exit full screen' : 'Full screen'}</button></div>
    ${opt('wide', 'auto', p.wide, 'Separate windows (recommended)', 'Each window fits its own screen. The stretched layout only turns on if one window really spans both monitors.')}
    ${opt('wide', 'off', p.wide, 'Never stretch', 'Always the normal layout, even in one very wide window.')}
    ${opt('wide', 'on', p.wide, 'Stretched across both', 'One window, screen 2 on the right half. Fits badly when the screens differ in size or height.')}
   </div>
   <div class="btns" style="margin-top:1rem"><button class="btn" data-mclose>Done</button></div></div></div>`;
}
// toasts
let toastTm = 0;
function toast(html, ms = 9000, id = '') {
  hideToast();
  document.body.insertAdjacentHTML('beforeend', `<div class="ntoast" id="ntoast" role="status" data-id="${id}">${html}<button class="x" data-tipx aria-label="Dismiss">✕</button></div>`);
  clearTimeout(toastTm); if (ms) toastTm = setTimeout(hideToast, ms);
}
function hideToast(id) { const t = $('#ntoast'); if (t && (!id || t.dataset.id === id)) t.remove(); }
function firstTips() {
  const k = 'nova.tip.fs.' + (SCREEN2 ? 2 : 1);
  if (isFs() || lsGet(k)) return;
  lsSet(k, 1);
  toast(`<div><b>Tip</b> <span class="mutedt">Press <kbd class="k">F11</kbd> or click <b>Full screen</b> to hide the browser bars.${SCREEN2 ? '' : ' Two monitors? Click <b>Screen 2</b> to open the second window.'}</span></div><button class="btn" data-fullscreen>Full screen</button>`, 14000, 'fs');
}
function wideTip() {
  if (lsGet('nova.tip.wide')) return; lsSet('nova.tip.wide', 1);
  toast(`<div><b>Stretched over two screens</b><div class="mutedt sm">NOVA fits much better as two windows, one per monitor.</div></div><button class="btn" data-twowin>Use two windows</button>`, 20000, 'wide');
}
// stretched mode: split where the monitors actually meet instead of assuming two equal halves
function wideSplit() {
  const root = document.documentElement;
  if (root.getAttribute('data-n3d-layout') !== 'wide' || SCREEN2) { root.style.removeProperty('--split-a'); return; }
  const vx = window.screenX + Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  let edge = null;
  if (screenSD && screenSD.screens) { const first = screenSD.screens.find((s) => vx >= s.left && vx < s.left + s.width); if (first) edge = first.left + first.width - vx; }
  else if (window.screen) { const sl = screen.availLeft ?? 0; edge = vx >= sl ? sl + screen.width - vx : sl - vx; }
  if (edge && edge > innerWidth * 0.25 && edge < innerWidth * 0.75) root.style.setProperty('--split-a', Math.round(edge) + 'px'); else root.style.removeProperty('--split-a');
}
window.addEventListener('resize', wideSplit);
if (N3) {
  document.addEventListener('nova:perf', (e) => {
    const d = e.detail;
    if (d.auto) lsSet(AUTO_KEY, { mode: d.mode, lowDpr: d.lowDpr });
    if (d.reason === 'minimal') toast(`<div><b>Switched to Minimal effects</b><div class="mutedt sm">The 3D scene was running at ${d.fps} fps on this computer, so NOVA turned it down to stay smooth.</div></div><button class="btn" data-settings>Settings</button>`, 15000, 'perf');
  });
  setInterval(() => { const f = $('[data-fps]'); if (f) f.textContent = fpsText(N3.state); }, 1000);
}
screenDetails(false).then(() => wideSplit()); // no prompt: only if already allowed

// ---------- lock / unlock ----------
let timers = [];
function startLive() {
  stopLive();
  refreshGitHub(); checkCalo();
  timers.push(setInterval(() => { refreshGitHub(); checkCalo(); refreshStatus(); }, REFRESH_MS));
  timers.push(setInterval(tickAgo, 30000));
  if (!SCREEN2) timers.push(setInterval(() => { if (document.visibilityState === 'visible') refreshConn(); }, 90000));
  document.addEventListener('visibilitychange', onVis);
}
function stopLive() { timers.forEach(clearInterval); timers = []; document.removeEventListener('visibilitychange', onVis); }
function onVis() { if (document.visibilityState === 'visible') { refreshGitHub(); checkCalo(); if (Date.now() - state.statusLoadedAt > 60000) refreshStatus(); } }
function lock(msg) {
  n3d.shown = false; apiLogout(); if ($('#modal')) $('#modal').innerHTML = '';
  localStorage.removeItem(LS.pass); keyCache.clear(); state.status = null; stopLive(); reset3D();
  $('#view').innerHTML = ''; $('#sheet').innerHTML = ''; ['#view', '#s2-feed', '#s2-logs'].forEach((k) => { if ($(k)) { $(k).innerHTML = ''; $(k).__html = ''; } });
  if (N3) N3.setPaused(true); hideToast();
  $('#lock').hidden = false; $('#screen').setAttribute('aria-hidden', 'true');
  const m = $('#lockmsg'); m.textContent = msg || 'Locked. Enter your passphrase to open NOVA.'; m.className = 'lockmsg' + (msg ? ' err' : '');
  $('#pass').value = ''; setTimeout(() => $('#pass').focus(), 50);
}
function showApp() { n3d.shown = true; $('#lock').hidden = true; $('#screen').removeAttribute('aria-hidden'); if (N3) N3.setPaused(false); route(); startLive(); setTimeout(firstTips, 1500); }
$('#lockring').innerHTML = coreRing([{ state: 'ok' }, { state: 'ok' }, { state: 'ok' }], false);
$('#lockform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const pass = normPass($('#pass').value), btn = $('#go'), m = $('#lockmsg');
  if (!pass) return;
  btn.disabled = true; btn.textContent = 'Unlocking…'; m.className = 'lockmsg'; m.textContent = 'Deriving key…';
  try {
    state.status = await fetchStatus(pass); state.statusErr = ''; state.statusLoadedAt = Date.now();
    localStorage.setItem(LS.pass, pass); m.textContent = ''; showApp();
    if (!SCREEN2) apiLogin(pass).then(refreshConn); // silent sign-in to the secure service (nova-api)
  } catch (err) {
    m.className = 'lockmsg err';
    m.textContent = err instanceof WrongPass ? 'That passphrase didn’t work. Check the words and dashes.' : 'Couldn’t reach the status file. Check your connection.';
  } finally { btn.disabled = false; btn.textContent = 'Unlock'; }
});

// boot
if (N3) { try { N3.init(); } catch (e) { console.warn('NOVA 3D unavailable:', e.message); } }
document.documentElement.classList.toggle('glass', !!prefs().glass);
setInterval(tick, 1000);
(async () => {
  const pass = localStorage.getItem(LS.pass);
  if (!pass) { lock(); $('#lockmsg').className = 'lockmsg'; $('#lockmsg').textContent = 'Remembered on this device until you press Lock.'; return; }
  showApp();
  if (!SCREEN2) refreshConn();
  await refreshStatus();
})();
window.addEventListener('nova:conn', () => { if ($('#lock').hidden) render(); });

if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e.message)));
