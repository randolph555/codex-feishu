import { spawn } from "node:child_process";
import { getBridgeRpcEndpoint } from "../lib/paths.js";
import { callJsonRpc } from "../lib/uds_rpc.js";

function isTruthy(value) {
  if (typeof value !== "string") {
    return Boolean(value);
  }
  const lowered = value.trim().toLowerCase();
  return lowered === "" || lowered === "1" || lowered === "true" || lowered === "yes" || lowered === "on";
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

async function maybeAutostartDaemon() {
  const auto = process.env.CODEX_FEISHU_AUTOSTART ?? "true";
  if (!isTruthy(auto)) {
    return false;
  }

  const trySpawn = (cmd, args) =>
    new Promise((resolve) => {
      const child = spawn(cmd, args, {
        detached: true,
        stdio: "ignore",
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
    if (!currentEntry) {
      return false;
    }
    const fromCurrentNode = await trySpawn(process.execPath, [currentEntry, "daemon"]);
    if (!fromCurrentNode) {
      return false;
    }
  }

  await new Promise((resolve) => {
    setTimeout(resolve, 700);
  });
  return true;
}

export async function fetchQrcode(options = {}) {
  const endpoint = getBridgeRpcEndpoint();
  const payload = {
    purpose: options.purpose ?? null,
    cwd_hint: options.cwdHint ?? process.cwd(),
  };
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 6000;
  const autostart = options.autostart !== false;

  try {
    return await callJsonRpc(endpoint, "feishu/qrcode", payload, { timeoutMs });
  } catch (firstErr) {
    if (!autostart) {
      throw firstErr;
    }
    await maybeAutostartDaemon();
    return await callJsonRpc(endpoint, "feishu/qrcode", payload, { timeoutMs: timeoutMs + 2000 });
  }
}

export async function renderAsciiQr(value) {
  try {
    const mod = await import("qrcode");
    const QRCode = mod?.default ?? mod;
    if (!QRCode || typeof QRCode.toString !== "function") {
      throw new Error("qrcode.toString unavailable");
    }
    return await QRCode.toString(value, { type: "terminal", small: true, margin: 1 });
  } catch {
    return "";
  }
}

function deriveBotOpenId(result) {
  if (result?.bot_open_id) {
    return String(result.bot_open_id);
  }
  const link = result?.open_chat_link;
  if (typeof link !== "string" || !link.trim()) {
    return "";
  }
  try {
    const url = new URL(link);
    return url.searchParams.get("openId") || "";
  } catch {
    return "";
  }
}

export function formatQrcodeSummary(result, options = {}) {
  const expireAtShanghai = formatInShanghai(result?.expires_at);
  const botOpenId = deriveBotOpenId(result);
  const lines = [
    "飞书绑定码已生成。",
    result?.reused ? "- note: 本次复用了最近一次未过期绑定码" : "",
    `- bot_open_id: ${botOpenId || "(not set)"}`,
    `- code: ${result?.code ?? "unknown"}`,
    `- expire_at(上海): ${expireAtShanghai || "unknown"}`,
    `- qrcode_mode: ${result?.qrcode_mode ?? "unknown"}`,
    `- qr_payload: ${result?.qr_text ?? ""}`,
    result?.open_chat_link ? `- open_chat_link: ${result.open_chat_link}` : "",
    `- 在飞书里发送: ${result?.bind_command_hint ?? "unknown"}`,
  ].filter(Boolean);

  if (options.asciiQr) {
    lines.push("", "可扫码二维码：", "```", options.asciiQr.trimEnd(), "```");
  }
  return lines.join("\n");
}

export async function runQrcode(flags = {}) {
  const purpose = flags.purpose || null;
  const asJson = isTruthy(flags.json);
  const wantAscii = isTruthy(flags.ascii);
  const result = await fetchQrcode({ purpose, autostart: true, cwdHint: process.cwd() });

  if (asJson) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const asciiQr = wantAscii ? await renderAsciiQr(result?.qr_text) : "";
  // eslint-disable-next-line no-console
  console.log(formatQrcodeSummary(result, { asciiQr }));
}
