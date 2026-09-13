/**
 * CC Switch Bridge — OpenAI → Anthropic 格式转换代理
 * 
 * 支持多 Provider、多 API Key、跨平台运行。
 * 
 * 链路：客户端 → localhost:PORT (Bridge) → [proxy] → upstream → Claude
 * 
 * 用法：
 *   node server.js
 *   node server.js --config ./config.json
 *   node server.js --port 3001
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ─── 日志系统 ────────────────────────────────────────────
const LOG_DIR = path.join(__dirname, "logs");
let _logEnabled = true;  // 启动阶段默认开启，CONFIG 加载后由配置决定
let _logMaxDays = 7;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (_logEnabled) {
    try {
      ensureDir(LOG_DIR);
      const logFile = path.join(LOG_DIR, `${todayStr()}.log`);
      fs.appendFileSync(logFile, line + "\n");
    } catch {}
  }
}

function logError(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [ERROR] ${msg}`;
  console.error(line);
  if (_logEnabled) {
    try {
      ensureDir(LOG_DIR);
      const logFile = path.join(LOG_DIR, `${todayStr()}.log`);
      fs.appendFileSync(logFile, line + "\n");
    } catch {}
  }
}

// 清理过期日志
function cleanOldLogs() {
  if (!_logEnabled || !_logMaxDays) return;
  try {
    ensureDir(LOG_DIR);
    const files = fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".log")).sort();
    const cutoff = Date.now() - _logMaxDays * 86400000;
    for (const f of files) {
      const fp = path.join(LOG_DIR, f);
      if (fs.statSync(fp).mtimeMs < cutoff) {
        fs.unlinkSync(fp);
        log(`Cleaned old log: ${f}`);
      }
    }
  } catch {}
}

// ─── 配置加载 ─────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}

const DEFAULTS = {
  port: 3000,
  bind: "127.0.0.1",
  defaultProvider: "",
  keyMode: "config",
  providers: [],
  log: { enabled: true, dir: "./logs", maxDays: 7 },
};

function loadConfig() {
  const configPath = getArg("config", path.join(__dirname, "config.json"));
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      log(`Loaded config from ${configPath}`);
    } catch (e) {
      console.error(`Failed to parse config: ${e.message}`);
      process.exit(1);
    }
  } else {
    log(`Config file not found: ${configPath}, using defaults`);
  }

  // 合并：CLI > config.json > defaults
  const config = { ...DEFAULTS, ...fileConfig };
  config.port = parseInt(getArg("port", String(config.port)), 10);
  config.bind = getArg("bind", config.bind);

  return config;
}

const CONFIG = loadConfig();

// 同步日志配置到模块变量
if (CONFIG.log) {
  _logEnabled = CONFIG.log.enabled !== false;
  _logMaxDays = CONFIG.log.maxDays || 7;
}

// ─── Provider 路由 ────────────────────────────────────────
// 构建 model → provider 映射表
const modelRouteMap = new Map(); // model → [provider, provider, ...]
const allModels = new Set();

for (const p of CONFIG.providers) {
  for (const m of (p.models || [])) {
    allModels.add(m);
    if (!modelRouteMap.has(m)) modelRouteMap.set(m, []);
    modelRouteMap.get(m).push(p);
  }
}

// Key 轮询计数器
const keyCounters = new Map(); // providerId → index

function pickKey(provider) {
  const keys = (provider.apiKeys || []).filter(k => k && k.trim());
  if (keys.length === 0) return "";

  const strategy = provider.keyStrategy || "round-robin";

  if (strategy === "random") {
    return keys[Math.floor(Math.random() * keys.length)];
  }

  if (strategy === "round-robin") {
    const idx = (keyCounters.get(provider.id) || 0) % keys.length;
    keyCounters.set(provider.id, idx + 1);
    return keys[idx];
  }

  // failover: 始终用第一个，除非外部标记失败
  return keys[0];
}

function resolveProvider(model) {
  // 1. 按 model 找 provider
  const candidates = modelRouteMap.get(model);
  if (candidates && candidates.length > 0) {
    // 如果指定了 defaultProvider，优先它
    if (CONFIG.defaultProvider) {
      const def = candidates.find(p => p.id === CONFIG.defaultProvider);
      if (def) return def;
    }
    return candidates[0];
  }

  // 2. model 没匹配到任何 provider → 用 defaultProvider
  if (CONFIG.defaultProvider) {
    const def = CONFIG.providers.find(p => p.id === CONFIG.defaultProvider);
    if (def) return def;
  }

  // 3. 兜底：第一个 provider
  return CONFIG.providers[0] || null;
}

// ─── OpenAI → Anthropic 请求转换 ────────────────────────
function openaiToAnthropic(openaiBody, provider) {
  const messages = [];
  let system = undefined;

  for (const msg of openaiBody.messages || []) {
    if (msg.role === "system") {
      system = typeof msg.content === "string"
        ? msg.content
        : msg.content.map((c) => c.text || "").join("\n");
    } else {
      if (typeof msg.content === "string") {
        messages.push({ role: msg.role, content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const parts = msg.content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          if (part.type === "image_url") {
            const url = part.image_url?.url || "";
            if (url.startsWith("data:")) {
              const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
              if (match) {
                return {
                  type: "image",
                  source: { type: "base64", media_type: match[1], data: match[2] },
                };
              }
            }
            return { type: "text", text: "[image]" };
          }
          return { type: "text", text: part.text || "" };
        });
        messages.push({ role: msg.role, content: parts });
      } else {
        messages.push({ role: msg.role, content: String(msg.content || "") });
      }
    }
  }

  const anthropicReq = {
    model: openaiBody.model || provider?.models?.[0] || "claude-sonnet-5",
    max_tokens: openaiBody.max_tokens || openaiBody.max_completion_tokens || 8192,
    messages,
  };

  if (system) anthropicReq.system = system;
  if (openaiBody.temperature !== undefined) anthropicReq.temperature = openaiBody.temperature;
  if (openaiBody.top_p !== undefined && openaiBody.top_p !== null) anthropicReq.top_p = openaiBody.top_p;
  if (openaiBody.stop) {
    anthropicReq.stop_sequences = Array.isArray(openaiBody.stop) ? openaiBody.stop : [openaiBody.stop];
  }
  if (openaiBody.stream) anthropicReq.stream = true;

  return anthropicReq;
}

// ─── Anthropic → OpenAI 响应转换 ────────────────────────
function anthropicToOpenai(anthropicResp, model) {
  const id = anthropicResp.id || `chatcmpl-${crypto.randomUUID()}`;
  const content = (anthropicResp.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const usage = anthropicResp.usage || {};

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || anthropicResp.model || "claude-sonnet-5",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: mapStopReason(anthropicResp.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

function mapStopReason(reason) {
  if (!reason) return "stop";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "length";
  return "stop";
}

// ─── SSE 流式转换 ───────────────────────────────────────
function convertSSELine(line, state) {
  if (!line.startsWith("data: ")) return null;
  const data = line.slice(6).trim();
  if (data === "[DONE]") return "data: [DONE]\n\n";

  let event_obj;
  try {
    event_obj = JSON.parse(data);
  } catch {
    return null;
  }

  const type = event_obj.type;

  if (type === "message_start") {
    state.id = event_obj.message?.id || `chatcmpl-${crypto.randomUUID()}`;
    state.model = event_obj.message?.model || state.model;
    return null;
  }

  if (type === "content_block_start") {
    if (event_obj.content_block?.type === "text") {
      const chunk = {
        id: state.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }
    return null;
  }

  if (type === "content_block_delta") {
    const delta = event_obj.delta;
    if (delta?.type === "text_delta") {
      const chunk = {
        id: state.id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: state.model,
        choices: [{ index: 0, delta: { content: delta.text || "" }, finish_reason: null }],
      };
      return `data: ${JSON.stringify(chunk)}\n\n`;
    }
    return null;
  }

  if (type === "content_block_stop" || type === "message_delta") {
    return null;
  }

  if (type === "message_stop") {
    const chunk = {
      id: state.id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  return null;
}

// ─── 发送 HTTPS 请求（支持代理 / 直连）────────────────────
function sendRequest(upstreamUrl, bodyStr, isStream, apiKey, provider) {
  const proxyStr = provider?.proxy;
  const userAgent = provider?.userAgent || "cc-switch-bridge/2.0";

  if (proxyStr) {
    return requestViaProxy(upstreamUrl, bodyStr, isStream, apiKey, userAgent, proxyStr);
  } else {
    return requestDirect(upstreamUrl, bodyStr, isStream, apiKey, userAgent);
  }
}

function requestViaProxy(upstreamUrl, bodyStr, isStream, apiKey, userAgent, proxyStr) {
  return new Promise((resolve, reject) => {
    const proxyUrl = new URL(proxyStr);

    const connectReq = http.request({
      hostname: proxyUrl.hostname,
      port: parseInt(proxyUrl.port) || 8080,
      method: "CONNECT",
      path: `${upstreamUrl.hostname}:443`,
    });

    connectReq.on("connect", (connectRes, socket) => {
      if (connectRes.statusCode !== 200) {
        reject(new Error(`Proxy CONNECT failed: ${connectRes.statusCode}`));
        return;
      }

      const req = https.request({
        socket: socket,
        host: upstreamUrl.hostname,
        port: 443,
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
          "Authorization": `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
          "User-Agent": userAgent,
        },
      }, (res) => {
        if (isStream) {
          resolve(res);
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve({ status: res.statusCode, body: json, headers: res.headers });
          } catch (e) {
            resolve({ status: res.statusCode, body: data, headers: res.headers });
          }
        });
        res.on("error", reject);
      });

      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    });

    connectReq.on("error", reject);
    connectReq.end();
  });
}

function requestDirect(upstreamUrl, bodyStr, isStream, apiKey, userAgent) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: upstreamUrl.hostname,
      port: 443,
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        "Authorization": `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        "User-Agent": userAgent,
      },
    }, (res) => {
      if (isStream) {
        resolve(res);
        return;
      }

      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, body: json, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, body: data, headers: res.headers });
        }
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

// ─── HTTP 服务 ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      providers: CONFIG.providers.map(p => ({
        id: p.id,
        name: p.name || p.id,
        upstream: p.upstream,
        proxy: p.proxy || null,
        models: p.models || [],
        keyCount: (p.apiKeys || []).filter(k => k && k.trim()).length,
        keyStrategy: p.keyStrategy || "round-robin",
      })),
      defaultProvider: CONFIG.defaultProvider,
      keyMode: CONFIG.keyMode,
      endpoints: ["/v1/chat/completions", "/v1/models"],
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/v1/models") {
    const models = [...allModels].map((id) => ({
      id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "anthropic",
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: models }));
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const openaiBody = JSON.parse(body);
        const isStream = !!openaiBody.stream;
        const requestedModel = openaiBody.model || "claude-sonnet-5";

        // 1. 路由：根据 model 选 provider
        const provider = resolveProvider(requestedModel);
        if (!provider) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: { message: `No provider found for model: ${requestedModel}`, type: "invalid_request_error" },
          }));
          return;
        }

        // 2. 选 key
        let apiKey;
        if (CONFIG.keyMode === "passthrough") {
          const authHeader = req.headers.authorization || "";
          apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
          if (!apiKey) apiKey = pickKey(provider);
        } else {
          apiKey = pickKey(provider);
        }

        if (!apiKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            error: { message: `No API key available for provider: ${provider.id}`, type: "authentication_error" },
          }));
          return;
        }

        // 3. 转换请求
        const anthropicBody = openaiToAnthropic(openaiBody, provider);

        log(`${isStream ? "STREAM" : "NORMAL"} model=${requestedModel} provider=${provider.id} key=${apiKey.slice(0, 8)}... msgs=${anthropicBody.messages.length}`);

        // 4. 发送请求
        const upstreamUrl = new URL(provider.upstream);
        const bodyStr = JSON.stringify(anthropicBody);
        const result = await sendRequest(upstreamUrl, bodyStr, isStream, apiKey, provider);

        if (isStream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const state = { id: "", model: requestedModel };
          const upstreamRes = result;

          if (upstreamRes.statusCode !== 200) {
            let errData = "";
            upstreamRes.on("data", (c) => (errData += c));
            upstreamRes.on("end", () => {
              logError(`Upstream ${upstreamRes.statusCode}: ${errData}`);
              res.write(`data: ${JSON.stringify({ error: { message: `Upstream error: ${upstreamRes.statusCode}`, type: "upstream_error" } })}\n\n`);
              res.write("data: [DONE]\n\n");
              res.end();
            });
            return;
          }

          let buffer = "";
          upstreamRes.on("data", (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const converted = convertSSELine(line.trim(), state);
              if (converted) res.write(converted);
            }
          });

          upstreamRes.on("end", () => {
            if (buffer.trim()) {
              const converted = convertSSELine(buffer.trim(), state);
              if (converted) res.write(converted);
            }
            res.write("data: [DONE]\n\n");
            res.end();
          });

          upstreamRes.on("error", (err) => {
            logError(`Upstream stream error: ${err.message}`);
            res.end();
          });

          req.on("close", () => {
            upstreamRes.destroy?.();
          });
        } else {
          const { status, body: respBody } = result;

          if (status !== 200) {
            logError(`Upstream ${status}: ${typeof respBody === "string" ? respBody : JSON.stringify(respBody)}`);
            res.writeHead(status, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              error: {
                message: typeof respBody === "string" ? respBody : respBody?.error?.message || "Upstream error",
                type: "upstream_error",
                code: status,
              },
            }));
            return;
          }

          const openaiResp = anthropicToOpenai(respBody, openaiBody.model);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(openaiResp));
        }
      } catch (err) {
        logError(err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "server_error" } }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
});

// ─── 启动 ───────────────────────────────────────────────
cleanOldLogs();

server.listen(CONFIG.port, CONFIG.bind, () => {
  const providerLines = CONFIG.providers.map(p =>
    `║  [${p.id}] ${p.upstream}  (${(p.models || []).join(", ")})`
  ).join("\n");

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  CC Switch Bridge v2.0 — OpenAI ↔ Anthropic 转换代理    ║
╠══════════════════════════════════════════════════════════╣
║  监听: http://${CONFIG.bind}:${CONFIG.port}
║  Key模式: ${CONFIG.keyMode}
║  默认Provider: ${CONFIG.defaultProvider || "(auto)"}
╠══════════════════════════════════════════════════════════╣
║  Providers:
${providerLines}
╠══════════════════════════════════════════════════════════╣
║  客户端配置:
║  Endpoint: http://${CONFIG.bind}:${CONFIG.port}/v1
║  API Key:  任意（Bridge 自动管理）
║  Models:   ${[...allModels].join(" / ")}
╚══════════════════════════════════════════════════════════╝
  `);
  log("Bridge started");
});
