import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import { AppServerClient } from "../lib/app_server_client.js";
import { FeishuBridge } from "../lib/feishu_bridge.js";
import { readJsonIfExists, readTextIfExists } from "../lib/fs_utils.js";
import {
  getCodexConfigPath,
  getCodexHome,
  getBridgeConfigPath,
  getDaemonPidPath,
  getDefaultBridgeRpcEndpoint,
  getBridgeRpcEndpoint,
  getBridgeSocketPath,
  getBridgeStatePath,
  getRunDir,
} from "../lib/paths.js";
import { createBindCode, pushRecentEvent, StateStore } from "../lib/state_store.js";
import { createJsonRpcServer, parseRpcEndpoint } from "../lib/uds_rpc.js";

const BIND_CODE_TTL_MS = 10 * 60 * 1000;
const PENDING_TIMEOUT_MS = 3 * 60 * 1000;
const IMAGE_DRAFT_WAIT_MS = 90 * 1000;
const PROGRESS_TIP_ROTATE_MS = 6 * 1000;
const PROGRESS_TICK_MS = 3 * 1000;
const APP_RPC_TIMEOUT_MS = 20 * 1000;
const DEFAULT_PROJECT_DOC_FILENAME = "AGENTS.md";
const INIT_COMMAND_PROMPT =
  "请在当前项目根目录创建 AGENTS.md，内容要求：\n" +
  "1) 简洁说明项目目标与边界；\n" +
  "2) 给出代码风格、测试与提交流程；\n" +
  "3) 标注常用命令与目录约定；\n" +
  "4) 不要写空话，尽量可执行。\n" +
  "若文件已存在，请先读取并在保留原意基础上补充，不要破坏已有有效内容。";
const PLAN_MODE_PREFIX =
  "请按 Plan 模式回答：先给出结构化计划（目标/步骤/风险），再给出执行内容。";
const CLI_CAPTURE_TIMEOUT_MS = 20 * 1000;
const CLI_CAPTURE_MAX_BUFFER = 1024 * 1024;
const CLI_OUTPUT_MAX_CHARS = 9000;
const PROGRESS_TIPS = [
  "`/status` 查看当前会话状态",
  "`/stop` 可中断当前回复",
  "`/skills` 查看本机可用技能",
  "`/mcp` 查看 MCP 服务列表",
  "`/cwd` 查看当前工作目录",
  "`/cwd <PATH>` 切到指定目录",
  "`/cwd <PATH> new` 切目录并新开会话",
  "`/threads` 查看会话列表",
  "`/sw 2` 按序号切换会话",
  "`/new` 立即新建一个会话",
  "`/rebind` 重新绑定当前飞书会话",
  "`/group` 查看群聊使用说明",
  "`/pending` 查看待审批请求",
  "发图片后再发文字，可图文一起提问",
  "`/send` 仅发送图片草稿，`/clear` 清空草稿",
];

function buildChatOpenLink(openId) {
  if (!openId || typeof openId !== "string") {
    return null;
  }
  return `https://applink.feishu.cn/client/chat/open?openId=${encodeURIComponent(openId)}`;
}

function safeUnlink(socketPath) {
  try {
    fs.unlinkSync(socketPath);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }
}

function parsePid(raw) {
  const pid = Number.parseInt(String(raw ?? "").trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function isPidAlive(pid) {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ESRCH") {
      return false;
    }
    return true;
  }
}

function readPidFile(pidPath) {
  try {
    return parsePid(fs.readFileSync(pidPath, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

function writePidFile(pidPath) {
  const ownPidText = `${process.pid}\n`;
  try {
    fs.writeFileSync(pidPath, ownPidText, { encoding: "utf8", flag: "wx" });
    return;
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      throw err;
    }
  }

  const existingPid = readPidFile(pidPath);
  if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
    throw new Error(
      `codex-feishu daemon already running (pid=${existingPid}). stop it first or use codex-feishu init daemon`,
    );
  }
  safeUnlink(pidPath);
  fs.writeFileSync(pidPath, ownPidText, { encoding: "utf8", flag: "wx" });
}

function removePidFileIfOwned(pidPath) {
  try {
    const existingPid = readPidFile(pidPath);
    if (existingPid && existingPid !== process.pid) {
      return;
    }
    safeUnlink(pidPath);
  } catch {
    // noop
  }
}

function pickThreadId(params) {
  if (!params || typeof params !== "object") {
    return null;
  }
  return params.threadId ?? params.thread_id ?? null;
}

function pickTurnId(params) {
  if (!params || typeof params !== "object") {
    return null;
  }
  return params.turnId ?? params.turn_id ?? null;
}

function getBoundChatIdsForThread(state, threadId) {
  if (!threadId) {
    return [];
  }
  const seen = new Set();
  for (const binding of Object.values(state.bindings ?? {})) {
    if (binding?.active_thread_id === threadId && binding.chat_id) {
      seen.add(binding.chat_id);
    }
  }
  return [...seen];
}

function splitTextChunks(text, maxLen = 1600) {
  if (!text || typeof text !== "string") {
    return [];
  }
  const chunks = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + maxLen));
    offset += maxLen;
  }
  return chunks;
}

function splitMarkdownChunks(text, maxLen = 3200) {
  if (!text || typeof text !== "string") {
    return [];
  }
  if (text.length <= maxLen) {
    return [text];
  }
  const blocks = text.split("\n\n");
  const chunks = [];
  let current = "";
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= maxLen) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (block.length <= maxLen) {
      current = block;
      continue;
    }
    let offset = 0;
    while (offset < block.length) {
      chunks.push(block.slice(offset, offset + maxLen));
      offset += maxLen;
    }
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function uniqueStrings(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || typeof item !== "string") {
      continue;
    }
    const key = item.trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

function normalizeReadableText(text) {
  if (!text || typeof text !== "string") {
    return "";
  }
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isSupportedImagePath(filePath) {
  if (!filePath || typeof filePath !== "string") {
    return false;
  }
  return /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(filePath);
}

function guessExtFromContentType(contentType) {
  const lowered = String(contentType || "").toLowerCase();
  if (lowered.includes("image/png")) {
    return ".png";
  }
  if (lowered.includes("image/jpeg")) {
    return ".jpg";
  }
  if (lowered.includes("image/webp")) {
    return ".webp";
  }
  if (lowered.includes("image/gif")) {
    return ".gif";
  }
  if (lowered.includes("image/bmp")) {
    return ".bmp";
  }
  if (lowered.includes("image/svg")) {
    return ".svg";
  }
  return ".img";
}

function looksLikeImageUrl(urlText) {
  if (!urlText || typeof urlText !== "string") {
    return false;
  }
  const normalized = urlText.toLowerCase();
  return (
    /\.(png|jpe?g|webp|gif|bmp|svg)(?:[?#].*)?$/.test(normalized) ||
    normalized.includes("image") ||
    normalized.includes("img")
  );
}

function sanitizePathToken(raw) {
  if (!raw || typeof raw !== "string") {
    return "";
  }
  let value = raw.trim();
  value = value.replace(/^[`"'“”‘’]+/, "").replace(/[`"'“”‘’]+$/, "");
  value = value.replace(/[),，。；;:!?]+$/g, "");
  return value.trim();
}

function extractImageRefsFromAssistantText(text) {
  const content = typeof text === "string" ? text : "";
  if (!content) {
    return { localPaths: [], remoteUrls: [], fileNames: [], directories: [] };
  }

  const localPaths = [];
  const remoteUrls = [];
  const fileNames = [];
  const directories = [];

  const markdownImageRe = /!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of content.matchAll(markdownImageRe)) {
    const ref = String(match?.[1] ?? "").trim();
    if (!ref) {
      continue;
    }
    if (/^https?:\/\//i.test(ref)) {
      remoteUrls.push(ref);
    } else if (ref.startsWith("/") && isSupportedImagePath(ref)) {
      localPaths.push(ref);
    }
  }

  const bareUrlRe = /https?:\/\/[^\s<>"'`)\]]+/g;
  for (const match of content.matchAll(bareUrlRe)) {
    const urlText = String(match?.[0] ?? "").trim();
    if (looksLikeImageUrl(urlText)) {
      remoteUrls.push(urlText);
    }
  }

  const localPathRe = /\/[^\s"'`]+?\.(?:png|jpe?g|webp|gif|bmp|svg)\b/gi;
  for (const match of content.matchAll(localPathRe)) {
    const ref = sanitizePathToken(String(match?.[0] ?? "").trim());
    if (ref) {
      localPaths.push(ref);
    }
  }

  const quotedImageNameRe = /[`"'“”‘’]([^`"'“”‘’\/\\]+?\.(?:png|jpe?g|webp|gif|bmp|svg))[`"'“”‘’]/gi;
  for (const match of content.matchAll(quotedImageNameRe)) {
    const name = sanitizePathToken(String(match?.[1] ?? ""));
    if (name) {
      fileNames.push(name);
    }
  }

  const bareImageNameRe = /(?:^|[\s，。；;:!?])([^\s"'`/\\]+?\.(?:png|jpe?g|webp|gif|bmp|svg))(?=$|[\s，。；;:!?])/gi;
  for (const match of content.matchAll(bareImageNameRe)) {
    const name = sanitizePathToken(String(match?.[1] ?? ""));
    if (name) {
      fileNames.push(name);
    }
  }

  const absPathTokenRe = /\/[^\s"'`]+/g;
  for (const match of content.matchAll(absPathTokenRe)) {
    const token = sanitizePathToken(String(match?.[0] ?? ""));
    if (!token || !token.startsWith("/")) {
      continue;
    }
    if (isSupportedImagePath(token)) {
      localPaths.push(token);
      continue;
    }
    directories.push(token);
  }

  return {
    localPaths: uniqueStrings(localPaths),
    remoteUrls: uniqueStrings(remoteUrls),
    fileNames: uniqueStrings(fileNames),
    directories: uniqueStrings(directories),
  };
}

function buildInboundImagePath(messageId, imageKey) {
  const safeMid = String(messageId ?? "mid").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "mid";
  const safeKey = String(imageKey ?? "img").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "img";
  const random = crypto.randomBytes(3).toString("hex");
  return path.join(getRunDir(), "inbound-images", `${safeMid}-${safeKey}-${random}.img`);
}

function isThreadNotFoundError(err) {
  const msg = String(err?.message ?? "").toLowerCase();
  if (msg.includes("thread not found") || msg.includes("thread_not_found")) {
    return true;
  }
  if (err?.data) {
    const dataText = String(JSON.stringify(err.data)).toLowerCase();
    if (dataText.includes("thread not found") || dataText.includes("thread_not_found")) {
      return true;
    }
  }
  return false;
}

function isAppServerExitError(err) {
  const msg = String(err?.message ?? "").toLowerCase();
  return msg.includes("app-server exited while waiting for response");
}

function isPrivateChatType(chatType) {
  const value = String(chatType ?? "").toLowerCase();
  return value === "p2p" || value === "single";
}

function findFirstValueByKeys(source, keys, validator, maxDepth = 5) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const keySet = new Set(keys);
  const queue = [{ value: source, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !current.value || typeof current.value !== "object") {
      continue;
    }
    const obj = current.value;
    for (const [key, value] of Object.entries(obj)) {
      if (keySet.has(key) && validator(value)) {
        return value;
      }
      if (current.depth < maxDepth && value && typeof value === "object") {
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function extractThreadHints(params) {
  const model = findFirstValueByKeys(
    params,
    ["model", "model_name", "modelName", "model_slug"],
    (value) => typeof value === "string" && value.length > 0 && value.length < 128,
  );
  const cwd = findFirstValueByKeys(
    params,
    ["cwd", "working_directory", "workingDirectory", "current_working_directory"],
    (value) => typeof value === "string" && value.startsWith("/"),
  );
  const progressRaw = findFirstValueByKeys(
    params,
    ["progress", "progress_percent", "percent", "percentage"],
    (value) => typeof value === "number" && Number.isFinite(value),
  );
  let progress = null;
  if (typeof progressRaw === "number") {
    progress = progressRaw <= 1 ? progressRaw * 100 : progressRaw;
    progress = Math.max(0, Math.min(100, progress));
  }
  return { model: model ?? null, cwd: cwd ?? null, progress };
}

function normalizeOneLineText(value, maxLen = 140) {
  if (typeof value !== "string") {
    return null;
  }
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) {
    return null;
  }
  const clipped = compact.length > maxLen ? `${compact.slice(0, maxLen - 1)}…` : compact;
  return clipped.replace(/[`]/g, "'");
}

function normalizeCwdHint(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) {
    return null;
  }
  if (!path.isAbsolute(trimmed)) {
    return null;
  }
  const normalized = path.normalize(trimmed);
  try {
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return normalized;
}

function expandUserHome(input) {
  if (typeof input !== "string" || !input) {
    return input;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (!home) {
    return input;
  }
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

function resolveCwdInput(rawInput, baseCwd = null) {
  if (typeof rawInput !== "string" || !rawInput.trim()) {
    return { ok: false, error: "目录不能为空" };
  }
  const expanded = expandUserHome(rawInput.trim());
  const base = normalizeCwdHint(baseCwd) ?? process.cwd();
  const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
  const normalized = normalizeCwdHint(candidate);
  if (!normalized) {
    return { ok: false, error: `目录不存在或不可用: ${candidate}` };
  }
  return { ok: true, cwd: normalized };
}

function asHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const text = value.trim();
  if (!/^https?:\/\//i.test(text)) {
    return null;
  }
  try {
    const parsed = new URL(text);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function formatSearchReference(params) {
  const urlValue = findFirstValueByKeys(
    params,
    [
      "url",
      "link",
      "href",
      "result_url",
      "source_url",
      "target_url",
      "canonical_url",
      "web_url",
      "uri",
    ],
    (value) => typeof value === "string" && value.length < 2048,
  );
  const queryValue = findFirstValueByKeys(
    params,
    ["query", "search_query", "searchQuery", "q", "keyword", "keywords", "term"],
    (value) => typeof value === "string" && value.length < 512,
  );
  const url = asHttpUrl(urlValue);
  const query = normalizeOneLineText(queryValue, 80);
  if (url) {
    let hostLabel = "链接";
    try {
      hostLabel = new URL(url).host;
    } catch {
      // keep default label
    }
    const prefix = query ? `${query} @ ` : "";
    return `[${prefix}${hostLabel}](${url})`;
  }
  if (query) {
    return `\`${query}\``;
  }
  return null;
}

function parseQuotedTomlString(text, key) {
  if (!text || typeof text !== "string") {
    return null;
  }
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"(.*?)"\\s*$`, "m");
  const match = text.match(re);
  if (!match || !match[1]) {
    return null;
  }
  return match[1];
}

async function loadConfiguredModelHint() {
  try {
    const tomlText = await readTextIfExists(getCodexConfigPath());
    const fromToml = parseQuotedTomlString(tomlText, "model");
    if (fromToml) {
      return fromToml;
    }
  } catch {
    // ignore and fallback to json
  }

  try {
    const configJsonPath = path.join(getCodexHome(), "config.json");
    const json = await readJsonIfExists(configJsonPath);
    const candidates = [json?.model, json?.model_name, json?.default_model, json?.default?.model];
    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  } catch {
    // ignore json parse/read errors
  }

  return null;
}

function formatSeconds(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

function formatShanghaiHM(dateMs) {
  if (!Number.isFinite(dateMs) || dateMs <= 0) {
    return "-";
  }
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(dateMs));
  } catch {
    return "-";
  }
}

function formatThreadShortId(threadId) {
  const raw = String(threadId ?? "");
  if (!raw) {
    return "(unknown)";
  }
  if (raw.length <= 14) {
    return raw;
  }
  return `${raw.slice(0, 8)}…${raw.slice(-4)}`;
}

function listSwitchableThreads(state, chatId) {
  const binding = chatId ? state.bindings?.[chatId] ?? null : null;
  const activeId = binding?.active_thread_id ?? state.active_thread_id ?? null;
  const ids = new Set();
  if (activeId) {
    ids.add(activeId);
  }
  for (const tid of Object.keys(state.thread_buffers ?? {})) {
    if (tid) {
      ids.add(tid);
    }
  }
  for (const tid of Object.keys(state.thread_titles ?? {})) {
    if (tid) {
      ids.add(tid);
    }
  }
  const items = [...ids].map((threadId) => {
    const buffer = state.thread_buffers?.[threadId] ?? null;
    const title = state.thread_titles?.[threadId] ?? null;
    const updatedAt = Number(buffer?.last_update_at ?? 0) || 0;
    const cwd = normalizeCwdHint(buffer?.last_cwd ?? null);
    return {
      thread_id: threadId,
      active: threadId === activeId,
      title,
      updated_at: updatedAt,
      cwd,
    };
  });
  items.sort((a, b) => {
    if (a.active && !b.active) {
      return -1;
    }
    if (!a.active && b.active) {
      return 1;
    }
    return (b.updated_at ?? 0) - (a.updated_at ?? 0);
  });
  return items;
}

function formatThreadListForFeishu(items) {
  if (!items || items.length === 0) {
    return "当前没有可切换的会话。";
  }
  const lines = ["会话列表（回复 `/sw 序号` 切换）："];
  let idx = 1;
  for (const item of items.slice(0, 30)) {
    const mark = item.active ? "⭐" : " ";
    const shortId = formatThreadShortId(item.thread_id);
    const updated = formatShanghaiHM(item.updated_at);
    lines.push(`${idx}. ${mark} ${shortId}  更新 ${updated}`);
    if (item.cwd) {
      lines.push(`   目录: ${item.cwd}`);
    }
    idx += 1;
  }
  if (items.length > 30) {
    lines.push(`... 还有 ${items.length - 30} 个会话`);
  }
  return lines.join("\n");
}

function parseTimestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function toAppThreadListItem(thread, activeThreadId = null) {
  if (!thread || typeof thread !== "object") {
    return null;
  }
  const threadId = typeof thread.id === "string" ? thread.id : null;
  if (!threadId) {
    return null;
  }
  return {
    thread_id: threadId,
    active: threadId === activeThreadId,
    title: typeof thread.name === "string" && thread.name.trim() ? thread.name.trim() : null,
    updated_at: parseTimestampMs(thread.updatedAt ?? null),
    cwd: normalizeCwdHint(thread.cwd ?? null),
  };
}

function formatModelListForFeishu(items = [], currentModel = null) {
  if (!Array.isArray(items) || items.length === 0) {
    return currentModel ? `当前模型：${currentModel}` : "当前未获取到模型列表。";
  }
  const lines = [];
  if (currentModel) {
    lines.push(`当前模型：${currentModel}`);
  }
  lines.push("可用模型：");
  let idx = 1;
  for (const item of items.slice(0, 30)) {
    const modelId = typeof item?.id === "string" ? item.id : null;
    if (!modelId) {
      continue;
    }
    const displayName =
      typeof item?.displayName === "string" && item.displayName.trim()
        ? item.displayName.trim()
        : null;
    const isDefault = Boolean(item?.isDefault);
    const marker = modelId === currentModel ? "⭐" : isDefault ? "•" : " ";
    lines.push(`${idx}. ${marker} ${modelId}${displayName && displayName !== modelId ? ` (${displayName})` : ""}`);
    idx += 1;
  }
  return lines.join("\n");
}

function buildBindingRecord(existing, patch = {}) {
  const merged = {
    ...(existing ?? {}),
    ...(patch ?? {}),
  };
  const planMode = normalizePlanMode(merged.plan_mode);
  merged.plan_mode = planMode === true;
  const approval = normalizeApprovalPolicy(merged.approval_policy);
  merged.approval_policy = approval ?? null;
  const sandbox = normalizeSandboxMode(merged.sandbox_mode);
  merged.sandbox_mode = sandbox ?? null;
  if (typeof merged.preferred_model !== "string" || !merged.preferred_model.trim()) {
    merged.preferred_model = null;
  } else {
    merged.preferred_model = merged.preferred_model.trim();
  }
  return merged;
}

function progressTipOf(startedAt, now = Date.now()) {
  if (!Array.isArray(PROGRESS_TIPS) || PROGRESS_TIPS.length === 0) {
    return null;
  }
  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return {
      tip: PROGRESS_TIPS[0],
      idx: 0,
      total: PROGRESS_TIPS.length,
      next_in_ms: PROGRESS_TIP_ROTATE_MS,
    };
  }
  const elapsed = Math.max(0, now - startedAt);
  const idx = Math.floor(elapsed / PROGRESS_TIP_ROTATE_MS) % PROGRESS_TIPS.length;
  const nextIn = PROGRESS_TIP_ROTATE_MS - (elapsed % PROGRESS_TIP_ROTATE_MS);
  return {
    tip: PROGRESS_TIPS[idx] ?? PROGRESS_TIPS[0],
    idx,
    total: PROGRESS_TIPS.length,
    next_in_ms: nextIn,
  };
}

function completionFooter(threadId, status, buffer, defaultModel = null) {
  const lines = [];
  lines.push(`✅ 已完成${status ? `（${status}）` : ""}`);
  const model = buffer?.last_model ?? defaultModel ?? null;
  if (model) {
    lines.push(`- \`${model}\``);
  }
  if (typeof buffer?.last_progress === "number") {
    lines.push(`- 进度 ${buffer.last_progress.toFixed(0)}%`);
  }
  const firstTokenText = formatSeconds(buffer?.first_token_ms);
  if (firstTokenText) {
    lines.push(`- 首字用时 ${firstTokenText}`);
  }
  if (buffer?.last_cwd) {
    lines.push(`- 目录 \`${buffer.last_cwd}\``);
  }
  if (threadId) {
    lines.push(`- 会话ID ${threadId}`);
  }
  return lines.join("\n");
}

function ensureThreadBuffer(state, threadId) {
  if (!threadId) {
    return null;
  }
  if (!state.thread_buffers[threadId]) {
    state.thread_buffers[threadId] = {
      assistant_text: "",
      command_output: "",
      file_change_output: "",
      last_turn_id: null,
      last_turn_status: null,
      last_model: null,
      last_progress: null,
      last_cwd: null,
      turn_started_at: null,
      first_token_at: null,
      first_token_ms: null,
      current_turn_id: null,
      last_update_at: Date.now(),
    };
  }
  return state.thread_buffers[threadId];
}

function pruneExpiredBindCodes(state) {
  const now = Date.now();
  for (const [code, info] of Object.entries(state.pending_bind_codes)) {
    if (!info || typeof info !== "object") {
      delete state.pending_bind_codes[code];
      continue;
    }
    if (typeof info.expires_at === "number" && info.expires_at < now) {
      delete state.pending_bind_codes[code];
    }
  }
}

function pickLatestValidBindCode(state) {
  const now = Date.now();
  let picked = null;
  for (const [code, info] of Object.entries(state.pending_bind_codes ?? {})) {
    if (!info || typeof info !== "object") {
      continue;
    }
    if (typeof info.expires_at === "number" && info.expires_at < now) {
      continue;
    }
    if (!picked || (info.created_at ?? 0) > (picked.created_at ?? 0)) {
      picked = { code, created_at: info.created_at ?? 0 };
    }
  }
  return picked?.code ?? null;
}

function getValidBindCodeInfo(state, code) {
  if (!code) {
    return null;
  }
  const info = state.pending_bind_codes?.[code];
  if (!info || typeof info !== "object") {
    return null;
  }
  if (typeof info.expires_at === "number" && info.expires_at < Date.now()) {
    return null;
  }
  return info;
}

function pickValidBindCodeForChat(state, chatId) {
  if (!chatId) {
    return null;
  }
  const now = Date.now();
  let picked = null;
  for (const [code, info] of Object.entries(state.pending_bind_codes ?? {})) {
    if (!info || typeof info !== "object") {
      continue;
    }
    if (info.chat_id !== chatId) {
      continue;
    }
    if (typeof info.expires_at === "number" && info.expires_at < now) {
      continue;
    }
    if (!picked || (info.created_at ?? 0) > (picked.created_at ?? 0)) {
      picked = { code, created_at: info.created_at ?? 0 };
    }
  }
  return picked?.code ?? null;
}

function pickReusableGlobalBindCode(state, options = {}) {
  const now = Date.now();
  const purpose = options.purpose ?? null;
  const cwdHint = normalizeCwdHint(options.cwdHint ?? null);
  const threadIdHint = options.threadIdHint ?? null;
  const maxAgeMs = Number.isFinite(options.maxAgeMs) ? Math.max(0, options.maxAgeMs) : 90_000;
  let picked = null;
  for (const [code, info] of Object.entries(state.pending_bind_codes ?? {})) {
    if (!info || typeof info !== "object") {
      continue;
    }
    if (info.chat_id) {
      continue;
    }
    if (typeof info.expires_at === "number" && info.expires_at < now) {
      continue;
    }
    const createdAt = typeof info.created_at === "number" ? info.created_at : 0;
    if (now - createdAt > maxAgeMs) {
      continue;
    }
    const samePurpose = (info.purpose ?? null) === purpose;
    if (!samePurpose) {
      continue;
    }
    const existingCwd = normalizeCwdHint(info.cwd_hint ?? null);
    const sameCwd = (existingCwd ?? null) === (cwdHint ?? null);
    if (!sameCwd) {
      continue;
    }
    const sameThread = (info.thread_id_hint ?? null) === (threadIdHint ?? null);
    if (!sameThread) {
      continue;
    }
    if (!picked || createdAt > picked.created_at) {
      picked = { code, created_at: createdAt };
    }
  }
  return picked?.code ?? null;
}

function pickPendingBindInfoForChat(state, chatId) {
  const code = pickValidBindCodeForChat(state, chatId);
  if (!code) {
    return null;
  }
  const info = getValidBindCodeInfo(state, code);
  if (!info) {
    return null;
  }
  return { code, info };
}

function pickLatestGlobalBindHint(state) {
  const now = Date.now();
  let picked = null;
  for (const [code, info] of Object.entries(state.pending_bind_codes ?? {})) {
    if (!info || typeof info !== "object") {
      continue;
    }
    if (info.chat_id) {
      continue;
    }
    if (typeof info.expires_at === "number" && info.expires_at < now) {
      continue;
    }
    const cwdHint = normalizeCwdHint(info.cwd_hint ?? null);
    if (!cwdHint) {
      continue;
    }
    const createdAt = typeof info.created_at === "number" ? info.created_at : 0;
    if (!picked || createdAt > picked.created_at) {
      picked = {
        code,
        cwd_hint: cwdHint,
        thread_id_hint: info.thread_id_hint ?? null,
        created_at: createdAt,
      };
    }
  }
  return picked;
}

async function ensureBindCodeForChat(store, chatId, options = {}) {
  let out = null;
  await store.mutate((state) => {
    pruneExpiredBindCodes(state);
    let code = pickValidBindCodeForChat(state, chatId);
    let info = getValidBindCodeInfo(state, code);
    const fallbackCwdHint = normalizeCwdHint(options.cwdHint ?? state.last_qrcode_cwd ?? null);
    const fallbackThreadId = options.threadId ?? null;
    if (!code || !info) {
      code = createBindCode();
      const createdAt = Date.now();
      info = {
        created_at: createdAt,
        expires_at: createdAt + BIND_CODE_TTL_MS,
        purpose: "auto_unbound_prompt",
        chat_id: chatId ?? null,
        cwd_hint: fallbackCwdHint,
        thread_id_hint: fallbackThreadId,
      };
      state.pending_bind_codes[code] = info;
      pushRecentEvent(state, {
        source: "daemon",
        type: "bind_code_created_auto",
        code,
      });
    } else if (fallbackCwdHint) {
      // Reuse existing chat-scoped code but keep cwd context aligned.
      const existingCwdHint = normalizeCwdHint(info.cwd_hint ?? null);
      if (!existingCwdHint || existingCwdHint !== fallbackCwdHint) {
        info.cwd_hint = fallbackCwdHint;
      }
    }
    if (fallbackThreadId && info.thread_id_hint !== fallbackThreadId) {
      info.thread_id_hint = fallbackThreadId;
    }
    out = {
      code,
      bindCommand: `/bind ${code}`,
      expiresAt: info.expires_at ?? null,
      cwdHint: normalizeCwdHint(info.cwd_hint ?? fallbackCwdHint),
      threadIdHint: info.thread_id_hint ?? fallbackThreadId ?? null,
    };
    return state;
  });
  return out;
}

function pickAutoBindHint(state, chatId) {
  const pendingBind = pickPendingBindInfoForChat(state, chatId);
  if (pendingBind) {
    return {
      code: pendingBind.code,
      cwdHint: normalizeCwdHint(pendingBind.info.cwd_hint ?? null),
      threadIdHint: pendingBind.info.thread_id_hint ?? null,
      source: "chat_scoped",
    };
  }
  const globalHint = pickLatestGlobalBindHint(state);
  if (globalHint) {
    return {
      code: globalHint.code,
      cwdHint: normalizeCwdHint(globalHint.cwd_hint ?? null),
      threadIdHint: globalHint.thread_id_hint ?? null,
      source: "global",
    };
  }
  return null;
}

function resolveTurnContext(snapshot, chatId, params = {}) {
  const binding = chatId ? snapshot.bindings?.[chatId] ?? null : null;
  const explicitThreadId = params?.thread_id ?? params?.threadId ?? null;
  const explicitCwd = normalizeCwdHint(params?.cwd ?? params?.cwd_hint ?? params?.cwdHint ?? null);
  let threadId = explicitThreadId;
  if (!threadId) {
    if (binding?.active_thread_id) {
      threadId = binding.active_thread_id;
    } else if (!chatId) {
      threadId = snapshot.active_thread_id ?? null;
    }
  }
  const threadBuffer = threadId ? snapshot.thread_buffers?.[threadId] ?? null : null;
  const cwd = normalizeCwdHint(
    explicitCwd ??
      binding?.active_cwd ??
      threadBuffer?.last_cwd ??
      snapshot.last_qrcode_cwd ??
      null,
  );
  return {
    binding,
    threadId: threadId ?? null,
    cwd,
  };
}

async function appendEvent(store, event) {
  await store.mutate((state) => {
    pushRecentEvent(state, event);
    return state;
  });
}

function statusFromState(state, appStatus, feishuStatus, pendingStatus) {
  return {
    daemon: {
      running: true,
      started_at: state.created_at,
      now: Date.now(),
    },
    app_server: appStatus,
    feishu: feishuStatus,
    pending: pendingStatus,
    active_thread_id: state.active_thread_id,
    bindings: Object.keys(state.bindings).length,
    pending_bind_codes: Object.keys(state.pending_bind_codes).length,
    recent_event_count: state.recent_events.length,
    latest_event: state.recent_events[state.recent_events.length - 1] ?? null,
  };
}

function pickInitialAppCwd(state, bridgeConfig) {
  const fromConfig = normalizeCwdHint(bridgeConfig?.codex_cwd ?? null);
  if (fromConfig) {
    return fromConfig;
  }
  const bindings = Object.values(state?.bindings ?? {});
  const activeThreadId = state?.active_thread_id ?? null;
  if (activeThreadId) {
    for (const binding of bindings) {
      if (binding?.active_thread_id === activeThreadId) {
        const candidate = normalizeCwdHint(binding?.active_cwd ?? null);
        if (candidate) {
          return candidate;
        }
      }
    }
  }
  for (const binding of bindings) {
    const candidate = normalizeCwdHint(binding?.active_cwd ?? null);
    if (candidate) {
      return candidate;
    }
  }
  return process.cwd();
}

function createFeishuRelay(store, feishu, appendEventFn, runtime = {}) {
  const buffers = new Map();
  const timers = new Map();
  const assistantStreams = new Map();
  const terminalCards = new Map();
  const progressCards = new Map();
  const progressTimers = new Map();
  const FLUSH_MS = 1200;
  const PROGRESS_FLUSH_MS = 900;
  const TERMINAL_CARD_KEEP_CHARS = 9000;
  const inboundImageDir = path.join(getRunDir(), "inbound-images");
  const outboundImageDir = path.join(getRunDir(), "outbound-images");
  const AUTO_FORWARD_IMAGE_LIMIT = 20;

  const keyOf = (threadId, kind) => `${threadId}::${kind}`;

  const cardTitleOf = (kind) => {
    if (kind === "command") {
      return "终端输出";
    }
    if (kind === "file") {
      return "文件变更";
    }
    if (kind === "meta") {
      return "会话状态";
    }
    return "Codex 回复";
  };

  const toCardMarkdown = (kind, text) => {
    const body = normalizeReadableText(text);
    if (!body) {
      return "";
    }
    if (kind === "command") {
      const safeBody = body.replace(/```/g, "``\\`");
      return `**终端输出**\n\`\`\`\n${safeBody}\n\`\`\``;
    }
    if (kind === "file") {
      const safeBody = body.replace(/```/g, "``\\`");
      return `**文件变更**\n\`\`\`\n${safeBody}\n\`\`\``;
    }
    return body;
  };

  const terminalCardKeyOf = (chatId, threadId, kind) => `${chatId}::${threadId}::${kind}`;

  const ensureTerminalCardState = (chatId, threadId, kind) => {
    const key = terminalCardKeyOf(chatId, threadId, kind);
    let state = terminalCards.get(key);
    if (!state) {
      state = {
        chat_id: chatId,
        thread_id: threadId,
        kind,
        message_id: null,
        full_text: "",
        truncated: false,
        last_markdown: "",
        last_note: "",
      };
      terminalCards.set(key, state);
    }
    return state;
  };

  const updateTerminalCard = async (chatId, threadId, kind, payloadText) => {
    const state = ensureTerminalCardState(chatId, threadId, kind);
    state.full_text += payloadText;
    if (state.full_text.length > TERMINAL_CARD_KEEP_CHARS) {
      state.full_text = state.full_text.slice(-TERMINAL_CARD_KEEP_CHARS);
      state.truncated = true;
    }
    const markdown = toCardMarkdown(kind, state.full_text);
    if (!markdown) {
      return true;
    }
    const note = state.truncated
      ? `仅显示最近 ${TERMINAL_CARD_KEEP_CHARS} 个字符，较早内容已折叠。`
      : "";
    if (markdown === state.last_markdown && note === state.last_note) {
      return true;
    }
    const payload = {
      title: cardTitleOf(kind),
      markdown,
      template: "grey",
      note,
      updatable: true,
    };
    try {
      if (state.message_id) {
        await feishu.patchMarkdownCard(state.message_id, payload);
      } else {
        state.message_id = await feishu.sendMarkdownCard(chatId, payload);
      }
      state.last_markdown = markdown;
      state.last_note = note;
      return true;
    } catch (err) {
      try {
        state.message_id = await feishu.sendMarkdownCard(chatId, payload);
        state.last_markdown = markdown;
        state.last_note = note;
        return true;
      } catch (fallbackErr) {
        await appendEventFn({
          source: "feishu",
          type: "terminal_card_update_failed",
          chat_id: chatId,
          thread_id: threadId,
          kind,
          error: fallbackErr?.message ?? err?.message ?? String(fallbackErr ?? err),
        });
        return false;
      }
    }
  };

  const sendToThread = async (threadId, kind, payloadText) => {
    if (!feishu || !feishu.status().running) {
      return;
    }
    const chatIds = getBoundChatIdsForThread(store.snapshot(), threadId);
    if (chatIds.length === 0) {
      return;
    }
    const markdown = toCardMarkdown(kind, payloadText);
    const markdownChunks = splitMarkdownChunks(markdown);
    const textChunks = splitTextChunks(normalizeReadableText(payloadText));
    for (const chatId of chatIds) {
      if (kind === "assistant") {
        const streamKey = `${chatId}::${threadId}`;
        const stream = assistantStreams.get(streamKey) ?? { fullText: "" };
        stream.fullText += payloadText;
        assistantStreams.set(streamKey, stream);
        continue;
      }
      if (kind === "command" || kind === "file") {
        const updated = await updateTerminalCard(chatId, threadId, kind, payloadText);
        if (updated) {
          continue;
        }
      }
      if (markdownChunks.length > 0) {
        let cardFailed = false;
        for (const chunk of markdownChunks) {
          try {
            await feishu.sendMarkdownCard(chatId, {
              title: cardTitleOf(kind),
              markdown: chunk,
            });
          } catch (err) {
            cardFailed = true;
            await appendEventFn({
              source: "feishu",
              type: "send_card_failed",
              chat_id: chatId,
              error: err?.message ?? String(err),
            });
            break;
          }
        }
        if (!cardFailed) {
          continue;
        }
      }
      for (const chunk of textChunks) {
        try {
          const textPrefix = kind === "assistant" ? "" : `[${kind}] `;
          await feishu.sendText(chatId, `${textPrefix}${chunk}`);
        } catch (err) {
          await appendEventFn({
            source: "feishu",
            type: "send_failed",
            chat_id: chatId,
            error: err?.message ?? String(err),
          });
        }
      }
    }
  };

  const sendImageToThread = async (threadId, imagePath) => {
    if (!feishu || !feishu.status().running) {
      return;
    }
    if (!threadId || !imagePath) {
      return;
    }
    const resolvedPath = path.resolve(imagePath);
    if (resolvedPath.startsWith(path.resolve(inboundImageDir) + path.sep)) {
      return;
    }
    const chatIds = getBoundChatIdsForThread(store.snapshot(), threadId);
    if (chatIds.length === 0) {
      return;
    }
    for (const chatId of chatIds) {
      try {
        await feishu.sendImage(chatId, imagePath);
      } catch (err) {
        await appendEventFn({
          source: "feishu",
          type: "send_image_failed",
          chat_id: chatId,
          image_path: imagePath,
          error: err?.message ?? String(err),
        });
      }
    }
  };

  const downloadRemoteImage = async (urlText) => {
    const res = await fetch(urlText, {
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`download failed: ${res.status}`);
    }
    const contentType = res.headers.get("content-type") || "";
    const extFromUrl = (() => {
      try {
        const parsed = new URL(urlText);
        const ext = path.extname(parsed.pathname || "").toLowerCase();
        return ext && ext.length <= 6 ? ext : "";
      } catch {
        return "";
      }
    })();
    const ext = extFromUrl || guessExtFromContentType(contentType);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length === 0) {
      throw new Error("downloaded image is empty");
    }
    if (data.length > 12 * 1024 * 1024) {
      throw new Error("image too large (>12MB)");
    }
    await fsp.mkdir(outboundImageDir, { recursive: true });
    const filePath = path.join(
      outboundImageDir,
      `img-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${ext}`,
    );
    await fsp.writeFile(filePath, data);
    return filePath;
  };

  const tryForwardImageRefsFromText = async (threadId, text) => {
    if (!threadId || !text || !feishu || !feishu.status().running) {
      return;
    }
    const refs = extractImageRefsFromAssistantText(text);
    const localCandidates = [...refs.localPaths];
    if (refs.fileNames.length > 0) {
      const snapshot = store.snapshot();
      const threadCwd = normalizeCwdHint(snapshot.thread_buffers?.[threadId]?.last_cwd ?? null);
      const dirCandidates = uniqueStrings([
        ...(threadCwd ? [threadCwd] : []),
        ...refs.directories,
      ]);
      for (const dirPath of dirCandidates) {
        for (const name of refs.fileNames) {
          const candidate = sanitizePathToken(path.join(dirPath, name));
          if (!candidate || !candidate.startsWith("/") || !isSupportedImagePath(candidate)) {
            continue;
          }
          localCandidates.push(candidate);
        }
      }
    }
    const localCandidatesLimited = uniqueStrings(localCandidates).slice(0, AUTO_FORWARD_IMAGE_LIMIT);
    const remoteCandidates = refs.remoteUrls.slice(0, AUTO_FORWARD_IMAGE_LIMIT);

    for (const localPath of localCandidatesLimited) {
      try {
        if (!path.isAbsolute(localPath)) {
          continue;
        }
        await fsp.access(localPath, fs.constants.R_OK);
        await sendImageToThread(threadId, localPath);
        await appendEventFn({
          source: "feishu",
          type: "assistant_image_forwarded",
          thread_id: threadId,
          image_path: localPath,
          via: "assistant_text_local_path",
        });
      } catch (err) {
        await appendEventFn({
          source: "feishu",
          type: "assistant_image_forward_failed",
          thread_id: threadId,
          image_path: localPath,
          via: "assistant_text_local_path",
          error: err?.message ?? String(err),
        });
      }
    }

    for (const remoteUrl of remoteCandidates) {
      let tmpPath = null;
      try {
        tmpPath = await downloadRemoteImage(remoteUrl);
        await sendImageToThread(threadId, tmpPath);
        await appendEventFn({
          source: "feishu",
          type: "assistant_image_forwarded",
          thread_id: threadId,
          image_url: remoteUrl,
          via: "assistant_text_remote_url",
        });
      } catch (err) {
        await appendEventFn({
          source: "feishu",
          type: "assistant_image_forward_failed",
          thread_id: threadId,
          image_url: remoteUrl,
          via: "assistant_text_remote_url",
          error: err?.message ?? String(err),
        });
      } finally {
        if (tmpPath) {
          try {
            await fsp.unlink(tmpPath);
          } catch {
            // noop
          }
        }
      }
    }
  };

  const flushKey = async (key) => {
    const raw = buffers.get(key);
    buffers.delete(key);
    const timer = timers.get(key);
    if (timer) {
      clearTimeout(timer);
      timers.delete(key);
    }
    if (!raw || !raw.text) {
      return;
    }
    const [threadId, kind] = key.split("::");
    if (!raw.text) {
      return;
    }
    await sendToThread(threadId, kind, raw.text);
  };

  const queue = (threadId, kind, delta) => {
    if (!threadId || !delta) {
      return;
    }
    const key = keyOf(threadId, kind);
    const current = buffers.get(key) ?? { text: "" };
    current.text += delta;
    buffers.set(key, current);
    if (!timers.has(key)) {
      const timer = setTimeout(() => {
        void flushKey(key);
      }, kind === "assistant" ? 350 : FLUSH_MS);
      timers.set(key, timer);
    }
  };

  const flushThread = async (threadId) => {
    const keys = [...buffers.keys()].filter((key) => key.startsWith(`${threadId}::`));
    for (const key of keys) {
      await flushKey(key);
    }
  };

  const progressKeyOf = (chatId, threadId) => `${chatId}::${threadId}`;

  const ensureProgressState = (chatId, threadId) => {
    const key = progressKeyOf(chatId, threadId);
    let state = progressCards.get(key);
    if (!state) {
      state = {
        chat_id: chatId,
        thread_id: threadId,
        started_at: Date.now(),
        steps_started: 0,
        steps_completed: 0,
        searches_started: 0,
        searches_completed: 0,
        searches_active: 0,
        latest_search: null,
        first_token_seen: false,
        message_id: null,
        last_markdown: "",
      };
      progressCards.set(key, state);
    }
    return state;
  };

  const progressTemplateOf = (state) => {
    if (state.searches_active > 0) {
      return "orange";
    }
    if (state.first_token_seen) {
      return "blue";
    }
    return "wathet";
  };

  const progressMarkdownOf = (state) => {
    const now = Date.now();
    const lines = [];
    if (state.searches_active > 0) {
      lines.push("🔎 正在联网检索中…");
    } else if (state.first_token_seen) {
      lines.push("✍️ 正在输出答案…");
    } else {
      lines.push("🧠 正在分析与处理…");
    }
    if (state.steps_started > 0) {
      lines.push(`- 步骤 ${state.steps_completed}/${state.steps_started}`);
    }
    if (state.searches_started > 0) {
      lines.push(`- 搜索 ${state.searches_completed}/${state.searches_started}`);
    }
    if (state.latest_search) {
      lines.push(`- 最近检索 ${state.latest_search}`);
    }
    const elapsed = formatSeconds(now - state.started_at);
    if (elapsed) {
      lines.push(`- 已等待 ${elapsed}`);
    }
    if (state.thread_id) {
      lines.push(`- 会话ID ${state.thread_id}`);
    }
    if (!state.first_token_seen || state.searches_active > 0) {
      const tipState = progressTipOf(state.started_at, now);
      if (tipState?.tip) {
        lines.push("");
        lines.push("💡 **操作提示**");
        lines.push(`> ${tipState.tip}`);
      }
    }
    return lines.join("\n");
  };

  const flushProgressKey = async (key) => {
    progressTimers.delete(key);
    const state = progressCards.get(key);
    if (!state || !feishu || !feishu.status().running) {
      return;
    }
    const markdown = progressMarkdownOf(state);
    if (!markdown || markdown === state.last_markdown) {
      return;
    }
    const payload = {
      title: "会话状态",
      template: progressTemplateOf(state),
      markdown,
      updatable: true,
    };
    try {
      if (state.message_id) {
        await feishu.patchMarkdownCard(state.message_id, payload);
      } else {
        state.message_id = await feishu.sendMarkdownCard(state.chat_id, payload);
      }
      state.last_markdown = markdown;
    } catch (err) {
      try {
        state.message_id = await feishu.sendMarkdownCard(state.chat_id, payload);
        state.last_markdown = markdown;
      } catch (fallbackErr) {
        await appendEventFn({
          source: "feishu",
          type: "progress_card_update_failed",
          chat_id: state.chat_id,
          error: fallbackErr?.message ?? err?.message ?? String(fallbackErr ?? err),
        });
      }
    }

    if (progressCards.has(key)) {
      scheduleProgressFlush(key, PROGRESS_TICK_MS);
    }
  };

  const scheduleProgressFlush = (key, delayMs = PROGRESS_FLUSH_MS) => {
    if (progressTimers.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      void flushProgressKey(key);
    }, delayMs);
    progressTimers.set(key, timer);
  };

  const updateThreadProgress = (threadId, updater) => {
    if (!threadId || !feishu || !feishu.status().running) {
      return;
    }
    const chatIds = getBoundChatIdsForThread(store.snapshot(), threadId);
    for (const chatId of chatIds) {
      const state = ensureProgressState(chatId, threadId);
      updater(state);
      scheduleProgressFlush(progressKeyOf(chatId, threadId));
    }
  };

  const onTurnCompleted = async (threadId, status) => {
    if (!threadId) {
      return;
    }
    await flushThread(threadId);
    const snapshotAfterFlush = store.snapshot();
    const completionBuffer = snapshotAfterFlush.thread_buffers?.[threadId] ?? null;
    const relatedAssistantStreams = [...assistantStreams.entries()].filter(([key]) =>
      key.endsWith(`::${threadId}`),
    );
    let imageForwardSourceText = "";
    for (const [key, stream] of relatedAssistantStreams) {
      if (!stream?.fullText) {
        continue;
      }
      if (!imageForwardSourceText) {
        imageForwardSourceText = stream.fullText;
      }
      const [chatId] = key.split("::");
      const rendered = toCardMarkdown("assistant", stream.fullText);
      const oneShot = rendered.length > 12000 ? `${rendered.slice(0, 11900)}\n\n...(内容较长，已截断)` : rendered;
      let sent = false;
      try {
        await feishu.sendMarkdownCard(chatId, {
          title: cardTitleOf("assistant"),
          markdown: oneShot,
        });
        sent = true;
      } catch (err) {
        await appendEventFn({
          source: "feishu",
          type: "assistant_final_send_failed",
          chat_id: chatId,
          error: err?.message ?? String(err),
        });
      }
      if (!sent) {
        const fallback = splitTextChunks(normalizeReadableText(stream.fullText));
        for (const chunk of fallback) {
          try {
            await feishu.sendText(chatId, chunk);
          } catch {
            // noop
          }
        }
      }
    }
    const fallbackAssistantText =
      typeof completionBuffer?.assistant_text === "string" ? completionBuffer.assistant_text : "";
    const imageSourceText = imageForwardSourceText || fallbackAssistantText;
    if (imageSourceText) {
      await tryForwardImageRefsFromText(threadId, imageSourceText);
    }
    const buffer = completionBuffer;
    await sendToThread(
      threadId,
      "meta",
      completionFooter(threadId, status, buffer, runtime.defaultModel ?? null),
    );
    for (const key of [...assistantStreams.keys()]) {
      if (key.endsWith(`::${threadId}`)) {
        assistantStreams.delete(key);
      }
    }
    for (const key of [...terminalCards.keys()]) {
      if (key.includes(`::${threadId}::`)) {
        terminalCards.delete(key);
      }
    }
    for (const key of [...progressCards.keys()]) {
      if (key.endsWith(`::${threadId}`)) {
        const timer = progressTimers.get(key);
        if (timer) {
          clearTimeout(timer);
          progressTimers.delete(key);
        }
        progressCards.delete(key);
      }
    }
  };

  const shutdown = () => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    for (const timer of progressTimers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    progressTimers.clear();
    buffers.clear();
    assistantStreams.clear();
    terminalCards.clear();
    progressCards.clear();
  };

  return {
    queue,
    onTurnCompleted,
    onTurnQueued: (threadId) =>
      updateThreadProgress(threadId, () => {
        // ensure status card appears immediately, even before first stream delta
      }),
    onStepStarted: (threadId) =>
      updateThreadProgress(threadId, (state) => {
        state.steps_started += 1;
      }),
    onStepCompleted: (threadId) =>
      updateThreadProgress(threadId, (state) => {
        state.steps_completed += 1;
      }),
    onSearchStarted: (threadId, meta = {}) =>
      updateThreadProgress(threadId, (state) => {
        state.searches_started += 1;
        state.searches_active += 1;
        if (meta.search_ref) {
          state.latest_search = meta.search_ref;
        }
      }),
    onSearchCompleted: (threadId, meta = {}) =>
      updateThreadProgress(threadId, (state) => {
        state.searches_completed += 1;
        state.searches_active = Math.max(0, state.searches_active - 1);
        if (meta.search_ref) {
          state.latest_search = meta.search_ref;
        }
      }),
    onFirstToken: (threadId) =>
      updateThreadProgress(threadId, (state) => {
        if (!state.first_token_seen) {
          state.first_token_seen = true;
        }
      }),
    sendImage: sendImageToThread,
    shutdown,
  };
}

function createPendingId() {
  return `p_${crypto.randomBytes(4).toString("hex")}`;
}

function parseDecisionTokens(available) {
  if (!Array.isArray(available)) {
    return null;
  }
  const set = new Set();
  for (const item of available) {
    if (typeof item === "string") {
      set.add(item);
      continue;
    }
    if (item && typeof item === "object") {
      if (item.acceptWithExecpolicyAmendment) {
        set.add("acceptWithExecpolicyAmendment");
      }
      if (item.applyNetworkPolicyAmendment) {
        set.add("applyNetworkPolicyAmendment");
      }
    }
  }
  return set;
}

function autoAnswersForQuestions(questions) {
  const answers = {};
  for (const question of questions ?? []) {
    const option = Array.isArray(question.options) && question.options.length > 0
      ? question.options[0].label
      : "";
    answers[question.id] = {
      answers: [option],
    };
  }
  return answers;
}

function normalizeAnswerPayload(entry, raw) {
  const input = (raw ?? "").trim();
  if (!input) {
    throw new Error("answer text is required");
  }
  const questions = entry.params.questions ?? [];
  if (questions.length === 0) {
    return { answers: {} };
  }

  if (input.startsWith("{")) {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("answer JSON must be an object");
    }
    const answers = {};
    for (const [questionId, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) {
        answers[questionId] = {
          answers: value.map((v) => String(v)),
        };
      } else {
        answers[questionId] = {
          answers: [String(value)],
        };
      }
    }
    return { answers };
  }

  if (questions.length !== 1) {
    throw new Error("multiple questions: use JSON mapping, e.g. /answer <id> {\"q1\":\"...\"}");
  }

  return {
    answers: {
      [questions[0].id]: {
        answers: [input],
      },
    },
  };
}

class PendingCoordinator {
  constructor({ store, feishu, appendEventFn }) {
    this.store = store;
    this.feishu = feishu;
    this.appendEvent = appendEventFn;
    this.entries = new Map();
  }

  status() {
    return {
      count: this.entries.size,
      ids: [...this.entries.keys()],
    };
  }

  entryType(method) {
    if (method === "item/commandExecution/requestApproval") {
      return "command_approval";
    }
    if (method === "item/fileChange/requestApproval") {
      return "file_approval";
    }
    if (method === "item/tool/requestUserInput") {
      return "request_user_input";
    }
    return null;
  }

  defaultPayload(entry) {
    if (entry.type === "command_approval") {
      const available = parseDecisionTokens(entry.params.availableDecisions);
      if (available) {
        if (available.has("decline")) {
          return { decision: "decline" };
        }
        if (available.has("cancel")) {
          return { decision: "cancel" };
        }
      }
      return { decision: "decline" };
    }
    if (entry.type === "file_approval") {
      return { decision: "decline" };
    }
    return { answers: autoAnswersForQuestions(entry.params.questions ?? []) };
  }

  async persistSet(entry) {
    await this.store.mutate((state) => {
      state.pending_requests[entry.id] = {
        id: entry.id,
        type: entry.type,
        method: entry.method,
        thread_id: entry.thread_id,
        turn_id: entry.turn_id,
        item_id: entry.item_id,
        created_at: entry.created_at,
        expires_at: entry.expires_at,
      };
      return state;
    });
  }

  async persistDelete(id) {
    await this.store.mutate((state) => {
      delete state.pending_requests[id];
      return state;
    });
  }

  buildPrompt(entry) {
    if (entry.type === "command_approval") {
      const lines = [
        "[审批请求] command",
        `command: ${entry.params.command ?? "(unknown)"}`,
      ];
      if (entry.params.reason) {
        lines.push(`reason: ${entry.params.reason}`);
      }
      lines.push("");
      lines.push("回复数字即可：1 同意 | 2 拒绝 | 3 本会话同意");
      lines.push(`id: ${entry.id}`);
      lines.push(`thread: ${entry.thread_id ?? "unknown"}`);
      return lines.join("\n");
    }

    if (entry.type === "file_approval") {
      const lines = [
        "[审批请求] file",
      ];
      if (entry.params.reason) {
        lines.push(`reason: ${entry.params.reason}`);
      }
      if (entry.params.grantRoot) {
        lines.push(`grantRoot: ${entry.params.grantRoot}`);
      }
      lines.push("");
      lines.push("回复数字即可：1 同意 | 2 拒绝 | 3 本会话同意");
      lines.push(`id: ${entry.id}`);
      lines.push(`thread: ${entry.thread_id ?? "unknown"}`);
      return lines.join("\n");
    }

    const questions = entry.params.questions ?? [];
    const lines = [
      "[输入请求] request_user_input",
      `id: ${entry.id}`,
      `thread: ${entry.thread_id ?? "unknown"}`,
      "",
      "问题:",
    ];
    for (const question of questions) {
      lines.push(`- ${question.id}: ${question.question}`);
      if (Array.isArray(question.options) && question.options.length > 0) {
        lines.push(`  options: ${question.options.map((o) => o.label).join(" | ")}`);
      }
    }
    lines.push("");
    lines.push("单问题回复:");
    lines.push(`/answer ${entry.id} 你的答案`);
    lines.push("多问题回复(JSON):");
    lines.push(`/answer ${entry.id} {"q1":"a","q2":"b"}`);
    return lines.join("\n");
  }

  buildPromptCard(entry) {
    const threadId = entry.thread_id ?? "unknown";
    if (entry.type === "command_approval") {
      const commandRaw = String(entry.params.command ?? "(unknown)");
      const command = commandRaw.length > 1800 ? `${commandRaw.slice(0, 1799)}…` : commandRaw;
      const reason = normalizeOneLineText(entry.params.reason, 280);
      const lines = [
        "⚠️ 需要审批：命令执行",
        `- 命令`,
        `\`\`\`bash\n${command.replace(/```/g, "``\\`")}\n\`\`\``,
      ];
      if (reason) {
        lines.push(`- 原因：${reason}`);
      }
      lines.push("");
      lines.push("**请直接回复一个数字：**");
      lines.push("- `1` 同意（本次）");
      lines.push("- `2` 拒绝");
      lines.push("- `3` 本会话同意");
      lines.push("");
      lines.push("高级：`/approve`、`/deny`、`/approve <id> session`");
      lines.push(`- 请求ID \`${entry.id}\``);
      lines.push(`- 会话ID ${threadId}`);
      return {
        title: "审批请求",
        template: "orange",
        markdown: lines.join("\n"),
      };
    }

    if (entry.type === "file_approval") {
      const reason = normalizeOneLineText(entry.params.reason, 280);
      const grantRoot = normalizeOneLineText(entry.params.grantRoot, 240);
      const lines = [
        "⚠️ 需要审批：文件变更",
      ];
      if (reason) {
        lines.push(`- 原因：${reason}`);
      }
      if (grantRoot) {
        lines.push(`- 目录：\`${grantRoot}\``);
      }
      lines.push("");
      lines.push("**请直接回复一个数字：**");
      lines.push("- `1` 同意（本次）");
      lines.push("- `2` 拒绝");
      lines.push("- `3` 本会话同意");
      lines.push("");
      lines.push("高级：`/approve`、`/deny`、`/approve <id> session`");
      lines.push(`- 请求ID \`${entry.id}\``);
      lines.push(`- 会话ID ${threadId}`);
      return {
        title: "审批请求",
        template: "orange",
        markdown: lines.join("\n"),
      };
    }

    const questions = entry.params.questions ?? [];
    const lines = [
      "📝 需要输入：request_user_input",
      `- 请求ID \`${entry.id}\``,
      `- 会话ID ${threadId}`,
      "",
      "问题：",
    ];
    for (const question of questions) {
      const qid = normalizeOneLineText(String(question.id ?? ""), 64) || "q";
      const qtext = normalizeOneLineText(String(question.question ?? ""), 180) || "(empty)";
      lines.push(`- ${qid}: ${qtext}`);
      if (Array.isArray(question.options) && question.options.length > 0) {
        const opts = question.options
          .map((item) => normalizeOneLineText(String(item?.label ?? ""), 48))
          .filter(Boolean)
          .slice(0, 6);
        if (opts.length > 0) {
          lines.push(`  options: ${opts.join(" | ")}`);
        }
      }
    }
    lines.push("");
    lines.push("回复命令：");
    lines.push(`/answer ${entry.id} 你的答案`);
    lines.push(`/answer ${entry.id} {"q1":"a","q2":"b"}`);
    return {
      title: "输入请求",
      template: "blue",
      markdown: lines.join("\n"),
    };
  }

  async notifyFeishu(entry) {
    if (!this.feishu || !this.feishu.status().running) {
      return 0;
    }
    const chatIds = getBoundChatIdsForThread(this.store.snapshot(), entry.thread_id);
    if (chatIds.length === 0) {
      return 0;
    }
    const text = this.buildPrompt(entry);
    const card = this.buildPromptCard(entry);
    for (const chatId of chatIds) {
      try {
        await this.feishu.sendMarkdownCard(chatId, card);
      } catch {
        await this.feishu.sendText(chatId, text);
      }
    }
    return chatIds.length;
  }

  async finish(entry, payload, actor, meta = {}) {
    if (!entry || entry.done) {
      return { ok: false, reason: "already_resolved" };
    }
    entry.done = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    this.entries.delete(entry.id);
    await this.persistDelete(entry.id);

    await this.appendEvent({
      source: "pending",
      type: "resolved",
      pending_id: entry.id,
      pending_type: entry.type,
      actor,
      ...meta,
    });

    entry.resolve(payload);
    return { ok: true };
  }

  async createAndWait(msg) {
    const type = this.entryType(msg.method);
    if (!type) {
      throw new Error(`unsupported server request: ${msg.method}`);
    }

    const params = msg.params ?? {};
    const entry = {
      id: createPendingId(),
      type,
      method: msg.method,
      app_request_id: msg.id,
      params,
      thread_id: params.threadId ?? null,
      turn_id: params.turnId ?? null,
      item_id: params.itemId ?? null,
      created_at: Date.now(),
      expires_at: Date.now() + PENDING_TIMEOUT_MS,
      done: false,
      resolve: null,
      timer: null,
    };

    const waitPromise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    this.entries.set(entry.id, entry);
    await this.persistSet(entry);
    await this.appendEvent({
      source: "pending",
      type: "created",
      pending_id: entry.id,
      pending_type: entry.type,
      thread_id: entry.thread_id,
      turn_id: entry.turn_id,
      item_id: entry.item_id,
    });

    try {
      const sentCount = await this.notifyFeishu(entry);
      await this.appendEvent({
        source: "pending",
        type: "notified",
        pending_id: entry.id,
        target_count: sentCount,
      });
    } catch (err) {
      await this.appendEvent({
        source: "pending",
        type: "notify_failed",
        pending_id: entry.id,
        error: err?.message ?? String(err),
      });
    }

    entry.timer = setTimeout(() => {
      void (async () => {
        const payload = this.defaultPayload(entry);
        await this.finish(entry, payload, "timeout", {
          timeout_payload: payload,
        });
        await this.notifyTimeout(entry, payload);
      })();
    }, PENDING_TIMEOUT_MS);

    return waitPromise;
  }

  list(chatId = null) {
    const binding = chatId ? this.store.snapshot().bindings?.[chatId] : null;
    if (chatId && !binding) {
      return [];
    }
    const threadScope = binding?.active_thread_id ?? null;

    const items = [];
    for (const entry of this.entries.values()) {
      if (threadScope && entry.thread_id && entry.thread_id !== threadScope) {
        continue;
      }
      items.push({
        id: entry.id,
        type: entry.type,
        thread_id: entry.thread_id,
        turn_id: entry.turn_id,
        item_id: entry.item_id,
        created_at: entry.created_at,
        expires_at: entry.expires_at,
      });
    }
    return items.sort((a, b) => a.created_at - b.created_at);
  }

  async resolveCommandApproval(entry, mode) {
    let decision = "accept";
    if (mode === "session") {
      decision = "acceptForSession";
    } else if (mode === "deny" || mode === "decline") {
      decision = "decline";
    } else if (mode === "cancel") {
      decision = "cancel";
    }

    const available = parseDecisionTokens(entry.params.availableDecisions);
    if (available && !available.has(decision)) {
      if (decision === "acceptForSession" && available.has("accept")) {
        decision = "accept";
      } else {
        throw new Error(`decision not allowed: ${decision}`);
      }
    }

    return this.finish(entry, { decision }, "feishu", { decision });
  }

  async resolveFileApproval(entry, mode) {
    let decision = "accept";
    if (mode === "session") {
      decision = "acceptForSession";
    } else if (mode === "deny" || mode === "decline") {
      decision = "decline";
    } else if (mode === "cancel") {
      decision = "cancel";
    }
    return this.finish(entry, { decision }, "feishu", { decision });
  }

  async resolveUserInput(entry, rawAnswer) {
    const payload = normalizeAnswerPayload(entry, rawAnswer);
    return this.finish(entry, payload, "feishu");
  }

  async resolveByCommand(pendingId, command, arg = "") {
    const entry = this.entries.get(pendingId);
    if (!entry) {
      return {
        ok: false,
        reply_text: `未找到待处理请求: ${pendingId}`,
      };
    }

    if (entry.type === "request_user_input") {
      if (command !== "answer") {
        return {
          ok: false,
          reply_text: `该请求需要 /answer ${pendingId} ...`,
        };
      }
      try {
        await this.resolveUserInput(entry, arg);
      } catch (err) {
        return {
          ok: false,
          reply_text: `回答失败: ${err?.message ?? String(err)}`,
        };
      }
      return {
        ok: true,
        reply_text: `已提交输入请求: ${pendingId}`,
      };
    }

    if (command === "answer") {
      return {
        ok: false,
        reply_text: `该请求不是输入请求，请用 /approve 或 /deny`,
      };
    }

    if (entry.type === "command_approval") {
      await this.resolveCommandApproval(entry, arg);
      const action = arg === "session" ? "本会话同意" : arg === "deny" || arg === "decline" ? "拒绝" : "同意";
      return {
        ok: true,
        reply_text: `已${action}审批（${pendingId}）`,
      };
    }

    if (entry.type === "file_approval") {
      await this.resolveFileApproval(entry, arg);
      const action = arg === "session" ? "本会话同意" : arg === "deny" || arg === "decline" ? "拒绝" : "同意";
      return {
        ok: true,
        reply_text: `已${action}文件审批（${pendingId}）`,
      };
    }

    return {
      ok: false,
      reply_text: `不支持的请求类型: ${entry.type}`,
    };
  }

  pickEntryByIndex(chatId, index1Based) {
    const list = this.list(chatId);
    if (!Number.isFinite(index1Based) || index1Based <= 0) {
      return null;
    }
    const idx = Math.floor(index1Based) - 1;
    if (idx < 0 || idx >= list.length) {
      return null;
    }
    const item = list[idx];
    if (!item?.id) {
      return null;
    }
    return this.entries.get(item.id) ?? null;
  }

  pickLatestEntryForChat(chatId, command) {
    const list = this.list(chatId);
    if (!list || list.length === 0) {
      return null;
    }
    const ordered = [...list].reverse();
    if (command === "answer") {
      const inputEntry = ordered.find((item) => item.type === "request_user_input");
      if (!inputEntry?.id) {
        return null;
      }
      return this.entries.get(inputEntry.id) ?? null;
    }
    const approvalEntry = ordered.find((item) => item.type !== "request_user_input");
    if (!approvalEntry?.id) {
      return null;
    }
    return this.entries.get(approvalEntry.id) ?? null;
  }

  hasApprovalForChat(chatId) {
    const entry = this.pickLatestEntryForChat(chatId, "approve");
    return Boolean(entry);
  }

  async resolveAuto(chatId, command, arg = "") {
    const entry = this.pickLatestEntryForChat(chatId, command);
    if (!entry) {
      return {
        ok: false,
        reply_text: "当前会话没有可处理的审批请求。可发送 /pending 查看列表。",
      };
    }
    const result = await this.resolveByCommand(entry.id, command, arg);
    if (!result?.ok) {
      return result;
    }
    return {
      ...result,
      reply_text: `${result.reply_text}（已自动匹配当前会话最新请求）`,
    };
  }

  async notifyTimeout(entry, payload) {
    if (!this.feishu || !this.feishu.status().running) {
      return;
    }
    const chatIds = getBoundChatIdsForThread(this.store.snapshot(), entry.thread_id);
    if (!chatIds || chatIds.length === 0) {
      return;
    }
    let markdown = `⏱️ 请求超时，已执行默认处理。\n- 请求ID \`${entry.id}\``;
    if (entry.type === "request_user_input") {
      markdown = `⏱️ 输入请求超时，已自动选择默认选项（第一个）。\n- 请求ID \`${entry.id}\``;
    } else {
      markdown =
        `⏱️ 审批请求超时，已自动处理。\n- 请求ID \`${entry.id}\`\n` +
        `- 默认结果 \`${JSON.stringify(payload).replace(/`/g, "'")}\``;
    }
    for (const chatId of chatIds) {
      try {
        await this.feishu.sendMarkdownCard(chatId, {
          title: "审批结果",
          template: "orange",
          markdown,
        });
      } catch {
        // noop
      }
    }
  }

  async shutdown() {
    const entries = [...this.entries.values()];
    for (const entry of entries) {
      await this.finish(entry, this.defaultPayload(entry), "daemon_shutdown");
    }
  }
}

function formatPendingList(items) {
  if (!items || items.length === 0) {
    return "当前无待处理请求。";
  }
  const lines = ["待处理请求："];
  let index = 1;
  for (const item of items.slice(0, 20)) {
    lines.push(`${index}. ${item.id} | ${item.type} | thread=${item.thread_id ?? "unknown"}`);
    index += 1;
  }
  if (items.length > 20) {
    lines.push(`... 还有 ${items.length - 20} 条`);
  }
  lines.push("");
  lines.push("快捷：回复 1/2/3 处理当前会话最新审批；或 /approve <序号>。");
  return lines.join("\n");
}

function helpText() {
  return [
    "常用命令：",
    "/bind <CODE>  绑定当前飞书会话",
    "/rebind       解绑并生成新绑定码",
    "/status       查看当前会话状态",
    "/new          新建会话并切换",
    "/stop         停止当前生成",
    "/pending      查看待审批项",
    "/help         查看命令说明",
    "/group        查看群聊使用说明",
    "",
    "会话/目录：",
    "/resume [序号|会话ID]  恢复并切到指定会话",
    "/fork [序号|会话ID]    从指定会话 fork 新会话",
    "/threads                查看会话列表",
    "/sw <序号|会话ID>       切换会话",
    "/cwd                    查看目录",
    "/cwd <PATH>             切目录",
    "/cwd <PATH> new         切目录并新建会话",
    "",
    "能力桥接：",
    "/review [说明]                           发起代码审查",
    "/compact                                 压缩当前会话上下文",
    "/model [MODEL_ID|list|clear]            设置或查看模型",
    "/approvals [untrusted|on-failure|on-request|never]  设置审批策略",
    "/permissions [read-only|workspace-write|danger-full-access] 设置权限策略",
    "/plan [on|off|toggle]                    Plan 兼容模式开关",
    "/init                                    生成/补全 AGENTS.md",
    "/skills                                  查看已安装 skills",
    "/mcp [list|get|add|remove|login|logout] 调用原生 codex mcp",
    "",
    "图片草稿：/send 提交草稿图，/clear 清空草稿",
    "审批快捷：1(同意) / 2(拒绝) / 3(本会话同意)",
    "高级审批：/approve /deny /cancel /answer",
  ].join("\n");
}

function statusMarkdownFromText(text) {
  const body = normalizeReadableText(text);
  if (!body) {
    return "ok";
  }
  return body.replace(/```/g, "``\\`");
}

function clipText(text, maxChars = CLI_OUTPUT_MAX_CHARS) {
  if (typeof text !== "string") {
    return "";
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n...(输出过长，已截断)`;
}

function splitShellLikeArgs(raw) {
  if (!raw || typeof raw !== "string") {
    return [];
  }
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = null;
  while ((match = pattern.exec(raw)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return out.filter(Boolean);
}

function resolveCodexBin(bridgeConfig) {
  const configured = bridgeConfig && typeof bridgeConfig.codex_bin === "string"
    ? bridgeConfig.codex_bin.trim()
    : "";
  if (configured) {
    return configured;
  }
  const envBin = typeof process.env.CODEX_FEISHU_CODEX_BIN === "string"
    ? process.env.CODEX_FEISHU_CODEX_BIN.trim()
    : "";
  if (envBin) {
    return envBin;
  }
  const fallbackBin = typeof process.env.CODEX_BIN === "string" ? process.env.CODEX_BIN.trim() : "";
  return fallbackBin || "codex";
}

function normalizeApprovalPolicy(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (new Set(["untrusted", "on-failure", "on-request", "never"]).has(value)) {
    return value;
  }
  return null;
}

function normalizeSandboxMode(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === "read-only" || value === "readonly" || value === "ro") {
    return "read-only";
  }
  if (
    value === "workspace-write" ||
    value === "workspacewrite" ||
    value === "ww" ||
    value === "default"
  ) {
    return "workspace-write";
  }
  if (
    value === "danger-full-access" ||
    value === "dangerfullaccess" ||
    value === "danger" ||
    value === "full"
  ) {
    return "danger-full-access";
  }
  return null;
}

function sandboxPolicyFromMode(mode) {
  const normalized = normalizeSandboxMode(mode);
  if (!normalized) {
    return null;
  }
  if (normalized === "read-only") {
    return {
      type: "readOnly",
    };
  }
  if (normalized === "danger-full-access") {
    return {
      type: "dangerFullAccess",
    };
  }
  return {
    type: "workspaceWrite",
  };
}

function normalizePlanMode(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (new Set(["on", "true", "1", "enable", "enabled"]).has(value)) {
    return true;
  }
  if (new Set(["off", "false", "0", "disable", "disabled"]).has(value)) {
    return false;
  }
  if (value === "toggle") {
    return "toggle";
  }
  return null;
}

function applyPlanModeText(text, planModeEnabled) {
  if (!planModeEnabled || typeof text !== "string") {
    return text;
  }
  const body = text.trim();
  if (!body) {
    return text;
  }
  if (body.startsWith(PLAN_MODE_PREFIX)) {
    return text;
  }
  return `${PLAN_MODE_PREFIX}\n\n${text}`;
}

function deriveTurnOverrides(resolvedContext, params = {}) {
  const binding = resolvedContext?.binding ?? null;
  const explicitModel =
    typeof params?.model === "string" && params.model.trim() ? params.model.trim() : null;
  const preferredModel =
    explicitModel ??
    (typeof binding?.preferred_model === "string" && binding.preferred_model.trim()
      ? binding.preferred_model.trim()
      : null);
  const explicitApproval = normalizeApprovalPolicy(
    params?.approval_policy ?? params?.approvalPolicy ?? null,
  );
  const preferredApproval =
    explicitApproval ?? normalizeApprovalPolicy(binding?.approval_policy ?? null);
  const explicitSandboxMode = normalizeSandboxMode(
    params?.sandbox_mode ?? params?.sandboxMode ?? null,
  );
  const preferredSandboxMode =
    explicitSandboxMode ?? normalizeSandboxMode(binding?.sandbox_mode ?? null);
  const planModeInput = normalizePlanMode(params?.plan_mode ?? params?.planMode ?? null);
  let planModeEnabled = Boolean(binding?.plan_mode);
  if (planModeInput === true) {
    planModeEnabled = true;
  } else if (planModeInput === false) {
    planModeEnabled = false;
  }
  return {
    model: preferredModel,
    approvalPolicy: preferredApproval,
    sandboxMode: preferredSandboxMode,
    sandboxPolicy: sandboxPolicyFromMode(preferredSandboxMode),
    planModeEnabled,
  };
}

async function callAppServerApi(app, method, params = {}, timeoutMs = APP_RPC_TIMEOUT_MS) {
  await app.ensureStarted();
  try {
    const result = await app.request(method, params, timeoutMs);
    return { ok: true, result };
  } catch (err) {
    const message = String(err?.message ?? err ?? "");
    const lower = message.toLowerCase();
    if (
      lower.includes("unsupported in proto mode") ||
      lower.includes("method not found") ||
      lower.includes("not implemented")
    ) {
      return {
        ok: false,
        unsupported: true,
        error: message,
      };
    }
    throw err;
  }
}

function runExecFileCapture(file, args, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : CLI_CAPTURE_TIMEOUT_MS;
  const cwd = options.cwd || process.cwd();
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        env: process.env,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: CLI_CAPTURE_MAX_BUFFER,
      },
      (err, stdout, stderr) => {
        const out = typeof stdout === "string" ? stdout : "";
        const errText = typeof stderr === "string" ? stderr : "";
        if (err) {
          resolve({
            ok: false,
            code: Number.isFinite(err.code) ? err.code : null,
            signal: err.signal ?? null,
            timedOut: Boolean(err.killed) && err.signal === "SIGTERM",
            message: err.message ?? String(err),
            stdout: out,
            stderr: errText,
          });
          return;
        }
        resolve({
          ok: true,
          code: 0,
          signal: null,
          timedOut: false,
          message: "",
          stdout: out,
          stderr: errText,
        });
      },
    );
  });
}

async function listInstalledSkills() {
  const root = path.join(getCodexHome(), "skills");
  const readDirNames = async (dir) => {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch (err) {
      if (err && typeof err === "object" && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
        return [];
      }
      throw err;
    }
  };

  const topLevel = await readDirNames(root);
  const userSkills = topLevel.filter((name) => name !== ".system" && !name.startsWith("."));
  const systemSkills = await readDirNames(path.join(root, ".system"));
  return { root, userSkills, systemSkills };
}

function groupUsageMarkdown() {
  return [
    "群聊使用说明：",
    "1. 先把机器人加入群聊。",
    "2. 在群里先发送：`/bind <CODE>` 完成绑定。",
    "3. 绑定后建议 `@机器人` 再提问（避免群消息策略拦截）。",
    "",
    "如果群里完全没响应：",
    "- 检查飞书应用是否开启了群聊消息接收。",
    "- 检查事件订阅里是否启用 `im.message.receive_v1`。",
    "- 检查机器人是否允许入群并可见。",
  ].join("\n");
}

function mapUserFacingError(err) {
  const raw = String(err?.message ?? err ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) {
    return "处理失败，请稍后重试。";
  }
  if (lower.includes("invalid_or_expired_code")) {
    return "绑定码无效或已过期。请发送 `/rebind` 获取新绑定码。";
  }
  if (lower.includes("feishu bridge not running")) {
    return "飞书桥接未就绪。请稍后重试；若持续失败，在终端执行 `codex-feishu init daemon`。";
  }
  if (isThreadNotFoundError(err)) {
    return "会话已失效，系统会自动恢复。请重发上一条消息。";
  }
  if (isAppServerExitError(err)) {
    return "Codex 后端连接中断，正在恢复。请稍后重试。";
  }
  if (lower.includes("pending coordinator unavailable")) {
    return "审批服务暂不可用，请稍后再试。";
  }
  if (lower.includes("decision not allowed")) {
    return "当前审批动作不可用。请发送 `/pending` 查看可处理项。";
  }
  if (lower.startsWith("unknown method:")) {
    return "该命令暂不支持。发送 `/help` 查看可用命令。";
  }
  return `处理失败：${statusMarkdownFromText(raw)}`;
}

async function startNewThread(store, app, title) {
  const response = await app.startThread({
    serviceName: "codex_feishu",
  });
  const threadId = response?.thread?.id;
  if (!threadId) {
    throw new Error("thread/start response missing thread.id");
  }
  await store.mutate((state) => {
    state.active_thread_id = threadId;
    if (title) {
      state.thread_titles[threadId] = title;
    }
    ensureThreadBuffer(state, threadId);
    pushRecentEvent(state, {
      source: "daemon",
      type: "thread_started",
      thread_id: threadId,
    });
    return state;
  });
  return { threadId, thread: response.thread };
}

async function ensureThread(store, app, threadId, options = {}) {
  if (threadId) {
    return threadId;
  }
  const preferGlobalActive = options.preferGlobalActive !== false;
  const state = store.snapshot();
  if (preferGlobalActive && state.active_thread_id) {
    return state.active_thread_id;
  }
  const created = await startNewThread(store, app, null);
  return created.threadId;
}

function buildTextInput(text) {
  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
  ];
}

function buildLocalImageInput(imagePath) {
  return [
    {
      type: "localImage",
      path: imagePath,
    },
  ];
}

function buildMixedInput(text, imagePaths = []) {
  const input = [];
  for (const imagePath of imagePaths) {
    if (typeof imagePath === "string" && imagePath) {
      input.push({
        type: "localImage",
        path: imagePath,
      });
    }
  }
  if (typeof text === "string" && text.trim()) {
    input.push({
      type: "text",
      text,
      text_elements: [],
    });
  }
  return input;
}

async function startTurnWithAutoRecoverInput(store, app, threadId, input, chatId, turnParams = {}) {
  const firstThreadId = await ensureThread(store, app, threadId, {
    preferGlobalActive: !chatId,
  });
  try {
    const turnResponse = await app.startTurn(firstThreadId, input, turnParams);
    const effectiveThreadId = turnResponse?.thread?.id ?? firstThreadId;
    return {
      threadId: effectiveThreadId,
      turnResponse,
      recovered: false,
      recoveredFromThreadId: null,
    };
  } catch (err) {
    if (isAppServerExitError(err)) {
      const turnResponse = await app.startTurn(firstThreadId, input, turnParams);
      const effectiveThreadId = turnResponse?.thread?.id ?? firstThreadId;
      await appendEvent(store, {
        source: "daemon",
        type: "app_server_auto_retried",
        chat_id: chatId ?? null,
        thread_id: effectiveThreadId,
        reason: err?.message ?? String(err),
      });
      return {
        threadId: effectiveThreadId,
        turnResponse,
        recovered: false,
        recoveredFromThreadId: null,
      };
    }
    if (!isThreadNotFoundError(err)) {
      throw err;
    }
    const created = await startNewThread(store, app, null);
    const turnResponse = await app.startTurn(created.threadId, input, turnParams);
    await appendEvent(store, {
      source: "daemon",
      type: "thread_auto_recovered",
      chat_id: chatId ?? null,
      recovered_from_thread_id: firstThreadId,
      thread_id: created.threadId,
      reason: err?.message ?? String(err),
    });
    return {
      threadId: created.threadId,
      turnResponse,
      recovered: true,
      recoveredFromThreadId: firstThreadId,
    };
  }
}

async function startTurnWithAutoRecover(store, app, threadId, text, chatId, turnParams = {}) {
  return startTurnWithAutoRecoverInput(store, app, threadId, buildTextInput(text), chatId, turnParams);
}

function extractLocalImagePathsFromThreadItem(item) {
  if (!item || typeof item !== "object") {
    return [];
  }
  const out = [];
  if (item.type === "imageView" && typeof item.path === "string" && item.path) {
    out.push(item.path);
  }
  if (item.type === "userMessage" && Array.isArray(item.content)) {
    for (const part of item.content) {
      if (part?.type === "localImage" && typeof part.path === "string" && part.path) {
        out.push(part.path);
      }
    }
  }
  return out;
}

async function handleAppNotification(store, msg, relay) {
  const method = msg.method;
  const params = msg.params ?? {};
  const threadId = pickThreadId(params);
  const turnId = pickTurnId(params);
  const methodText = String(method ?? "");
  const isWebSearchBegin = methodText.endsWith("web_search_begin");
  const isWebSearchEnd = methodText.endsWith("web_search_end");
  const searchRef = isWebSearchBegin || isWebSearchEnd ? formatSearchReference(params) : null;
  let sawFirstToken = false;

  await store.mutate((state) => {
    const event = pushRecentEvent(state, {
      source: "app_server",
      method,
      thread_id: threadId,
      turn_id: turnId,
    });

    if (threadId) {
      const buffer = ensureThreadBuffer(state, threadId);
      const hints = extractThreadHints(params);
      if (method === "item/agentMessage/delta") {
        buffer.assistant_text += params.delta ?? "";
        if (!buffer.first_token_at && typeof buffer.turn_started_at === "number") {
          buffer.first_token_at = Date.now();
          buffer.first_token_ms = Math.max(0, buffer.first_token_at - buffer.turn_started_at);
          sawFirstToken = true;
        }
      } else if (method === "item/commandExecution/outputDelta") {
        buffer.command_output += params.delta ?? "";
      } else if (method === "item/fileChange/outputDelta") {
        buffer.file_change_output += params.delta ?? "";
      } else if (method === "turn/completed") {
        buffer.last_turn_id = params?.turn?.id ?? turnId ?? null;
        buffer.last_turn_status = params?.turn?.status ?? null;
        buffer.current_turn_id = null;
      }
      if (hints.model) {
        buffer.last_model = hints.model;
      }
      if (hints.cwd) {
        buffer.last_cwd = hints.cwd;
      }
      if (typeof hints.progress === "number") {
        buffer.last_progress = hints.progress;
      }
      buffer.last_update_at = Date.now();
      state.active_thread_id = threadId;
      event.thread_id = threadId;
    }
    return state;
  });

  if (threadId && relay) {
    if (method === "item/agentMessage/delta" && typeof params.delta === "string") {
      relay.queue(threadId, "assistant", params.delta);
      if (sawFirstToken) {
        relay.onFirstToken(threadId);
      }
    } else if (method === "item/commandExecution/outputDelta" && typeof params.delta === "string") {
      relay.queue(threadId, "command", params.delta);
    } else if (method === "item/fileChange/outputDelta" && typeof params.delta === "string") {
      relay.queue(threadId, "file", params.delta);
    } else if (method === "item/started") {
      relay.onStepStarted(threadId);
    } else if (method === "item/completed") {
      relay.onStepCompleted(threadId);
      const imagePaths = extractLocalImagePathsFromThreadItem(params?.item);
      for (const imagePath of imagePaths) {
        await relay.sendImage(threadId, imagePath);
      }
    } else if (method === "turn/completed") {
      await relay.onTurnCompleted(threadId, params?.turn?.status ?? null);
    }
    if (isWebSearchBegin) {
      relay.onSearchStarted(threadId, { search_ref: searchRef });
    } else if (isWebSearchEnd) {
      relay.onSearchCompleted(threadId, { search_ref: searchRef });
    }
  } else if (relay && (isWebSearchBegin || isWebSearchEnd)) {
    const activeThreadId = store.snapshot().active_thread_id ?? null;
    if (activeThreadId) {
      if (isWebSearchBegin) {
        relay.onSearchStarted(activeThreadId, { search_ref: searchRef });
      } else if (isWebSearchEnd) {
        relay.onSearchCompleted(activeThreadId, { search_ref: searchRef });
      }
    }
  }
}

async function handleAppServerRequest(store, app, pending, msg) {
  const type = pending.entryType(msg.method);
  if (!type) {
    await appendEvent(store, {
      source: "app_server",
      type: "request_unhandled",
      method: msg.method,
    });
    app.respondError(msg.id, -32601, `Unhandled app-server request: ${msg.method}`);
    return;
  }

  try {
    const payload = await pending.createAndWait(msg);
    app.respond(msg.id, payload);
  } catch (err) {
    await appendEvent(store, {
      source: "app_server",
      type: "request_failed",
      method: msg.method,
      error: err?.message ?? String(err),
    });
    app.respondError(msg.id, -32000, err?.message ?? "request handling failed");
  }
}

async function handleRpcCall(store, app, method, params, ctx = {}) {
  const feishuStatus = ctx.feishu?.status?.() ?? {
    enabled: false,
    running: false,
    has_sdk: false,
    last_error: null,
  };
  const pendingStatus = ctx.pending?.status?.() ?? { count: 0, ids: [] };
  const runtime = ctx.runtime ?? {};

  if (method === "bridge/ping") {
    return {
      ok: true,
      ts: Date.now(),
      version: "0.1.0",
    };
  }

  if (method === "bridge/status" || method === "feishu/status") {
    return statusFromState(store.snapshot(), app.status(), feishuStatus, pendingStatus);
  }

  if (method === "feishu/qrcode") {
    const purpose = params?.purpose ?? null;
    const cwdHint = normalizeCwdHint(params?.cwd_hint ?? params?.cwdHint ?? null);
    const requestedThreadIdHint = params?.thread_id ?? params?.threadId ?? null;
    let code = null;
    const createdAt = Date.now();
    let expiresAt = createdAt + BIND_CODE_TTL_MS;
    let threadIdHint = requestedThreadIdHint ?? null;
    const botOpenId = (ctx.bridgeConfig?.bot_open_id ?? "").trim();
    const openChatLink = buildChatOpenLink(botOpenId);
    const qrcodeMode = openChatLink ? "open_chat_link" : "bind_command";
    let bindCommand = "";
    let reused = false;
    await store.mutate((state) => {
      pruneExpiredBindCodes(state);
      if (!threadIdHint) {
        threadIdHint = state.active_thread_id ?? null;
      }
      const reusableCode = pickReusableGlobalBindCode(state, {
        purpose,
        cwdHint,
        threadIdHint,
      });
      if (reusableCode) {
        const info = getValidBindCodeInfo(state, reusableCode);
        if (info) {
          code = reusableCode;
          expiresAt = info.expires_at ?? expiresAt;
          threadIdHint = info.thread_id_hint ?? threadIdHint ?? null;
          reused = true;
        }
      }
      if (!code) {
        code = createBindCode();
        state.pending_bind_codes[code] = {
          created_at: createdAt,
          expires_at: expiresAt,
          purpose,
          cwd_hint: cwdHint,
          thread_id_hint: threadIdHint,
        };
      }
      if (cwdHint) {
        state.last_qrcode_cwd = cwdHint;
      }
      pushRecentEvent(state, {
        source: "daemon",
        type: reused ? "bind_code_reused" : "bind_code_created",
        code,
      });
      return state;
    });
    bindCommand = `/bind ${code}`;
    const qrPayload = openChatLink ?? bindCommand;
    return {
      code,
      created_at: createdAt,
      expires_at: expiresAt,
      bot_open_id: botOpenId || null,
      qr_text: qrPayload,
      qrcode_mode: qrcodeMode,
      open_chat_link: openChatLink,
      bind_command_hint: bindCommand,
      reused,
      thread_id_hint: threadIdHint,
      reply_text: openChatLink
        ? `二维码会打开机器人会话，进入后发送：${bindCommand}`
        : `绑定码已生成：${code}\n请在飞书发送：${bindCommand}`,
    };
  }

  if (method === "feishu/bind") {
    const code = params?.code;
    const chatId = params?.chat_id || params?.chatId;
    const userId = params?.user_id || params?.userId;
    if (!code || !chatId) {
      throw new Error("feishu/bind requires code and chat_id");
    }

    await store.mutate((state) => {
      pruneExpiredBindCodes(state);
      const pendingCode = state.pending_bind_codes[code];
      if (!pendingCode) {
        throw new Error("invalid_or_expired_code");
      }
      const existed = state.bindings?.[chatId] ?? null;
      const activeCwd = normalizeCwdHint(
        pendingCode.cwd_hint ?? existed?.active_cwd ?? state.last_qrcode_cwd ?? null,
      );
      const activeThreadId =
        pendingCode.thread_id_hint ?? existed?.active_thread_id ?? null;
      state.bindings[chatId] = buildBindingRecord(existed, {
        chat_id: chatId,
        user_id: userId ?? existed?.user_id ?? null,
        bound_at: Date.now(),
        active_thread_id: activeThreadId,
        active_cwd: activeCwd,
      });
      delete state.pending_bind_codes[code];
      pushRecentEvent(state, {
        source: "daemon",
        type: "binding_completed",
        chat_id: chatId,
        thread_id: activeThreadId,
        cwd: activeCwd,
      });
      return state;
    });
    return {
      ok: true,
      reply_text: "绑定成功，飞书会话已接入当前 Codex。",
      reply_card: {
        title: "会话状态",
        template: "green",
        markdown: "✅ 绑定成功，飞书会话已接入当前 Codex。",
      },
    };
  }

  if (method === "feishu/new_thread") {
    const title = typeof params?.title === "string" ? params.title : null;
    const chatId = params?.chat_id || params?.chatId || null;
    const created = await startNewThread(store, app, title);
    if (chatId) {
      await store.mutate((state) => {
        if (state.bindings[chatId]) {
          state.bindings[chatId].active_thread_id = created.threadId;
          pushRecentEvent(state, {
            source: "daemon",
            type: "binding_thread_switched",
            chat_id: chatId,
            thread_id: created.threadId,
          });
        }
        return state;
      });
    }
    return {
      ok: true,
      thread_id: created.threadId,
      reply_text: `已创建新会话：${created.threadId}`,
      reply_card: {
        title: "会话状态",
        template: "green",
        markdown: `🆕 已创建新会话\n- 会话ID ${created.threadId}`,
      },
    };
  }

  if (method === "feishu/threads") {
    const chatId = params?.chat_id || params?.chatId || null;
    if (!chatId) {
      throw new Error("feishu/threads requires chat_id");
    }
    const snapshot = store.snapshot();
    const binding = snapshot.bindings?.[chatId] ?? null;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先完成绑定后再查看会话列表。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先完成绑定后再查看会话列表。",
        },
      };
    }
    const items = listSwitchableThreads(snapshot, chatId);
    const text = formatThreadListForFeishu(items);
    return {
      ok: true,
      items: items.map((item, idx) => ({
        index: idx + 1,
        thread_id: item.thread_id,
        active: item.active,
        title: item.title ?? null,
        updated_at: item.updated_at ?? null,
        cwd: item.cwd ?? null,
      })),
      reply_text: text,
      reply_card: {
        title: "会话列表",
        template: "blue",
        markdown: `\`\`\`\n${text}\n\`\`\``,
      },
    };
  }

  if (method === "feishu/switch_thread") {
    const chatId = params?.chat_id || params?.chatId || null;
    const rawTarget = params?.target ?? params?.thread_id ?? params?.threadId ?? null;
    if (!chatId) {
      throw new Error("feishu/switch_thread requires chat_id");
    }
    if (rawTarget === null || rawTarget === undefined || String(rawTarget).trim() === "") {
      return {
        ok: false,
        reply_text: "请指定会话序号或会话ID，例如：/sw 2",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "请指定会话序号或会话ID，例如：`/sw 2`",
        },
      };
    }
    const snapshot = store.snapshot();
    const binding = snapshot.bindings?.[chatId] ?? null;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先完成绑定后再切换会话。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先完成绑定后再切换会话。",
        },
      };
    }
    const items = listSwitchableThreads(snapshot, chatId);
    if (items.length === 0) {
      return {
        ok: false,
        reply_text: "当前没有可切换的会话。发送 /new 创建新会话。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前没有可切换的会话。发送 `/new` 创建新会话。",
        },
      };
    }

    const targetText = String(rawTarget).trim();
    let targetThreadId = "";
    if (/^\d+$/.test(targetText)) {
      const idx = Number.parseInt(targetText, 10);
      const picked = items[idx - 1];
      if (!picked) {
        return {
          ok: false,
          reply_text: `序号无效：${targetText}。先发送 /threads 查看列表。`,
          reply_card: {
            title: "会话状态",
            template: "orange",
            markdown: `序号无效：\`${targetText}\`。先发送 \`/threads\` 查看列表。`,
          },
        };
      }
      targetThreadId = picked.thread_id;
    } else {
      targetThreadId = targetText;
    }

    const existed = items.find((item) => item.thread_id === targetThreadId);
    if (!existed) {
      return {
        ok: false,
        reply_text: "未找到该会话。先发送 /threads 查看可切换列表。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "未找到该会话。先发送 `/threads` 查看可切换列表。",
        },
      };
    }

    const switchedCwd = normalizeCwdHint(
      snapshot.thread_buffers?.[targetThreadId]?.last_cwd ?? binding.active_cwd ?? null,
    );
    await store.mutate((state) => {
      state.active_thread_id = targetThreadId;
      const current = state.bindings?.[chatId] ?? null;
      if (current) {
        current.active_thread_id = targetThreadId;
        if (switchedCwd) {
          current.active_cwd = switchedCwd;
        }
      }
      pushRecentEvent(state, {
        source: "daemon",
        type: "binding_thread_switched_manual",
        chat_id: chatId,
        thread_id: targetThreadId,
        cwd: switchedCwd ?? null,
      });
      return state;
    });

    const shortId = formatThreadShortId(targetThreadId);
    const message = switchedCwd
      ? `已切换到会话 ${shortId}（目录已同步）`
      : `已切换到会话 ${shortId}`;
    return {
      ok: true,
      thread_id: targetThreadId,
      cwd: switchedCwd ?? null,
      reply_text: message,
      reply_card: {
        title: "会话状态",
        template: "green",
        markdown:
          `🔁 已切换会话\n- 会话ID ${targetThreadId}` +
          (switchedCwd ? `\n- 目录 \`${switchedCwd}\`` : ""),
      },
    };
  }

  if (method === "feishu/rebind") {
    const chatId = params?.chat_id || params?.chatId || null;
    if (!chatId) {
      throw new Error("feishu/rebind requires chat_id");
    }
    let previousCwd = null;
    let previousThreadId = null;
    await store.mutate((state) => {
      const existed = state.bindings?.[chatId] ?? null;
      if (existed) {
        previousCwd = normalizeCwdHint(existed.active_cwd ?? null);
        previousThreadId = existed.active_thread_id ?? null;
        delete state.bindings[chatId];
        pushRecentEvent(state, {
          source: "daemon",
          type: "binding_reset",
          chat_id: chatId,
          previous_thread_id: existed.active_thread_id ?? null,
          previous_cwd: previousCwd,
        });
      } else {
        previousCwd = normalizeCwdHint(state.last_qrcode_cwd ?? null);
        pushRecentEvent(state, {
          source: "daemon",
          type: "binding_reset_noop",
          chat_id: chatId,
        });
      }
      return state;
    });
    const bindInfo = await ensureBindCodeForChat(store, chatId, {
      cwdHint: previousCwd,
      threadId: previousThreadId,
    });
    const openChatLink = buildChatOpenLink((ctx.bridgeConfig?.bot_open_id ?? "").trim());
    return {
      ok: true,
      unbound: true,
      rebound: true,
      bind_code: bindInfo.code,
      bind_command: bindInfo.bindCommand,
      expires_at: bindInfo.expiresAt,
      open_chat_link: openChatLink,
      reply_text: `已重置绑定，请先发送：${bindInfo.bindCommand}`,
    };
  }

  if (method === "feishu/cwd") {
    const chatId = params?.chat_id || params?.chatId || null;
    if (!chatId) {
      throw new Error("feishu/cwd requires chat_id");
    }
    const action = typeof params?.action === "string" ? params.action : "get";
    const snapshot = store.snapshot();
    const binding = snapshot.bindings?.[chatId] ?? null;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先完成绑定后再设置目录。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先完成绑定后再设置目录。",
        },
      };
    }

    if (action === "get") {
      const activeThreadId = binding.active_thread_id ?? null;
      const threadBuffer = activeThreadId ? snapshot.thread_buffers?.[activeThreadId] ?? null : null;
      const activeCwd =
        normalizeCwdHint(binding.active_cwd ?? threadBuffer?.last_cwd ?? snapshot.last_qrcode_cwd ?? null) ??
        "(未设置，将使用 daemon 当前目录)";
      return {
        ok: true,
        cwd: activeCwd,
        thread_id: activeThreadId,
        reply_text: `当前目录：${activeCwd}`,
        reply_card: {
          title: "会话状态",
          template: "blue",
          markdown: `📁 当前目录：\`${activeCwd}\`${activeThreadId ? `\n- 会话ID ${activeThreadId}` : ""}`,
        },
      };
    }

    if (action === "set") {
      const rawPath = typeof params?.path === "string" ? params.path : "";
      const baseCwd =
        normalizeCwdHint(binding.active_cwd ?? snapshot.last_qrcode_cwd ?? null) ?? process.cwd();
      const resolved = resolveCwdInput(rawPath, baseCwd);
      if (!resolved.ok) {
        return {
          ok: false,
          reply_text: resolved.error,
          reply_card: {
            title: "会话状态",
            template: "red",
            markdown: `❌ ${statusMarkdownFromText(resolved.error)}`,
          },
        };
      }

      const createNewThread = Boolean(params?.new_thread ?? params?.newThread);
      let newThreadId = null;
      if (createNewThread) {
        const created = await startNewThread(store, app, null);
        newThreadId = created.threadId;
      }

      await store.mutate((state) => {
        const current = state.bindings?.[chatId] ?? null;
        if (!current) {
          return state;
        }
        current.active_cwd = resolved.cwd;
        if (newThreadId) {
          current.active_thread_id = newThreadId;
        }
        pushRecentEvent(state, {
          source: "daemon",
          type: "binding_cwd_changed",
          chat_id: chatId,
          cwd: resolved.cwd,
          thread_id: current.active_thread_id ?? null,
          new_thread: Boolean(newThreadId),
        });
        return state;
      });

      const latest = store.snapshot().bindings?.[chatId] ?? null;
      const effectiveThreadId = latest?.active_thread_id ?? snapshot.active_thread_id ?? null;
      const message = newThreadId
        ? `已切换目录并新建会话：${resolved.cwd}`
        : `已切换目录：${resolved.cwd}`;
      return {
        ok: true,
        cwd: resolved.cwd,
        thread_id: effectiveThreadId,
        reply_text: message,
        reply_card: {
          title: "会话状态",
          template: newThreadId ? "green" : "blue",
          markdown:
            `${newThreadId ? "🆕 " : "📁 "}已切换目录：\`${resolved.cwd}\`` +
            `${effectiveThreadId ? `\n- 会话ID ${effectiveThreadId}` : ""}`,
        },
      };
    }

    throw new Error(`unsupported feishu/cwd action: ${action}`);
  }

  if (method === "feishu/chat_status") {
    const chatId = params?.chat_id || params?.chatId || null;
    const chatType = params?.chat_type || params?.chatType || null;
    if (!chatId) {
      throw new Error("feishu/chat_status requires chat_id");
    }
    const snapshot = store.snapshot();
    const binding = snapshot.bindings?.[chatId] ?? null;
    const threadId = binding?.active_thread_id ?? null;
    const threadBuffer = threadId ? snapshot.thread_buffers?.[threadId] ?? null : null;
    const cwd = normalizeCwdHint(binding?.active_cwd ?? threadBuffer?.last_cwd ?? null) ?? "(未设置)";
    const pendingCount = ctx.pending ? ctx.pending.list(chatId).length : 0;
    const model = binding?.preferred_model ?? runtime.defaultModel ?? null;
    const approvalPolicy = normalizeApprovalPolicy(binding?.approval_policy ?? null);
    const sandboxMode = normalizeSandboxMode(binding?.sandbox_mode ?? null);
    const planMode = Boolean(binding?.plan_mode);
    const isGroup = !isPrivateChatType(chatType);
    const lines = [
      binding ? "✅ 已绑定" : "⚠️ 未绑定",
      `- 会话类型：${isGroup ? "群聊" : "私聊"}`,
      `- 会话ID：${threadId || "(未设置)"}`,
      `- 目录：\`${cwd}\``,
      ...(model ? [`- 模型：${model}`] : []),
      ...(approvalPolicy ? [`- 审批：${approvalPolicy}`] : []),
      ...(sandboxMode ? [`- 权限：${sandboxMode}`] : []),
      `- Plan：${planMode ? "on" : "off"}`,
      `- 待审批：${pendingCount}`,
    ];
    if (isGroup) {
      lines.push("- 群聊建议：优先 `@机器人` 触发");
      lines.push("- 群里未绑定时先发送 `/bind <CODE>`");
    }
    return {
      ok: true,
      bound: Boolean(binding),
      thread_id: threadId,
      cwd,
      pending_count: pendingCount,
      is_group: isGroup,
      reply_text: lines.join("\n"),
      reply_card: {
        title: "会话状态",
        template: binding ? "blue" : "orange",
        markdown: lines.join("\n"),
      },
    };
  }

  if (method === "feishu/skills") {
    const details = await listInstalledSkills();
    const lines = [
      "Skills 列表：",
      `- 根目录：\`${details.root}\``,
      `- 用户技能：${details.userSkills.length > 0 ? details.userSkills.join(", ") : "(无)"}`,
      `- 系统技能：${details.systemSkills.length > 0 ? details.systemSkills.join(", ") : "(无)"}`,
    ];
    return {
      ok: true,
      user_skills: details.userSkills,
      system_skills: details.systemSkills,
      reply_text: lines.join("\n"),
      reply_card: {
        title: "Skills",
        template: "blue",
        markdown: lines.join("\n"),
      },
    };
  }

  if (method === "feishu/codex_mcp") {
    const rawArgs = typeof params?.args === "string" ? params.args.trim() : "";
    const parsedArgs = splitShellLikeArgs(rawArgs);
    const args = parsedArgs.length > 0 ? parsedArgs : ["list"];
    const action = String(args[0] ?? "").toLowerCase();
    const allowedActions = new Set(["list", "get", "add", "remove", "login", "logout"]);
    if (!allowedActions.has(action)) {
      return {
        ok: false,
        reply_text: "用法：/mcp [list|get|add|remove|login|logout] ...",
        reply_card: {
          title: "MCP",
          template: "orange",
          markdown: "用法：`/mcp [list|get|add|remove|login|logout] ...`",
        },
      };
    }

    const snapshot = store.snapshot();
    const chatId = params?.chat_id || params?.chatId || null;
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const execResult = await runExecFileCapture(
      resolveCodexBin(ctx.bridgeConfig),
      ["mcp", ...args],
      {
        cwd: resolved.cwd || process.cwd(),
        timeoutMs: CLI_CAPTURE_TIMEOUT_MS,
      },
    );
    const combinedOutput = normalizeReadableText(`${execResult.stdout || ""}\n${execResult.stderr || ""}`);
    const outputBody = clipText(combinedOutput || "(无输出)");
    if (!execResult.ok) {
      const header = execResult.timedOut
        ? "执行超时（20s）"
        : `执行失败${execResult.code !== null ? ` (exit=${execResult.code})` : ""}`;
      return {
        ok: false,
        reply_text: `${header}\n${outputBody}`,
        reply_card: {
          title: "MCP",
          template: "red",
          markdown: `❌ ${header}\n\n\`\`\`\n${statusMarkdownFromText(outputBody)}\n\`\`\``,
        },
      };
    }

    return {
      ok: true,
      args,
      output: combinedOutput,
      reply_text: outputBody,
      reply_card: {
        title: "MCP",
        template: "blue",
        markdown: `\`\`\`\n${statusMarkdownFromText(outputBody)}\n\`\`\``,
      },
    };
  }

  if (method === "feishu/resume") {
    const chatId = params?.chat_id || params?.chatId || null;
    const action = typeof params?.action === "string" ? params.action : "list";
    const rawTarget = params?.target ?? params?.thread_id ?? params?.threadId ?? null;
    if (!chatId) {
      throw new Error("feishu/resume requires chat_id");
    }

    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const binding = resolved.binding;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先绑定后再使用 /resume。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先绑定后再使用 `/resume`。",
        },
      };
    }

    const listCall = await callAppServerApi(app, "thread/list", {
      limit: 50,
      ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
    });
    if (listCall.unsupported) {
      if (action === "list") {
        return handleRpcCall(store, app, "feishu/threads", { chat_id: chatId }, ctx);
      }
      return handleRpcCall(
        store,
        app,
        "feishu/switch_thread",
        { chat_id: chatId, target: rawTarget },
        ctx,
      );
    }

    let items = Array.isArray(listCall.result?.data)
      ? listCall.result.data
          .map((thread) => toAppThreadListItem(thread, binding.active_thread_id ?? null))
          .filter(Boolean)
      : [];
    if (items.length === 0) {
      items = listSwitchableThreads(snapshot, chatId);
    }
    items.sort((a, b) => {
      if (a.active && !b.active) {
        return -1;
      }
      if (!a.active && b.active) {
        return 1;
      }
      return (b.updated_at ?? 0) - (a.updated_at ?? 0);
    });

    if (action === "list") {
      const text = formatThreadListForFeishu(items);
      return {
        ok: true,
        items: items.map((item, idx) => ({
          index: idx + 1,
          thread_id: item.thread_id,
          active: item.active,
          title: item.title ?? null,
          updated_at: item.updated_at ?? null,
          cwd: item.cwd ?? null,
        })),
        reply_text: text,
        reply_card: {
          title: "会话列表",
          template: "blue",
          markdown: `\`\`\`\n${text}\n\`\`\``,
        },
      };
    }

    const targetText = String(rawTarget ?? "").trim();
    if (!targetText) {
      const text = formatThreadListForFeishu(items);
      return {
        ok: false,
        reply_text: "请提供会话序号或会话ID，例如：/resume 2",
        reply_card: {
          title: "会话列表",
          template: "orange",
          markdown: `请提供会话序号或会话ID，例如：\`/resume 2\`\n\n\`\`\`\n${text}\n\`\`\``,
        },
      };
    }

    let targetThreadId = targetText;
    if (/^\d+$/.test(targetText)) {
      const idx = Number.parseInt(targetText, 10);
      const picked = items[idx - 1];
      if (!picked) {
        return {
          ok: false,
          reply_text: `序号无效：${targetText}。先发送 /resume 查看会话列表。`,
          reply_card: {
            title: "会话状态",
            template: "orange",
            markdown: `序号无效：\`${targetText}\`。先发送 \`/resume\` 查看会话列表。`,
          },
        };
      }
      targetThreadId = picked.thread_id;
    }

    const resumeCall = await callAppServerApi(app, "thread/resume", {
      threadId: targetThreadId,
    });
    if (resumeCall.unsupported) {
      return handleRpcCall(
        store,
        app,
        "feishu/switch_thread",
        { chat_id: chatId, target: targetThreadId },
        ctx,
      );
    }
    const resumedThread = resumeCall.result?.thread ?? null;
    const resumedCwd = normalizeCwdHint(
      resumeCall.result?.cwd ?? resumedThread?.cwd ?? resolved.cwd ?? null,
    );
    await store.mutate((state) => {
      state.active_thread_id = targetThreadId;
      const existed = state.bindings?.[chatId] ?? null;
      if (existed) {
        state.bindings[chatId] = buildBindingRecord(existed, {
          active_thread_id: targetThreadId,
          active_cwd: resumedCwd ?? existed.active_cwd ?? null,
        });
      }
      const buffer = ensureThreadBuffer(state, targetThreadId);
      if (buffer) {
        if (resumedCwd) {
          buffer.last_cwd = resumedCwd;
        }
        const updatedAtMs = parseTimestampMs(resumedThread?.updatedAt ?? null);
        if (updatedAtMs > 0) {
          buffer.last_update_at = updatedAtMs;
        }
      }
      if (typeof resumedThread?.name === "string" && resumedThread.name.trim()) {
        state.thread_titles[targetThreadId] = resumedThread.name.trim();
      }
      pushRecentEvent(state, {
        source: "daemon",
        type: "binding_thread_resumed",
        chat_id: chatId,
        thread_id: targetThreadId,
        cwd: resumedCwd,
      });
      return state;
    });

    return {
      ok: true,
      thread_id: targetThreadId,
      cwd: resumedCwd ?? null,
      reply_text: `已恢复到会话 ${formatThreadShortId(targetThreadId)}。`,
      reply_card: {
        title: "会话状态",
        template: "green",
        markdown:
          `✅ 已恢复会话\n- 会话ID ${targetThreadId}` +
          (resumedCwd ? `\n- 目录 \`${resumedCwd}\`` : ""),
      },
    };
  }

  if (method === "feishu/fork") {
    const chatId = params?.chat_id || params?.chatId || null;
    const rawTarget = params?.target ?? params?.thread_id ?? params?.threadId ?? null;
    if (!chatId) {
      throw new Error("feishu/fork requires chat_id");
    }
    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const binding = resolved.binding;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先绑定后再使用 /fork。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先绑定后再使用 `/fork`。",
        },
      };
    }

    let sourceThreadId = resolved.threadId ?? null;
    const targetText = String(rawTarget ?? "").trim();
    if (targetText) {
      if (/^\d+$/.test(targetText)) {
        const listCall = await callAppServerApi(app, "thread/list", {
          limit: 50,
          ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
        });
        let items = [];
        if (!listCall.unsupported) {
          items = Array.isArray(listCall.result?.data)
            ? listCall.result.data
                .map((thread) => toAppThreadListItem(thread, binding.active_thread_id ?? null))
                .filter(Boolean)
            : [];
        }
        if (items.length === 0) {
          items = listSwitchableThreads(snapshot, chatId);
        }
        const idx = Number.parseInt(targetText, 10);
        const picked = items[idx - 1];
        if (!picked) {
          return {
            ok: false,
            reply_text: `序号无效：${targetText}。先发送 /resume 查看会话列表。`,
            reply_card: {
              title: "会话状态",
              template: "orange",
              markdown: `序号无效：\`${targetText}\`。先发送 \`/resume\` 查看会话列表。`,
            },
          };
        }
        sourceThreadId = picked.thread_id;
      } else {
        sourceThreadId = targetText;
      }
    }

    if (!sourceThreadId) {
      return {
        ok: false,
        reply_text: "当前没有可 fork 的会话。先发一条消息创建会话。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前没有可 fork 的会话。先发一条消息创建会话。",
        },
      };
    }

    const forkCall = await callAppServerApi(app, "thread/fork", {
      threadId: sourceThreadId,
    });
    if (forkCall.unsupported) {
      return {
        ok: false,
        reply_text: "当前 Codex 版本暂不支持 /fork（app-server 未暴露 thread/fork）。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前 Codex 版本暂不支持 `/fork`（app-server 未暴露 `thread/fork`）。",
        },
      };
    }

    const newThreadId = forkCall.result?.thread?.id ?? null;
    if (!newThreadId) {
      throw new Error("thread/fork response missing thread.id");
    }
    const forkedCwd = normalizeCwdHint(
      forkCall.result?.cwd ?? forkCall.result?.thread?.cwd ?? resolved.cwd ?? null,
    );
    await store.mutate((state) => {
      state.active_thread_id = newThreadId;
      const existed = state.bindings?.[chatId] ?? null;
      if (existed) {
        state.bindings[chatId] = buildBindingRecord(existed, {
          active_thread_id: newThreadId,
          active_cwd: forkedCwd ?? existed.active_cwd ?? null,
        });
      }
      ensureThreadBuffer(state, newThreadId);
      if (typeof forkCall.result?.thread?.name === "string" && forkCall.result.thread.name.trim()) {
        state.thread_titles[newThreadId] = forkCall.result.thread.name.trim();
      }
      pushRecentEvent(state, {
        source: "daemon",
        type: "binding_thread_forked",
        chat_id: chatId,
        from_thread_id: sourceThreadId,
        thread_id: newThreadId,
        cwd: forkedCwd,
      });
      return state;
    });

    return {
      ok: true,
      thread_id: newThreadId,
      source_thread_id: sourceThreadId,
      cwd: forkedCwd ?? null,
      reply_text: `已 fork 新会话：${formatThreadShortId(newThreadId)}`,
      reply_card: {
        title: "会话状态",
        template: "green",
        markdown:
          `🌿 已 fork 新会话\n- 来源会话 ${sourceThreadId}\n- 新会话ID ${newThreadId}` +
          (forkedCwd ? `\n- 目录 \`${forkedCwd}\`` : ""),
      },
    };
  }

  if (method === "feishu/review") {
    const chatId = params?.chat_id || params?.chatId || null;
    const rawArg = typeof params?.arg === "string" ? params.arg.trim() : "";
    if (!chatId) {
      throw new Error("feishu/review requires chat_id");
    }
    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const binding = resolved.binding;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先绑定后再使用 /review。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先绑定后再使用 `/review`。",
        },
      };
    }

    let threadId = resolved.threadId;
    if (!threadId) {
      const created = await startNewThread(store, app, null);
      threadId = created.threadId;
    }
    let target = { type: "uncommittedChanges" };
    if (rawArg) {
      const branchMatch = rawArg.match(/^branch:(.+)$/i);
      const commitMatch = rawArg.match(/^commit:(.+)$/i);
      if (branchMatch) {
        target = {
          type: "baseBranch",
          branch: branchMatch[1].trim(),
        };
      } else if (commitMatch) {
        target = {
          type: "commit",
          sha: commitMatch[1].trim(),
        };
      } else {
        target = {
          type: "custom",
          instructions: rawArg,
        };
      }
    }

    const reviewCall = await callAppServerApi(app, "review/start", {
      threadId,
      target,
    });
    if (reviewCall.unsupported) {
      return {
        ok: false,
        reply_text: "当前 Codex 版本暂不支持 /review（app-server 未暴露 review/start）。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前 Codex 版本暂不支持 `/review`（app-server 未暴露 `review/start`）。",
        },
      };
    }

    const reviewThreadId = reviewCall.result?.reviewThreadId ?? threadId;
    const turnId = reviewCall.result?.turn?.id ?? null;
    await store.mutate((state) => {
      state.active_thread_id = reviewThreadId;
      const existed = state.bindings?.[chatId] ?? null;
      if (existed) {
        state.bindings[chatId] = buildBindingRecord(existed, {
          active_thread_id: reviewThreadId,
          active_cwd: resolved.cwd ?? existed.active_cwd ?? null,
        });
      }
      const buffer = ensureThreadBuffer(state, reviewThreadId);
      if (buffer) {
        buffer.turn_started_at = Date.now();
        buffer.first_token_at = null;
        buffer.first_token_ms = null;
        buffer.current_turn_id = turnId;
        if (resolved.cwd) {
          buffer.last_cwd = resolved.cwd;
        }
      }
      pushRecentEvent(state, {
        source: "daemon",
        type: "review_started",
        chat_id: chatId,
        thread_id: reviewThreadId,
        target_type: target.type,
      });
      return state;
    });
    if (ctx.relay && typeof ctx.relay.onTurnQueued === "function") {
      ctx.relay.onTurnQueued(reviewThreadId);
    }

    return {
      ok: true,
      thread_id: reviewThreadId,
      turn_id: turnId,
      reply_text: "已开始 Review，正在生成…",
      reply_card: {
        title: "会话状态",
        markdown: `🔍 已开始 Review，正在生成…\n- 会话ID ${reviewThreadId}`,
      },
    };
  }

  if (method === "feishu/compact") {
    const chatId = params?.chat_id || params?.chatId || null;
    if (!chatId) {
      throw new Error("feishu/compact requires chat_id");
    }
    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    if (!resolved.binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先绑定后再使用 /compact。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先绑定后再使用 `/compact`。",
        },
      };
    }
    if (!resolved.threadId) {
      return {
        ok: false,
        reply_text: "当前没有可压缩的会话。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前没有可压缩的会话。",
        },
      };
    }

    const compactCall = await callAppServerApi(app, "thread/compact/start", {
      threadId: resolved.threadId,
    });
    if (compactCall.unsupported) {
      return {
        ok: false,
        reply_text: "当前 Codex 版本暂不支持 /compact（app-server 未暴露 thread/compact/start）。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前 Codex 版本暂不支持 `/compact`（app-server 未暴露 `thread/compact/start`）。",
        },
      };
    }
    await appendEvent(store, {
      source: "daemon",
      type: "thread_compact_started",
      chat_id: chatId,
      thread_id: resolved.threadId,
    });
    return {
      ok: true,
      thread_id: resolved.threadId,
      reply_text: "已开始压缩当前会话上下文。",
      reply_card: {
        title: "会话状态",
        template: "green",
        markdown: `🧩 已开始压缩当前会话\n- 会话ID ${resolved.threadId}`,
      },
    };
  }

  if (method === "feishu/model") {
    const chatId = params?.chat_id || params?.chatId || null;
    const action = typeof params?.action === "string" ? params.action : "list";
    const rawModel = typeof params?.model === "string" ? params.model.trim() : "";
    if (!chatId) {
      throw new Error("feishu/model requires chat_id");
    }
    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const binding = resolved.binding;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先绑定后再使用 /model。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先绑定后再使用 `/model`。",
        },
      };
    }

    if (action === "set") {
      if (!rawModel) {
        return {
          ok: false,
          reply_text: "请提供模型名，例如：/model gpt-5.3-codex",
          reply_card: {
            title: "会话状态",
            template: "orange",
            markdown: "请提供模型名，例如：`/model gpt-5.3-codex`",
          },
        };
      }
      await store.mutate((state) => {
        const existed = state.bindings?.[chatId] ?? null;
        if (!existed) {
          return state;
        }
        state.bindings[chatId] = buildBindingRecord(existed, {
          preferred_model: rawModel,
        });
        pushRecentEvent(state, {
          source: "daemon",
          type: "binding_model_updated",
          chat_id: chatId,
          model: rawModel,
        });
        return state;
      });
      return {
        ok: true,
        model: rawModel,
        reply_text: `已设置会话模型：${rawModel}`,
        reply_card: {
          title: "会话状态",
          template: "green",
          markdown: `🤖 已设置会话模型\n- ${rawModel}`,
        },
      };
    }

    if (action === "clear") {
      await store.mutate((state) => {
        const existed = state.bindings?.[chatId] ?? null;
        if (!existed) {
          return state;
        }
        state.bindings[chatId] = buildBindingRecord(existed, {
          preferred_model: null,
        });
        pushRecentEvent(state, {
          source: "daemon",
          type: "binding_model_cleared",
          chat_id: chatId,
        });
        return state;
      });
      return {
        ok: true,
        model: null,
        reply_text: "已清除会话模型覆盖，将使用 Codex 默认模型。",
        reply_card: {
          title: "会话状态",
          template: "green",
          markdown: "🧹 已清除会话模型覆盖，将使用 Codex 默认模型。",
        },
      };
    }

    const modelCall = await callAppServerApi(app, "model/list", {
      limit: 100,
      includeHidden: false,
    });
    const currentModel =
      (typeof binding.preferred_model === "string" && binding.preferred_model.trim()
        ? binding.preferred_model.trim()
        : null) ??
      runtime.defaultModel ??
      null;
    if (modelCall.unsupported) {
      const text = currentModel
        ? `当前模型：${currentModel}\n当前版本不支持模型列表接口。`
        : "当前版本不支持模型列表接口。";
      return {
        ok: true,
        models: [],
        current_model: currentModel,
        reply_text: text,
        reply_card: {
          title: "会话状态",
          template: "blue",
          markdown: text,
        },
      };
    }
    const models = Array.isArray(modelCall.result?.data) ? modelCall.result.data : [];
    const body = formatModelListForFeishu(models, currentModel);
    return {
      ok: true,
      models: models.map((item) => ({
        id: item?.id ?? null,
        display_name: item?.displayName ?? null,
        model: item?.model ?? null,
        is_default: Boolean(item?.isDefault),
      })),
      current_model: currentModel,
      reply_text: body,
      reply_card: {
        title: "模型",
        template: "blue",
        markdown: `\`\`\`\n${statusMarkdownFromText(body)}\n\`\`\``,
      },
    };
  }

  if (method === "feishu/approvals") {
    const chatId = params?.chat_id || params?.chatId || null;
    const action = typeof params?.action === "string" ? params.action : "get";
    const policy = normalizeApprovalPolicy(
      params?.approval_policy ?? params?.approvalPolicy ?? params?.value ?? null,
    );
    if (!chatId) {
      throw new Error("feishu/approvals requires chat_id");
    }
    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const binding = resolved.binding;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先绑定后再使用 /approvals。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先绑定后再使用 `/approvals`。",
        },
      };
    }

    if (action === "set") {
      if (!policy) {
        return {
          ok: false,
          reply_text: "参数无效，可选：untrusted|on-failure|on-request|never",
          reply_card: {
            title: "会话状态",
            template: "orange",
            markdown: "参数无效，可选：`untrusted|on-failure|on-request|never`",
          },
        };
      }
      await store.mutate((state) => {
        const existed = state.bindings?.[chatId] ?? null;
        if (!existed) {
          return state;
        }
        state.bindings[chatId] = buildBindingRecord(existed, {
          approval_policy: policy,
        });
        pushRecentEvent(state, {
          source: "daemon",
          type: "binding_approval_policy_updated",
          chat_id: chatId,
          approval_policy: policy,
        });
        return state;
      });
      return {
        ok: true,
        approval_policy: policy,
        reply_text: `已设置审批策略：${policy}`,
        reply_card: {
          title: "会话状态",
          template: "green",
          markdown: `✅ 已设置审批策略：\`${policy}\``,
        },
      };
    }

    if (action === "clear") {
      await store.mutate((state) => {
        const existed = state.bindings?.[chatId] ?? null;
        if (!existed) {
          return state;
        }
        state.bindings[chatId] = buildBindingRecord(existed, {
          approval_policy: null,
        });
        pushRecentEvent(state, {
          source: "daemon",
          type: "binding_approval_policy_cleared",
          chat_id: chatId,
        });
        return state;
      });
      return {
        ok: true,
        approval_policy: null,
        reply_text: "已清除会话审批策略覆盖，将使用 Codex 默认值。",
        reply_card: {
          title: "会话状态",
          template: "green",
          markdown: "🧹 已清除会话审批策略覆盖，将使用 Codex 默认值。",
        },
      };
    }

    let effective = normalizeApprovalPolicy(binding.approval_policy ?? null);
    if (!effective) {
      const cfgCall = await callAppServerApi(app, "config/read", {
        ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
      });
      if (cfgCall.ok) {
        effective = normalizeApprovalPolicy(cfgCall.result?.config?.approval_policy ?? null);
      }
    }
    return {
      ok: true,
      approval_policy: effective,
      reply_text: `当前审批策略：${effective ?? "(未设置，使用默认)"}`,
      reply_card: {
        title: "会话状态",
        template: "blue",
        markdown: `当前审批策略：\`${effective ?? "(未设置，使用默认)"}\``,
      },
    };
  }

  if (method === "feishu/permissions") {
    const chatId = params?.chat_id || params?.chatId || null;
    const action = typeof params?.action === "string" ? params.action : "get";
    const mode = normalizeSandboxMode(params?.sandbox_mode ?? params?.sandboxMode ?? params?.value ?? null);
    if (!chatId) {
      throw new Error("feishu/permissions requires chat_id");
    }
    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const binding = resolved.binding;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先绑定后再使用 /permissions。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先绑定后再使用 `/permissions`。",
        },
      };
    }

    if (action === "set") {
      if (!mode) {
        return {
          ok: false,
          reply_text: "参数无效，可选：read-only|workspace-write|danger-full-access",
          reply_card: {
            title: "会话状态",
            template: "orange",
            markdown: "参数无效，可选：`read-only|workspace-write|danger-full-access`",
          },
        };
      }
      await store.mutate((state) => {
        const existed = state.bindings?.[chatId] ?? null;
        if (!existed) {
          return state;
        }
        state.bindings[chatId] = buildBindingRecord(existed, {
          sandbox_mode: mode,
        });
        pushRecentEvent(state, {
          source: "daemon",
          type: "binding_sandbox_mode_updated",
          chat_id: chatId,
          sandbox_mode: mode,
        });
        return state;
      });
      return {
        ok: true,
        sandbox_mode: mode,
        reply_text: `已设置权限策略：${mode}`,
        reply_card: {
          title: "会话状态",
          template: "green",
          markdown: `✅ 已设置权限策略：\`${mode}\``,
        },
      };
    }

    if (action === "clear") {
      await store.mutate((state) => {
        const existed = state.bindings?.[chatId] ?? null;
        if (!existed) {
          return state;
        }
        state.bindings[chatId] = buildBindingRecord(existed, {
          sandbox_mode: null,
        });
        pushRecentEvent(state, {
          source: "daemon",
          type: "binding_sandbox_mode_cleared",
          chat_id: chatId,
        });
        return state;
      });
      return {
        ok: true,
        sandbox_mode: null,
        reply_text: "已清除会话权限策略覆盖，将使用 Codex 默认值。",
        reply_card: {
          title: "会话状态",
          template: "green",
          markdown: "🧹 已清除会话权限策略覆盖，将使用 Codex 默认值。",
        },
      };
    }

    let effective = normalizeSandboxMode(binding.sandbox_mode ?? null);
    if (!effective) {
      const cfgCall = await callAppServerApi(app, "config/read", {
        ...(resolved.cwd ? { cwd: resolved.cwd } : {}),
      });
      if (cfgCall.ok) {
        effective = normalizeSandboxMode(cfgCall.result?.config?.sandbox_mode ?? null);
      }
    }
    return {
      ok: true,
      sandbox_mode: effective,
      reply_text: `当前权限策略：${effective ?? "(未设置，使用默认)"}`,
      reply_card: {
        title: "会话状态",
        template: "blue",
        markdown: `当前权限策略：\`${effective ?? "(未设置，使用默认)"}\``,
      },
    };
  }

  if (method === "feishu/plan") {
    const chatId = params?.chat_id || params?.chatId || null;
    const action = normalizePlanMode(params?.action ?? params?.value ?? null);
    if (!chatId) {
      throw new Error("feishu/plan requires chat_id");
    }
    const snapshot = store.snapshot();
    const binding = snapshot.bindings?.[chatId] ?? null;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先绑定后再使用 /plan。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先绑定后再使用 `/plan`。",
        },
      };
    }

    let planMode = Boolean(binding.plan_mode);
    if (action === true) {
      planMode = true;
    } else if (action === false) {
      planMode = false;
    } else if (action === "toggle") {
      planMode = !planMode;
    }
    await store.mutate((state) => {
      const existed = state.bindings?.[chatId] ?? null;
      if (!existed) {
        return state;
      }
      state.bindings[chatId] = buildBindingRecord(existed, {
        plan_mode: planMode,
      });
      pushRecentEvent(state, {
        source: "daemon",
        type: "binding_plan_mode_updated",
        chat_id: chatId,
        plan_mode: planMode,
      });
      return state;
    });
    return {
      ok: true,
      plan_mode: planMode,
      reply_text: `Plan 模式已${planMode ? "开启" : "关闭"}（兼容模式）。`,
      reply_card: {
        title: "会话状态",
        template: "blue",
        markdown: `Plan 模式已${planMode ? "开启" : "关闭"}（兼容模式）。`,
      },
    };
  }

  if (method === "feishu/init") {
    const chatId = params?.chat_id || params?.chatId || null;
    if (!chatId) {
      throw new Error("feishu/init requires chat_id");
    }
    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const binding = resolved.binding;
    if (!binding) {
      return {
        ok: false,
        reply_text: "当前会话未绑定，请先绑定后再使用 /init。",
        reply_card: {
          title: "会话状态",
          template: "orange",
          markdown: "当前会话未绑定，请先绑定后再使用 `/init`。",
        },
      };
    }
    const cwd = resolved.cwd ?? process.cwd();
    const targetPath = path.join(cwd, DEFAULT_PROJECT_DOC_FILENAME);
    if (fs.existsSync(targetPath)) {
      return {
        ok: true,
        exists: true,
        path: targetPath,
        reply_text: `${DEFAULT_PROJECT_DOC_FILENAME} 已存在，已跳过 /init。`,
        reply_card: {
          title: "会话状态",
          template: "blue",
          markdown: `${DEFAULT_PROJECT_DOC_FILENAME} 已存在，已跳过 \`/init\`。\n- 路径 \`${targetPath}\``,
        },
      };
    }
    return handleRpcCall(
      store,
      app,
      "feishu/submit_text",
      {
        text: INIT_COMMAND_PROMPT,
        chat_id: chatId,
        user_id: params?.user_id || params?.userId || null,
        thread_id: resolved.threadId ?? null,
        cwd,
        plan_mode: "off",
      },
      ctx,
    );
  }

  if (method === "feishu/submit_text") {
    const text = params?.text;
    const chatId = params?.chat_id || params?.chatId || null;
    if (!text || typeof text !== "string") {
      throw new Error("feishu/submit_text requires text");
    }
    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const preferredThreadId = resolved.threadId;
    const activeCwd = resolved.cwd;
    const turnOverrides = deriveTurnOverrides(resolved, params);
    const finalText = applyPlanModeText(text, turnOverrides.planModeEnabled);
    const turnParams = activeCwd ? { cwd: activeCwd } : {};
    if (turnOverrides.model) {
      turnParams.model = turnOverrides.model;
    }
    if (turnOverrides.approvalPolicy) {
      turnParams.approvalPolicy = turnOverrides.approvalPolicy;
    }
    if (turnOverrides.sandboxPolicy) {
      turnParams.sandboxPolicy = turnOverrides.sandboxPolicy;
    }
    const submitResult = await startTurnWithAutoRecover(
      store,
      app,
      preferredThreadId,
      finalText,
      chatId,
      turnParams,
    );
    const threadId = submitResult.threadId;
    const turnResponse = submitResult.turnResponse;
    const turnId = turnResponse?.turn?.id ?? null;
    await store.mutate((state) => {
      state.active_thread_id = threadId;
      const buffer = ensureThreadBuffer(state, threadId);
      if (buffer) {
        buffer.turn_started_at = Date.now();
        buffer.first_token_at = null;
        buffer.first_token_ms = null;
        buffer.current_turn_id = turnId;
        if (activeCwd) {
          buffer.last_cwd = activeCwd;
        }
      }
      if (chatId && state.bindings[chatId]) {
        state.bindings[chatId].active_thread_id = threadId;
        if (activeCwd) {
          state.bindings[chatId].active_cwd = activeCwd;
        }
      }
      pushRecentEvent(state, {
        source: "daemon",
        type: "user_text_forwarded",
        thread_id: threadId,
        chat_id: chatId,
        preferred_thread_id: preferredThreadId,
        cwd: activeCwd,
        model: turnOverrides.model ?? null,
        approval_policy: turnOverrides.approvalPolicy ?? null,
        sandbox_mode: turnOverrides.sandboxMode ?? null,
        plan_mode: Boolean(turnOverrides.planModeEnabled),
      });
      return state;
    });
    if (ctx.relay && typeof ctx.relay.onTurnQueued === "function") {
      ctx.relay.onTurnQueued(threadId);
    }
    return {
      ok: true,
      thread_id: threadId,
      reply_text: submitResult.recovered
        ? "检测到旧会话失效，已自动切换并开始生成…"
        : "已收到，正在生成…",
      reply_card: {
        title: "会话状态",
        markdown: submitResult.recovered
          ? `⏳ 检测到旧会话失效，已自动切换并开始生成…\n- 会话ID ${threadId}`
          : `⏳ 已收到，正在生成…\n- 会话ID ${threadId}`,
      },
    };
  }

  if (method === "feishu/submit_image") {
    const imagePath = params?.image_path || params?.imagePath || null;
    if (!imagePath || typeof imagePath !== "string") {
      throw new Error("feishu/submit_image requires image_path");
    }
    return handleRpcCall(
      store,
      app,
      "feishu/submit_mixed",
      {
        chat_id: params?.chat_id || params?.chatId || null,
        user_id: params?.user_id || params?.userId || null,
        thread_id: params?.thread_id ?? params?.threadId ?? null,
        image_paths: [imagePath],
      },
      ctx,
    );
  }

  if (method === "feishu/submit_mixed") {
    const chatId = params?.chat_id || params?.chatId || null;
    const text = typeof params?.text === "string" ? params.text : null;
    const imagePathsRaw = params?.image_paths ?? params?.imagePaths ?? [];
    const imagePaths = Array.isArray(imagePathsRaw)
      ? imagePathsRaw.filter((item) => typeof item === "string" && item)
      : [];
    if ((!text || !text.trim()) && imagePaths.length === 0) {
      throw new Error("feishu/submit_mixed requires text or image_paths");
    }

    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const preferredThreadId = resolved.threadId;
    const activeCwd = resolved.cwd;
    const turnOverrides = deriveTurnOverrides(resolved, params);
    const finalText = typeof text === "string"
      ? applyPlanModeText(text, turnOverrides.planModeEnabled)
      : text;
    const input = buildMixedInput(finalText, imagePaths);
    const turnParams = activeCwd ? { cwd: activeCwd } : {};
    if (turnOverrides.model) {
      turnParams.model = turnOverrides.model;
    }
    if (turnOverrides.approvalPolicy) {
      turnParams.approvalPolicy = turnOverrides.approvalPolicy;
    }
    if (turnOverrides.sandboxPolicy) {
      turnParams.sandboxPolicy = turnOverrides.sandboxPolicy;
    }
    const submitResult = await startTurnWithAutoRecoverInput(
      store,
      app,
      preferredThreadId,
      input,
      chatId,
      turnParams,
    );
    const threadId = submitResult.threadId;
    const turnResponse = submitResult.turnResponse;
    const turnId = turnResponse?.turn?.id ?? null;
    await store.mutate((state) => {
      state.active_thread_id = threadId;
      const buffer = ensureThreadBuffer(state, threadId);
      if (buffer) {
        buffer.turn_started_at = Date.now();
        buffer.first_token_at = null;
        buffer.first_token_ms = null;
        buffer.current_turn_id = turnId;
        if (activeCwd) {
          buffer.last_cwd = activeCwd;
        }
      }
      if (chatId && state.bindings[chatId]) {
        state.bindings[chatId].active_thread_id = threadId;
        if (activeCwd) {
          state.bindings[chatId].active_cwd = activeCwd;
        }
      }
      pushRecentEvent(state, {
        source: "daemon",
        type: "user_multimodal_forwarded",
        thread_id: threadId,
        chat_id: chatId,
        preferred_thread_id: preferredThreadId,
        has_text: Boolean(text && text.trim()),
        image_count: imagePaths.length,
        cwd: activeCwd,
        model: turnOverrides.model ?? null,
        approval_policy: turnOverrides.approvalPolicy ?? null,
        sandbox_mode: turnOverrides.sandboxMode ?? null,
        plan_mode: Boolean(turnOverrides.planModeEnabled),
      });
      return state;
    });
    if (ctx.relay && typeof ctx.relay.onTurnQueued === "function") {
      ctx.relay.onTurnQueued(threadId);
    }
    const mixedKind = text && text.trim() && imagePaths.length > 0 ? "image_text" : imagePaths.length > 0 ? "image" : "text";
    const startText =
      mixedKind === "image_text"
        ? "已收到图文，正在生成…"
        : mixedKind === "image"
          ? "已收到图片，正在生成…"
          : "已收到，正在生成…";
    const startTextRecovered =
      mixedKind === "image_text"
        ? "检测到旧会话失效，已自动切换并开始生成（图文）…"
        : mixedKind === "image"
          ? "检测到旧会话失效，已自动切换并开始生成（图片）…"
          : "检测到旧会话失效，已自动切换并开始生成…";
    return {
      ok: true,
      thread_id: threadId,
      reply_text: submitResult.recovered
        ? startTextRecovered
        : startText,
      reply_card: {
        title: "会话状态",
        markdown: submitResult.recovered
          ? `⏳ ${startTextRecovered}\n- 会话ID ${threadId}`
          : `⏳ ${startText}\n- 会话ID ${threadId}`,
      },
    };
  }

  if (method === "feishu/stop_turn") {
    const chatId = params?.chat_id || params?.chatId || null;
    if (!chatId) {
      throw new Error("feishu/stop_turn requires chat_id");
    }
    const snapshot = store.snapshot();
    const resolved = resolveTurnContext(snapshot, chatId, params);
    const threadId = resolved.threadId;
    if (!threadId) {
      return {
        ok: false,
        stopped: false,
        reply_text: "当前没有可中断的会话。",
        reply_card: {
          title: "会话状态",
          template: "grey",
          markdown: "当前没有可中断的会话。",
        },
      };
    }
    const threadBuffer = snapshot.thread_buffers?.[threadId] ?? null;
    const turnId = params?.turn_id ?? params?.turnId ?? threadBuffer?.current_turn_id ?? null;
    if (!turnId) {
      return {
        ok: false,
        stopped: false,
        thread_id: threadId,
        reply_text: "当前没有正在生成的回复。",
        reply_card: {
          title: "会话状态",
          template: "grey",
          markdown: `当前没有正在生成的回复。\n- 会话ID ${threadId}`,
        },
      };
    }

    const stopped = await app.stopTurn(threadId, turnId, { timeoutMs: 10_000 });
    await store.mutate((state) => {
      const buffer = ensureThreadBuffer(state, threadId);
      if (buffer) {
        if (!buffer.current_turn_id || buffer.current_turn_id === turnId) {
          buffer.current_turn_id = null;
        }
        buffer.last_turn_status = "cancelled";
        buffer.last_update_at = Date.now();
      }
      if (chatId && state.bindings?.[chatId]) {
        state.bindings[chatId].active_thread_id = threadId;
      }
      pushRecentEvent(state, {
        source: "daemon",
        type: "turn_stop_requested",
        chat_id: chatId,
        thread_id: threadId,
        turn_id: turnId,
        stop_mode: stopped?.mode ?? null,
        stop_reason: stopped?.reason ?? null,
      });
      return state;
    });

    if (stopped?.mode === "restart" && ctx.relay && typeof ctx.relay.onTurnCompleted === "function") {
      await ctx.relay.onTurnCompleted(threadId, "cancelled");
    }

    return {
      ok: true,
      stopped: true,
      thread_id: threadId,
      turn_id: turnId,
      stop_mode: stopped?.mode ?? null,
      reply_text: "已停止当前回复。",
      reply_card: {
        title: "会话状态",
        template: "green",
        markdown:
          "🛑 已停止当前回复。" +
          `\n- 会话ID ${threadId}` +
          (stopped?.mode === "restart" ? "\n- 已自动重连后端" : ""),
      },
    };
  }

  if (method === "feishu/pending/list") {
    const chatId = params?.chat_id || params?.chatId || null;
    const items = ctx.pending ? ctx.pending.list(chatId) : [];
    return {
      items,
      reply_text: formatPendingList(items),
      reply_card: {
        title: "待处理请求",
        template: items.length > 0 ? "orange" : "green",
        markdown: `\`\`\`\n${formatPendingList(items)}\n\`\`\``,
      },
    };
  }

  if (method === "feishu/pending/respond") {
    if (!ctx.pending) {
      throw new Error("pending coordinator unavailable");
    }
    const pendingIdRaw = params?.pending_id || params?.pendingId || null;
    const chatId = params?.chat_id || params?.chatId || null;
    const command = params?.command;
    const arg = params?.arg ?? "";
    if (!command) {
      throw new Error("feishu/pending/respond requires command");
    }

    if (!pendingIdRaw) {
      if (!chatId) {
        throw new Error("feishu/pending/respond without pending_id requires chat_id");
      }
      return ctx.pending.resolveAuto(chatId, command, arg);
    }

    const pendingIdText = String(pendingIdRaw);
    if (/^\d+$/.test(pendingIdText) && chatId) {
      const entry = ctx.pending.pickEntryByIndex(chatId, Number.parseInt(pendingIdText, 10));
      if (!entry) {
        return {
          ok: false,
          reply_text: `未找到序号为 ${pendingIdText} 的待处理请求。可回复 1/2/3，或发送 /pending 查看列表。`,
        };
      }
      return ctx.pending.resolveByCommand(entry.id, command, arg);
    }
    return ctx.pending.resolveByCommand(pendingIdText, command, arg);
  }

    if (method === "feishu/inbound_image") {
    const chatId = params?.chat_id || params?.chatId || null;
    const userId = params?.user_id || params?.userId || null;
    const chatType = params?.chat_type || params?.chatType || null;
    const messageId = params?.message_id || params?.messageId || null;
    const imageKey = params?.image_key || params?.imageKey || null;
    if (!chatId) {
      throw new Error("feishu/inbound_image requires chat_id");
    }
    if (!messageId || !imageKey) {
      return {
        ok: true,
        ignored: true,
        reply_text: "收到图片消息，但缺少 message_id 或 image_key。",
      };
    }
    const defer = Boolean(params?.defer);

    let binding = store.snapshot().bindings?.[chatId] ?? null;
    if (!binding) {
      if (isPrivateChatType(chatType)) {
        await store.mutate((state) => {
          let activeCwd = normalizeCwdHint(state.last_qrcode_cwd ?? null);
          let activeThreadId = null;
          const bindHint = pickAutoBindHint(state, chatId);
          if (bindHint) {
            if (bindHint.cwdHint) {
              activeCwd = bindHint.cwdHint;
            }
            if (bindHint.threadIdHint) {
              activeThreadId = bindHint.threadIdHint;
            }
            delete state.pending_bind_codes[bindHint.code];
          }
          const existed = state.bindings?.[chatId] ?? null;
          state.bindings[chatId] = buildBindingRecord(existed, {
            chat_id: chatId,
            user_id: userId ?? existed?.user_id ?? null,
            bound_at: Date.now(),
            active_thread_id: activeThreadId,
            active_cwd: activeCwd,
          });
          pushRecentEvent(state, {
            source: "daemon",
            type: "binding_auto_completed",
            chat_id: chatId,
            thread_id: activeThreadId,
            cwd: activeCwd,
            code_consumed: bindHint?.code ?? null,
            bind_hint_source: bindHint?.source ?? null,
          });
          return state;
        });
      } else {
        const bindInfo = await ensureBindCodeForChat(store, chatId);
        const openChatLink = buildChatOpenLink((ctx.bridgeConfig?.bot_open_id ?? "").trim());
        return {
          ok: true,
          unbound: true,
          group_hint: true,
          bind_code: bindInfo.code,
          bind_command: bindInfo.bindCommand,
          expires_at: bindInfo.expiresAt,
          open_chat_link: openChatLink,
          reply_text: `当前会话尚未绑定，请先发送：${bindInfo.bindCommand}`,
        };
      }
    }

    if (!ctx.feishu || !ctx.feishu.status().running) {
      throw new Error("feishu bridge not running");
    }
    const localImagePath = buildInboundImagePath(messageId, imageKey);
    await ctx.feishu.saveIncomingImage(messageId, imageKey, localImagePath);
    if (defer) {
      return {
        ok: true,
        deferred: true,
        image_path: localImagePath,
        reply_text: "已收到图片，等待与文本合并发送。",
      };
    }

    binding = store.snapshot().bindings?.[chatId] ?? null;
    return handleRpcCall(
      store,
      app,
      "feishu/submit_image",
      {
        chat_id: chatId,
        user_id: userId,
        thread_id: binding?.active_thread_id ?? null,
        image_path: localImagePath,
        cwd: binding?.active_cwd ?? null,
      },
      ctx,
    );
  }

  if (method === "feishu/inbound_text") {
    const text = (params?.text ?? "").trim();
    const chatId = params?.chat_id || params?.chatId || null;
    const userId = params?.user_id || params?.userId || null;
    const chatType = params?.chat_type || params?.chatType || null;
    if (!chatId) {
      throw new Error("feishu/inbound_text requires chat_id");
    }
    if (!text) {
      return { ok: true, ignored: true, reply_text: "" };
    }
    let match = null;

    if (text === "/help" || text === "/?") {
      return {
        ok: true,
        reply_text: helpText(),
        reply_card: {
          title: "可用命令",
          markdown: `\`\`\`\n${helpText()}\n\`\`\``,
        },
      };
    }

    if (text === "/pending") {
      return handleRpcCall(store, app, "feishu/pending/list", { chat_id: chatId }, ctx);
    }

    if (text === "/stop") {
      return handleRpcCall(store, app, "feishu/stop_turn", { chat_id: chatId }, ctx);
    }

    if (text === "/status") {
      return handleRpcCall(
        store,
        app,
        "feishu/chat_status",
        { chat_id: chatId, chat_type: chatType },
        ctx,
      );
    }

    match = text.match(/^\/resume(?:\s+(.+))?$/i);
    if (match) {
      const target = (match[1] ?? "").trim();
      return handleRpcCall(
        store,
        app,
        "feishu/resume",
        {
          chat_id: chatId,
          action: target ? "switch" : "list",
          target: target || null,
        },
        ctx,
      );
    }

    match = text.match(/^\/fork(?:\s+(.+))?$/i);
    if (match) {
      const target = (match[1] ?? "").trim();
      return handleRpcCall(
        store,
        app,
        "feishu/fork",
        {
          chat_id: chatId,
          target: target || null,
        },
        ctx,
      );
    }

    match = text.match(/^\/review(?:\s+([\s\S]+))?$/i);
    if (match) {
      const arg = (match[1] ?? "").trim();
      return handleRpcCall(
        store,
        app,
        "feishu/review",
        {
          chat_id: chatId,
          arg: arg || "",
        },
        ctx,
      );
    }

    if (text === "/compact") {
      return handleRpcCall(
        store,
        app,
        "feishu/compact",
        { chat_id: chatId },
        ctx,
      );
    }

    match = text.match(/^\/model(?:\s+(.+))?$/i);
    if (match) {
      const arg = (match[1] ?? "").trim();
      let action = "list";
      let model = "";
      if (!arg || arg.toLowerCase() === "list") {
        action = "list";
      } else if (arg.toLowerCase() === "clear" || arg.toLowerCase() === "default") {
        action = "clear";
      } else {
        action = "set";
        model = arg;
      }
      return handleRpcCall(
        store,
        app,
        "feishu/model",
        {
          chat_id: chatId,
          action,
          model,
        },
        ctx,
      );
    }

    match = text.match(/^\/approvals(?:\s+(.+))?$/i);
    if (match) {
      const rawArg = (match[1] ?? "").trim();
      const arg = normalizeApprovalPolicy(rawArg);
      const lowered = rawArg.toLowerCase();
      const action = !rawArg
        ? "get"
        : lowered === "clear" || lowered === "default"
          ? "clear"
          : "set";
      return handleRpcCall(
        store,
        app,
        "feishu/approvals",
        {
          chat_id: chatId,
          action,
          approval_policy: arg,
        },
        ctx,
      );
    }

    match = text.match(/^\/permissions(?:\s+(.+))?$/i);
    if (match) {
      const rawArg = (match[1] ?? "").trim();
      const arg = normalizeSandboxMode(rawArg);
      const lowered = rawArg.toLowerCase();
      const action = !rawArg
        ? "get"
        : lowered === "clear" || lowered === "default"
          ? "clear"
          : "set";
      return handleRpcCall(
        store,
        app,
        "feishu/permissions",
        {
          chat_id: chatId,
          action,
          sandbox_mode: arg,
        },
        ctx,
      );
    }

    match = text.match(/^\/plan(?:\s+(.+))?$/i);
    if (match) {
      const actionArg = (match[1] ?? "").trim();
      return handleRpcCall(
        store,
        app,
        "feishu/plan",
        {
          chat_id: chatId,
          action: actionArg || "toggle",
        },
        ctx,
      );
    }

    if (text === "/init") {
      return handleRpcCall(
        store,
        app,
        "feishu/init",
        {
          chat_id: chatId,
          user_id: userId,
        },
        ctx,
      );
    }

    if (text === "/group" || text === "/group-help") {
      return {
        ok: true,
        reply_text: groupUsageMarkdown(),
        reply_card: {
          title: "群聊说明",
          template: "blue",
          markdown: groupUsageMarkdown(),
        },
      };
    }

    if (text === "/skills") {
      return handleRpcCall(store, app, "feishu/skills", { chat_id: chatId }, ctx);
    }

    match = text.match(/^\/mcp(?:\s+([\s\S]+))?$/i);
    if (match) {
      return handleRpcCall(
        store,
        app,
        "feishu/codex_mcp",
        {
          chat_id: chatId,
          args: (match[1] ?? "").trim(),
        },
        ctx,
      );
    }

    match = text.match(/^\/bind\s+(\S+)$/i);
    if (match) {
      return handleRpcCall(
        store,
        app,
        "feishu/bind",
        {
          code: match[1],
          chat_id: chatId,
          user_id: userId,
        },
        ctx,
      );
    }

    if (text === "/new") {
      return handleRpcCall(
        store,
        app,
        "feishu/new_thread",
        { chat_id: chatId },
        ctx,
      );
    }

    if (text === "/threads" || text === "/sessions") {
      return handleRpcCall(
        store,
        app,
        "feishu/threads",
        { chat_id: chatId },
        ctx,
      );
    }

    match = text.match(/^\/(?:sw|switch)(?:\s+(.+))?$/i);
    if (match) {
      const target = (match[1] ?? "").trim();
      if (!target) {
        return handleRpcCall(
          store,
          app,
          "feishu/threads",
          { chat_id: chatId },
          ctx,
        );
      }
      return handleRpcCall(
        store,
        app,
        "feishu/switch_thread",
        { chat_id: chatId, target },
        ctx,
      );
    }

    if (text === "/rebind") {
      return handleRpcCall(
        store,
        app,
        "feishu/rebind",
        { chat_id: chatId },
        ctx,
      );
    }

    match = text.match(/^\/(?:cwd|cd)(?:\s+([\s\S]+))?$/i);
    if (match) {
      const rawArg = (match[1] ?? "").trim();
      if (!rawArg) {
        return handleRpcCall(
          store,
          app,
          "feishu/cwd",
          {
            chat_id: chatId,
            action: "get",
          },
          ctx,
        );
      }
      let createNewThread = false;
      let pathArg = rawArg;
      if (/\s+--new$/i.test(pathArg)) {
        createNewThread = true;
        pathArg = pathArg.replace(/\s+--new$/i, "").trim();
      } else if (/\s+new$/i.test(pathArg)) {
        createNewThread = true;
        pathArg = pathArg.replace(/\s+new$/i, "").trim();
      }
      return handleRpcCall(
        store,
        app,
        "feishu/cwd",
        {
          chat_id: chatId,
          action: "set",
          path: pathArg,
          new_thread: createNewThread,
        },
        ctx,
      );
    }

    match = text.match(/^\/approve(?:\s+(\S+))?(?:\s+(session))?$/i);
    if (match) {
      const pendingId = (match[1] ?? "").trim() || null;
      const mode = match[2] ? "session" : "";
      return handleRpcCall(
        store,
        app,
        "feishu/pending/respond",
        {
          pending_id: pendingId,
          command: "approve",
          arg: mode,
          chat_id: chatId,
        },
        ctx,
      );
    }

    match = text.match(/^\/(deny|decline)(?:\s+(\S+))?$/i);
    if (match) {
      return handleRpcCall(
        store,
        app,
        "feishu/pending/respond",
        {
          pending_id: (match[2] ?? "").trim() || null,
          command: "deny",
          arg: "deny",
          chat_id: chatId,
        },
        ctx,
      );
    }

    match = text.match(/^\/cancel(?:\s+(\S+))?$/i);
    if (match) {
      return handleRpcCall(
        store,
        app,
        "feishu/pending/respond",
        {
          pending_id: (match[1] ?? "").trim() || null,
          command: "cancel",
          arg: "cancel",
          chat_id: chatId,
        },
        ctx,
      );
    }

    const pendingQuickMap = {
      "1": { command: "approve", arg: "" },
      "2": { command: "deny", arg: "deny" },
      "3": { command: "approve", arg: "session" },
    };
    const quick = pendingQuickMap[text];
    if (quick && ctx.pending?.hasApprovalForChat?.(chatId)) {
      return handleRpcCall(
        store,
        app,
        "feishu/pending/respond",
        {
          pending_id: null,
          command: quick.command,
          arg: quick.arg,
          chat_id: chatId,
        },
        ctx,
      );
    }

    match = text.match(/^\/answer\s+(\S+)\s+([\s\S]+)$/i);
    if (match) {
      return handleRpcCall(
        store,
        app,
        "feishu/pending/respond",
        {
          pending_id: match[1],
          command: "answer",
          arg: match[2],
        },
        ctx,
      );
    }

    let binding = store.snapshot().bindings?.[chatId] ?? null;
    if (!binding) {
      if (isPrivateChatType(chatType)) {
        await store.mutate((state) => {
          let activeCwd = normalizeCwdHint(state.last_qrcode_cwd ?? null);
          let activeThreadId = null;
          const bindHint = pickAutoBindHint(state, chatId);
          if (bindHint) {
            if (bindHint.cwdHint) {
              activeCwd = bindHint.cwdHint;
            }
            if (bindHint.threadIdHint) {
              activeThreadId = bindHint.threadIdHint;
            }
            delete state.pending_bind_codes[bindHint.code];
          }
          const existed = state.bindings?.[chatId] ?? null;
          state.bindings[chatId] = buildBindingRecord(existed, {
            chat_id: chatId,
            user_id: userId ?? existed?.user_id ?? null,
            bound_at: Date.now(),
            active_thread_id: activeThreadId,
            active_cwd: activeCwd,
          });
          pushRecentEvent(state, {
            source: "daemon",
            type: "binding_auto_completed",
            chat_id: chatId,
            thread_id: activeThreadId,
            cwd: activeCwd,
            code_consumed: bindHint?.code ?? null,
            bind_hint_source: bindHint?.source ?? null,
          });
          return state;
        });
        const autoBinding = store.snapshot().bindings?.[chatId] ?? null;
        return handleRpcCall(
          store,
          app,
          "feishu/submit_text",
          {
            text,
            chat_id: chatId,
            user_id: userId,
            thread_id: autoBinding?.active_thread_id ?? null,
            cwd: autoBinding?.active_cwd ?? null,
          },
          ctx,
        );
      }
      const bindInfo = await ensureBindCodeForChat(store, chatId);
      const openChatLink = buildChatOpenLink((ctx.bridgeConfig?.bot_open_id ?? "").trim());
      return {
        ok: true,
        unbound: true,
        group_hint: true,
        bind_code: bindInfo.code,
        bind_command: bindInfo.bindCommand,
        expires_at: bindInfo.expiresAt,
        open_chat_link: openChatLink,
        reply_text: `当前会话尚未绑定，请先发送：${bindInfo.bindCommand}`,
      };
    }

    return handleRpcCall(
      store,
      app,
      "feishu/submit_text",
      {
        text,
        chat_id: chatId,
        user_id: userId,
        cwd: binding?.active_cwd ?? null,
      },
      ctx,
    );
  }

  if (method === "feishu/events/recent") {
    const limit = Number.isFinite(params?.limit) ? Math.max(1, Math.min(200, params.limit)) : 20;
    const recent = store.snapshot().recent_events;
    return {
      items: recent.slice(-limit),
    };
  }

  throw new Error(`unknown method: ${method}`);
}

export async function runDaemon() {
  const runDir = getRunDir();
  const pidPath = getDaemonPidPath();
  const endpoint = getBridgeRpcEndpoint();
  const parsedEndpoint = parseRpcEndpoint(endpoint);
  const statePath = getBridgeStatePath();
  const store = new StateStore(statePath);
  await store.load();
  const bridgeConfig = await readJsonIfExists(getBridgeConfigPath());
  const runtime = {
    defaultModel: await loadConfiguredModelHint(),
  };
  const initialAppCwd = pickInitialAppCwd(store.snapshot(), bridgeConfig);

  fs.mkdirSync(runDir, { recursive: true });
  writePidFile(pidPath);
  if (parsedEndpoint.kind === "unix") {
    safeUnlink(parsedEndpoint.path);
  }

  const app = new AppServerClient({
    codexBin:
      bridgeConfig && typeof bridgeConfig.codex_bin === "string" && bridgeConfig.codex_bin.trim()
        ? bridgeConfig.codex_bin.trim()
        : undefined,
    protoCwd: initialAppCwd,
  });
  const inboundImageDrafts = new Map();

  const clearImageDraft = (chatId) => {
    const entry = inboundImageDrafts.get(chatId);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    inboundImageDrafts.delete(chatId);
  };

  const stageImageDraft = (chatId, imagePath, message) => {
    const existing = inboundImageDrafts.get(chatId) ?? {
      images: [],
      userId: null,
      chatType: null,
      timer: null,
    };
    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    existing.images.push(imagePath);
    existing.userId = message?.userId ?? existing.userId ?? null;
    existing.chatType = message?.chatType ?? existing.chatType ?? null;
    existing.timer = setTimeout(() => {
      void (async () => {
        const active = inboundImageDrafts.get(chatId);
        if (!active || active.images.length === 0) {
          return;
        }
        try {
          if (feishu) {
            await feishu.sendMarkdownCard(chatId, {
              title: "会话状态",
              template: "wathet",
              markdown:
                `🖼️ 图片仍在草稿区（${active.images.length} 张）\n\n` +
                "继续发送文字可自动图文提问，或发送 `/send` / `/clear`。",
            });
          }
        } catch (err) {
          await appendEvent(store, {
            source: "daemon",
            type: "image_draft_reminder_failed",
            chat_id: chatId,
            error: err?.message ?? String(err),
          });
        }
      })();
    }, IMAGE_DRAFT_WAIT_MS);
    inboundImageDrafts.set(chatId, existing);
    return existing.images.length;
  };

  const deliverFeishuResult = async (chatId, result) => {
    if (!feishu || !chatId || !result) {
      return;
    }
    if (result?.unbound && result?.bind_command) {
      try {
        await feishu.sendBindCard(chatId, {
          bindCommand: result.bind_command,
          code: result.bind_code,
          expiresAt: result.expires_at,
          openChatLink: result.open_chat_link ?? null,
          groupHint: Boolean(result.group_hint),
        });
      } catch {
        const fallbackText = result?.reply_text || `请先发送：${result.bind_command}`;
        if (fallbackText) {
          await feishu.sendText(chatId, fallbackText);
        }
      }
      return;
    }

    let statusCardSent = false;
    if (result?.reply_card?.markdown) {
      try {
        await feishu.sendMarkdownCard(chatId, {
          title: result?.reply_card?.title || "会话状态",
          markdown: result.reply_card.markdown,
          template: result?.reply_card?.template || "blue",
          note: result?.reply_card?.note ?? "",
        });
        statusCardSent = true;
      } catch {
        // fall back to plain text below
      }
    }
    const text = result?.reply_text || "ok";
    if (text && !statusCardSent) {
      try {
        await feishu.sendMarkdownCard(chatId, {
          title: "会话状态",
          template: "blue",
          markdown: statusMarkdownFromText(text),
        });
      } catch {
        await feishu.sendText(chatId, text);
      }
    }
  };

  const submitImageDraft = async (chatId, opts = {}) => {
    const entry = inboundImageDrafts.get(chatId);
    if (!entry || entry.images.length === 0) {
      return false;
    }
    clearImageDraft(chatId);
    const result = await handleRpcCall(
      store,
      app,
      "feishu/submit_mixed",
      {
        chat_id: chatId,
        user_id: entry.userId,
        chat_type: entry.chatType,
        text: typeof opts?.text === "string" ? opts.text : null,
        image_paths: entry.images,
      },
      { feishu, pending, runtime, relay },
    );
    await deliverFeishuResult(chatId, result);
    return true;
  };

  let feishu = null;
  if (bridgeConfig?.app_id && bridgeConfig?.app_secret) {
    feishu = new FeishuBridge({
      appId: bridgeConfig.app_id,
      appSecret: bridgeConfig.app_secret,
      onEvent: async (event) => {
        await appendEvent(store, {
          source: "feishu",
          ...event,
        });
      },
      onMessage: async (message) => {
        try {
          const inboundType = String(message?.messageType ?? "text").toLowerCase();
          if (inboundType !== "text" && inboundType !== "image") {
            if (inboundType === "file") {
              await feishu.sendMarkdownCard(message.chatId, {
                title: "会话状态",
                template: "grey",
                markdown: "暂不支持文件直传到 Codex，请先在终端里提供文件路径后再处理。",
              });
            }
            return;
          }
          if (inboundType === "image") {
            const result = await handleRpcCall(
              store,
              app,
              "feishu/inbound_image",
              {
                chat_id: message.chatId,
                user_id: message.userId,
                chat_type: message.chatType,
                message_id: message.messageId,
                image_key: message.imageKey,
                defer: true,
              },
              { feishu, pending, runtime, relay },
            );
            if (result?.image_path) {
              const count = stageImageDraft(message.chatId, result.image_path, message);
              await feishu.sendMarkdownCard(message.chatId, {
                title: "会话状态",
                markdown:
                  `🖼️ 已暂存图片 **${count}** 张\n\n` +
                  "💡 **Tips**\n" +
                  "- 直接再发一段文字：自动图文一起提问\n" +
                  "- 发送 `/send`：只提交图片\n" +
                  "- 发送 `/clear`：清空图片草稿",
                template: "wathet",
              });
              return;
            }
            await deliverFeishuResult(message.chatId, result);
            return;
          }

          const trimmed = String(message?.text ?? "").trim();
          const normalizedKey = trimmed.toLowerCase().replace(/\s+/g, "");
          const draft = inboundImageDrafts.get(message.chatId);
          const isSendAlias = new Set(["发送", "提交", "发出", "send", "确认发送", "确认提交"]).has(normalizedKey);
          const isClearAlias = new Set(["清空", "取消", "作废", "clear", "清除", "丢弃"]).has(normalizedKey);
          const isNewAlias = new Set(["新会话", "新建会话", "new", "重开"]).has(normalizedKey);
          const isRebindAlias = new Set(["重绑", "重新绑定", "rebind"]).has(normalizedKey);
          const isHelpAlias = new Set(["帮助", "菜单", "help"]).has(normalizedKey);
          const isPendingAlias = new Set(["待处理", "pending"]).has(normalizedKey);
          const isStatusAlias = new Set(["状态", "status"]).has(normalizedKey);
          const isStopAlias = new Set(["停止", "中断", "打断", "stop"]).has(normalizedKey);
          const isSkillsAlias = new Set(["skills", "skill", "技能"]).has(normalizedKey);
          const isMcpAlias = new Set(["mcp"]).has(normalizedKey);
          const isGroupAlias = new Set(["群聊", "群说明", "group"]).has(normalizedKey);
          const isResumeAlias = new Set(["恢复会话", "恢复", "resume"]).has(normalizedKey);
          const isForkAlias = new Set(["分叉会话", "分支会话", "fork"]).has(normalizedKey);
          const isReviewAlias = new Set(["代码审查", "审查", "review"]).has(normalizedKey);
          const isCompactAlias = new Set(["压缩会话", "压缩", "compact"]).has(normalizedKey);
          const isModelAlias = new Set(["模型", "model"]).has(normalizedKey);
          const isApprovalsAlias = new Set(["审批策略", "审批", "approvals"]).has(normalizedKey);
          const isPermissionsAlias = new Set(["权限策略", "权限", "permissions"]).has(normalizedKey);
          const isPlanAlias = new Set(["计划模式", "计划", "plan"]).has(normalizedKey);
          const isInitAlias = new Set(["初始化", "init"]).has(normalizedKey);
          let commandText = trimmed;
          if (isSendAlias && draft && draft.images.length > 0) {
            commandText = "/send";
          } else if (isClearAlias && draft && draft.images.length > 0) {
            commandText = "/clear";
          } else if (isNewAlias) {
            commandText = "/new";
          } else if (isRebindAlias) {
            commandText = "/rebind";
          } else if (isHelpAlias) {
            commandText = "/help";
          } else if (isPendingAlias) {
            commandText = "/pending";
          } else if (isStatusAlias) {
            commandText = "/status";
          } else if (isStopAlias) {
            commandText = "/stop";
          } else if (isSkillsAlias) {
            commandText = "/skills";
          } else if (isMcpAlias) {
            commandText = "/mcp";
          } else if (isGroupAlias) {
            commandText = "/group";
          } else if (isResumeAlias) {
            commandText = "/resume";
          } else if (isForkAlias) {
            commandText = "/fork";
          } else if (isReviewAlias) {
            commandText = "/review";
          } else if (isCompactAlias) {
            commandText = "/compact";
          } else if (isModelAlias) {
            commandText = "/model";
          } else if (isApprovalsAlias) {
            commandText = "/approvals";
          } else if (isPermissionsAlias) {
            commandText = "/permissions";
          } else if (isPlanAlias) {
            commandText = "/plan";
          } else if (isInitAlias) {
            commandText = "/init";
          }

          if (commandText === "/clear") {
            clearImageDraft(message.chatId);
            await feishu.sendMarkdownCard(message.chatId, {
              title: "会话状态",
              markdown: "🧹 已清空待发送图片。",
              template: "green",
            });
            return;
          }
          if (commandText === "/send") {
            const submitted = await submitImageDraft(message.chatId, {
              text: null,
              reason: "manual",
            });
            if (!submitted) {
              await feishu.sendMarkdownCard(message.chatId, {
                title: "会话状态",
                markdown: "当前没有待发送图片。",
                template: "grey",
              });
            }
            return;
          }
          if (draft && draft.images.length > 0 && !commandText.startsWith("/")) {
            await submitImageDraft(message.chatId, {
              text: message.text,
              reason: "text_appended",
            });
            return;
          }

          const result = await handleRpcCall(
            store,
            app,
            "feishu/inbound_text",
            {
              text: commandText,
              chat_id: message.chatId,
              user_id: message.userId,
              chat_type: message.chatType,
            },
            { feishu, pending, runtime, relay },
          );
          await deliverFeishuResult(message.chatId, result);
        } catch (err) {
          await appendEvent(store, {
            source: "feishu",
            type: "inbound_handle_failed",
            chat_id: message.chatId,
            error: err?.message ?? String(err),
          });
          try {
            const friendly = mapUserFacingError(err);
            await feishu.sendMarkdownCard(message.chatId, {
              title: "会话状态",
              template: "red",
              markdown: statusMarkdownFromText(friendly),
            });
          } catch {
            // noop
          }
        }
      },
    });
  }

  const relay = createFeishuRelay(store, feishu, (event) => appendEvent(store, event), runtime);
  const pending = new PendingCoordinator({
    store,
    feishu,
    appendEventFn: (event) => appendEvent(store, event),
  });

  app.on("notification", async (msg) => {
    try {
      await handleAppNotification(store, msg, relay);
    } catch {
      // keep stream alive
    }
  });
  app.on("request", async (msg) => {
    try {
      await handleAppServerRequest(store, app, pending, msg);
    } catch {
      // keep stream alive
    }
  });
  app.on("stderr", async (line) => {
    await appendEvent(store, {
      source: "app_server",
      type: "stderr",
      line,
    });
  });
  app.on("exit", async (info) => {
    await appendEvent(store, {
      source: "app_server",
      type: "exit",
      code: info.code ?? null,
      signal: info.signal ?? null,
    });
  });
  app.on("error", async (err) => {
    await appendEvent(store, {
      source: "app_server",
      type: "error",
      error: err?.message ?? String(err),
    });
  });

  try {
    await app.ensureStarted();
    await appendEvent(store, {
      source: "daemon",
      type: "app_server_started",
      status: app.status(),
    });
  } catch (err) {
    await appendEvent(store, {
      source: "daemon",
      type: "app_server_start_failed",
      error: err?.message ?? String(err),
    });
  }

  if (feishu) {
    await feishu.start();
  }

  const server = await createJsonRpcServer({
    endpoint,
    onRequest: async (method, params) =>
      handleRpcCall(store, app, method, params, {
        feishu,
        pending,
        bridgeConfig,
        runtime,
        relay,
      }),
    onNotification: async (method, params) => {
      await appendEvent(store, {
        source: "client",
        type: "notification",
        method,
        params: params ?? null,
      });
    },
  });

  const shutdown = async () => {
    server.close(async () => {
      try {
        removePidFileIfOwned(pidPath);
        relay.shutdown();
        await pending.shutdown();
        if (feishu) {
          await feishu.stop();
        }
        await app.stop();
      } finally {
        process.exit(0);
      }
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => {
    try {
      removePidFileIfOwned(pidPath);
    } catch {
      // noop
    }
  });

  // eslint-disable-next-line no-console
  console.log("codex-feishu daemon started");
  // eslint-disable-next-line no-console
  console.log(`rpc endpoint: ${endpoint}`);
  const defaultEndpoint = getDefaultBridgeRpcEndpoint();
  if (endpoint !== defaultEndpoint) {
    // eslint-disable-next-line no-console
    console.log(`rpc default: ${defaultEndpoint}`);
  } else if (parsedEndpoint.kind === "unix" && endpoint !== getBridgeSocketPath()) {
    // eslint-disable-next-line no-console
    console.log(`socket default: ${getBridgeSocketPath()}`);
  }
  // eslint-disable-next-line no-console
  console.log(`state: ${statePath}`);
  // eslint-disable-next-line no-console
  console.log(
    `feishu config: ${
      bridgeConfig?.app_id && bridgeConfig?.app_secret ? "configured" : "missing app_id/app_secret"
    }`,
  );
  if (feishu) {
    // eslint-disable-next-line no-console
    console.log(`feishu runtime: ${feishu.status().running ? "running" : "not running"}`);
  }
}
