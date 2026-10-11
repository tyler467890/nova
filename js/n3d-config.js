// NOVA boot config, loaded synchronously in <head> (CSP forbids inline scripts) so each window knows
// its screen number, its place (left / centre / right) and the performance mode before first paint.
// ?screen=1 (default) holds the core and the secure session · ?screen=2 · ?screen=3. Settings → Screens sets the order.
// ?screen=phone is the 4th screen: a paired phone, synced across devices through nova-api (NOVA 2.3; 2.4: behaves like screens 2/3).
(function () {
  var q = new URLSearchParams(location.search), d = document.documentElement;
  var get = function (k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  // a paired phone that opens plain "/" (e.g. the home-screen icon on an older install) is still the phone
  var phone = q.get('screen') === 'phone' || (!q.get('screen') && !!get('nova.dev.v1') && !localStorage.getItem('nova.passphrase'));
  if (phone) {
    d.setAttribute('data-screen', 'phone'); d.setAttribute('data-pos', 'phone'); d.setAttribute('data-n3d-mode', 'minimal');
    var mf = document.querySelector('link[rel="manifest"]'); if (mf) mf.setAttribute('href', 'manifest-phone.webmanifest');
    window.NOVA3D_CONFIG = { autoInit: false, perf: 'minimal', perfAuto: null };
    return;
  }
  var scr = +q.get('screen'); if (scr !== 2 && scr !== 3) scr = 1;
  var p = get('nova.prefs') || {}, auto = get('nova.perf.auto') || {};
  var perf = q.get('perf') || p.perf || 'auto';            // auto (= Smooth that can step down) | full | minimal
  var o = p.order || {}, ok = [o.left, o.centre, o.right].sort().join() === '1,2,3';
  if (!ok) o = { left: 2, centre: 1, right: 3 };
  var pos = o.left === scr ? 'left' : o.right === scr ? 'right' : 'centre';
  d.setAttribute('data-screen', String(scr));
  d.setAttribute('data-pos', pos);
  d.setAttribute('data-n3d-mode', perf === 'auto' ? (auto.mode || 'smooth') : perf);
  window.NOVA3D_CONFIG = { autoInit: false, perf: perf, perfAuto: auto.mode || null };
})();
