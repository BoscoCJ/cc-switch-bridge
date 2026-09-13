#!/bin/bash

# CC Switch Bridge - macOS/Linux 启动脚本

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 自动检测 Node.js
find_node() {
    # 1. 系统 PATH
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
    
    # 4. 常见路径
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
    echo "❌ 未找到 Node.js，请先安装 Node.js 18+"
    exit 1
fi

echo "✓ 使用 Node: $NODE_PATH"
echo "✓ 启动 CC Switch Bridge..."

# 前台运行（可见日志）
exec "$NODE_PATH" server.js --config config.json
