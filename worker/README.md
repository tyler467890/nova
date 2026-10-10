# nova-api

Cloudflare Worker that is NOVA's secure backend: https://nova-api.tyler467890.workers.dev

- All integration keys live here as Worker secrets. The NOVA site holds none.
- `POST /auth/login {passphrase}` → 12-hour HMAC-signed session token (rate-limited in a Durable Object: 5 wrong tries / 15 min per IP or IPv6 /48, plus 20 wrong tries / 15 min overall).
- Everything else needs `Authorization: Bearer <session token>`; integrations that aren't set up return
  `503 {configured:false, need:"<SECRET>"}`.
- Write routes (`/github/issue`, `/cursor/agents`, `/cursor/agents/:id/followup`, `/grok/command`) are logged to `GET /audit`,
  capped per day, and blocked when `POST /controls {off:true}` is set.
- `POST /inbox/result` is for the Grok Bot (separate `INBOX_KEY`), `GET /inbox` shows the last 50 replies.
- `GET /school/assignments` → Tyler's NSCC Brightspace assignments, parsed from the private calendar feed
  (`BRIGHTSPACE_ICAL_URL`). Cached in KV for 30 minutes (the last good copy is served, with `stale:true`, if
  Brightspace is down). Returns `{ calendar, fetchedAt, stale, timezone, counts:{total, upcoming, recent, due_3d, due_7d, due_14d},
  courses:[{code, name, section, instructor, ou}], upcoming:[…], recent:[…] }`. Each item:
  `{ id, title, kind ("Due", "Available", "Availability Ends"…), due (ISO UTC), allDay, date?, course, description, url }`.
  `upcoming` = due from now to 180 days ahead, soonest first; `recent` = the last 30 days, newest first.
  `?fresh=1` forces a re-fetch (at most once every 2 minutes). Grades are not in the feed.
  Auth: a session token, **or** `Authorization: Bearer <INBOX_KEY>` (read-only, this route only) so the bots can answer
  "what's due this week?".

## For the bots: reading assignments (NOVA command intake)

The INBOX_KEY is on the box at `/home/box/.nova/inbox_key` (never print it). Cloudflare blocks requests without a
User-Agent, so always send one:

    curl -s -H "Authorization: Bearer $(cat /home/box/.nova/inbox_key)" \
         -H "User-Agent: grokbot-nova-intake/1.0" \
         https://nova-api.tyler467890.workers.dev/school/assignments

Due this week, in Halifax time (jq):

    curl -s -H "Authorization: Bearer $(cat /home/box/.nova/inbox_key)" -H "User-Agent: grokbot-nova-intake/1.0" \
         https://nova-api.tyler467890.workers.dev/school/assignments \
      | jq -r '.upcoming[] | select(.kind=="Due" and (.due|fromdate) < (now+7*86400))
               | "\(.due|fromdate|strflocaltime("%a %b %-d %-I:%M %p")) · \(.course.code) · \(.title)"'

(run with `TZ=America/Halifax`). Due times are end-of-day deadlines, e.g. `02:59:59Z` is 11:59 PM Atlantic the day before.
- CORS: only https://tyler467890.github.io and http://localhost:* (tests).

## Secrets (names only; values are never committed)
NOVA_PASSPHRASE_HASH, SESSION_KEY, INBOX_KEY, plus optional GITHUB_TOKEN, CURSOR_API_KEY,
GROK_WEBHOOK_URL, GROK_WEBHOOK_KEY, NOTION_TOKEN, NOTION_TASKS_DB, BRIGHTSPACE_ICAL_URL.

Set one from an environment variable without printing it:

    printf '%s' "$GITHUB_TOKEN" | npx wrangler secret put GITHUB_TOKEN

Deploy: `npx wrangler deploy` (Node 22, `CLOUDFLARE_API_TOKEN` in the environment).
