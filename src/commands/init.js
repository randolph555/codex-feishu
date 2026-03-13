import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { ensureDir, readJsonIfExists, readTextIfExists, writeText } from "../lib/fs_utils.js";
import { hasManagedMcpBlock, hasMcpServerSection, upsertManagedMcpBlock } from "../lib/install_config.js";
import { getBridgeConfigPath, getBridgeHome, getCodexConfigPath, getPromptsDir } from "../lib/paths.js";

const FEISHU_QRCODE_PROMPT_NAME = "feishu-qrcode";
const FEISHU_QRCODE_PROMPT_ALIAS = "fq";
const FEISHU_QRCODE_PROMPT = [
  "Call the `feishu_qrcode` MCP tool.",
  "Return the tool result directly.",
  "Do not summarize away the QR text or ASCII block.",
  "If the tool returns both a link and a bind command, keep both.",
].join("\n");

function buildBridgeConfig(flags, existing = {}) {
  return {
    version: 1,
    app_id: flags["app-id"] || process.env.FEISHU_APP_ID || existing.app_id || "",
    app_secret: flags["app-secret"] || process.env.FEISHU_APP_SECRET || existing.app_secret || "",
    bot_open_id: flags["bot-open-id"] || process.env.FEISHU_BOT_OPEN_ID || existing.bot_open_id || "",
    encrypt_key: flags["encrypt-key"] || process.env.FEISHU_ENCRYPT_KEY || existing.encrypt_key || "",
    verify_token: flags["verify-token"] || process.env.FEISHU_VERIFY_TOKEN || existing.verify_token || "",
    codex_bin:
      flags["codex-bin"] ||
      process.env.CODEX_FEISHU_CODEX_BIN ||
      process.env.CODEX_BIN ||
      existing.codex_bin ||
      "",
    event_mode: "long_connection",
  };
}

function detectWindowsCodexBin() {
  if (process.platform !== "win32") {
    return "";
  }
  const tryWhere = (name) => {
    try {
      const output = execFileSync("where.exe", [name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      return lines[0] || "";
    } catch {
      return "";
    }
  };
  return tryWhere("codex.cmd") || tryWhere("codex.exe") || tryWhere("codex");
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function formatReason(prefix, code, msg, status) {
  if (typeof code === "number" || typeof code === "string") {
    return `${prefix} code=${code}${msg ? ` msg=${msg}` : ""}`;
  }
  if (status) {
    return `${prefix} http=${status}`;
  }
  return prefix;
}

async function tryFetchBotOpenId(appId, appSecret) {
  try {
    const authResp = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(6000),
    });
    const authJson = await readJsonSafe(authResp);
    if (!authResp.ok) {
      return {
        ok: false,
        reason: formatReason("tenant_access_token failed", authJson?.code, authJson?.msg, authResp.status),
      };
    }
    if (!authJson || authJson.code !== 0 || !authJson.tenant_access_token) {
      return {
        ok: false,
        reason: formatReason(
          "tenant_access_token invalid response",
          authJson?.code,
          authJson?.msg,
          authResp.status,
        ),
      };
    }

    const botResp = await fetch("https://open.feishu.cn/open-apis/bot/v3/info/", {
      method: "GET",
      headers: { authorization: `Bearer ${authJson.tenant_access_token}` },
      signal: AbortSignal.timeout(6000),
    });
    const botJson = await readJsonSafe(botResp);
    if (!botResp.ok) {
      return {
        ok: false,
        reason: formatReason("bot_info failed", botJson?.code, botJson?.msg, botResp.status),
      };
    }
    if (!botJson || botJson.code !== 0) {
      return {
        ok: false,
        reason: formatReason("bot_info invalid response", botJson?.code, botJson?.msg, botResp.status),
      };
    }
    const botOpenId = botJson?.bot?.open_id || botJson?.data?.bot?.open_id || "";
    if (!botOpenId) {
      return {
        ok: false,
        reason: "bot_info success but open_id is empty (enable bot ability and publish app first)",
      };
    }
    return { ok: true, botOpenId };
  } catch (error) {
    return {
      ok: false,
      reason: `auto detect request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function ensureCodexConfigHasMcpBlock() {
  const configPath = getCodexConfigPath();
  const configDir = path.dirname(configPath);
  await ensureDir(configDir);
  const current = (await readTextIfExists(configPath)) ?? "";
  if (hasManagedMcpBlock(current) || hasMcpServerSection(current, "codex_feishu")) {
    return { updated: false, configPath };
  }
  await writeText(configPath, upsertManagedMcpBlock(current, "codex-feishu", ["mcp"]));
  return { updated: true, configPath };
}

async function ensureCodexPromptFiles() {
  const promptsDir = getPromptsDir();
  await ensureDir(promptsDir);

  const promptMain = path.join(promptsDir, `${FEISHU_QRCODE_PROMPT_NAME}.md`);
  const promptAlias = path.join(promptsDir, `${FEISHU_QRCODE_PROMPT_ALIAS}.md`);
  await writeText(promptMain, `${FEISHU_QRCODE_PROMPT}
`);
  await writeText(promptAlias, `${FEISHU_QRCODE_PROMPT}
`);
  return { promptsDir, files: [promptMain, promptAlias] };
}

async function writeBridgeConfig(bridgeConfig) {
  const bridgeHome = getBridgeHome();
  const bridgeConfigPath = getBridgeConfigPath();
  await ensureDir(bridgeHome);
  await writeText(`${bridgeConfigPath}`, `${JSON.stringify(bridgeConfig, null, 2)}\n`);
  return { bridgeConfigPath, bridgeConfig };
}

export async function runInit(flags, options = {}) {
  const existingBridgeConfig = (await readJsonIfExists(getBridgeConfigPath())) ?? {};
  const bridgeConfig = buildBridgeConfig(flags, existingBridgeConfig);
  let autoDetectedCodexBin = "";
  if (!bridgeConfig.codex_bin && process.platform === "win32") {
    autoDetectedCodexBin = detectWindowsCodexBin();
    if (autoDetectedCodexBin) {
      bridgeConfig.codex_bin = autoDetectedCodexBin;
    }
  }
  const hasManualBotOpenId =
    Boolean(flags["bot-open-id"] && flags["bot-open-id"].trim()) ||
    Boolean(process.env.FEISHU_BOT_OPEN_ID && process.env.FEISHU_BOT_OPEN_ID.trim());
  let autoDetectBotOpenIdResult = null;
  if (!bridgeConfig.bot_open_id && !hasManualBotOpenId && bridgeConfig.app_id && bridgeConfig.app_secret) {
    autoDetectBotOpenIdResult = await tryFetchBotOpenId(bridgeConfig.app_id, bridgeConfig.app_secret);
    if (autoDetectBotOpenIdResult.ok) {
      bridgeConfig.bot_open_id = autoDetectBotOpenIdResult.botOpenId;
    }
  }

  const { updated, configPath } = await ensureCodexConfigHasMcpBlock();
  const promptInfo = await ensureCodexPromptFiles();
  const { bridgeConfigPath } = await writeBridgeConfig(bridgeConfig);

  // eslint-disable-next-line no-console
  console.log("codex-feishu init completed");
  // eslint-disable-next-line no-console
  console.log(`- Codex config: ${configPath}${updated ? " (updated)" : " (already configured)"}`);
  // eslint-disable-next-line no-console
  console.log(`- Bridge config: ${bridgeConfigPath}`);
  console.log(`- Prompts: ${promptInfo.files.join(", ")}`);
  // eslint-disable-next-line no-console
  console.log(`- codex_bin: ${bridgeConfig.codex_bin ? bridgeConfig.codex_bin : "(default: codex in PATH)"}`);
  if (autoDetectedCodexBin) {
    // eslint-disable-next-line no-console
    console.log(`- codex_bin auto-detected: ${autoDetectedCodexBin}`);
  }

  if (!bridgeConfig.app_id || !bridgeConfig.app_secret) {
    // eslint-disable-next-line no-console
    console.log(
      "- Missing app_id/app_secret. Set FEISHU_APP_ID and FEISHU_APP_SECRET, then re-run init.",
    );
  }
  if (!bridgeConfig.bot_open_id) {
    // eslint-disable-next-line no-console
    console.log(
      "- Optional bot_open_id is empty. QR will encode /bind CODE instead of opening bot chat directly.",
    );
    if (autoDetectBotOpenIdResult && !autoDetectBotOpenIdResult.ok) {
      // eslint-disable-next-line no-console
      console.log(`- bot_open_id auto-detect failed: ${autoDetectBotOpenIdResult.reason}`);
      // eslint-disable-next-line no-console
      console.log(
        "- Degraded gracefully: binding and chat sync still work; one-tap open-chat QR is disabled.",
      );
      // eslint-disable-next-line no-console
      console.log("- To set manually: codex-feishu init --app-id <...> --app-secret <...> --bot-open-id <...>");
    }
  }

  // eslint-disable-next-line no-console
  console.log("\nNext:");
  if (options.startDaemon) {
    // eslint-disable-next-line no-console
    console.log("1) Daemon will be restarted in background (see Daemon section below).");
    // eslint-disable-next-line no-console
    console.log("2) Start Codex normally: codex");
    // eslint-disable-next-line no-console
    console.log(`3) In Codex use: /prompts:${FEISHU_QRCODE_PROMPT_NAME}`);
    console.log("4) Bind info will also be printed automatically below (or refresh with: codex-feishu qrcode).");
  } else {
    // eslint-disable-next-line no-console
    console.log("1) Start daemon: codex-feishu daemon");
    // eslint-disable-next-line no-console
    console.log("2) Start Codex normally: codex");
    // eslint-disable-next-line no-console
    console.log(`3) In Codex use: /prompts:${FEISHU_QRCODE_PROMPT_NAME}`);
    console.log("4) Or get bind info directly: codex-feishu qrcode");
  }
}
