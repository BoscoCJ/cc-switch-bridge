# CC Switch Bridge

OpenAI ↔ Anthropic 协议转换代理。解决 WorkBuddy 只支持 OpenAI 格式、但部分上游 API 只接受 Anthropic 协议的问题。

## 为什么需要这个？

**WorkBuddy 的限制：**
- 自定义模型只支持 OpenAI 格式（`/v1/chat/completions`）
- 无法直接调用需要 Anthropic 协议（`/v1/messages`）的上游 API

**CC Switch 的限制：**
- 不支持 WorkBuddy
- 部分特殊协议转换场景覆盖不全
- 主要面向 Claude Code 和 Anthropic 原生客户端

**Bridge 的作用：**
- 在本地提供 OpenAI 兼容接口，让 WorkBuddy 可以调用任何上游
- 自动转换协议：OpenAI 请求 → Anthropic 格式 → 转发到上游
- 支持 HTTP 代理，解决网络访问限制
- 可配置多个 Provider 和 API Key

## 协议路由

Bridge 根据 Provider 的 `protocol` 配置决定转发方式：

| protocol | 转发目标 | 说明 |
|----------|---------|------|
| `anthropic` | `/v1/messages` | OpenAI → Anthropic 转换 |
| `openai` | `/v1/chat/completions` | 原样转发，不转换 |

每个 Provider 独立配置协议。同一个上游 API 可以注册多个 Provider，分别处理不同协议。

## 架构

```
WorkBuddy / 其它 OpenAI 客户端
        │  POST /v1/chat/completions (OpenAI 格式)
        ▼
localhost:<port> (Bridge)
        │
        ├─ Provider A (protocol: anthropic)  → /v1/messages
        └─ Provider B (protocol: openai)     → /v1/chat/completions
        │
        ▼
HTTP Proxy (可选)
        │
        ▼
上游 API (在 config.json 中配置)
```

## 配置说明

复制 `config.example.json` 为 `config.json`：

```json
{
  "port": 3000,
  "bind": "127.0.0.1",
  "keyMode": "passthrough",
  "defaultMaxTokens": 262144,
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic Provider",
      "upstream": "https://your-upstream-api.com",
      "protocol": "anthropic",
      "proxy": "http://127.0.0.1:<proxy-port>",
      "userAgent": "claude-code/1.0.0",
      "apiKeys": ["your-api-key-here"],
      "keyStrategy": "round-robin",
      "models": ["claude-sonnet-5", "claude-opus-5"]
    },
    {
      "id": "openai",
      "name": "OpenAI Provider",
      "upstream": "https://your-upstream-api.com",
      "protocol": "openai",
      "proxy": "http://127.0.0.1:<proxy-port>",
      "userAgent": "claude-code/1.0.0",
      "apiKeys": ["your-api-key-here"],
      "keyStrategy": "round-robin",
      "models": ["grok-4.6", "grok-4.7"]
    }
  ],
  "log": {
    "enabled": true,
    "dir": "./logs",
    "maxDays": 7
  }
}
```

**关键配置项：**

- `port`: Bridge 监听端口，默认 3000，可自定义
- `keyMode`: `"passthrough"` 表示使用客户端传入的 API Key；`"config"` 表示使用配置文件中的 Key
- `providers[].protocol`: 转发协议，`"anthropic"` 或 `"openai"`。不填默认 `"anthropic"`
- `providers[].proxy`: HTTP 代理地址，用于解决网络访问限制。留空或设为 `null` 表示直连
- `providers[].userAgent`: 伪装 User-Agent，某些上游会检查
- `providers[].models`: 该 Provider 支持的模型列表，用于路由匹配

## 启动方式

### Windows

#### 前台运行（调试用）

```powershell
cd <your-bridge-directory>
node server.js

# 自定义端口
node server.js --port 3001
```

#### VBS 隐藏运行（推荐）

```powershell
# 启动（无窗口）
wscript.exe "run-silent.vbs"

# 查看状态（替换 <port> 为实际端口）
netstat -ano | findstr :<port>

# 停止（用 netstat 查到的 PID 替换）
taskkill /F /PID <PID>
```

**开机自启**：将 `run-silent.vbs` 的快捷方式放入 Windows 启动文件夹。

#### 注册为 Windows 服务（需管理员权限）

```powershell
cd <your-bridge-directory>

# 替换 <node-path> 为 Node.js 可执行文件路径
# 替换 <bridge-directory> 为项目绝对路径
.\nssm.exe install CC-Bridge "<node-path>" "<bridge-directory>\server.js"
.\nssm.exe set CC-Bridge AppDirectory "<bridge-directory>"
.\nssm.exe set CC-Bridge DisplayName "CC Switch Bridge"
.\nssm.exe set CC-Bridge Start SERVICE_AUTO_START
.\nssm.exe start CC-Bridge
```

### macOS / Linux

#### 前台运行（调试用）

```bash
cd <your-bridge-directory>
./start.sh          # 自动检测 Node.js
# 或
node server.js
```

#### LaunchAgent 开机自启（推荐）

```bash
cd <your-bridge-directory>
chmod +x install-launchd.sh
./install-launchd.sh
```

脚本会自动检测 Node.js 路径，生成 `~/Library/LaunchAgents/com.cc-switch.bridge.plist` 并加载。

```bash
# 查看状态
launchctl list | grep cc-switch

# 停止
launchctl unload ~/Library/LaunchAgents/com.cc-switch.bridge.plist

# 启动
launchctl load ~/Library/LaunchAgents/com.cc-switch.bridge.plist

# 卸载
launchctl unload ~/Library/LaunchAgents/com.cc-switch.bridge.plist && \
  rm ~/Library/LaunchAgents/com.cc-switch.bridge.plist
```

## 客户端配置

### WorkBuddy

在 WorkBuddy 的自定义模型配置中：

| 配置项 | 值 |
|--------|-----|
| Endpoint | `http://127.0.0.1:<port>/v1` |
| API Key | 上游 API 的 Key |
| Model | 配置文件 `models` 列表中的模型名 |

### CC Switch

在 CC Switch 中配置上游时：

| 配置项 | 值 |
|--------|-----|
| URL | `http://127.0.0.1:<port>/v1` |
| 上游格式 | Chat Completions (OpenAI) |
| Auth | ANTHROPIC_AUTH_TOKEN |
| Model | 配置文件 `models` 列表中的模型名 |

Bridge 会根据模型名自动选择转发协议。

## 前置条件

- **Node.js** 运行时（推荐 18+）
- **HTTP 代理**（可选）：如果上游需要特殊网络访问，需在 `config.json` 中配置 `proxy`

## 故障排查

| 问题 | 排查 |
|------|------|
| 连接被拒绝 | `netstat -ano \| findstr :<port>` 看 Bridge 是否在跑 |
| 上游 401 | API Key 无效，检查 `config.json` 或客户端传入的 Key |
| 上游 500/503 | 该模型可能不支持当前转发协议，检查模型名是否匹配 |
| 连接超时 | 代理是否开启，`config.json` 中的 `proxy` 配置是否正确 |

## 与 CC Switch 的关系

**互补而非替代。**

- **CC Switch**：主要面向 Claude Code，提供本地 Anthropic 协议代理
- **Bridge**：主要面向 WorkBuddy，提供协议转换和多 Provider 支持

两者可以并行运行，也可以只用其中一个。CC Switch 无法直接服务 WorkBuddy（不支持 OpenAI 客户端），Bridge 可以填补这个缺口。

## 文件说明

| 文件 | 用途 |
|------|------|
| `server.js` | 主服务，Node.js 协议转换代理 |
| `config.json` | 运行时配置（含 API Key，已 gitignore） |
| `config.example.json` | 配置示例 |
| `run-silent.vbs` | Windows 隐藏窗口启动脚本 |
| `start.bat` / `stop.bat` | Windows 启停脚本 |
| `start.sh` / `stop.sh` | macOS / Linux 启停脚本 |
| `install-launchd.sh` | macOS LaunchAgent 安装脚本 |
| `nssm.exe` | Windows 服务管理工具（备用） |

## 许可证

MIT
