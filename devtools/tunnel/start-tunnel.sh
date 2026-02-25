#!/usr/bin/env bash
set -e

# Colors for terminal output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$DIR/logs"
LOG_FILE="$LOG_DIR/tunnel.log"
STATUS_FILE="$DIR/status.json"

# Create logs directory
mkdir -p "$LOG_DIR"
touch "$LOG_FILE"

echo -e "${BLUE}=== Cloudflare Tunnel Auto-Heal Setup ===${NC}" | tee -a "$LOG_FILE"

# Detect OS and prevent sleep
if [[ "$OSTYPE" == "darwin"* ]]; then
    echo -e "${GREEN}[INFO] macOS detected. Preventing system sleep...${NC}" | tee -a "$LOG_FILE"
    caffeinate -i -s -d &
    CAFFEINATE_PID=$!
    trap "kill $CAFFEINATE_PID 2>/dev/null" EXIT
elif command -v systemd-inhibit &> /dev/null; then
    echo -e "${GREEN}[INFO] Linux (systemd) detected. Preventing system sleep...${NC}" | tee -a "$LOG_FILE"
    systemd-inhibit --what=sleep:idle --who="cloudflare-tunnel" --why="Running a demo" sleep infinity &
    INHIBIT_PID=$!
    trap "kill $INHIBIT_PID 2>/dev/null" EXIT
else
    echo -e "${YELLOW}[WARNING] Could not detect a way to prevent system sleep. Please configure your OS manually if needed.${NC}" | tee -a "$LOG_FILE"
fi

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo -e "${RED}[ERROR] cloudflared is not installed.${NC}" | tee -a "$LOG_FILE"
    echo -e "Install using: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
fi

# Loop to restart tunnel if it dies, preventing crash
while true; do
    # Internet Watchdog
    echo -e "${BLUE}[INFO] Checking internet connection...${NC}" | tee -a "$LOG_FILE"
    while ! ping -c 1 -W 2 google.com &> /dev/null; do
        echo -e "${YELLOW}[WARNING] Internet unavailable. Retrying in 5 seconds...${NC}" | tee -a "$LOG_FILE"
        sleep 5
    done
    echo -e "${GREEN}[INFO] Internet is available!${NC}" | tee -a "$LOG_FILE"

    echo -e "${GREEN}[INFO] Starting Cloudflare tunnel to http://localhost:4000...${NC}" | tee -a "$LOG_FILE"
    
    # Start the tunnel, redirect logs to file
    cloudflared tunnel --url http://localhost:4000 > "$LOG_FILE" 2>&1 &
    TUNNEL_PID=$!

    echo -e "${BLUE}[INFO] Waiting for public URL...${NC}" | tee -a "$LOG_FILE"
    
    # Wait for the tunnel connection to stabilize and print the URL
    URL=""
    for i in {1..30}; do
        sleep 1
        URL=$(grep -a -o 'https://[-a-zA-Z0-9]*\.trycloudflare\.com' "$LOG_FILE" | tail -1)
        if [ -n "$URL" ]; then
            break
        fi
    done

    # Print public URL
    if [ -n "$URL" ]; then
        echo -e "${GREEN}===============================================${NC}"
        echo -e "${GREEN} Tunnel is LIVE at: ${BLUE}$URL${NC}"
        echo -e "${GREEN}===============================================${NC}"
        
        # Update status json
        node -e "
const fs = require('fs'); 
let s = { status: 'stopped', uptime_seconds: 0, tunnel_url: '', last_health_check: '', backend: 'offline' };
try { if(fs.existsSync('$STATUS_FILE')) { s = JSON.parse(fs.readFileSync('$STATUS_FILE', 'utf8')); } } catch(e){}
s.tunnel_url = '$URL'; 
fs.writeFileSync('$STATUS_FILE', JSON.stringify(s, null, 2));
" 2>/dev/null || true

        # Handle dev-runtime configuration and Git Automation
        RUNTIME_DIR="$DIR/../../dev-runtime"
        RUNTIME_FILE="$RUNTIME_DIR/backend-url.json"
        mkdir -p "$RUNTIME_DIR"
        
        NEW_API_URL="${URL}/api/v1"
        CURRENT_API_URL=""
        if [ -f "$RUNTIME_FILE" ]; then
            CURRENT_API_URL=$(node -p "try { require('$RUNTIME_FILE').api } catch { '' }" 2>/dev/null || echo "")
        fi

        if [ "$CURRENT_API_URL" != "$NEW_API_URL" ]; then
            echo -e "${BLUE}[RUNTIME-CONFIG] Updated frontend URL to $NEW_API_URL${NC}" | tee -a "$LOG_FILE"
            
            node -e "
const fs = require('fs');
fs.writeFileSync('$RUNTIME_FILE', JSON.stringify({
  api: '$NEW_API_URL',
  updatedAt: new Date().toISOString()
}, null, 2));
" 2>/dev/null || true

            if [ "${AUTO_PUSH_TUNNEL_URL:-true}" = "true" ]; then
                echo -e "${BLUE}[INFO] Committing and pushing new tunnel URL...${NC}" | tee -a "$LOG_FILE"
                (
                    cd "$RUNTIME_DIR" || exit
                    git add backend-url.json
                    git commit -m "chore: update tunnel runtime url"
                    git push origin HEAD
                ) > /dev/null 2>&1 || echo -e "${YELLOW}[WARNING] Runtime config push ignored (git not ready or push failed).${NC}" | tee -a "$LOG_FILE"
            fi
        fi
    else
        echo -e "${YELLOW}[WARNING] Could not find URL yet. Tunnel may still be connecting...${NC}" | tee -a "$LOG_FILE"
    fi

    # Block script until the tunnel disconnects
    set +e
    wait $TUNNEL_PID
    set -e

    # Retry if tunnel disconnects
    echo -e "${RED}[ERROR] Tunnel disconnected or crashed at $(date +"%Y-%m-%d %H:%M:%S").${NC}" | tee -a "$LOG_FILE"
        # Update status json
        node -e "
const fs = require('fs'); 
let s = { status: 'stopped', uptime_seconds: 0, tunnel_url: '', last_health_check: '', backend: 'offline' };
try { if(fs.existsSync('$STATUS_FILE')) { s = JSON.parse(fs.readFileSync('$STATUS_FILE', 'utf8')); } } catch(e){}
s.tunnel_url = ''; 
fs.writeFileSync('$STATUS_FILE', JSON.stringify(s, null, 2));
" 2>/dev/null || true

    echo -e "${YELLOW}[INFO] Restarting in 5 seconds... (Press Ctrl+C to stop)${NC}" | tee -a "$LOG_FILE"
    sleep 5
done
