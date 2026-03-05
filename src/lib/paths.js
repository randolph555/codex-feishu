import os from "node:os";
import path from "node:path";

const WINDOWS_DEFAULT_RPC_ENDPOINT = "tcp://127.0.0.1:9765";

export function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function getBridgeHome() {
  return process.env.CODEX_FEISHU_HOME || path.join(os.homedir(), ".codex-feishu");
}

export function getCodexConfigPath() {
  return path.join(getCodexHome(), "config.toml");
}

export function getPromptsDir() {
  return path.join(getCodexHome(), "prompts");
}

export function getBridgeConfigPath() {
  return path.join(getBridgeHome(), "config.json");
}

export function getBridgeStatePath() {
  return path.join(getBridgeHome(), "state.json");
}

export function getRunDir() {
  return path.join(getBridgeHome(), "run");
}

export function getBridgeSocketPath() {
  return path.join(getRunDir(), "bridge.sock");
}

export function getDefaultBridgeRpcEndpoint() {
  if (process.platform === "win32") {
    return WINDOWS_DEFAULT_RPC_ENDPOINT;
  }
  return getBridgeSocketPath();
}

export function getBridgeRpcEndpoint() {
  const fromEnv = process.env.CODEX_FEISHU_RPC_ENDPOINT;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return getDefaultBridgeRpcEndpoint();
}

export function getDaemonPidPath() {
  return path.join(getRunDir(), "daemon.pid");
}

export function getDaemonLogPath() {
  return path.join(getRunDir(), "daemon.log");
}
