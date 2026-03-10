#!/usr/bin/env bash

# Colors for terminal output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$DIR/../../" && pwd)"
LOG_DIR="$DIR/logs"
LOG_FILE="$LOG_DIR/backend.log"
STATUS_FILE="$DIR/status.json"

mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

# Ensure we're running from the root of the project
cd "$ROOT_DIR" || exit 1

echo -e "${BLUE}=== Dev Server Supervisor ===${NC}" | tee -a "$LOG_FILE"

# Install deps if missing
if [ ! -d "node_modules" ]; then
    echo -e "${GREEN}[INFO] Installing missing dependencies...${NC}" | tee -a "$LOG_FILE"
    npm install
else
    echo -e "${GREEN}[INFO] Dependencies found. No need to install.${NC}" | tee -a "$LOG_FILE"
fi

# Load tunnel env vars if it exists
if [ -f "devtools/tunnel/.env.tunnel" ]; then
    export $(grep -v '^#' devtools/tunnel/.env.tunnel | xargs)
elif [ -f ".env.tunnel" ]; then
    export $(grep -v '^#' .env.tunnel | xargs)
else
    export PORT=4000
    export NODE_ENV=development
fi

# Start health monitor in background
if [ -f "$DIR/health-monitor.sh" ]; then
    bash "$DIR/health-monitor.sh" &
    HEALTH_PID=$!
    trap "kill $HEALTH_PID 2>/dev/null" EXIT
fi

# Update status json to running
node -e "
const fs = require('fs'); 
let s = { status: 'stopped', uptime_seconds: 0, tunnel_url: '', last_health_check: '', backend: 'offline' };
try { if(fs.existsSync('$STATUS_FILE')) { s = JSON.parse(fs.readFileSync('$STATUS_FILE', 'utf8')); } } catch(e){}
s.backend = 'online'; 
s.status = 'running'; 
fs.writeFileSync('$STATUS_FILE', JSON.stringify(s, null, 2));
" 2>/dev/null || true

# Infinite loop to auto-restart backend
while true; do
    echo -e "${GREEN}[INFO] Starting backend on port ${PORT:-4000}...${NC}" | tee -a "$LOG_FILE"
    
    # If package.json has a dev script, use it; else fallback to start or node
    if grep -q '"dev":' package.json; then
        CMD="npm run dev"
    elif grep -q '"start":' package.json; then
        CMD="npm start"
    else
        CMD="node index.js"
    fi
    
    # Run backend, capture logs
    $CMD 2>&1 | tee -a "$LOG_FILE"
    EXIT_CODE=${PIPESTATUS[0]}
    
    CRASH_TIME=$(date +"%Y-%m-%d %H:%M:%S")
    echo -e "${RED}[ERROR] Backend crashed or stopped at $CRASH_TIME with exit code $EXIT_CODE${NC}" | tee -a "$LOG_FILE"
    
    # Update status to offline
    node -e "
const fs = require('fs'); 
let s = { status: 'stopped', uptime_seconds: 0, tunnel_url: '', last_health_check: '', backend: 'offline' };
try { if(fs.existsSync('$STATUS_FILE')) { s = JSON.parse(fs.readFileSync('$STATUS_FILE', 'utf8')); } } catch(e){}
s.backend = 'offline'; 
fs.writeFileSync('$STATUS_FILE', JSON.stringify(s, null, 2));
" 2>/dev/null || true
    
    echo -e "${YELLOW}[INFO] Waiting 3 seconds before restart...${NC}" | tee -a "$LOG_FILE"
    sleep 3
done
