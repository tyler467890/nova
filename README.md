# NOVA

Tyler's personal command center for Calo. Static site on GitHub Pages.

- Live panels read public data only: the GitHub REST API (no token) and the public Calo site.
- Private status (AI team, tasks, updates) lives in `data/status.enc.json`, encrypted with
  AES-256-GCM. The key is derived in the browser from a passphrase with PBKDF2-SHA256
  (600,000 iterations, random salt). The passphrase is never stored in this repo.
- No secrets, tokens or passphrases belong in this repository.

## 3D hook
`<canvas id="nova-3d">` is a full-screen layer behind all panels (pointer-events off).
Panels accept CSS 3D transforms through `--rx`, `--ry` and `--tz`; `main.view` sets the perspective.
The app exposes `window.NOVA.state` and fires `nova:render` and `nova:data` events on `window`.
