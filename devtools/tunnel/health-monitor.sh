#!/usr/bin/env bash

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$DIR/logs"
LOG_FILE="$LOG_DIR/health.log"
STATUS_FILE="$DIR/status.json"

mkdir -p "$LOG_DIR"

if [ -f "$DIR/.env.tunnel" ]; then
    export $(grep -v '^#' "$DIR/.env.tunnel" | xargs)
elif [ -f "$DIR/../../.env.tunnel" ]; then
    export $(grep -v '^#' "$DIR/../../.env.tunnel" | xargs)
fi

PORT=${PORT:-4000}

START_TIME=$(date +%s)

echo "[INFO] Health monitor started. Logging to $LOG_FILE"

while true; do
    TIMESTAMP=$(date +"%Y-%m-%dT%H:%M:%SZ")
    CURRENT_TIME=$(date +%s)
    UPTIME=$((CURRENT_TIME - START_TIME))

    # Call /api/v1/health
    REQ_START=$(date +%s%N)
    
    # Using 5 seconds max time
    HTTP_CODE=$(curl -s -w "%{http_code}" -o /dev/null --max-time 5 http://localhost:$PORT/api/v1/health || echo "failure")
    
    REQ_END=$(date +%s%N)
    RESP_TIME_MS=$(( (REQ_END - REQ_START) / 1000000 ))

    if [ "$HTTP_CODE" == "failure" ] || [ "$HTTP_CODE" == "000" ]; then
        BACKEND_STATUS="offline"
        echo "[$TIMESTAMP] Health check FAILED. Backend unreachable." >> "$LOG_FILE"
    else
        # We got an HTTP response
        BACKEND_STATUS="online"
        echo "[$TIMESTAMP] Health check OK. Response time: ${RESP_TIME_MS}ms. HTTP Status: $HTTP_CODE" >> "$LOG_FILE"
    fi

    # Update status.json using Node.js
    node -e "
const fs = require('fs');
let s = { status: 'running', uptime_seconds: 0, tunnel_url: '', last_health_check: '', backend: 'offline' };
try { 
  if (fs.existsSync('$STATUS_FILE')) {
      s = JSON.parse(fs.readFileSync('$STATUS_FILE', 'utf8')); 
  }
} catch(e){}
s.uptime_seconds = $UPTIME;
s.last_health_check = '$TIMESTAMP';
s.backend = '$BACKEND_STATUS';
fs.writeFileSync('$STATUS_FILE', JSON.stringify(s, null, 2));
" || true

    sleep 60
done
