import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, readJsonIfExists, readTextIfExists, writeText } from "../lib/fs_utils.js";
import { getBridgeConfigPath, getBridgeHome, getCodexConfigPath, getPromptsDir } from "../lib/paths.js";

const CODEX_FEISHU_MARK_BEGIN = "# BEGIN codex-feishu";
const CODEX_FEISHU_MARK_END = "# END codex-feishu";

const MCP_BLOCK = `${CODEX_FEISHU_MARK_BEGIN}
[mcp_servers.codex_feishu]
command = "codex-feishu"
args = ["mcp"]
${CODEX_FEISHU_MARK_END}
`;

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
  if (current.includes(CODEX_FEISHU_MARK_BEGIN)) {
    return { updated: false, configPath };
  }
  const joiner = current.endsWith("\n") || current.length === 0 ? "" : "\n";
  await writeText(configPath, `${current}${joiner}\n${MCP_BLOCK}`);
  return { updated: true, configPath };
}

async function cleanupLegacyPromptFiles() {
  const promptsDir = getPromptsDir();
  await ensureDir(promptsDir);

  const promptFq = path.join(promptsDir, "fq.md");
  const promptLegacy = path.join(promptsDir, "feishu-qrcode.md");
  try {
    await fs.unlink(promptFq);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }
  try {
    await fs.unlink(promptLegacy);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }
  return { promptsDir, removed: [promptFq, promptLegacy] };
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
  await cleanupLegacyPromptFiles();
  const { bridgeConfigPath } = await writeBridgeConfig(bridgeConfig);

  // eslint-disable-next-line no-console
  console.log("codex-feishu init completed");
  // eslint-disable-next-line no-console
  console.log(`- Codex config: ${configPath}${updated ? " (updated)" : " (already configured)"}`);
  // eslint-disable-next-line no-console
  console.log(`- Bridge config: ${bridgeConfigPath}`);
  // eslint-disable-next-line no-console
  console.log(`- codex_bin: ${bridgeConfig.codex_bin ? bridgeConfig.codex_bin : "(default: codex in PATH)"}`);

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
    console.log("3) Bind info will be printed automatically below (or refresh with: codex-feishu qrcode).");
  } else {
    // eslint-disable-next-line no-console
    console.log("1) Start daemon: codex-feishu daemon");
    // eslint-disable-next-line no-console
    console.log("2) Start Codex normally: codex");
    // eslint-disable-next-line no-console
    console.log("3) Get bind info: codex-feishu qrcode");
  }
}
