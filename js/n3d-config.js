// NOVA 3D layer config. Loaded synchronously in <head> (CSP forbids inline scripts) so the screen mode,
// performance mode and glass setting are in place before first paint.
(function () {
  var q = new URLSearchParams(location.search), s2 = q.get('screen') === '2', d = document.documentElement;
  var get = function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  var p = get('nova.prefs') || {}, auto = get('nova.perf.auto') || {};
  var perf = q.get('perf') || p.perf || 'auto';            // auto (= Smooth that can step down) | smooth | full | minimal
  var wide = q.get('wide') || p.wide || 'auto';            // auto | on | off
  d.setAttribute('data-n3d-screen', s2 ? '2' : '1');
  d.setAttribute('data-n3d-mode', perf === 'auto' ? (auto.mode || 'smooth') : perf);
  if (p.glass) d.classList.add('glass');
  window.NOVA3D_CONFIG = {
    autoInit: false,                 // js/app.js calls NOVA3D.init()
    screen: s2 ? 2 : 1,
    bunnyUrl: '3d/assets/calo-bunny.glb',
    bay: true,                       // the bay hologram shares the main WebGL context, so it costs nothing while hidden
    perf: perf, perfAuto: auto.mode || null, perfLowDpr: !!auto.lowDpr,
    wide: wide,
    detailAvoid: '#cmdform',         // keep the desktop detail panel clear of the Ask bar
    phoneBottomInset: 92,            // phone tab bar
  };
})();
