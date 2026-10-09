#!/usr/bin/env bash
# Verifies the deployed nova-api. Never prints secrets.
set -u
U=https://nova-api.tyler467890.workers.dev
O=https://tyler467890.github.io
code(){ curl -s -o /tmp/nv.out -w '%{http_code}' "$@"; }
echo "health: $(code $U/health) $(cat /tmp/nv.out)"
echo "wrong login: $(code -X POST -H "Origin: $O" -H 'Content-Type: application/json' -d '{"passphrase":"definitely-wrong-words"}' $U/auth/login) $(cat /tmp/nv.out)"
PASS=$(python3 -c "import re;print(re.sub(r'\s+','-',open('/home/box/.nova/passphrase').read().strip().lower()))")
BODY=$(PASS="$PASS" python3 -c 'import json,os;print(json.dumps({"passphrase":os.environ["PASS"]}))')
c=$(curl -s -o /tmp/nv.login -w '%{http_code}' -X POST -H "Origin: $O" -H 'Content-Type: application/json' --data-binary @- $U/auth/login <<<"$BODY")
TOK=$(python3 -c 'import json;print(json.load(open("/tmp/nv.login")).get("token",""))')
echo "right login: $c token_len=${#TOK} expiresAt=$(python3 -c 'import json;print(json.load(open("/tmp/nv.login")).get("expiresAt"))')"
rm -f /tmp/nv.login
echo "status no token: $(code $U/status)"
echo "status bad token: $(code -H 'Authorization: Bearer abc.def' $U/status)"
echo "status: $(code -H "Authorization: Bearer $TOK" $U/status) $(cat /tmp/nv.out)"
echo "inbox: $(code -H "Authorization: Bearer $TOK" $U/inbox) $(cat /tmp/nv.out)"
echo "grok cmd (unconfigured): $(code -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"text":"hi"}' $U/grok/command) $(cat /tmp/nv.out)"
echo "cursor agents: $(code -H "Authorization: Bearer $TOK" $U/cursor/agents) $(cat /tmp/nv.out)"
echo "github bad repo: $(code -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d '{"repo":"evil/x","title":"t"}' $U/github/issue) $(cat /tmp/nv.out)"
echo "notion (unconfigured): $(code -H "Authorization: Bearer $TOK" $U/notion/tasks) $(cat /tmp/nv.out)"
echo "preflight NOVA origin:"; curl -s -o /dev/null -D - -X OPTIONS -H "Origin: $O" -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type' $U/status | grep -iE '^(HTTP|access-control)'
echo "preflight localhost:"; curl -s -o /dev/null -D - -X OPTIONS -H "Origin: http://localhost:8080" -H 'Access-Control-Request-Method: GET' $U/status | grep -iE '^(HTTP|access-control-allow-origin)'
echo "preflight evil origin:"; curl -s -o /dev/null -D - -X OPTIONS -H "Origin: https://evil.example.com" -H 'Access-Control-Request-Method: POST' $U/status | grep -iE '^(HTTP|access-control)'
echo "POST from evil origin: $(code -X POST -H 'Origin: https://evil.example.com' -H 'Content-Type: application/json' -d '{"passphrase":"x"}' $U/auth/login)"
IK=$(cat /home/box/.nova/inbox_key)
echo "inbox/result wrong key: $(code -X POST -H 'Authorization: Bearer nope' -H 'Content-Type: application/json' -d '{"text":"x"}' $U/inbox/result)"
if [ "${POST_INBOX:-0}" = 1 ]; then echo "inbox/result right key: $(code -X POST -H "Authorization: Bearer $IK" -H 'Content-Type: application/json' -d '{"request_id":"setup-test","text":"NOVA API connected. Replies from your bots will show here."}' $U/inbox/result) $(cat /tmp/nv.out)"; fi
echo "audit: $(code -H "Authorization: Bearer $TOK" $U/audit) $(cat /tmp/nv.out)"
rm -f /tmp/nv.out
