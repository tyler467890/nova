# NOVA

Tyler's personal command center for Calo. Static site on GitHub Pages.

- Live panels read public data only: the GitHub REST API (no token) and the public Calo site.
- Private status (AI team, tasks, updates) lives in `data/status.enc.json`, encrypted with
  AES-256-GCM. The key is derived in the browser from a passphrase with PBKDF2-SHA256
  (600,000 iterations, random salt). The passphrase is never stored in this repo.
- No secrets, tokens or passphrases belong in this repository.

## NOVA 2 layout (2.1: globe core · 2.2: school + app launchers)
Every screen starts as the same empty blue grid, drawn once on a 2D canvas so it lines up across all three monitors
(`js/grid.js`). The only thing on the home view is the 3D core on the centre screen, plus a menu button that fades in
when the mouse moves (Full screen, Set up screens, Clear screens, Settings, Identify, Lock).

- **Core nodes** (`3d/nova-3d.min.js`, three.js r170 bundled, no CDN): Chat, AI Team, Agents (Cursor + Copilot), GitHub,
  Calo App, Tasks, Business (after launch), Quick Launch, Settings. Since 2.1 the core is a holographic wireframe globe and
  the nodes sit on its surface, spread evenly (Fibonacci seed + relax, Chat at the front). Drag spins it in any direction
  (trackball, with inertia and damping); when it slows down, the nearest node eases to the front-centre. Scroll or pinch
  zooms. Nodes on the far side fade and shrink and their labels hide, so categories reveal themselves as you spin. Hover
  shows the name, click a front node opens the tab, double-click turns a node to the front (double-click empty space or
  Home resets). Arrow keys turn to the neighbouring node, Enter opens the front one. Chat shows an amber badge for unread
  replies and glows when a new one lands; AI Team shows an amber badge when an agent needs you.
- **School (2.2)**: the globe has 13 nodes. **Brightspace** shows what's due in the next 14 days (Today / This week /
  Later, Halifax time, countdowns, expandable details), Recently due (collapsed), per-course grade links and buttons for
  Brightspace, Grades and Calendar. Data comes from nova-api `GET /school/assignments` (the private NSCC calendar feed,
  cached 30 min; grades aren't pulled). The node carries an amber badge with the number of items due in the next 3 days.
  **VS Code**, **Notepad++** and **Packet Tracer** are grouped as Tools (neighbouring spots, violet accent); each opens a
  panel with a Launch button (`vscode://`, `nova-npp://open`, `nova-pt://open`). The last two need the one-time
  `launchers/NOVA-launchers.reg` on the laptop (per-user, starts the program with no arguments).
- **Tabs** open on the centre screen and can be thrown to Left / Centre / Right with the buttons in the tab header,
  the 1 / 2 / 3 keys, or by dragging the header off the side of the screen. 1 tab fills the screen, 2 split it,
  3 or more tile. The layout is saved in `localStorage` (`nova.layout.v2`) and comes back after a reload.
  Only screens that are open are offered; a tab whose screen is closed shows on screen 1.
- **Screens**: `/` is screen 1 (the core, the secure session), `?screen=2` and `?screen=3` are the others.
  Default order is left = 2, centre = 1, right = 3; change it in Settings → Screens. Windows sync over `BroadcastChannel`.
- **Security**: only screen 1 signs in to nova-api. It relays decrypted status, replies and lists to the other screens
  (never a token); a message typed on a side screen is confirmed there and sent by screen 1.
- **Performance**: screens 2 and 3 never load WebGL. Screen 1 draws one small WebGL canvas (only the square around the
  core) on demand, at 1x resolution in Smooth (the default), with no bloom and no backdrop blur anywhere.
  Settings → Performance: Smooth (steps down to Minimal by itself if the computer struggles), Full effects, Minimal.

The 3D source lives outside this repo and is built into `3d/`. `js/n3d-config.js` sets the screen, position and
performance mode before first paint (CSP allows no inline scripts).
