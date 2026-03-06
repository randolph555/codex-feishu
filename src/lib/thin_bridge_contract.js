export function createThinBridgeBindingRecord(existing = {}, patch = {}) {
  const merged = {
    ...(existing ?? {}),
    ...(patch ?? {}),
  };

  const chatId = typeof merged.chat_id === "string" && merged.chat_id.trim() ? merged.chat_id.trim() : null;
  const threadId =
    typeof merged.thread_id === "string" && merged.thread_id.trim() ? merged.thread_id.trim() : null;
  const currentTurnId =
    typeof merged.current_turn_id === "string" && merged.current_turn_id.trim()
      ? merged.current_turn_id.trim()
      : null;

  return {
    chat_id: chatId,
    thread_id: threadId,
    current_turn_id: currentTurnId,
    bound_at: Number.isFinite(merged.bound_at) ? Number(merged.bound_at) : null,
    transport: typeof merged.transport === "string" && merged.transport.trim() ? merged.transport.trim() : null,
    metadata: merged.metadata && typeof merged.metadata === "object" && !Array.isArray(merged.metadata)
      ? merged.metadata
      : {},
  };
}

export function normalizeThinBridgeBindings(bindings) {
  const source = bindings && typeof bindings === "object" && !Array.isArray(bindings) ? bindings : {};
  const out = {};
  for (const [chatId, value] of Object.entries(source)) {
    const normalized = createThinBridgeBindingRecord({ chat_id: chatId }, value ?? {});
    if (!normalized.chat_id) {
      continue;
    }
    out[normalized.chat_id] = normalized;
  }
  return out;
}
