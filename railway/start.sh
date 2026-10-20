#!/usr/bin/env bash
# RedPanel container entrypoint (Railway & other platforms without Docker access)
# Env vars:
#   ADMIN_USERNAME / ADMIN_PASSWORD / ADMIN_EMAIL  first admin (only used on first boot)
#   PUBLIC_HOST     host players connect to (default: Railway TCP proxy domain)
#   DATA_DIR        persistent folder - mount a Railway Volume here (default /data)
#   PORT            panel web port (Railway sets this automatically)
set -euo pipefail
DATA="${DATA_DIR:-/data}"
mkdir -p "$DATA/volumes" "$DATA/panel"
cd /app

[ -s "$DATA/node-token" ] || node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))' > "$DATA/node-token"
export NT="$(cat "$DATA/node-token")"
export PH="${PUBLIC_HOST:-${RAILWAY_TCP_PROXY_DOMAIN:-127.0.0.1}}"
export DD="$DATA"

FIRST_BOOT=0
[ -f "$DATA/panel/db.json" ] || FIRST_BOOT=1
if [ "$FIRST_BOOT" = 1 ] && [ -z "${ADMIN_PASSWORD:-}" ]; then
  export ADMIN_PASSWORD="$(node -e 'process.stdout.write(require("crypto").randomBytes(9).toString("base64url"))')"
  GENERATED=1
fi

node -e '
const fs=require("fs"),e=process.env;
fs.writeFileSync("/app/node/config.json", JSON.stringify({port:8080,host:"127.0.0.1",token:e.NT,dataDir:e.DD+"/volumes",runtime:"process"},null,2));
fs.writeFileSync("/app/panel/config.json", JSON.stringify({port:+(e.PORT||8000),host:"0.0.0.0",
  admin:{username:e.ADMIN_USERNAME||"admin",email:e.ADMIN_EMAIL||"",password:e.ADMIN_PASSWORD||""},
  localNode:{url:"http://127.0.0.1:8080",token:e.NT,publicIp:e.PH}},null,2));'

echo "❀ RedPanel starting (process mode, data in $DATA)"
[ "${GENERATED:-0}" = 1 ] && echo "❀ First boot admin login: ${ADMIN_USERNAME:-admin} / ${ADMIN_PASSWORD}   (change it in Account info)"
if [ -n "${RAILWAY_TCP_PROXY_DOMAIN:-}" ]; then
  echo "❀ Railway TCP proxy: ${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT:-?} -> container port ${RAILWAY_TCP_APPLICATION_PORT:-25565}"
  echo "  Set this as the server's Public address in Admin -> Servers -> Edit"
fi

node /app/node/src/daemon.js &
NODE_PID=$!
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break; sleep 1; done
echo "❀ node daemon online"

PANEL_DATA_DIR="$DATA/panel" node /app/panel/src/server.js &
PANEL_PID=$!

stop_all() { kill -TERM "$PANEL_PID" "$NODE_PID" 2>/dev/null || true; wait "$NODE_PID" 2>/dev/null || true; exit 0; }
trap stop_all TERM INT
wait -n "$NODE_PID" "$PANEL_PID"
echo "❀ a process exited - stopping container so the platform restarts it"
stop_all
