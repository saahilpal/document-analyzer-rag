# Cloudflare Tunnel Demo Reliability Setup

This directory contains advanced, self-healing utility scripts to run a secure, isolated testing environment for Cloudflare Tunnel exposure on the `feature/cloudflare-tunnel-test` branch. It acts as a mini production supervisor suitable for unattended 6-24 hour demos.

## Files

- `start-dev-server.sh`: Installs backend dependencies (if missing), starts the backend on port 4000, handles automatic auto-restarts upon crashes, and initiates the background health monitor.
- `start-tunnel.sh`: A self-healing script encompassing an internet watchdog, Cloudflare tunnel creation, URL retrieval, tunnel auto-healing, and preventing the OS from sleeping (`caffeinate` / `systemd-inhibit`).
- `health-monitor.sh`: Runs every 60 seconds to query `/api/v1/health` verifying uptime, pushing findings to `status.json`, and isolating health logging.
- `status.json`: Contains a live aggregated view of the environment state.
- `.env.tunnel`: Local configuration overriding `PORT=4000` and `NODE_ENV=development` specifically for this setup.
- `logs/`: Directory holding `backend.log`, `tunnel.log`, and `health.log`.

## How to Start the System

1. Open a new terminal and invoke the backend supervisor:
   ```bash
   ./devtools/tunnel/start-dev-server.sh
   ```

2. Open another terminal window and invoke the tunnel watchdog:
   ```bash
   ./devtools/tunnel/start-tunnel.sh
   ```

## How to Check Status

View the live state without needing to dig into bash:
```bash
cat devtools/tunnel/status.json
```
or use `jq` to parse it clearly.

## How to View Logs

Check the live streaming logs out of the respective containers:
```bash
tail -f devtools/tunnel/logs/backend.log
tail -f devtools/tunnel/logs/tunnel.log
tail -f devtools/tunnel/logs/health.log
```

## How to Recover if Crash

You do **NOT** need to manually intervene for typical failures.
- If the Node.js server crashes, `start-dev-server.sh` will auto-restart the environment within 3 seconds.
- If the Cloudflare Tunnel drops out natively or disconnects, `start-tunnel.sh` catches the exception and launches a replacement.
- If the internet completely drops, the watchdog handles the block until internet is restored and then reinstantiates the tunnel.

## How to Stop the System

- Stop the backend or the tunnel scripts by purposefully focusing on their terminal window and pressing **Ctrl + C**.
- When stopping the backend, the associated `health-monitor.sh` child process will cleanly exit as well.

## Switching Back to Main (Rollback)

To exit the demo functionality, return safely to your `main` branch:

```bash
git checkout main
```
