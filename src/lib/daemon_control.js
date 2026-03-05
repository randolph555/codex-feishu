import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { ensureDir, readTextIfExists, writeText } from "./fs_utils.js";
import { getDaemonLogPath, getDaemonPidPath, getRunDir } from "./paths.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toPid(value) {
  const n = Number.parseInt(String(value || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isPidAlive(pid) {
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

async function readPidFile() {
  const pidPath = getDaemonPidPath();
  const raw = await readTextIfExists(pidPath);
  return {
    pidPath,
    pid: toPid(raw),
  };
}

async function removePidFile() {
  const { pidPath } = await readPidFile();
  try {
    fs.unlinkSync(pidPath);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
  }
}

async function stopByPid(pid, timeoutMs = 3000) {
  if (!isPidAlive(pid)) {
    return { action: "already_stopped", pid };
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return { action: "already_stopped", pid };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return { action: "stopped", pid, signal: "SIGTERM" };
    }
    await sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return { action: "stopped", pid, signal: "SIGTERM" };
  }
  return { action: "killed", pid, signal: "SIGKILL" };
}

function listDaemonPids() {
  if (process.platform === "win32") {
    // Keep Windows path simple and rely on pid file + explicit restart flow.
    // `ps` is not guaranteed to exist on native Windows environments.
    return [];
  }
  try {
    const ps = spawnSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
    });
    if (ps.status !== 0 || !ps.stdout) {
      return [];
    }
    const pids = [];
    for (const line of ps.stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const match = trimmed.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }
      const pid = toPid(match[1]);
      const command = match[2] || "";
      if (!pid || pid === process.pid) {
        continue;
      }
      if (/\bcodex-feishu\s+daemon(?:\s|$)/.test(command)) {
        pids.push(pid);
      }
    }
    return [...new Set(pids)];
  } catch {
    return [];
  }
}

async function trySpawnDetached(cmd, args, logPath) {
  await ensureDir(getRunDir());
  const fd = fs.openSync(logPath, "a");
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        fs.closeSync(fd);
      } catch {
        // noop
      }
      resolve(value);
    };

    child.once("error", (err) => {
      finish({ ok: false, error: err?.message ?? String(err) });
    });

    child.once("spawn", () => {
      child.unref();
      finish({ ok: true, pid: child.pid });
    });
  });
}

export async function restartDaemonDetached() {
  await ensureDir(getRunDir());
  const logPath = getDaemonLogPath();
  const { pidPath, pid } = await readPidFile();

  const stopTargets = new Set([...listDaemonPids(), ...(pid ? [pid] : [])]);
  const stopResults = [];
  for (const targetPid of stopTargets) {
    // eslint-disable-next-line no-await-in-loop
    const result = await stopByPid(targetPid);
    stopResults.push(result);
  }

  let stopResult = { action: "no_previous_pid", pid: null };
  if (pid) {
    const matched = stopResults.find((item) => item.pid === pid);
    if (matched) {
      stopResult = matched;
    }
  } else if (stopResults.length > 0) {
    stopResult = { action: "cleaned_stale", pid: null, count: stopResults.length };
  }
  await removePidFile();

  let startResult = await trySpawnDetached("codex-feishu", ["daemon"], logPath);
  if (!startResult.ok) {
    const entry = process.argv[1];
    if (entry) {
      startResult = await trySpawnDetached(process.execPath, [entry, "daemon"], logPath);
    }
  }
  if (!startResult.ok) {
    throw new Error(`failed to start daemon in background: ${startResult.error}`);
  }

  await writeText(pidPath, `${startResult.pid}\n`);
  return {
    pidPath,
    logPath,
    stopResult,
    stopResults,
    startResult,
  };
}
