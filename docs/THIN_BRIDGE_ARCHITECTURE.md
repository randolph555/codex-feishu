# Thin Bridge Architecture

## Goal

Make Feishu a second Codex conversation window, not a second session orchestrator.

## Product model

- Codex thread is the only source of truth.
- Terminal and Feishu are two views over the same thread.
- Bridge owns transport, binding, and minimal delivery state only.
- Bridge should avoid inventing command semantics when Codex app-server already exposes them.

## Non-goals

- Pixel-identical TUI mirroring.
- Reimplementing Codex slash menu UI inside Feishu.
- Reconstructing every historical terminal interaction from lossy thread history.
- Multi-daemon active/active operation for the same bot.

## Core objects

### Thread binding

A Feishu chat binds to exactly one Codex thread at a time.

```text
feishu_chat_id -> codex_thread_id
```

Optional metadata:
- current turn id
- latest visible status card ids
- lightweight delivery cache

### Transport adapter

A transport adapter only needs to do four things:
- receive user messages
- send text/markdown/image output
- present approval/input prompts
- emit delivery/update failures

This should be generic enough for Feishu today and other chat UIs later.

### Codex runtime adapter

The bridge should prefer app-server protocol capabilities directly:
- `thread/start`
- `thread/list`
- `thread/read`
- `thread/resume`
- `thread/fork`
- `thread/compact/start`
- `turn/start`
- `turn/steer`
- `turn/cancel` / `turn/interrupt`
- `review/start`
- `model/list`
- `config/read`
- `skills/list`

## Binding flow

### Preferred flow

1. User starts chatting in Feishu or terminal.
2. Bridge auto-binds on first message (private/group).
3. The Feishu chat becomes another view for that thread.
4. Optional fallback: generate a QR/bind payload to force binding to a specific thread.

## Slash command reality

The ideal terminal UX is a lightweight bind trigger (if needed).

However, the bridge should not assume custom slash commands are injectable into Codex core.
Practical options should be evaluated in this order:

1. Native Codex extension point, if one exists.
2. Codex prompt entry (if supported).
3. MCP tool invocation surfaced naturally in Codex.
4. External shell command fallback.

The bridge architecture should not depend on any one of these trigger mechanisms.

## Sync model

### Terminal -> Feishu

- Terminal-originated turns should be visible in Feishu if the thread is bound.
- Assistant deltas should stream to Feishu incrementally.
- Approval and input requests should be mirrored.

### Feishu -> Terminal

- Feishu-originated turns should target the same thread.
- The terminal session should be able to resume/read that thread and see the same semantic state.
- Exact TUI state mirroring is not required.

## State ownership

### Codex owns

- thread lifecycle
- turn lifecycle
- tool execution state
- approvals and elicitation semantics
- persisted thread history

### Bridge owns

- chat_id -> thread_id binding
- transient message/card ids for patching output
- transient turn -> chat routing map
- delivery retries/backoff

### Bridge should not own

- global active thread selection logic
- inferred cwd inheritance across unrelated chats
- shadow session model separate from Codex threads

## Rendering model

- Render assistant output from live deltas.
- Patch one assistant card/message per turn when possible.
- Render terminal/tool output separately from assistant narrative.
- Keep rendering transport-specific but event model shared.

## Phased implementation

### Phase 1

- Stable per-chat thread binding
- Turn-to-chat exact routing
- Streaming assistant output
- Approval/input relay
- Basic commands: status/new/stop

### Phase 2

- Resume/list/fork/compact via app-server only
- Thread read/sync improvements
- Better recovery after daemon restart

### Phase 3

- Generalized transport adapter for non-Feishu UIs
- Optional terminal-originated thread mirroring enhancements
- Optional bind trigger UX inside Codex (fallback only)

## Current branch intent

This branch should incrementally move the current codebase toward the thin-bridge model instead of continuing to add bridge-local orchestration.
