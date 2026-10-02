/**
 * CC Switch Bridge — 双向协议转换代理
 *
 * 出站（OpenAI 客户端）：OpenAI → Anthropic（/v1/messages），给 WorkBuddy 的 Claude/GPT/Gemini 用。
 * grok-*：OpenAI 原样透传（/v1/chat/completions），xapi 的 Grok 分组不提供 Anthropic。
 * 入站（Anthropic 客户端）：POST /v1/messages → OpenAI（/v1/chat/completions），给 Claude Code 用；
 *                          只服务 protocol=openai 的 provider，其它协议返回 400。
 *
 * 链路：客户端 → localhost:PORT (Bridge) → [proxy] → upstream
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

  const defaultMax = CONFIG.defaultMaxTokens || 8192;
  const maxTokens = openaiBody.max_tokens || openaiBody.max_completion_tokens || defaultMax;

  const anthropicReq = {
    model: openaiBody.model || provider?.models?.[0] || "claude-sonnet-5",
    max_tokens: maxTokens,
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

// ─── OpenAI → TypeSafe 请求转换 ─────────────────────────
function openaiToTypesafe(openaiBody, provider) {
  // 提取用户消息文本
  const textParts = [];
  for (const msg of openaiBody.messages || []) {
    if (msg.role === "system") continue;
    if (typeof msg.content === "string") {
      textParts.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) textParts.push(part.text);
      }
    }
  }
  const lastMsg = textParts[textParts.length - 1] || "";
  const state = textParts.join("\n");

  const tsConfig = provider.typesafe || {};
  const model = tsConfig.model || "jev-latest";

  // 智能判断：如果最后一条用户消息是问句，直接用作 instructions
  const isQuestion = /[?？]\s*$/.test(lastMsg.trim());
  const defaultQ = isQuestion
    ? { type: "noul", instructions: lastMsg.trim() }
    : (tsConfig.defaultQuestion || {
        type: "noul",
        instructions: "请分析这条消息并给出你的判断。",
      });

  const questions = {};
  questions["q1"] = { ...defaultQ };

  return { state, model, questions };
}

// ─── TypeSafe → OpenAI 响应转换 ─────────────────────────
function typesafeToOpenai(tsResp, model) {
  const answers = tsResp.answers || {};
  const lines = [];

  for (const [id, ans] of Object.entries(answers)) {
    if (ans.type === "noul") {
      lines.push(`[${id}] noul: ${ans.noul}`);
    } else if (ans.type === "choice") {
      lines.push(`[${id}] choice: ${ans.choice} (confidence: ${ans.confidence})`);
      if (ans.probabilities) {
        const probs = Object.entries(ans.probabilities)
          .map(([k, v]) => `  ${k}: ${(v * 100).toFixed(1)}%`)
          .join("\n");
        lines.push(probs);
      }
    } else if (ans.type === "score") {
      lines.push(`[${id}] score: ${ans.score} (confidence: ${ans.confidence})`);
      if (ans.probabilities) {
        const probs = Object.entries(ans.probabilities)
          .map(([k, v]) => `  ${k}: ${(v * 100).toFixed(1)}%`)
          .join("\n");
        lines.push(probs);
      }
    } else {
      lines.push(`[${id}] ${JSON.stringify(ans)}`);
    }
  }

  const content = lines.join("\n");
  const usage = tsResp.usage || {};

  return {
    id: tsResp.id || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || tsResp.model || "jev-latest",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
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

  if (type === "content_block_stop") {
    return null;
  }

  if (type === "message_delta") {
    // Capture the real stop_reason from upstream
    const delta = event_obj.delta || {};
    if (delta.stop_reason) {
      state.stopReason = delta.stop_reason;
    }
    // Capture usage if present
    if (event_obj.usage) {
      state.usage = event_obj.usage;
    }
    return null;
  }

  if (type === "message_stop") {
    const finishReason = mapStopReason(state.stopReason);
    const chunk = {
      id: state.id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
//  /v1/messages 入站（Anthropic 进 → OpenAI 出）
//  用于上游只提供 OpenAI Chat Completions 的 provider（如 grok），
//  也就是 Claude Code 这类 Anthropic 原生客户端直连的场景。
// ═══════════════════════════════════════════════════════════

// ─── Anthropic 请求 → OpenAI 请求 ───────────────────────
function anthropicToOpenaiRequest(anthReq) {
  const out = { model: anthReq.model, messages: [] };

  if (anthReq.system) {
    const sys = typeof anthReq.system === "string"
      ? anthReq.system
      : (anthReq.system || []).map((b) => b.text || "").join("\n");
    if (sys.trim()) out.messages.push({ role: "system", content: sys });
  }

  for (const msg of anthReq.messages || []) {
    if (typeof msg.content === "string") {
      out.messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = Array.isArray(msg.content) ? msg.content : [];

    if (msg.role === "assistant") {
      const texts = [];
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === "text") texts.push(b.text || "");
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
          });
        }
      }
      const m = { role: "assistant", content: texts.join("") || null };
      if (toolCalls.length) m.tool_calls = toolCalls;
      if (m.content !== null || toolCalls.length) out.messages.push(m);
      continue;
    }

    // user：可能夹带 tool_result
    const results = blocks.filter((b) => b.type === "tool_result");
    const rest = blocks.filter((b) => b.type !== "tool_result");

    for (const tr of results) {
      const text = typeof tr.content === "string"
        ? tr.content
        : (tr.content || []).map((c) => c.text || (c.type === "image" ? "[image]" : "")).join("\n");
      out.messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: text || "" });
    }

    if (rest.length) {
      const parts = [];
      let onlyText = true;
      for (const b of rest) {
        if (b.type === "text") parts.push(b.text || "");
        else if (b.type === "image") {
          onlyText = false;
          const src = b.source || {};
          if (src.type === "base64") {
            parts.push({ type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } });
          } else if (src.type === "url") {
            parts.push({ type: "image_url", image_url: { url: src.url } });
          }
        }
      }
      if (!parts.length) continue;
      out.messages.push(onlyText
        ? { role: "user", content: parts.join("") }
        : { role: "user", content: parts.map((p) => (typeof p === "string" ? { type: "text", text: p } : p)) });
    }
  }

  if (anthReq.max_tokens != null) out.max_tokens = anthReq.max_tokens;
  if (anthReq.temperature != null) out.temperature = anthReq.temperature;
  if (anthReq.top_p != null) out.top_p = anthReq.top_p;
  if (Array.isArray(anthReq.stop_sequences) && anthReq.stop_sequences.length) out.stop = anthReq.stop_sequences;

  if (Array.isArray(anthReq.tools) && anthReq.tools.length) {
    out.tools = anthReq.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  }

  const tc = anthReq.tool_choice;
  if (tc) {
    if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "none") out.tool_choice = "none";
    else if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
  }

  out.stream = !!anthReq.stream;
  if (out.stream) out.stream_options = { include_usage: true };
  return out;
}

function oaiFinishToAnthropic(fr) {
  if (fr === "length") return "max_tokens";
  if (fr === "tool_calls" || fr === "function_call") return "tool_use";
  return "end_turn";
}

// ─── OpenAI 响应 → Anthropic 响应（非流式）───────────────
function openaiToAnthropicResponse(oai, model) {
  const choice = (oai.choices || [])[0] || {};
  const msg = choice.message || {};
  const content = [];

  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tcall of msg.tool_calls || []) {
    let input = {};
    try {
      input = JSON.parse(tcall.function?.arguments || "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: tcall.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      name: tcall.function?.name || "",
      input,
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = oai.usage || {};
  return {
    id: oai.id || `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model: model || oai.model || "unknown",
    content,
    stop_reason: oaiFinishToAnthropic(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
  };
}

// ─── OpenAI SSE → Anthropic SSE（流式）───────────────────
function createOaiToAnthropicStreamer(model) {
  const st = {
    model: model || "unknown",
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    started: false,
    nextIndex: 0,
    textIndex: -1,
    textOpen: false,
    toolBlocks: new Map(), // openai tool_call index → { anthIndex, open }
    stopReason: "end_turn",
    usage: null,
  };

  const ev = (type, obj) => `event: ${type}\ndata: ${JSON.stringify(obj)}\n\n`;

  function ensureStart() {
    if (st.started) return "";
    st.started = true;
    return ev("message_start", {
      type: "message_start",
      message: {
        id: st.id,
        type: "message",
        role: "assistant",
        model: st.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function closeText() {
    if (!st.textOpen) return "";
    st.textOpen = false;
    return ev("content_block_stop", { type: "content_block_stop", index: st.textIndex });
  }

  function feed(chunk) {
    let out = ensureStart();
    const choice = (chunk.choices || [])[0];
    if (chunk.usage) st.usage = chunk.usage;
    if (!choice) return out;

    const delta = choice.delta || {};

    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!st.textOpen) {
        st.textIndex = st.nextIndex++;
        st.textOpen = true;
        out += ev("content_block_start", {
          type: "content_block_start",
          index: st.textIndex,
          content_block: { type: "text", text: "" },
        });
      }
      out += ev("content_block_delta", {
        type: "content_block_delta",
        index: st.textIndex,
        delta: { type: "text_delta", text: delta.content },
      });
    }

    for (const tcall of delta.tool_calls || []) {
      const key = tcall.index ?? 0;
      let blk = st.toolBlocks.get(key);
      if (!blk) {
        out += closeText();
        blk = { anthIndex: st.nextIndex++, open: true, started: false };
        st.toolBlocks.set(key, blk);
      }
      if (!blk.started) {
        blk.started = true;
        blk.id = tcall.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        blk.name = tcall.function?.name || "";
        out += ev("content_block_start", {
          type: "content_block_start",
          index: blk.anthIndex,
          content_block: { type: "tool_use", id: blk.id, name: blk.name, input: {} },
        });
      }
      if (tcall.function?.arguments) {
        out += ev("content_block_delta", {
          type: "content_block_delta",
          index: blk.anthIndex,
          delta: { type: "input_json_delta", partial_json: tcall.function.arguments },
        });
      }
    }

    if (choice.finish_reason) st.stopReason = oaiFinishToAnthropic(choice.finish_reason);
    return out;
  }

  function finish() {
    let out = ensureStart();
    out += closeText();
    for (const blk of st.toolBlocks.values()) {
      if (blk.open) {
        blk.open = false;
        out += ev("content_block_stop", { type: "content_block_stop", index: blk.anthIndex });
      }
    }
    // 空回复也要给一个内容块，避免客户端拿到空的 content
    if (st.textIndex === -1 && st.toolBlocks.size === 0) {
      const idx = st.nextIndex++;
      out += ev("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
      out += ev("content_block_stop", { type: "content_block_stop", index: idx });
    }
    const usage = st.usage || {};
    out += ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: st.stopReason, stop_sequence: null },
      usage: { output_tokens: usage.completion_tokens || 0 },
    });
    out += ev("message_stop", { type: "message_stop" });
    return out;
  }

  return { feed, finish };
}

// ─── 发送 HTTPS 请求（支持代理 / 直连）────────────────────
function buildUpstreamHeaders(bodyStr, apiKey, userAgent, opts = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(bodyStr),
    "Authorization": `Bearer ${apiKey}`,
    "User-Agent": userAgent,
  };
  if (opts.anthropic !== false) {
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function sendRequest(upstreamUrl, bodyStr, isStream, apiKey, provider, opts = {}) {
  const proxyStr = provider?.proxy;
  const userAgent = provider?.userAgent || "cc-switch-bridge/2.0";
  const upstreamPath = opts.path || "/v1/messages";
  const headers = buildUpstreamHeaders(bodyStr, apiKey, userAgent, opts);

  if (proxyStr) {
    return requestViaProxy(upstreamUrl, bodyStr, isStream, headers, proxyStr, upstreamPath);
  }
  return requestDirect(upstreamUrl, bodyStr, isStream, headers, upstreamPath);
}

function requestViaProxy(upstreamUrl, bodyStr, isStream, headers, proxyStr, upstreamPath) {
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
        path: upstreamPath,
        method: "POST",
        headers,
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

function requestDirect(upstreamUrl, bodyStr, isStream, headers, upstreamPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: upstreamUrl.hostname,
      port: 443,
      path: upstreamPath,
      method: "POST",
      headers,
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

  // 按 pathname 匹配，忽略查询串（Claude Code 会请求 /v1/messages?beta=true，
  // 用 req.url 全等匹配会 404）
  const reqPath = (req.url || "").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method === "GET" && (reqPath === "/" || reqPath === "/health")) {
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
      endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
      passthrough: "Provider protocol config: openai → /v1/chat/completions; anthropic → /v1/messages; typesafe → /v1/systemone",
    }));
    return;
  }

  if (req.method === "GET" && reqPath === "/v1/models") {
    const models = [...allModels].map((id) => ({
      id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "anthropic",
    }));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: models }));
    return;
  }

  if (req.method === "POST" && reqPath === "/v1/chat/completions") {
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

        const openaiProvider = provider.protocol === "openai";
        const typesafeProvider = provider.protocol === "typesafe";
        const upstreamUrl = new URL(provider.upstream);
        const msgCount = Array.isArray(openaiBody.messages) ? openaiBody.messages.length : 0;
        log(`${isStream ? "STREAM" : "NORMAL"} ${typesafeProvider ? "TYPESAFE" : openaiProvider ? "OPENAI" : "ANTHROPIC"} model=${requestedModel} provider=${provider.id} protocol=${provider.protocol || "anthropic"} key=${apiKey.slice(0, 8)}... msgs=${msgCount}`);

        let bodyStr;
        let sendOpts;
        if (typesafeProvider) {
          bodyStr = JSON.stringify(openaiToTypesafe(openaiBody, provider));
          sendOpts = { path: "/v1/systemone", anthropic: false };
        } else if (openaiProvider) {
          bodyStr = JSON.stringify(openaiBody);
          sendOpts = { path: "/v1/chat/completions", anthropic: false };
        } else {
          bodyStr = JSON.stringify(openaiToAnthropic(openaiBody, provider));
          sendOpts = { path: "/v1/messages", anthropic: true };
        }

        const result = await sendRequest(upstreamUrl, bodyStr, isStream, apiKey, provider, sendOpts);

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

          if (openaiProvider) {
            upstreamRes.pipe(res);
            req.on("close", () => {
              upstreamRes.destroy?.();
            });
            return;
          }

          // TypeSafe: non-streaming upstream, simulate SSE
          if (typesafeProvider) {
            let tsData = "";
            upstreamRes.on("data", (c) => (tsData += c));
            upstreamRes.on("end", () => {
              if (upstreamRes.statusCode !== 200) {
                logError(`TypeSafe upstream ${upstreamRes.statusCode}: ${tsData}`);
                res.write(`data: ${JSON.stringify({ error: { message: `Upstream error: ${upstreamRes.statusCode}`, type: "upstream_error" } })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
                return;
              }
              try {
                const tsResp = JSON.parse(tsData);
                const openaiResp = typesafeToOpenai(tsResp, openaiBody.model);
                const content = openaiResp.choices[0].message.content;

                // Role chunk
                res.write(`data: ${JSON.stringify({
                  id: openaiResp.id, object: "chat.completion.chunk",
                  created: openaiResp.created, model: openaiResp.model,
                  choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
                })}\n\n`);
                // Content chunk
                res.write(`data: ${JSON.stringify({
                  id: openaiResp.id, object: "chat.completion.chunk",
                  created: openaiResp.created, model: openaiResp.model,
                  choices: [{ index: 0, delta: { content }, finish_reason: null }],
                })}\n\n`);
                // Finish chunk
                res.write(`data: ${JSON.stringify({
                  id: openaiResp.id, object: "chat.completion.chunk",
                  created: openaiResp.created, model: openaiResp.model,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
              } catch (e) {
                logError(`TypeSafe parse error: ${e.message}`);
                res.write(`data: ${JSON.stringify({ error: { message: e.message, type: "server_error" } })}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
              }
            });
            upstreamRes.on("error", (err) => {
              logError(`TypeSafe stream error: ${err.message}`);
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

          const openaiResp = typesafeProvider ? typesafeToOpenai(respBody, openaiBody.model)
            : openaiProvider ? respBody : anthropicToOpenai(respBody, openaiBody.model);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(typeof openaiResp === "string" ? openaiResp : JSON.stringify(openaiResp));
        }
      } catch (err) {
        logError(err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message, type: "server_error" } }));
      }
    });
    return;
  }

  // ─── POST /v1/messages：Anthropic 入站（Claude Code）→ OpenAI 上游 ───
  // 只服务 protocol=openai 的 provider，其余一律拒绝，不影响原有链路
  if (req.method === "POST" && reqPath === "/v1/messages") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const anthBody = JSON.parse(body);
        const requestedModel = anthBody.model || "";

        const provider = resolveProvider(requestedModel);
        if (!provider) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: `No provider found for model: ${requestedModel}` } }));
          return;
        }
        if (provider.protocol !== "openai") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            type: "error",
            error: {
              type: "invalid_request_error",
              message: `Model ${requestedModel} is served by provider '${provider.id}' (protocol=${provider.protocol || "anthropic"}), which is not OpenAI-format. Use /v1/chat/completions for that provider.`,
            },
          }));
          return;
        }

        // Key：优先透传客户端带的，其次用 provider 配置的
        let apiKey = "";
        const authHeader = req.headers.authorization || "";
        if (authHeader.startsWith("Bearer ")) apiKey = authHeader.slice(7).trim();
        if (!apiKey && req.headers["x-api-key"]) apiKey = String(req.headers["x-api-key"]).trim();
        if (!apiKey) apiKey = pickKey(provider);
        if (!apiKey) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: `No API key available for provider: ${provider.id}` } }));
          return;
        }

        const isStream = !!anthBody.stream;
        const oaiReq = anthropicToOpenaiRequest(anthBody);
        const upstreamUrl = new URL(provider.upstream);
        const bodyStr = JSON.stringify(oaiReq);
        const msgCount = (anthBody.messages || []).length;
        const toolCount = (anthBody.tools || []).length;

        log(`${isStream ? "STREAM" : "NORMAL"} ANTHROPIC-IN model=${requestedModel} provider=${provider.id} key=${apiKey.slice(0, 8)}... msgs=${msgCount} tools=${toolCount}`);

        const result = await sendRequest(upstreamUrl, bodyStr, isStream, apiKey, provider, {
          path: "/v1/chat/completions",
          anthropic: false,
        });

        if (isStream) {
          if (result.statusCode !== 200) {
            let errData = "";
            result.on("data", (c) => (errData += c));
            result.on("end", () => {
              logError(`Upstream ${result.statusCode}: ${errData}`);
              res.writeHead(result.statusCode, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ type: "error", error: { type: "upstream_error", message: errData.slice(0, 800) || "Upstream error" } }));
            });
            return;
          }

          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const streamer = createOaiToAnthropicStreamer(requestedModel);
          let buffer = "";

          const consume = (text) => {
            buffer += text;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const raw of lines) {
              const line = raw.trim();
              if (!line.startsWith("data:")) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === "[DONE]") continue;
              let chunk;
              try {
                chunk = JSON.parse(payload);
              } catch {
                continue;
              }
              const out = streamer.feed(chunk);
              if (out) res.write(out);
            }
          };

          result.on("data", (c) => consume(c.toString()));
          result.on("end", () => {
            if (buffer.trim()) consume("\n");
            res.write(streamer.finish());
            res.end();
          });
          result.on("error", (err) => {
            logError(`Upstream stream error: ${err.message}`);
            try {
              res.write(streamer.finish());
            } catch {}
            res.end();
          });
          req.on("close", () => result.destroy?.());
          return;
        }

        const { status, body: respBody } = result;
        if (status !== 200) {
          logError(`Upstream ${status}: ${typeof respBody === "string" ? respBody : JSON.stringify(respBody)}`);
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            type: "error",
            error: {
              type: "upstream_error",
              message: (typeof respBody === "string" ? respBody : respBody?.error?.message) || "Upstream error",
            },
          }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(openaiToAnthropicResponse(respBody, requestedModel)));
      } catch (err) {
        logError(err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "server_error", message: err.message } }));
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
║  CC Switch Bridge v2.2 — 双向协议转换                     ║
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
