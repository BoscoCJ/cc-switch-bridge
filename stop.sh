#!/bin/bash

# CC Switch Bridge - Stop script for macOS/Linux

echo "Stopping CC Switch Bridge..."

# Find and kill node processes running server.js
PIDS=$(pgrep -f "server.js.*cc-switch-bridge" 2>/dev/null)

if [ -z "$PIDS" ]; then
    # Try alternative: find by port 3000
    PIDS=$(lsof -ti:3000 2>/dev/null)
fi

if [ -n "$PIDS" ]; then
    for pid in $PIDS; do
        kill -9 "$pid" 2>/dev/null
        echo "Stopped process $pid"
    done
    echo "Done."
else
    echo "No running CC Switch Bridge process found."
fi

# Clean up PID file
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
rm -f "$SCRIPT_DIR/bridge.pid"
