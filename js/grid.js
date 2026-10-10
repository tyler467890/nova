// NOVA grid background: a static 2D canvas, drawn once per resize (no WebGL, no animation loop).
// The three screens share one virtual perspective: the vanishing point sits in the middle of the centre screen,
// and the left and right screens continue the same floor and ceiling lines, so the grid reads as one space.
// Units are the window height; each window knows its own size and the centre screen's aspect (from its heartbeat).
const F = 0.95, HOR = 0.40, FLOOR_H = 1, CEIL_H = 2.4, STEP = 1;

export function drawGrid(canvas, o) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = innerWidth, H = innerHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
  const g = canvas.getContext('2d', { alpha: false });
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const a = W / H, aC = o.centreAspect || 16 / 9;
  // x of this window's left edge, in height units, measured from the vanishing point
  const x0 = o.pos === 'left' ? -aC / 2 - a : o.pos === 'right' ? aC / 2 : -a / 2;
  const sx = (u) => (u - x0) * H, sy = (v) => v * H;
  // backdrop: deep blue, brighter around the vanishing point (continuous across screens)
  g.fillStyle = '#03080f'; g.fillRect(0, 0, W, H);
  const rg = g.createRadialGradient(sx(0), sy(HOR), 0, sx(0), sy(HOR), H * 1.6);
  rg.addColorStop(0, 'rgba(64,214,255,0.13)'); rg.addColorStop(0.35, 'rgba(64,214,255,0.05)'); rg.addColorStop(1, 'rgba(64,214,255,0)');
  g.fillStyle = rg; g.fillRect(0, 0, W, H);
  const plane = (h, dir, alpha) => {
    // dir +1 = floor (below the horizon), -1 = ceiling
    const zNear = F * h / (dir > 0 ? 1 - HOR : HOR), zFar = 70;
    g.lineWidth = 1;
    // depth lines (horizontal): fade with distance
    for (let z = Math.ceil(zNear / STEP) * STEP; z < zFar; z += z < 12 ? STEP : STEP * 2) {
      const y = sy(HOR + dir * F * h / z), k = Math.min(1, 3.2 / z);
      g.strokeStyle = `rgba(64,214,255,${(alpha * (0.15 + 0.85 * k)).toFixed(3)})`;
      g.beginPath(); g.moveTo(0, Math.round(y) + 0.5); g.lineTo(W, Math.round(y) + 0.5); g.stroke();
    }
    // lateral lines (toward the vanishing point)
    // the same set of lines in every window (lines far to the side enter from the edges), so the screens join up
    for (let k = -30; k <= 30; k++) {
      const X = k * STEP, xn = sx(F * X / zNear), yn = sy(HOR + dir * F * h / zNear), xf = sx(F * X / zFar), yf = sy(HOR + dir * F * h / zFar);
      const lg = g.createLinearGradient(xn, yn, xf, yf);
      lg.addColorStop(0, `rgba(64,214,255,${(alpha * 0.9).toFixed(3)})`); lg.addColorStop(0.55, `rgba(64,214,255,${(alpha * 0.25).toFixed(3)})`); lg.addColorStop(1, 'rgba(64,214,255,0)');
      g.strokeStyle = lg; g.beginPath(); g.moveTo(xn, yn); g.lineTo(xf, yf); g.stroke();
    }
  };
  plane(FLOOR_H, 1, o.minimal ? 0.22 : 0.3);
  plane(CEIL_H, -1, o.minimal ? 0.07 : 0.1);
  // horizon glow line
  const hy = Math.round(sy(HOR)) + 0.5;
  const hg = g.createLinearGradient(sx(-3.2), 0, sx(3.2), 0);
  hg.addColorStop(0, 'rgba(64,214,255,0)'); hg.addColorStop(0.5, 'rgba(155,234,255,0.35)'); hg.addColorStop(1, 'rgba(64,214,255,0)');
  g.strokeStyle = hg; g.lineWidth = 1; g.beginPath(); g.moveTo(0, hy); g.lineTo(W, hy); g.stroke();
  // soft vignette at the top and bottom
  const vg = g.createLinearGradient(0, 0, 0, H);
  vg.addColorStop(0, 'rgba(3,8,15,0.55)'); vg.addColorStop(0.2, 'rgba(3,8,15,0)'); vg.addColorStop(0.85, 'rgba(3,8,15,0)'); vg.addColorStop(1, 'rgba(3,8,15,0.5)');
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  return { horizon: HOR, x0 };
}
