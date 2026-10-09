// NOVA 3D layer config. Loaded synchronously in <head> (CSP forbids inline scripts) so the screen, its role,
// the performance mode and the glass setting are in place before first paint.
// Screens: ?screen=1 (default) Command · ?screen=2 Team · ?screen=3 Build & Business. js/app.js keeps the role up to date.
(function () {
  var q = new URLSearchParams(location.search), d = document.documentElement;
  var scr = +q.get('screen'); if (scr !== 2 && scr !== 3) scr = 1;
  var get = function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  var p = get('nova.prefs') || {}, auto = get('nova.perf.auto') || {};
  var perf = q.get('perf') || p.perf || 'auto';            // auto (= Smooth that can step down) | smooth | full | minimal
  var wide = q.get('wide') || p.wide || 'auto';            // auto | on | off
  // how many screens are in use: the Layout setting, or (Auto) the NOVA windows that are open right now
  var alive = function (n) { var b = get('nova.scr.' + n); return !!b && Date.now() - b.t < (b.h ? 75000 : 6500); };
  var want = p.screens === '1' || p.screens === '2' || p.screens === '3' ? +p.screens : alive(3) || scr === 3 ? 3 : alive(2) || scr === 2 ? 2 : 1;
  var phone = window.innerWidth <= 760;
  var role = scr === 3 ? 'build' : scr === 2 ? (want >= 3 ? 'team' : 'merged') : (!phone && want >= 2 ? 'command' : 'all');
  d.setAttribute('data-n3d-screen', String(scr));
  d.setAttribute('data-role', role);
  d.setAttribute('data-n3d-mode', perf === 'auto' ? (auto.mode || 'smooth') : perf);
  if (p.glass) d.classList.add('glass');
  window.NOVA3D_CONFIG = {
    autoInit: false,                 // js/app.js calls NOVA3D.init()
    screen: scr,                     // only screen 1 draws the 3D core; screens 2 and 3 draw small holograms only
    bunnyUrl: '3d/assets/calo-bunny.glb',
    bay: true,                       // Calo bunny + phone hologram in the Calo panel (screen 3, or screen 2 with two screens)
    perf: perf, perfAuto: auto.mode || null, perfLowDpr: !!auto.lowDpr,
    wide: wide,
    detailAvoid: '#cmdform',         // keep the desktop detail panel clear of the Ask bar
    phoneBottomInset: 92,            // phone tab bar
  };
})();
