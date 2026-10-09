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
Screens (1, 2 or 3; Settings → Screens, Auto by default):
- Screen 1 · Command (`/`): 3D core, Ask bar and replies, status, needs-you approvals. Only this window signs in and relays data to the others.
- Screen 2 · Team (`?screen=2`): AI team with live activity and log, the selected agent and the core's focus slot, read-only Cursor and Copilot lists.
- Screen 3 · Build & Business (`?screen=3`): GitHub PRs/deploys/commits, Calo status and hologram, Tasks, quick launch, Business placeholders.
- With 2 screens, screen 2 merges Team with Build & Business. With 1, everything is on one page as before.
- **Set up screens** (top bar) opens and places the other windows using Chrome's Window management permission; click **Full screen** in each.
- Windows sync over BroadcastChannel. Only screen 1 runs the full 3D scene; the others draw light holograms at low fps.
- One window wider than 2200 px at 2.3:1 or more still splits itself in half.
in a second window (synced over `BroadcastChannel`; it uses the same unlock and stored passphrase).
