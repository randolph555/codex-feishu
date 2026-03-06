import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { getBridgeRpcEndpoint } from "../lib/paths.js";
import { callJsonRpc } from "../lib/uds_rpc.js";



function getCodexTuiLogPath() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "log", "codex-tui.log");
}

function extractRecentLogTail(filePath, maxBytes = 256 * 1024) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size || 0;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const length = size - start;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function findInvokingThreadIdForTool(toolName, purpose = null, lookbackMs = 60_000) {
  const logPath = getCodexTuiLogPath();
  const tail = extractRecentLogTail(logPath);
  if (!tail) {
    return null;
  }
  const lines = tail.split(/\r?\n/).filter(Boolean);
  const pattern = new RegExp(`session_loop\\{thread_id=([^}]+)\\}.*ToolCall: mcp__codex_feishu__${toolName}\\s+(\\{.*\\})`);
  const now = Date.now();
  let best = null;
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }
    const threadId = match[1] ?? null;
    const jsonText = match[2] ?? "{}";
    let parsed = {};
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      parsed = {};
    }
    const lineTsText = line.slice(0, 30).trim();
    const lineTs = Date.parse(lineTsText);
    if (Number.isFinite(lineTs) && now - lineTs > lookbackMs) {
      continue;
    }
    const loggedPurpose = typeof parsed?.purpose === "string" ? parsed.purpose : null;
    if (purpose && loggedPurpose && loggedPurpose !== purpose) {
      continue;
    }
    best = {
      threadId,
      loggedPurpose,
      ts: Number.isFinite(lineTs) ? lineTs : 0,
    };
  }
  return best?.threadId ?? null;
}

function resolveInvokingThreadForTool(toolName, purpose = null, options = {}) {
  const lookbackMs = Number.isFinite(options.lookbackMs)
    ? Math.max(1_000, Number(options.lookbackMs))
    : 60_000;
  const threadId = findInvokingThreadIdForTool(toolName, purpose, lookbackMs);
  if (threadId) {
    return {
      threadId,
      reason: "matched_recent_tool_call",
    };
  }
  return {
    threadId: null,
    reason: "no_recent_tool_call_match",
  };
}

const TOOLS = [
  {
    name: "feishu_qrcode",
    description: "Generate a Feishu binding QR code for codex-feishu.",
    inputSchema: {
      type: "object",
      properties: {
        purpose: {
          type: "string",
          description: "Optional reason for QR code generation.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "feishu_status",
    description: "Get codex-feishu bridge status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "feishu_new_thread",
    description: "Create/switch to a new synced conversation thread on Feishu side.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Optional thread title",
        },
      },
      additionalProperties: false,
    },
  },
];

function out(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id, result) {
  out({ jsonrpc: "2.0", id, result });
}

function err(id, code, message) {
  out({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function toolText(text) {
  return {
    content: [{ type: "text", text }],
    isError: false,
  };
}

function formatInShanghai(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const read = (type) => parts.find((item) => item.type === type)?.value ?? "";
  const y = read("year");
  const mon = read("month");
  const d = read("day");
  const h = read("hour");
  const min = read("minute");
  const s = read("second");
  if (!y || !mon || !d || !h || !min || !s) {
    return "";
  }
  return `${y}-${mon}-${d} ${h}:${min}:${s}`;
}

function quoteForCmd(arg) {
  const text = String(arg ?? "");
  if (text.length === 0) {
    return '""';
  }
  if (!/[\s"&|<>^()]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

async function renderAsciiQr(value) {
  try {
    const mod = await import("qrcode");
    const QRCode = mod?.default ?? mod;
    if (!QRCode || typeof QRCode.toString !== "function") {
      throw new Error("qrcode.toString unavailable");
    }
    return await QRCode.toString(value, { type: "terminal", small: true, margin: 1 });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[codex-feishu] qr render failed: ${err?.message ?? String(err)}`);
    return null;
  }
}

async function maybeAutostartDaemon() {
  const auto = process.env.CODEX_FEISHU_AUTOSTART ?? "true";
  if (auto === "0" || auto.toLowerCase() === "false") {
    return false;
  }

  const trySpawn = (cmd, args) =>
    new Promise((resolve) => {
      const spawnCmd = process.platform === "win32" ? "cmd.exe" : cmd;
      const spawnArgs = process.platform === "win32"
        ? ["/d", "/s", "/c", [cmd, ...args].map(quoteForCmd).join(" ")]
        : args;
      const child = spawn(spawnCmd, spawnArgs, {
        detached: true,
        stdio: "ignore",
        windowsHide: process.platform === "win32",
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });

  const fromPath = await trySpawn("codex-feishu", ["daemon"]);
  if (!fromPath) {
    const currentEntry = process.argv[1];
    if (currentEntry) {
      const fromCurrentNode = await trySpawn(process.execPath, [currentEntry, "daemon"]);
      if (fromCurrentNode) {
        await new Promise((resolve) => {
          setTimeout(resolve, 500);
        });
        return true;
      }
    }
    return false;
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
  return true;
}

async function callDaemon(method, params) {
  const endpoint = getBridgeRpcEndpoint();
  try {
    return await callJsonRpc(endpoint, method, params, { timeoutMs: 4000 });
  } catch (firstErr) {
    await maybeAutostartDaemon();
    try {
      return await callJsonRpc(endpoint, method, params, { timeoutMs: 6000 });
    } catch (secondErr) {
      throw new Error(
        `daemon unavailable. Start it with \`codex-feishu daemon\`. Last error: ${secondErr.message}`,
      );
    }
  }
}

async function handleToolCall(id, params) {
  const toolName = params?.name;
  const args = params?.arguments ?? {};

  if (toolName === "feishu_qrcode") {
    const purpose = args.purpose ?? null;
    const resolution = resolveInvokingThreadForTool("feishu_qrcode", purpose);
    const result = await callDaemon("feishu/qrcode", {
      purpose,
      cwd_hint: process.cwd(),
      thread_id: resolution.threadId,
      strict_thread_hint: true,
      force_new_code: true,
    });
    const asciiQr = await renderAsciiQr(result.qr_text);
    const expireAtShanghai = formatInShanghai(result.expires_at);
    const resolutionNote = resolution.threadId
      ? "- note: 已精确绑定到当前触发二维码的 Codex 会话"
      : `- note: 未能精确识别当前 Codex 会话（${resolution.reason}），因此不会自动绑定到某条会话，避免绑错`;
    const text = [
      "飞书绑定码已生成。",
      resolutionNote,
      result.reused ? "- note: 本次复用了最近一次未过期绑定码（避免重复调用生成新码）" : "",
      `- code: ${result.code}`,
      `- expire_at(上海): ${expireAtShanghai || "unknown"}`,
      `- qrcode_mode: ${result.qrcode_mode ?? "unknown"}`,
      `- qr_payload: ${result.qr_text}`,
      result.open_chat_link ? `- open_chat_link: ${result.open_chat_link}` : "",
      `- 在飞书里发送: ${result.bind_command_hint}`,
      result.open_chat_link
        ? "\n可扫码二维码(内容是 打开机器人聊天页；进入后仍需发送 /bind 命令)。"
        : "\n可扫码二维码(内容是 /bind 命令)。",
      "如二维码显示被截断，请直接使用上面的 open_chat_link 或 /bind 指令。",
      asciiQr ? `\n\`\`\`\n${asciiQr}\n\`\`\`` : "",
      asciiQr ? "" : "\n二维码渲染失败：请先执行 `npm install` 后重启 codex/codex-feishu。",
    ].join("\n");
    ok(id, toolText(text));
    return;
  }

  if (toolName === "feishu_status") {
    const status = await callDaemon("feishu/status", {});
    const text = [
      "codex-feishu 状态：",
      `- app_server_running: ${status.app_server?.running ? "yes" : "no"}`,
      `- app_server_initialized: ${status.app_server?.initialized ? "yes" : "no"}`,
      `- feishu_enabled: ${status.feishu?.enabled ? "yes" : "no"}`,
      `- feishu_running: ${status.feishu?.running ? "yes" : "no"}`,
      `- feishu_last_error: ${status.feishu?.last_error ?? "none"}`,
      `- active_thread_id: ${status.active_thread_id ?? "none"}`,
      `- bindings: ${status.bindings}`,
      `- pending_bind_codes: ${status.pending_bind_codes}`,
      `- pending_requests: ${status.pending?.count ?? 0}`,
      `- latest_event: ${status.latest_event?.type || status.latest_event?.method || "none"}`,
    ].join("\n");
    ok(id, toolText(text));
    return;
  }

  if (toolName === "feishu_new_thread") {
    const created = await callDaemon("feishu/new_thread", {
      title: args.title ?? null,
    });
    ok(id, toolText(`已创建并切换到新线程: ${created.thread_id}`));
    return;
  }

  err(id, -32601, `unknown tool: ${toolName}`);
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    ok(id, {
      protocolVersion: "2024-11-05",
      serverInfo: {
        name: "codex-feishu",
        version: "0.1.0",
      },
      capabilities: {
        tools: {},
      },
    });
    return;
  }

  if (method === "tools/list") {
    ok(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    try {
      await handleToolCall(id, params);
    } catch (toolErr) {
      ok(
        id,
        {
          content: [{ type: "text", text: toolErr.message }],
          isError: true,
        },
      );
    }
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (id !== undefined) {
    err(id, -32601, `method not found: ${method}`);
  }
}

export async function runMcp() {
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    await handleRequest(msg);
  }
}
