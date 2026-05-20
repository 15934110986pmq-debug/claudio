#!/usr/bin/env bash
# Claudio end-to-end smoke test.
#
# Boots the server, POSTs to /api/chat, then inspects SQLite to confirm the chain
# actually wrote rows. Strongest "it works" signal: messages grew by 2 + plays grew by 1.
#
# Usage:  ./scripts/smoke.sh
# Env:    PORT (default 8080)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8080}"
DB="$ROOT/data/claudio.db"
LOG="$ROOT/data/smoke-server.log"
SERVER_PID=""

green()  { printf "\033[32m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
cyan()   { printf "\033[36m%s\033[0m\n" "$*"; }

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    for _ in 1 2 3; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ── preflight ────────────────────────────────────────────────────────────────
command -v node  >/dev/null 2>&1 || { red "✗ node not on PATH"; exit 1; }
command -v curl  >/dev/null 2>&1 || { red "✗ curl not on PATH"; exit 1; }
if ! command -v claude >/dev/null 2>&1; then
  yellow "△ 'claude' CLI not on PATH — brain will fall back to canned reply (no real song picked)"
fi

mkdir -p data

# Run a tiny node snippet against the SQLite db. Used for table row counts.
# Returns 0 even if the table doesn't exist yet (echoes 0).
count_rows() {
  local table="$1"
  node -e "
    const sql = require('sqlite3').verbose();
    const db = new sql.Database('$DB');
    db.get('SELECT COUNT(*) AS n FROM ' + '$table', (e, r) => {
      console.log(e ? 0 : r.n);
      db.close();
    });
  " 2>/dev/null
}

# ── boot server ──────────────────────────────────────────────────────────────
cyan "▶ booting server on port $PORT ..."
PORT="$PORT" node server.js > "$LOG" 2>&1 &
SERVER_PID=$!

UP=0
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/" -o /dev/null 2>/dev/null; then
    UP=1; break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    red "✗ server died during startup. last 30 lines of $LOG:"
    tail -30 "$LOG" || true
    exit 1
  fi
  sleep 0.5
done

if [[ "$UP" -ne 1 ]]; then
  red "✗ server failed to listen within 15s. last 30 lines of $LOG:"
  tail -30 "$LOG" || true
  exit 1
fi
green "✓ server up (pid=$SERVER_PID)"

# ── baseline ─────────────────────────────────────────────────────────────────
MSG_BEFORE=$(count_rows messages)
PLAY_BEFORE=$(count_rows plays)
echo "  baseline: messages=$MSG_BEFORE  plays=$PLAY_BEFORE"

# ── exercise the chain ───────────────────────────────────────────────────────
cyan "▶ POST /api/chat (max-time 60s) ..."
HTTP_CODE=$(curl -s -o /tmp/claudio-smoke.resp -w "%{http_code}" \
  --max-time 60 \
  -X POST "http://localhost:$PORT/api/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke test：随便给我推一首"}' || echo "000")

RESPONSE=$(cat /tmp/claudio-smoke.resp 2>/dev/null || echo "")
echo "  HTTP $HTTP_CODE  body: $RESPONSE"

if [[ "$HTTP_CODE" != "200" ]]; then
  red "✗ /api/chat did not return 200. last 30 lines of $LOG:"
  tail -30 "$LOG" || true
  exit 1
fi

SAY=$(node -e "
  try { const r = JSON.parse(process.argv[1]); process.stdout.write(r.say || ''); }
  catch { process.exit(1); }
" "$RESPONSE" 2>/dev/null || echo "")

if [[ -n "$SAY" ]]; then
  green "✓ /api/chat returned say: $SAY"
else
  yellow "△ /api/chat returned 200 but no 'say' — likely hit Claude fallback"
fi

# broadcastResult is async (TTS + Netease + savePlay); give it a moment
cyan "▶ waiting 3s for downstream side-effects ..."
sleep 3

# ── final checks ─────────────────────────────────────────────────────────────
MSG_AFTER=$(count_rows messages)
PLAY_AFTER=$(count_rows plays)

echo
echo "━━━━━━━━━━━━━━━━━━━━━━ summary ━━━━━━━━━━━━━━━━━━━━━━"
echo "  messages  $MSG_BEFORE → $MSG_AFTER  (Δ $((MSG_AFTER - MSG_BEFORE)))"
echo "  plays     $PLAY_BEFORE → $PLAY_AFTER  (Δ $((PLAY_AFTER - PLAY_BEFORE)))"
echo

PASS=1
if (( MSG_AFTER >= MSG_BEFORE + 2 )); then
  green "✓ messages table grew ≥ 2 — Claude round-trip persisted"
else
  red "✗ messages did not grow by 2 — chain broke between /api/chat and state.saveMessage"
  PASS=0
fi

if (( PLAY_AFTER > PLAY_BEFORE )); then
  green "✓ plays table grew — Claude returned a song AND Netease resolved it"
else
  yellow "△ plays unchanged — either Claude returned empty play[] (fallback) or Netease lookup failed"
  yellow "  search $LOG for '[Netease]' / '[Claude]' to diagnose"
fi

echo
if (( PASS == 1 )); then
  green "smoke PASSED — backend chain is live, frontend work unblocked"
  echo "  server log saved at: $LOG"
  exit 0
else
  red "smoke FAILED — see log: $LOG"
  exit 1
fi
