import { getBridgeRpcEndpoint } from "../lib/paths.js";
import { callJsonRpc } from "../lib/uds_rpc.js";

export async function runInbound(flags) {
  const chatId = flags["chat-id"] || flags.chat;
  const userId = flags["user-id"] || flags.user || null;
  const text = flags.text;
  if (!chatId || !text) {
    throw new Error("usage: codex-feishu inbound --chat-id <chat_id> --text <message> [--user-id <id>]");
  }

  const endpoint = getBridgeRpcEndpoint();
  const result = await callJsonRpc(
    endpoint,
    "feishu/inbound_text",
    {
      chat_id: chatId,
      user_id: userId,
      text,
    },
    { timeoutMs: 30_000 },
  );

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

