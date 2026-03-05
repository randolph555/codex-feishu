import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";

function getCodexSpawnOptions(base = {}) {
  if (process.platform === "win32") {
    return {
      ...base,
      // Windows commonly resolves codex via codex.cmd; shell mode keeps it executable.
      shell: true,
    };
  }
  return base;
}

function normalizeJsonRpcPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  if (payload.jsonrpc === undefined) {
    return { jsonrpc: "2.0", ...payload };
  }
  return payload;
}

function toTextInput(text) {
  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
  ];
}

function toProtoItems(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const out = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "text" && typeof item.text === "string" && item.text.length > 0) {
      out.push({
        type: "text",
        text: item.text,
      });
      continue;
    }
    if (item.type === "localImage" && typeof item.path === "string" && item.path.length > 0) {
      out.push({
        type: "local_image",
        path: item.path,
      });
    }
  }
  return out;
}

function withTimeout(promise, timeoutMs, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // noop
      }
      reject(new Error(`operation timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function probeSubcommand(codexBin, args, timeoutMs = 2_500) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timer = null;
    const child = spawn(
      codexBin,
      args,
      getCodexSpawnOptions({
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      }),
    );
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const done = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // noop
      }
      done({
        ok: false,
        code: null,
        stdout,
        stderr,
        timedOut: true,
      });
    }, timeoutMs);
    child.on("error", (err) => {
      done({
        ok: false,
        code: null,
        stdout,
        stderr: `${stderr}\n${err?.message ?? String(err)}`,
        timedOut: false,
      });
    });
    child.on("close", (code) => {
      done({
        ok: code === 0,
        code,
        stdout,
        stderr,
        timedOut: false,
      });
    });
  });
}

export class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.codexBin =
      options.codexBin ||
      process.env.CODEX_BIN ||
      (process.platform === "win32" ? "codex.cmd" : "codex");
    this.transport = options.transport || process.env.CODEX_FEISHU_TRANSPORT || "auto";
    this.protoCwd = options.protoCwd || process.env.CODEX_FEISHU_CWD || process.cwd();
    this.protoModel = options.protoModel || process.env.CODEX_FEISHU_MODEL || "gpt-5.3-codex";
    this.protoApprovalPolicy = process.env.CODEX_FEISHU_APPROVAL_POLICY || "on-failure";
    this.protoSandboxMode = process.env.CODEX_FEISHU_SANDBOX_MODE || "workspace-write";
    this.protoSummary = process.env.CODEX_FEISHU_SUMMARY || "auto";

    this.process = null;
    this.stdoutRl = null;
    this.stderrRl = null;
    this.starting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.lastStartError = null;
    this.protocolMode = null;
    this.probedMode = null;
    this.startupStderr = [];
    this.sessionId = null;
    this.activeTurns = new Map();
    this.protoReady = null;
  }

  status() {
    return {
      running: Boolean(this.process && !this.process.killed),
      pid: this.process?.pid ?? null,
      initialized: this.initialized,
      pending_requests: this.pending.size,
      last_start_error: this.lastStartError,
      transport: this.transport,
      mode: this.protocolMode,
      session_id: this.sessionId,
      active_turns: this.activeTurns.size,
    };
  }

  async ensureStarted() {
    if (this.process && !this.process.killed && this.initialized) {
      return;
    }
    if (!this.starting) {
      this.starting = this.start();
    }
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async resolveTransportMode() {
    if (this.transport === "app-server" || this.transport === "proto") {
      return this.transport;
    }
    if (this.probedMode) {
      return this.probedMode;
    }
    // Prefer app-server when available so behavior stays aligned with interactive Codex.
    // Fall back to proto only when app-server is not supported by the local codex binary.
    const appServerProbe = await probeSubcommand(this.codexBin, ["app-server", "--help"]);
    const appServerText = `${appServerProbe.stdout}\n${appServerProbe.stderr}`;
    const looksLikeAppServerHelp =
      /transport endpoint url/i.test(appServerText) ||
      /analytics are disabled by default for app-server/i.test(appServerText) ||
      (/--listen/i.test(appServerText) && /stdio:\/\//i.test(appServerText));
    if (looksLikeAppServerHelp) {
      this.probedMode = "app-server";
      return this.probedMode;
    }

    const protoProbe = await probeSubcommand(this.codexBin, ["proto", "--help"]);
    const protoText = `${protoProbe.stdout}\n${protoProbe.stderr}`;
    if (protoProbe.ok && /protocol stream/i.test(protoText)) {
      this.probedMode = "proto";
      return this.probedMode;
    }

    // Conservative final fallback for very old/odd builds.
    this.probedMode = "app-server";
    return this.probedMode;
  }

  async start() {
    this.lastStartError = null;
    this.initialized = false;
    this.sessionId = null;
    this.activeTurns.clear();
    this.startupStderr = [];

    const mode = await this.resolveTransportMode();
    this.protocolMode = mode;
    if (mode === "proto") {
      await this.startProto();
      return;
    }
    await this.startLegacyAppServer();
  }

  async startLegacyAppServer() {
    const child = spawn(
      this.codexBin,
      ["app-server", "--listen", "stdio://"],
      getCodexSpawnOptions({
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        cwd: this.protoCwd,
      }),
    );
    this.process = child;

    child.on("error", (err) => {
      if (this.process !== child) {
        return;
      }
      this.lastStartError = err?.message ?? String(err);
      this.emit("error", err);
    });

    child.on("close", (code, signal) => {
      if (this.process !== child) {
        return;
      }
      this.process = null;
      this.initialized = false;
      const stderrHint = this.startupStderr.slice(-6).join(" | ").trim();
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timeout);
        const extra = stderrHint ? `; stderr: ${stderrHint}` : "";
        entry.reject(new Error(`app-server exited while waiting for response (id=${id})${extra}`));
      }
      this.pending.clear();
      this.emit("exit", { code, signal });
    });

    this.stdoutRl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.stderrRl = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });

    this.stdoutRl.on("line", (line) => this.handleLine(line));
    this.stderrRl.on("line", (line) => {
      this.startupStderr.push(line);
      if (this.startupStderr.length > 40) {
        this.startupStderr = this.startupStderr.slice(-40);
      }
      this.emit("stderr", line);
    });

    try {
      await this.request(
        "initialize",
        {
          clientInfo: {
            name: "codex_feishu",
            title: "Codex Feishu Bridge",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
          },
        },
        15_000,
      );
      this.notify("initialized");
      this.initialized = true;
    } catch (err) {
      this.lastStartError = err?.message ?? String(err);
      throw err;
    }
  }

  async startProto() {
    const child = spawn(
      this.codexBin,
      ["proto"],
      getCodexSpawnOptions({
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
        cwd: this.protoCwd,
      }),
    );
    this.process = child;
    this.protoReady = {};

    child.on("error", (err) => {
      if (this.process !== child) {
        return;
      }
      this.lastStartError = err?.message ?? String(err);
      this.emit("error", err);
    });

    child.on("close", (code, signal) => {
      if (this.process !== child) {
        return;
      }
      this.process = null;
      this.initialized = false;
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error(`codex proto exited while waiting for response (id=${id})`));
      }
      this.pending.clear();
      for (const [turnId, turn] of this.activeTurns.entries()) {
        this.emit("notification", {
          method: "turn/completed",
          params: {
            threadId: turn.threadId,
            turnId,
            turn: {
              id: turnId,
              status: "failed",
            },
            error: `codex proto exited (code=${code ?? "unknown"}, signal=${signal ?? "none"})`,
          },
        });
      }
      this.activeTurns.clear();
      if (this.protoReady?.reject) {
        this.protoReady.reject(new Error(`codex proto exited before session configured (code=${code ?? "unknown"})`));
      }
      this.protoReady = null;
      this.emit("exit", { code, signal });
    });

    this.stdoutRl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.stderrRl = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });

    this.stdoutRl.on("line", (line) => this.handleLine(line));
    this.stderrRl.on("line", (line) => {
      this.startupStderr.push(line);
      if (this.startupStderr.length > 40) {
        this.startupStderr = this.startupStderr.slice(-40);
      }
      this.emit("stderr", line);
    });

    await withTimeout(
      new Promise((resolve, reject) => {
        this.protoReady.resolve = resolve;
        this.protoReady.reject = reject;
      }),
      20_000,
      () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // noop
        }
      },
    );
    this.initialized = true;
  }

  async forceStopProcess() {
    if (!this.process || this.process.killed) {
      return;
    }
    try {
      this.process.kill("SIGKILL");
    } catch {
      // noop
    }
  }

  async stop() {
    if (!this.process || this.process.killed) {
      return;
    }
    const current = this.process;
    if (this.protocolMode === "proto") {
      try {
        this.writeProto({
          id: `shutdown-${Date.now()}`,
          op: { type: "shutdown" },
        });
      } catch {
        // noop
      }
      await withTimeout(
        once(current, "close"),
        1_500,
        () => {
          try {
            current.kill("SIGKILL");
          } catch {
            // noop
          }
        },
      ).catch(() => undefined);
      return;
    }
    try {
      current.kill("SIGTERM");
    } catch {
      // noop
    }
    await withTimeout(
      once(current, "close"),
      1_500,
      () => {
        try {
          current.kill("SIGKILL");
        } catch {
          // noop
        }
      },
    ).catch(() => undefined);
  }

  writePayload(payload) {
    if (!this.process || this.process.killed || !this.process.stdin) {
      throw new Error("app-server is not running");
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  writeProto(submission) {
    if (!this.process || this.process.killed || !this.process.stdin) {
      throw new Error("codex proto is not running");
    }
    this.process.stdin.write(`${JSON.stringify(submission)}\n`);
  }

  notify(method, params = undefined) {
    const payload = normalizeJsonRpcPayload({
      method,
      params,
    });
    this.writePayload(payload);
  }

  request(method, params, timeoutMs = 120_000) {
    if (this.protocolMode === "proto") {
      return Promise.reject(new Error(`request(${method}) is unsupported in proto mode`));
    }
    const id = `app-${this.nextId++}`;
    const payload = normalizeJsonRpcPayload({
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      const entry = { resolve, reject, timeout };
      this.pending.set(id, entry);
      try {
        this.writePayload(payload);
      } catch (err) {
        clearTimeout(entry.timeout);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  respond(id, result) {
    this.writePayload(
      normalizeJsonRpcPayload({
        id,
        result,
      }),
    );
  }

  respondError(id, code, message, data) {
    this.writePayload(
      normalizeJsonRpcPayload({
        id,
        error: {
          code,
          message,
          data,
        },
      }),
    );
  }

  async startThread(params = {}) {
    await this.ensureStarted();
    if (this.protocolMode === "proto") {
      await this.stop();
      await this.ensureStarted();
      return {
        threadId: this.sessionId,
        thread: {
          id: this.sessionId,
          title: params?.title ?? null,
        },
      };
    }
    return this.request("thread/start", {
      experimentalRawEvents: false,
      persistExtendedHistory: true,
      ...params,
    });
  }

  async resumeThread(threadId, params = {}) {
    await this.ensureStarted();
    if (this.protocolMode === "proto") {
      if (threadId && threadId === this.sessionId) {
        return {
          threadId: this.sessionId,
          thread: {
            id: this.sessionId,
            resumed: true,
          },
        };
      }
      return this.startThread(params);
    }
    return this.request("thread/resume", {
      threadId,
      ...params,
    });
  }

  async startTurn(threadId, text, params = {}) {
    const requestedCwd =
      typeof params?.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : null;
    if (requestedCwd && (!this.process || this.process.killed)) {
      this.protoCwd = requestedCwd;
    }
    await this.ensureStarted();
    const input = Array.isArray(text) ? text : toTextInput(text);

    if (this.protocolMode === "proto") {
      let targetThreadId = threadId || this.sessionId;
      if (!targetThreadId || targetThreadId !== this.sessionId) {
        const created = await this.startThread({});
        targetThreadId = created.threadId;
      }
      const turnCwd = requestedCwd || this.protoCwd;
      if (requestedCwd) {
        this.protoCwd = requestedCwd;
      }
      const turnId = `turn-${this.nextId++}`;
      const items = toProtoItems(input);
      this.activeTurns.set(turnId, {
        threadId: targetThreadId,
      });
      this.writeProto({
        id: turnId,
        op: {
          type: "user_turn",
          cwd: turnCwd,
          approval_policy: this.protoApprovalPolicy,
          sandbox_policy: { mode: this.protoSandboxMode },
          model: this.protoModel,
          summary: this.protoSummary,
          items,
        },
      });
      return {
        thread: {
          id: targetThreadId,
        },
        turn: {
          id: turnId,
          status: "in_progress",
        },
      };
    }

    if (requestedCwd && requestedCwd !== this.protoCwd) {
      this.protoCwd = requestedCwd;
      await this.stop();
      await this.ensureStarted();
    }

    return this.request("turn/start", {
      threadId,
      input,
      ...params,
    });
  }

  async steerTurn(threadId, expectedTurnId, text) {
    await this.ensureStarted();
    if (this.protocolMode === "proto") {
      return this.startTurn(threadId, text, {});
    }
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: toTextInput(text),
    });
  }

  async stopTurn(threadId, turnId, options = {}) {
    const timeoutMs =
      Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
        ? Number(options.timeoutMs)
        : 10_000;
    await this.ensureStarted();

    if (this.protocolMode === "proto") {
      const hadActive = this.activeTurns.size > 0;
      if (!hadActive && !turnId) {
        return {
          ok: false,
          stopped: false,
          mode: "proto",
          reason: "no_active_turn",
        };
      }
      await this.stop();
      await this.ensureStarted();
      return {
        ok: true,
        stopped: true,
        mode: "restart",
        reason: "proto_no_cancel_rpc",
      };
    }

    const payload = {};
    if (threadId) {
      payload.threadId = threadId;
    }
    if (turnId) {
      payload.turnId = turnId;
    }

    try {
      await this.request("turn/cancel", payload, timeoutMs);
      return {
        ok: true,
        stopped: true,
        mode: "rpc",
      };
    } catch (err) {
      await this.stop();
      await this.ensureStarted();
      return {
        ok: true,
        stopped: true,
        mode: "restart",
        reason: err?.message ?? String(err),
      };
    }
  }

  handleProtoPayload(payload) {
    const id = typeof payload?.id === "string" ? payload.id : "";
    const msg = payload?.msg && typeof payload.msg === "object" ? payload.msg : null;
    if (!msg || !msg.type) {
      return;
    }

    if (msg.type === "session_configured") {
      this.sessionId = msg.session_id ?? this.sessionId;
      this.protoModel = msg.model ?? this.protoModel;
      this.initialized = true;
      if (this.protoReady?.resolve) {
        this.protoReady.resolve(msg);
      }
      this.protoReady = null;
      return;
    }

    if (!id) {
      return;
    }

    if (this.pending.has(id)) {
      const pending = this.pending.get(id);
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.resolve(msg);
      return;
    }

    const active = this.activeTurns.get(id);
    if (!active) {
      return;
    }
    const threadId = active.threadId ?? this.sessionId;
    const turnId = id;

    if (msg.type === "agent_message_delta" && typeof msg.delta === "string" && msg.delta.length > 0) {
      this.emit("notification", {
        method: "item/agentMessage/delta",
        params: {
          threadId,
          turnId,
          delta: msg.delta,
          model: this.protoModel,
        },
      });
      return;
    }

    if (msg.type === "task_complete") {
      this.activeTurns.delete(id);
      this.emit("notification", {
        method: "turn/completed",
        params: {
          threadId,
          turnId,
          model: this.protoModel,
          turn: {
            id: turnId,
            status: "completed",
          },
          last_agent_message: msg.last_agent_message ?? null,
        },
      });
      return;
    }

    if (msg.type === "error" || msg.type === "task_error") {
      this.activeTurns.delete(id);
      this.emit("notification", {
        method: "turn/completed",
        params: {
          threadId,
          turnId,
          model: this.protoModel,
          turn: {
            id: turnId,
            status: "failed",
          },
          error: msg.message ?? "task failed",
        },
      });
      return;
    }
  }

  handleLegacyPayload(msg) {
    if (!msg) {
      return;
    }
    if ("id" in msg && !("method" in msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(msg.id);
      if ("error" in msg) {
        const err = new Error(msg.error?.message || "app-server rpc error");
        err.code = msg.error?.code;
        err.data = msg.error?.data;
        pending.reject(err);
        return;
      }
      pending.resolve(msg.result);
      return;
    }

    if ("method" in msg && "id" in msg) {
      this.emit("request", msg);
      return;
    }

    if ("method" in msg) {
      this.emit("notification", msg);
    }
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      this.emit("parse_error", line);
      return;
    }

    if (payload && typeof payload === "object" && "msg" in payload && "id" in payload && !("jsonrpc" in payload)) {
      this.handleProtoPayload(payload);
      return;
    }

    const msg = normalizeJsonRpcPayload(payload);
    this.handleLegacyPayload(msg);
  }
}
