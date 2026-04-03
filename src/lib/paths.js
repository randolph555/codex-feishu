import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WINDOWS_DEFAULT_RPC_ENDPOINT = "tcp://127.0.0.1:9765";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function sanitizeProfileName(raw) {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return text || "default";
}

function isDevCheckout() {
  try {
    return fs.existsSync(path.join(PACKAGE_ROOT, ".git"));
  } catch {
    return false;
  }
}

function isPathWithin(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

export function getCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function getBridgeBaseHome() {
  return process.env.CODEX_FEISHU_BASE_HOME || path.join(os.homedir(), ".codex-feishu");
}

export function getBridgeProfile() {
  const explicit = process.env.CODEX_FEISHU_PROFILE;
  if (typeof explicit === "string" && explicit.trim()) {
    return sanitizeProfileName(explicit);
  }
  const invokedEntry = typeof process.argv[1] === "string" ? process.argv[1].trim() : "";
  if (isDevCheckout() && invokedEntry && isPathWithin(PACKAGE_ROOT, invokedEntry)) {
    return sanitizeProfileName(`dev-${path.basename(PACKAGE_ROOT)}`);
  }
  return "default";
}

export function getBridgeHome() {
  if (typeof process.env.CODEX_FEISHU_HOME === "string" && process.env.CODEX_FEISHU_HOME.trim()) {
    return process.env.CODEX_FEISHU_HOME.trim();
  }
  const baseHome = getBridgeBaseHome();
  const profile = getBridgeProfile();
  if (profile === "default") {
    return baseHome;
  }
  return path.join(baseHome, "profiles", profile);
}

export function getCodexConfigPath() {
  return path.join(getCodexHome(), "config.toml");
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

export function getBridgeLocksDir() {
  return path.join(getBridgeBaseHome(), "locks");
}
