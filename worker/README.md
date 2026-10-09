# nova-api

Cloudflare Worker that is NOVA's secure backend: https://nova-api.tyler467890.workers.dev

- All integration keys live here as Worker secrets. The NOVA site holds none.
- `POST /auth/login {passphrase}` → 12-hour HMAC-signed session token (rate-limited: 5 tries / 15 min per IP).
- Everything else needs `Authorization: Bearer <session token>`; integrations that aren't set up return
  `503 {configured:false, need:"<SECRET>"}`.
- Write routes (`/github/issue`, `/cursor/agents`, `/cursor/agents/:id/followup`, `/grok/command`) are logged to `GET /audit`,
  capped per day, and blocked when `POST /controls {off:true}` is set.
- `POST /inbox/result` is for the Grok Bot (separate `INBOX_KEY`), `GET /inbox` shows the last 50 replies.
- CORS: only https://tyler467890.github.io and http://localhost:* (tests).

## Secrets (names only; values are never committed)
NOVA_PASSPHRASE_HASH, SESSION_KEY, INBOX_KEY, plus optional GITHUB_TOKEN, CURSOR_API_KEY,
GROK_WEBHOOK_URL, GROK_WEBHOOK_KEY, NOTION_TOKEN, NOTION_TASKS_DB.

Set one from an environment variable without printing it:

    printf '%s' "$GITHUB_TOKEN" | npx wrangler secret put GITHUB_TOKEN

Deploy: `npx wrangler deploy` (Node 22, `CLOUDFLARE_API_TOKEN` in the environment).
