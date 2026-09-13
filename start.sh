#!/bin/bash

# CC Switch Bridge - macOS/Linux startup script

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check required files
if [ ! -f "server.js" ]; then
    echo "[ERROR] server.js not found"
    exit 1
fi
if [ ! -f "config.json" ]; then
    echo "[ERROR] config.json not found."
    echo "Please copy config.example.json to config.json and edit it."
    exit 1
fi

# Auto-detect Node.js
find_node() {
    # 1. System PATH
    if command -v node &> /dev/null; then
        echo "node"
        return
    fi
    
    # 2. nvm
    if [ -f "$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node 2>/dev/null | head -1)/bin/node" ]; then
        echo "$HOME/.nvm/versions/node/$(ls -t $HOME/.nvm/versions/node | head -1)/bin/node"
        return
    fi
    
    # 3. fnm
    if [ -d "$HOME/.fnm" ]; then
        FNM_NODE=$(find "$HOME/.fnm" -name "node" -type f 2>/dev/null | head -1)
        if [ -n "$FNM_NODE" ]; then
            echo "$FNM_NODE"
            return
        fi
    fi
    
    # 4. Common paths
    for path in "/usr/local/bin/node" "/opt/homebrew/bin/node" "/usr/bin/node"; do
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
echo "[INFO] Starting CC Switch Bridge..."

# Run in foreground
exec "$NODE_PATH" server.js --config config.json
