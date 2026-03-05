import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureDir, readTextIfExists, writeText } from "./fs_utils.js";
import { getBridgeRpcEndpoint, getDaemonLogPath, getDaemonPidPath, getRunDir } from "./paths.js";
import { callJsonRpc } from "./uds_rpc.js";

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

async function isDaemonRpcResponsive(timeoutMs = 1000) {
  try {
    const endpoint = getBridgeRpcEndpoint();
    const pong = await callJsonRpc(endpoint, "ping", {}, { timeoutMs });
    return Boolean(pong?.ok);
  } catch {
    return false;
  }
}

async function readLogTail(logPath, maxLines = 60) {
  try {
    const text = await readTextIfExists(logPath);
    if (!text) {
      return "";
    }
    const lines = text
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .slice(-maxLines);
    return lines.join("\n");
  } catch {
    return "";
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
    windowsHide: true,
  });

  return await new Promise((resolve) => {
    let settled = false;
    const graceMs = process.platform === "win32" ? 1500 : 800;
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

    child.once("exit", (code, signal) => {
      finish({
        ok: false,
        error: `process exited early (cmd=${cmd}) code=${code ?? "null"} signal=${signal ?? "null"}`,
      });
    });

    child.once("error", (err) => {
      finish({ ok: false, error: err?.message ?? String(err) });
    });

    child.once("spawn", () => {
      setTimeout(() => {
        if (settled) {
          return;
        }
        child.unref();
        finish({ ok: true, pid: child.pid });
      }, graceMs);
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

  const entry = process.argv[1];
  const stableBinEntry = fileURLToPath(new URL("../../bin/codex-feishu.js", import.meta.url));
  const candidateEntries = [...new Set([stableBinEntry, entry].filter(Boolean))];
  const attempts = [];
  if (process.platform === "win32") {
    for (const cliEntry of candidateEntries) {
      attempts.push([process.execPath, [cliEntry, "daemon"]]);
    }
    attempts.push(["cmd.exe", ["/d", "/s", "/c", "codex-feishu daemon"]]);
  } else {
    attempts.push(["codex-feishu", ["daemon"]]);
    for (const cliEntry of candidateEntries) {
      attempts.push([process.execPath, [cliEntry, "daemon"]]);
    }
  }

  let startResult = { ok: false, error: "no_start_attempt" };
  const failedAttempts = [];
  for (const [cmd, args] of attempts) {
    // eslint-disable-next-line no-await-in-loop
    startResult = await trySpawnDetached(cmd, args, logPath);
    if (startResult.ok) {
      break;
    }
    // On Windows, daemon may already be alive (port occupied by existing daemon)
    // while a new detached process exits early. In that case, treat as healthy.
    // eslint-disable-next-line no-await-in-loop
    const responsive = await isDaemonRpcResponsive(1200);
    if (responsive) {
      // eslint-disable-next-line no-await-in-loop
      const current = await readPidFile();
      startResult = {
        ok: true,
        pid: current.pid ?? null,
        reused: true,
      };
      break;
    }
    failedAttempts.push(`${cmd} ${args.join(" ")} => ${startResult.error}`);
  }
  if (!startResult.ok) {
    const logTail = await readLogTail(logPath, 80);
    const details = failedAttempts.length > 0 ? `; attempts: ${failedAttempts.join(" | ")}` : "";
    const logHint = logTail ? `; daemon.log tail:\n${logTail}` : "";
    throw new Error(`failed to start daemon in background: ${startResult.error}${details}${logHint}`);
  }

  if (startResult.pid) {
    await writeText(pidPath, `${startResult.pid}\n`);
  }
  return {
    pidPath,
    logPath,
    stopResult,
    stopResults,
    startResult,
  };
}
