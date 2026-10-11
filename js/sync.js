// NOVA cross-device sync: one WebSocket to nova-api /sync (the NovaRoom Durable Object on Cloudflare).
// Desktop screen 1 bridges its BroadcastChannel to it; the phone talks to it directly.
// The token rides in the subprotocol header (never the URL). Reconnects with exponential backoff + jitter,
// pings every 25 s (answered by Cloudflare without waking the room) and drops a socket that stops answering.
import { API } from './connect.js';

export function createSync({ getToken, onMessage, onState }) {
  let ws = null, tries = 0, timer = 0, pingT = 0, pongT = 0, want = false, st = 'off', opening = false;
  const set = (s) => { if (st !== s) { st = s; if (onState) onState(s, tries); } };
  const clear = () => { clearInterval(pingT); clearTimeout(pongT); };
  function drop(code) { // forget the current socket right away (a dead network can take minutes to report close)
    const w = ws; ws = null; clear();
    if (w) { w.onopen = w.onmessage = w.onclose = w.onerror = null; try { w.close(code || 1000); } catch (e) {} }
  }
  function retry() {
    if (!want) return;
    clearTimeout(timer);
    const d = Math.min(30000, 1000 * 2 ** Math.min(tries, 5)) * (0.75 + Math.random() * 0.5); tries++;
    timer = setTimeout(open, d);
  }
  async function open() {
    clearTimeout(timer);
    if (!want || opening || (ws && ws.readyState <= 1)) return;
    if (navigator.onLine === false) { set('offline'); return; } // the 'online' event reopens
    opening = true; set('connecting');
    let tok = null; try { tok = await getToken(); } catch (e) {}
    opening = false;
    if (!want) return;
    if (!tok) { set('noauth'); retry(); return; }
    let w; try { w = new WebSocket(API.replace(/^http/, 'ws') + '/sync', ['nova-sync', 'tok.' + tok]); } catch (e) { set('closed'); retry(); return; }
    ws = w;
    w.onopen = () => { tries = 0; set('open'); clear(); pingT = setInterval(ping, 25000); };
    w.onmessage = (e) => {
      clearTimeout(pongT);
      if (e.data === 'pong') return;
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      if (m && m.t) onMessage(m);
    };
    w.onclose = (e) => {
      if (ws !== w) return;
      ws = null; clear();
      if (e.code === 4001) { want = false; set('revoked'); return; }
      set('closed'); retry();
    };
    w.onerror = () => {};
  }
  function ping() {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send('ping'); } catch (e) {}
    clearTimeout(pongT);
    pongT = setTimeout(() => { drop(); set('closed'); retry(); }, 10000);
  }
  window.addEventListener('online', () => { if (want) { tries = 0; open(); } });
  window.addEventListener('offline', () => { if (want) { drop(); set('offline'); } });
  return {
    start() { if (want && ws) return; want = true; tries = 0; open(); },
    stop() { want = false; clearTimeout(timer); drop(1000); set('off'); },
    now() { if (!want) return; if (ws && ws.readyState === 1) { ping(); return; } tries = 0; open(); }, // reconnect immediately (page shown again)
    send(m) { if (!ws || ws.readyState !== 1) return false; try { ws.send(JSON.stringify(m)); return true; } catch (e) { return false; } },
    drop() { drop(); set('closed'); retry(); }, // tests: simulate a dropped connection
    get state() { return st; }, get tries() { return tries; },
  };
}
