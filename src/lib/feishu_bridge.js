import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function parseMessageContent(messageContent) {
  if (typeof messageContent !== "string" || messageContent.length === 0) {
    return {};
  }
  const parsed = safeJsonParse(messageContent, {});
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed;
  }
  return {};
}

function findFirstStringValue(source, keys, maxDepth = 4) {
  if (!source || typeof source !== "object") {
    return null;
  }
  const wanted = new Set(keys);
  const queue = [{ value: source, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || !current.value || typeof current.value !== "object") {
      continue;
    }
    for (const [key, value] of Object.entries(current.value)) {
      if (wanted.has(key) && typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (current.depth < maxDepth && value && typeof value === "object") {
        queue.push({ value, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

function formatInShanghai(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const read = (type) => parts.find((item) => item.type === type)?.value ?? "";
  const y = read("year");
  const mon = read("month");
  const d = read("day");
  const h = read("hour");
  const min = read("minute");
  const s = read("second");
  if (!y || !mon || !d || !h || !min || !s) {
    return "";
  }
  return `${y}-${mon}-${d} ${h}:${min}:${s}`;
}

function normalizeMessageEvent(payload) {
  const event = payload?.event ?? payload ?? {};
  const message = event.message ?? {};
  const sender = event.sender ?? {};
  const content = parseMessageContent(message.content);
  const text = typeof content?.text === "string" ? content.text : "";
  const imageKey = findFirstStringValue(content, ["image_key", "imageKey"]);
  const fileKey = findFirstStringValue(content, ["file_key", "fileKey"]);
  const fileName = findFirstStringValue(content, ["file_name", "fileName", "name"]);
  const chatId = message.chat_id ?? null;
  const messageId = message.message_id ?? null;
  const userId =
    sender?.sender_id?.open_id ??
    sender?.sender_id?.union_id ??
    sender?.sender_id?.user_id ??
    null;
  const senderType = sender?.sender_type ?? null;
  const messageType = message?.message_type ?? null;
  const chatType = message?.chat_type ?? null;

  return {
    text,
    chatId,
    messageId,
    userId,
    senderType,
    messageType,
    chatType,
    imageKey,
    fileKey,
    fileName,
    content,
    raw: payload,
  };
}

function sanitizeCardMarkdown(markdown) {
  const raw = typeof markdown === "string" ? markdown : "";
  if (!raw) {
    return "";
  }
  // Feishu interactive card markdown does not accept Markdown image syntax
  // unless image_key resources are explicitly provided.
  return raw
    .replace(/!\[[^\]]*]\(([^)\n]+)\)/g, (_m, link) => `图片：\`${String(link).trim()}\``)
    .replace(/<img[^>]*>/gi, "[图片]");
}

function buildInteractiveCardContent(payload = {}) {
  const title = payload?.title || "Codex";
  const markdown = sanitizeCardMarkdown(payload?.markdown || "");
  const template = payload?.template || "blue";
  // Hard-disable interactive card actions to avoid callback/button failures in Feishu.
  const actions = [];
  const note = typeof payload?.note === "string" ? payload.note.trim() : "";
  const elements = [
    {
      tag: "markdown",
      content: markdown,
    },
  ];
  if (note) {
    elements.push({
      tag: "note",
      elements: [
        {
          tag: "plain_text",
          content: note,
        },
      ],
    });
  }
  if (actions.length > 0) {
    elements.push({
      tag: "action",
      layout: "flow",
      actions,
    });
  }
  return JSON.stringify({
    config: {
      wide_screen_mode: true,
      update_multi: Boolean(payload?.updatable),
    },
    header: {
      template,
      title: { tag: "plain_text", content: title },
    },
    elements,
  });
}

export class FeishuBridge {
  constructor(options) {
    this.appId = options.appId;
    this.appSecret = options.appSecret;
    this.onText = options.onText || null;
    this.onMessage = options.onMessage || options.onText || null;
    this.onEvent = options.onEvent || (() => {});
    this.running = false;
    this.client = null;
    this.wsClient = null;
    this.sdk = null;
    this.lastError = null;
  }

  status() {
    return {
      enabled: Boolean(this.appId && this.appSecret),
      running: this.running,
      has_sdk: Boolean(this.sdk),
      last_error: this.lastError,
    };
  }

  async start() {
    if (!this.appId || !this.appSecret) {
      this.lastError = "missing app_id/app_secret";
      return false;
    }

    let Lark;
    try {
      Lark = await import("@larksuiteoapi/node-sdk");
    } catch (err) {
      this.lastError =
        "missing @larksuiteoapi/node-sdk. Run: npm i -g @openai-lite/codex-feishu (with dependencies)";
      this.onEvent({
        type: "feishu_sdk_missing",
        error: err?.message ?? String(err),
      });
      return false;
    }

    this.sdk = Lark;
    this.client = new Lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    const eventDispatcher = new Lark.EventDispatcher({});
    const handler = this.onMessage || this.onText;
    const dispatchNormalizedMessage = async (normalized) => {
      if (!handler) {
        return;
      }
      try {
        await handler(normalized);
      } catch (err) {
        this.onEvent({
          type: "feishu_message_inbound_error",
          error: err?.message ?? String(err),
        });
      }
    };

    eventDispatcher.register({
      "im.message.receive_v1": async (payload) => {
        const normalized = normalizeMessageEvent(payload);
        if (normalized.senderType === "app") {
          return;
        }
        if (!normalized.chatId) {
          return;
        }
        if (normalized.messageType === "text" && !normalized.text) {
          return;
        }

        this.onEvent({
          type: "feishu_message_inbound",
          chat_id: normalized.chatId,
          user_id: normalized.userId,
          message_type: normalized.messageType ?? "unknown",
          chat_type: normalized.chatType ?? "unknown",
        });
        await dispatchNormalizedMessage({
          chatId: normalized.chatId,
          userId: normalized.userId,
          messageId: normalized.messageId,
          text: normalized.text,
          chatType: normalized.chatType,
          messageType: normalized.messageType,
          imageKey: normalized.imageKey,
          fileKey: normalized.fileKey,
          fileName: normalized.fileName,
          content: normalized.content,
          raw: normalized.raw,
          source: "message_receive",
        });
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
    });

    try {
      await this.wsClient.start({
        eventDispatcher,
      });
      this.running = true;
      this.lastError = null;
      this.onEvent({
        type: "feishu_ws_started",
      });
      return true;
    } catch (err) {
      this.running = false;
      this.lastError = err?.message ?? String(err);
      this.onEvent({
        type: "feishu_ws_start_failed",
        error: this.lastError,
      });
      return false;
    }
  }

  async stop() {
    this.running = false;
    if (this.wsClient && typeof this.wsClient.stop === "function") {
      try {
        await this.wsClient.stop();
      } catch {
        // noop
      }
    }
  }

  async sendText(chatId, text) {
    if (!this.client || !this.running) {
      throw new Error("feishu bridge not running");
    }
    await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
  }

  async sendImage(chatId, imagePath) {
    if (!this.client || !this.running) {
      throw new Error("feishu bridge not running");
    }
    if (!imagePath || typeof imagePath !== "string") {
      throw new Error("imagePath is required");
    }
    const uploaded = await this.client.im.v1.image.create({
      data: {
        image_type: "message",
        image: fs.createReadStream(imagePath),
      },
    });
    const imageKey = uploaded?.image_key ?? null;
    if (!imageKey) {
      throw new Error("upload image failed: missing image_key");
    }
    await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "image",
        content: JSON.stringify({ image_key: imageKey }),
      },
    });
    return imageKey;
  }

  async saveIncomingImage(messageId, imageKey, filePath) {
    if (!this.client || !this.running) {
      throw new Error("feishu bridge not running");
    }
    if (!messageId || !imageKey || !filePath) {
      throw new Error("messageId, imageKey and filePath are required");
    }

    await fsp.mkdir(path.dirname(filePath), { recursive: true });

    let resource = null;
    try {
      resource = await this.client.im.v1.messageResource.get({
        params: { type: "image" },
        path: {
          message_id: messageId,
          file_key: imageKey,
        },
      });
    } catch {
      // Fallback for cases where image belongs to app-uploaded resources.
      resource = await this.client.im.v1.image.get({
        path: {
          image_key: imageKey,
        },
      });
    }
    await resource.writeFile(filePath);
    return filePath;
  }

  async sendBindCard(chatId, payload) {
    if (!this.client || !this.running) {
      throw new Error("feishu bridge not running");
    }
    const bindCommand = payload?.bindCommand || "";
    const code = payload?.code || "";
    const openChatLink =
      typeof payload?.openChatLink === "string" && payload.openChatLink.trim()
        ? payload.openChatLink.trim()
        : null;
    const expiresAtShanghai = payload?.expiresAt ? formatInShanghai(payload.expiresAt) : "";
    const groupHint = Boolean(payload?.groupHint);
    const lines = [
      `请先绑定当前飞书会话到 Codex。`,
      code ? `绑定码：${code}` : "",
      bindCommand ? `绑定指令：\`${bindCommand}\`` : "",
      expiresAtShanghai ? `过期时间(上海)：${expiresAtShanghai}` : "",
      groupHint ? "群聊建议：完成绑定后优先 `@机器人` 提问。" : "",
      "",
      "发送上面的绑定指令后，即可开始双端同步对话。",
      "提示：直接复制并发送绑定指令即可。",
    ].filter(Boolean);
    const content = buildInteractiveCardContent({
      title: "Codex 会话绑定",
      markdown: lines.join("\n"),
      template: "orange",
      note: bindCommand ? `请手动发送：${bindCommand}${openChatLink ? `\n机器人会话：${openChatLink}` : ""}` : "",
    });

    await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content,
      },
    });
  }

  async sendMarkdownCard(chatId, payload) {
    if (!this.client || !this.running) {
      throw new Error("feishu bridge not running");
    }
    const content = buildInteractiveCardContent(payload);
    const resp = await this.client.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content,
      },
    });
    return resp?.data?.message_id ?? null;
  }

  async patchMarkdownCard(messageId, payload) {
    if (!this.client || !this.running) {
      throw new Error("feishu bridge not running");
    }
    if (!messageId) {
      throw new Error("messageId is required");
    }
    const content = buildInteractiveCardContent({
      ...payload,
      updatable: true,
    });
    await this.client.im.v1.message.patch({
      path: {
        message_id: messageId,
      },
      data: {
        content,
      },
    });
  }
}
