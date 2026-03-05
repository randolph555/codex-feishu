import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readTextIfExists, writeJson } from "./fs_utils.js";

const STATE_VERSION = 1;
const MAX_RECENT_EVENTS = 500;

function nowTs() {
  return Date.now();
}

function defaultState() {
  const ts = nowTs();
  return {
    version: STATE_VERSION,
    created_at: ts,
    updated_at: ts,
    active_thread_id: null,
    pending_requests: {},
    bindings: {},
    pending_bind_codes: {},
    last_qrcode_cwd: null,
    thread_titles: {},
    thread_buffers: {},
    recent_events: [],
  };
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== "object") {
    return base;
  }
  return {
    ...base,
    ...raw,
    version: STATE_VERSION,
    pending_requests: normalizeObject(raw.pending_requests),
    bindings: normalizeObject(raw.bindings),
    pending_bind_codes: normalizeObject(raw.pending_bind_codes),
    last_qrcode_cwd: typeof raw.last_qrcode_cwd === "string" ? raw.last_qrcode_cwd : null,
    thread_titles: normalizeObject(raw.thread_titles),
    thread_buffers: normalizeObject(raw.thread_buffers),
    recent_events: normalizeArray(raw.recent_events).slice(-MAX_RECENT_EVENTS),
  };
}

function toPersistedState(state) {
  return {
    version: STATE_VERSION,
    created_at: state.created_at ?? nowTs(),
    updated_at: state.updated_at ?? nowTs(),
    active_thread_id: state.active_thread_id ?? null,
    bindings: normalizeObject(state.bindings),
    pending_bind_codes: normalizeObject(state.pending_bind_codes),
    last_qrcode_cwd: typeof state.last_qrcode_cwd === "string" ? state.last_qrcode_cwd : null,
    thread_titles: normalizeObject(state.thread_titles),
  };
}

export class StateStore {
  constructor(statePath) {
    this.statePath = statePath;
    this.state = defaultState();
    this.queue = Promise.resolve();
  }

  async load() {
    const text = await readTextIfExists(this.statePath);
    if (!text) {
      this.state = defaultState();
      return this.state;
    }
    try {
      const raw = JSON.parse(text);
      this.state = normalizeState(raw);
    } catch (err) {
      const backupPath = `${this.statePath}.corrupt-${Date.now()}`;
      try {
        await fs.rename(this.statePath, backupPath);
      } catch {
        // noop
      }
      this.state = defaultState();
      pushRecentEvent(this.state, {
        source: "daemon",
        type: "state_recovered_from_corrupt_json",
        backup_path: backupPath,
        error: err?.message ?? String(err),
      });
      await this.save();
    }
    return this.state;
  }

  snapshot() {
    return this.state;
  }

  async save() {
    this.state.updated_at = nowTs();
    await writeJson(this.statePath, toPersistedState(this.state));
  }

  async mutate(mutator) {
    const run = async () => {
      const maybeNext = await mutator(this.state);
      if (maybeNext) {
        this.state = normalizeState(maybeNext);
      } else {
        this.state = normalizeState(this.state);
      }
      await this.save();
      return this.state;
    };
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export function createBindCode() {
  return `CF-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export function pushRecentEvent(state, event) {
  const next = {
    ts: nowTs(),
    ...event,
  };
  const recent = normalizeArray(state.recent_events);
  recent.push(next);
  state.recent_events = recent.slice(-MAX_RECENT_EVENTS);
  return next;
}
