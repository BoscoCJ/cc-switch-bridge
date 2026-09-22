# CC Switch Bridge

WorkBuddy / CC Switch 的本地 OpenAI 入站代理。默认把请求转成 Anthropic 发给 xapi；`grok-*` 原样透传到 OpenAI Chat Completions（xapi 的 Grok 分组不提供 `/v1/messages`）。

## 架构

```
WorkBuddy / CC Switch
        │  OpenAI POST /v1/chat/completions
        ▼
localhost:3000 (Bridge)
        │
        ├─ grok-*     原样转发 → xapi /v1/chat/completions
        └─ 其它       转 Anthropic → xapi /v1/messages
        ▼
clash:7890
        ▼
xapi-token.xyz
```

**为什么需要 Bridge？**
- WorkBuddy 自定义模型只支持 OpenAI 格式（`/v1/chat/completions`）
- xapi 的 Claude / GPT / Gemini 走 Anthropic（`/v1/messages`）；Grok 只走 OpenAI Chat Completions
- Bridge 按模型名前缀分流，并伪装成 Claude Code 的 User-Agent

## 文件说明

| 文件 | 用途 |
|------|------|
| `server.js` | 主服务，Node.js 格式转换代理 |
| `run-silent.vbs` | 隐藏窗口启动脚本（无控制台窗口） |
| `nssm.exe` | Windows 服务管理工具（备用，需管理员权限） |

## 启动方式

### 方式 1：VBS 隐藏运行（当前方案）

```powershell
# 启动（无窗口）
wscript.exe "D:\AI\cc-switch-bridge\run-silent.vbs"

# 查看状态
netstat -ano | findstr :3000

# 停止（用 netstat 查到的 PID 替换）
taskkill /F /PID <PID>
```

**开机自启**：`run-silent.vbs` 已复制到 Windows 启动文件夹：
```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CC-Bridge.vbs
```

### 方式 2：前台运行（调试用）

```powershell
cd D:\AI\cc-switch-bridge
node server.js

# 自定义端口
node server.js --port 3001

# 自定义代理
node server.js --proxy http://127.0.0.1:1080
```

### 方式 3：注册为 Windows 服务（需管理员权限）

```powershell
# 以管理员身份运行 PowerShell
cd D:\AI\cc-switch-bridge
.\nssm.exe install CC-Bridge "C:\Users\bson9\.workbuddy\binaries\node\versions\22.22.2-2\node.exe" "D:\AI\cc-switch-bridge\server.js"
.\nssm.exe set CC-Bridge AppDirectory "D:\AI\cc-switch-bridge"
.\nssm.exe set CC-Bridge DisplayName "WorkBuddy CC Switch Bridge"
.\nssm.exe set CC-Bridge Start SERVICE_AUTO_START
.\nssm.exe start CC-Bridge

# 管理服务
.\nssm.exe status CC-Bridge
.\nssm.exe stop CC-Bridge
.\nssm.exe restart CC-Bridge
.\nssm.exe remove CC-Bridge confirm
```

## WorkBuddy 配置

| 配置项 | 值 |
|--------|-----|
| Endpoint | `http://127.0.0.1:3000/v1` |
| API Key | xapi-token.xyz 的 API Key（各模型用对应分组的 key） |
| Model | `claude-sonnet-5` / `gemini-3.8-flash` / `grok-4.7` 等 |

Grok 不要再指向 LiteLLM `:4000`。CC Switch 的 xapi-Grok 上游 URL 用 `http://127.0.0.1:3000`，格式选 Chat Completions。

## 前置条件

- **clash 代理**必须在运行（默认 `127.0.0.1:7890`），否则无法连接 xapi
- **Node.js** 运行时（使用 WorkBuddy 自带的 `C:\Users\bson9\.workbuddy\binaries\node\versions\22.22.2-2\node.exe`）

## 故障排查

| 问题 | 排查 |
|------|------|
| 连接被拒绝 | `netstat -ano \| findstr :3000` 看 Bridge 是否在跑 |
| 上游 429 | xapi 后端繁忙，等几分钟重试 |
| 上游 401 | API Key 无效，检查 xapi 后台 token 映射配置 |
| 上游 405 | xapi 限制了非 Coding Agent 的调用 |
| 连接超时 | clash 代理是否开启（7890 端口） |

## 与 CC Switch 的关系

**完全独立，互不影响。**

- CC Switch（80端口）：给 Claude Code 用的本地代理
- Bridge（3000端口）：给 WorkBuddy 用的格式转换代理，直连 xapi

两者可以并行运行，也可以只用其中一个。
