#!/bin/bash

# CC Switch Bridge - macOS LaunchAgent installer
# 生成并安装 LaunchAgent plist，实现开机自启

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_NAME="com.cc-switch.bridge.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME"

# Auto-detect Node.js
find_node() {
    if command -v node &> /dev/null; then
        echo "$(command -v node)"
        return
    fi

    # nvm
    if [ -f "$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node 2>/dev/null | head -1)/bin/node" ]; then
        echo "$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node | head -1)/bin/node"
        return
    fi

    # fnm
    if [ -d "$HOME/.fnm" ]; then
        FNM_NODE=$(find "$HOME/.fnm" -name "node" -type f 2>/dev/null | head -1)
        if [ -n "$FNM_NODE" ]; then
            echo "$FNM_NODE"
            return
        fi
    fi

    # Common paths
    for path in "/usr/local/bin/node" "/opt/homebrew/bin/node"; do
        if [ -f "$path" ]; then
            echo "$path"
            return
        fi
    done

    echo ""
}

NODE_PATH=$(find_node)

if [ -z "$NODE_PATH" ]; then
    echo "[ERROR] Node.js not found. Please install Node.js 18+"
    exit 1
fi

echo "[INFO] Using Node: $NODE_PATH"
echo "[INFO] Bridge directory: $SCRIPT_DIR"

# Generate plist
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cc-switch.bridge</string>

    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$SCRIPT_DIR/server.js</string>
        <string>--config</string>
        <string>$SCRIPT_DIR/config.json</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$SCRIPT_DIR</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$SCRIPT_DIR/logs/launchd-stdout.log</string>

    <key>StandardErrorPath</key>
    <string>$SCRIPT_DIR/logs/launchd-stderr.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF

echo "[INFO] Generated $PLIST_PATH"

# Unload if already loaded
if launchctl list | grep -q "com.cc-switch.bridge"; then
    echo "[INFO] Unloading existing LaunchAgent..."
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Load the new plist
launchctl load "$PLIST_PATH"
echo "[INFO] LaunchAgent loaded and started"

echo ""
echo "[OK] CC Switch Bridge will now start automatically on login"
echo ""
echo "Commands:"
echo "  Check status:  launchctl list | grep cc-switch"
echo "  Stop:          launchctl unload $PLIST_PATH"
echo "  Start:         launchctl load $PLIST_PATH"
echo "  Restart:       launchctl unload $PLIST_PATH && launchctl load $PLIST_PATH"
echo "  Uninstall:     launchctl unload $PLIST_PATH && rm $PLIST_PATH"
