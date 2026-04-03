import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./fs_utils.js";
import { getBridgeHome, getBridgeLocksDir } from "./paths.js";

function sanitizeLockName(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120) || "unknown";
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

function readLockFile(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function removeFileIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }
}

export async function acquireAppInstanceLock(appId) {
  if (!appId || typeof appId !== "string" || !appId.trim()) {
    return null;
  }
  const safeAppId = appId.trim();
  const locksDir = getBridgeLocksDir();
  await ensureDir(locksDir);

  const lockPath = path.join(locksDir, `feishu-app-${sanitizeLockName(safeAppId)}.json`);
  const payload = {
    pid: process.pid,
    app_id: safeAppId,
    bridge_home: getBridgeHome(),
    argv: process.argv.slice(),
    created_at: Date.now(),
  };
  const lockText = `${JSON.stringify(payload, null, 2)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, lockText, { encoding: "utf8", flag: "wx" });
      return {
        appId: safeAppId,
        lockPath,
        ownerPid: process.pid,
      };
    } catch (err) {
      if (!err || err.code !== "EEXIST") {
        throw err;
      }
      const existing = readLockFile(lockPath);
      const existingPid = parsePid(existing?.pid);
      if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
        const homeText = existing?.bridge_home ? `, home=${existing.bridge_home}` : "";
        throw new Error(
          `another codex-feishu daemon is already using Feishu app ${safeAppId} (pid=${existingPid}${homeText})`,
        );
      }
      removeFileIfExists(lockPath);
    }
  }

  throw new Error(`failed to acquire Feishu app lock for ${safeAppId}`);
}

export function releaseAppInstanceLock(lock) {
  if (!lock?.lockPath) {
    return;
  }
  const existing = readLockFile(lock.lockPath);
  const existingPid = parsePid(existing?.pid);
  if (existingPid && existingPid !== process.pid) {
    return;
  }
  removeFileIfExists(lock.lockPath);
}
