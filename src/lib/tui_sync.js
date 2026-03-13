import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function execFileText(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { encoding: "utf8", ...options },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function normalizeTtyPath(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }
  if (text.startsWith("/dev/")) {
    return text;
  }
  return path.join("/dev", text);
}

function parseThreadIdFromSessionPath(filePath) {
  const match = String(filePath ?? "").match(
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i,
  );
  return match ? match[1] : null;
}

async function listSessionFilesForPid(pid) {
  try {
    const output = await execFileText("lsof", ["-p", String(pid), "-Fn"]);
    const paths = [];
    for (const line of output.split("\n")) {
      if (!line.startsWith("n")) {
        continue;
      }
      const filePath = line.slice(1);
      if (!filePath.includes(`${path.sep}.codex${path.sep}sessions${path.sep}`)) {
        continue;
      }
      if (!filePath.endsWith(".jsonl")) {
        continue;
      }
      paths.push(filePath);
    }
    return paths;
  } catch {
    return [];
  }
}

async function listCodexTuiCandidates() {
  let output = "";
  try {
    output = await execFileText("ps", ["-eo", "pid=,tty=,lstart=,command="]);
  } catch {
    return [];
  }
  const candidates = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/^(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/);
    if (!match) {
      continue;
    }
    const pid = Number.parseInt(match[1], 10);
    const tty = match[2];
    const startText = match[3];
    const command = match[4] ?? "";
    if (!pid || !tty || tty === "?") {
      continue;
    }
    if (!/(^|\s)codex(\s|$)/.test(command)) {
      continue;
    }
    if (command.includes("codex-feishu")) {
      continue;
    }
    if (command.includes("app-server")) {
      continue;
    }
    const startedAt = Number.isNaN(Date.parse(startText)) ? null : Date.parse(startText);
    candidates.push({
      pid,
      tty,
      command,
      startedAt,
      sessionPaths: [],
      threadIds: new Set(),
      newestSessionMtime: 0,
    });
  }
  await Promise.all(
    candidates.map(async (entry) => {
      const sessionPaths = await listSessionFilesForPid(entry.pid);
      entry.sessionPaths = sessionPaths;
      let newest = 0;
      for (const filePath of sessionPaths) {
        const threadId = parseThreadIdFromSessionPath(filePath);
        if (threadId) {
          entry.threadIds.add(threadId);
        }
        try {
          const stat = await fsp.stat(filePath);
          const mtime = stat.mtimeMs ?? 0;
          if (mtime >= newest) {
            newest = mtime;
          }
        } catch {
          // ignore
        }
      }
      entry.newestSessionMtime = newest;
    }),
  );
  return candidates;
}

async function pickNewestSessionPath(paths) {
  let best = null;
  let bestMtime = 0;
  for (const candidate of paths) {
    try {
      const stat = await fsp.stat(candidate);
      const mtime = stat.mtimeMs ?? 0;
      if (mtime >= bestMtime) {
        bestMtime = mtime;
        best = candidate;
      }
    } catch {
      // ignore
    }
  }
  return best;
}

async function findSessionFileByThreadId(threadId) {
  if (!threadId) {
    return null;
  }
  const root = path.join(os.homedir(), ".codex", "sessions");
  let best = null;
  let bestMtime = 0;
  const yearDirs = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const year of yearDirs) {
    if (!year.isDirectory()) {
      continue;
    }
    const yearPath = path.join(root, year.name);
    const monthDirs = await fsp.readdir(yearPath, { withFileTypes: true }).catch(() => []);
    for (const month of monthDirs) {
      if (!month.isDirectory()) {
        continue;
      }
      const monthPath = path.join(yearPath, month.name);
      const dayDirs = await fsp.readdir(monthPath, { withFileTypes: true }).catch(() => []);
      for (const day of dayDirs) {
        if (!day.isDirectory()) {
          continue;
        }
        const dayPath = path.join(monthPath, day.name);
        const files = await fsp.readdir(dayPath, { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (!file.isFile()) {
            continue;
          }
          if (!file.name.includes(threadId) || !file.name.endsWith(".jsonl")) {
            continue;
          }
          const filePath = path.join(dayPath, file.name);
          try {
            const stat = await fsp.stat(filePath);
            const mtime = stat.mtimeMs ?? 0;
            if (mtime >= bestMtime) {
              bestMtime = mtime;
              best = filePath;
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return best;
}

export async function resolveTuiTarget(threadId) {
  const candidates = await listCodexTuiCandidates();
  if (candidates.length === 0) {
    return null;
  }
  let picked = null;
  if (threadId) {
    picked = candidates.find((entry) => entry.threadIds.has(threadId)) ?? null;
  }
  if (!picked) {
    picked = candidates.reduce((best, entry) => {
      if (!best) {
        return entry;
      }
      const a = entry.newestSessionMtime ?? 0;
      const b = best.newestSessionMtime ?? 0;
      if (a !== b) {
        return a >= b ? entry : best;
      }
      const aStart = entry.startedAt ?? 0;
      const bStart = best.startedAt ?? 0;
      return aStart >= bStart ? entry : best;
    }, null);
  }
  if (!picked) {
    return null;
  }
  const ttyPath = normalizeTtyPath(picked.tty);
  let resolvedThreadId = threadId ?? null;
  let sessionPath = null;
  if (resolvedThreadId && picked.threadIds.has(resolvedThreadId)) {
    sessionPath = picked.sessionPaths.find((p) => p.includes(resolvedThreadId)) ?? null;
  }
  if (!sessionPath) {
    sessionPath = await pickNewestSessionPath(picked.sessionPaths);
  }
  if (!resolvedThreadId) {
    resolvedThreadId = parseThreadIdFromSessionPath(sessionPath) ?? null;
  }
  if (!sessionPath && resolvedThreadId) {
    sessionPath = await findSessionFileByThreadId(resolvedThreadId);
  }
  return {
    pid: picked.pid,
    tty: picked.tty,
    ttyPath,
    threadId: resolvedThreadId,
    sessionPath,
  };
}

async function injectInputToTty(ttyPath, text) {
  const target = normalizeTtyPath(ttyPath);
  if (!target) {
    throw new Error("tty not available");
  }
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  const script = [
    "import base64, fcntl, os, sys, termios",
    "tty_path = sys.argv[1]",
    "data = base64.b64decode(sys.argv[2])",
    "fd = os.open(tty_path, os.O_WRONLY)",
    "try:",
    "  for b in data:",
    "    fcntl.ioctl(fd, termios.TIOCSTI, bytes([b]))",
    "finally:",
    "  os.close(fd)",
  ].join("\n");
  await execFileText("python3", ["-c", script, target, encoded], { timeout: 1500 });
}

async function injectViaITerm(ttyPath, text) {
  const target = normalizeTtyPath(ttyPath);
  if (!target) {
    throw new Error("tty not available");
  }
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  const script = [
    "on run argv",
    "  set targetTty to item 1 of argv",
    "  set msg to item 2 of argv",
    "  tell application \"iTerm2\"",
    "    repeat with w in windows",
    "      repeat with s in sessions of w",
    "        try",
    "          if (tty of s) is equal to targetTty then",
    "            tell s to write text msg",
    "            return \"ok\"",
    "          end if",
    "        end try",
    "      end repeat",
    "    end repeat",
    "  end tell",
    "  return \"not_found\"",
    "end run",
  ].join("\n");
  const tmpPath = path.join(os.tmpdir(), `codex-feishu-iterm-${Date.now()}.scpt`);
  await fsp.writeFile(tmpPath, script, "utf8");
  try {
    const out = await execFileText("osascript", [tmpPath, target, payload], { timeout: 2000 });
    if (!String(out).includes("ok")) {
      throw new Error("iterm_target_not_found");
    }
  } finally {
    try {
      await fsp.unlink(tmpPath);
    } catch {
      // noop
    }
  }
}

async function writeToTtyOutput(ttyPath, text) {
  const target = normalizeTtyPath(ttyPath);
  if (!target) {
    throw new Error("tty not available");
  }
  const payload = text.endsWith("\n") ? text : `${text}\n`;
  const handle = await fsp.open(target, "w");
  try {
    await handle.write(payload);
  } finally {
    await handle.close();
  }
}

export async function writeToTty(ttyPath, text) {
  try {
    await injectInputToTty(ttyPath, text);
  } catch (err) {
    try {
      await injectViaITerm(ttyPath, text);
      return;
    } catch {
      await writeToTtyOutput(ttyPath, text);
      throw err;
    }
  }
}

export function createTextFingerprint(text) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  return crypto.createHash("sha1").update(normalized).digest("hex");
}

export class SessionTailer {
  constructor(filePath, onLine) {
    this.filePath = filePath;
    this.onLine = onLine;
    this.offset = 0;
    this.buffer = "";
    this.watcher = null;
    this.reading = false;
  }

  async start() {
    const stat = await fsp.stat(this.filePath);
    this.offset = stat.size ?? 0;
    this.watcher = fs.watch(this.filePath, (event) => {
      if (event !== "change") {
        return;
      }
      void this.readNew();
    });
  }

  async readNew() {
    if (this.reading) {
      return;
    }
    this.reading = true;
    try {
      const stat = await fsp.stat(this.filePath);
      const size = stat.size ?? 0;
      if (size < this.offset) {
        this.offset = 0;
        this.buffer = "";
      }
      if (size === this.offset) {
        return;
      }
      const stream = fs.createReadStream(this.filePath, {
        start: this.offset,
        end: size - 1,
        encoding: "utf8",
      });
      let data = "";
      for await (const chunk of stream) {
        data += chunk;
      }
      this.offset = size;
      this.buffer += data;
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        this.onLine(trimmed);
      }
    } finally {
      this.reading = false;
    }
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
