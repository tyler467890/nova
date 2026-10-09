// NOVA 3D layer config. Loaded synchronously in <head> (CSP forbids inline scripts) so the screen mode is set before first paint.
(function () {
  var q = new URLSearchParams(location.search), s2 = q.get('screen') === '2', d = document.documentElement;
  var wide = window.matchMedia && matchMedia('(min-aspect-ratio: 23/10) and (min-width: 2200px)').matches;
  d.setAttribute('data-n3d-screen', s2 ? '2' : '1');
  window.NOVA3D_CONFIG = {
    autoInit: false,                 // js/app.js calls NOVA3D.init()
    screen: s2 ? 2 : 1,
    bunnyUrl: '3d/assets/calo-bunny.glb',
    bay: s2 || wide,                 // hologram bay only where screen 2 is visible
    detailAvoid: '#cmdform',         // keep the desktop detail panel clear of the Ask bar
    phoneBottomInset: 92,            // phone tab bar
  };
})();
