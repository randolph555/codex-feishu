import { execFileSync } from "node:child_process";
import { readTextIfExists } from "../lib/fs_utils.js";
import {
  getBridgeConfigPath,
  getBridgeRpcEndpoint,
  getCodexConfigPath,
} from "../lib/paths.js";
import { callJsonRpc } from "../lib/uds_rpc.js";

function checkCommand(cmd, args = ["--version"]) {
  try {
    const output = execFileSync(cmd, args, { encoding: "utf8" }).trim();
    return { ok: true, output };
  } catch {
    return { ok: false, output: "" };
  }
}

async function existsNonEmpty(filePath) {
  const content = await readTextIfExists(filePath);
  return Boolean(content && content.trim().length > 0);
}

function mark(ok) {
  return ok ? "OK " : "ERR";
}

export async function runDoctor() {
  const codexCheck = checkCommand("codex");
  const codexFeishuCheck = checkCommand("codex-feishu");
  const invokedFromLocalScript = (process.argv[1] || "").includes("codex-feishu");
  const codexFeishuAvailable = codexFeishuCheck.ok || invokedFromLocalScript;
  const codexConfigPath = getCodexConfigPath();
  const bridgeConfigPath = getBridgeConfigPath();

  const codexConfig = (await readTextIfExists(codexConfigPath)) ?? "";
  const mcpConfigured =
    codexConfig.includes("[mcp_servers.codex_feishu]") &&
    codexConfig.includes('command = "codex-feishu"');
  const bridgeConfigReady = await existsNonEmpty(bridgeConfigPath);
  const endpoint = getBridgeRpcEndpoint();
  let daemonRunning = false;
  let daemonInfo = "not running";
  let bridgeStatus = null;
  let recentEvents = [];
  try {
    const pong = await callJsonRpc(endpoint, "bridge/ping", {}, { timeoutMs: 800 });
    daemonRunning = Boolean(pong?.ok);
    daemonInfo = daemonRunning ? `running (version=${pong?.version || "unknown"})` : "not running";
    if (daemonRunning) {
      try {
        bridgeStatus = await callJsonRpc(endpoint, "bridge/status", {}, { timeoutMs: 1200 });
      } catch {
        bridgeStatus = null;
      }
      try {
        const eventsResp = await callJsonRpc(endpoint, "feishu/events/recent", { limit: 80 }, { timeoutMs: 1200 });
        if (Array.isArray(eventsResp?.items)) {
          recentEvents = eventsResp.items;
        }
      } catch {
        recentEvents = [];
      }
    }
  } catch {
    daemonRunning = false;
  }

  // eslint-disable-next-line no-console
  console.log("codex-feishu doctor\n");
  // eslint-disable-next-line no-console
  console.log(`[${mark(codexCheck.ok)}] codex binary ${codexCheck.ok ? codexCheck.output : "not found"}`);
  // eslint-disable-next-line no-console
  console.log(
    `[${mark(codexFeishuAvailable)}] codex-feishu binary ${
      codexFeishuCheck.ok
        ? codexFeishuCheck.output
        : invokedFromLocalScript
          ? "running from local script (not on PATH)"
          : "not found"
    }`,
  );
  // eslint-disable-next-line no-console
  console.log(`[${mark(mcpConfigured)}] mcp config in ${codexConfigPath}`);
  // eslint-disable-next-line no-console
  console.log(`[${mark(bridgeConfigReady)}] bridge config ${bridgeConfigPath}`);
  // eslint-disable-next-line no-console
  console.log(`[${mark(daemonRunning)}] daemon rpc ${endpoint} ${daemonInfo}`);
  if (bridgeStatus) {
    const feishuRunning = Boolean(bridgeStatus?.feishu?.running);
    const bindings = Number(bridgeStatus?.bindings ?? 0);
    const activeThread = bridgeStatus?.active_thread_id ?? "(none)";
    // eslint-disable-next-line no-console
    console.log(`[${mark(feishuRunning)}] feishu runtime ${feishuRunning ? "running" : "stopped"}`);
    // eslint-disable-next-line no-console
    console.log(`[INFO] bindings=${bindings}, active_thread=${activeThread}`);
  }
  if (recentEvents.length > 0) {
    const inbound = recentEvents.filter((ev) => ev?.source === "feishu" && ev?.type === "feishu_message_inbound");
    const inboundCount = inbound.length;
    const groupInboundCount = inbound.filter((ev) => {
      const t = String(ev?.chat_type ?? "").toLowerCase();
      return t && t !== "p2p" && t !== "single";
    }).length;
    // eslint-disable-next-line no-console
    console.log(
      `[INFO] recent inbound events=${inboundCount}, group_inbound=${groupInboundCount} (last ${recentEvents.length} events)`,
    );
  }

  const ok =
    codexCheck.ok &&
    codexFeishuAvailable &&
    mcpConfigured &&
    bridgeConfigReady &&
    daemonRunning;
  // eslint-disable-next-line no-console
  console.log(`\nOverall: ${ok ? "READY" : "NOT READY"}`);
  if (!ok) {
    // eslint-disable-next-line no-console
    console.log("Run: codex-feishu init");
    // eslint-disable-next-line no-console
    console.log("Then start daemon: codex-feishu daemon");
    process.exitCode = 1;
  }
}
