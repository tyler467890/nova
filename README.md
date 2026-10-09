# NOVA

Tyler's personal command center for Calo. Static site on GitHub Pages.

- Live panels read public data only: the GitHub REST API (no token) and the public Calo site.
- Private status (AI team, tasks, updates) lives in `data/status.enc.json`, encrypted with
  AES-256-GCM. The key is derived in the browser from a passphrase with PBKDF2-SHA256
  (600,000 iterations, random salt). The passphrase is never stored in this repo.
- No secrets, tokens or passphrases belong in this repository.

## 3D layer
`3d/nova-3d.min.js` (three.js r170 bundled, no CDN) draws a navigable holographic core behind the glass panels.
`js/n3d-config.js` sets its options before first paint (CSP allows no inline scripts); `js/app.js` feeds it real data
(`setAgents`, `setActivity`, `setStatus`), fills the focus panel on `nova:focus`, and mounts the Calo bunny hologram.
Two monitors: one window wider than 2200 px at 2.3:1 or more shows Screen 2 on the right half, or open `?screen=2`
in a second window (synced over `BroadcastChannel`; it uses the same unlock and stored passphrase).
