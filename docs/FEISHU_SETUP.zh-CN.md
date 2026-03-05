# 飞书准备与权限

这份文档用于单独说明 `codex-feishu` 的飞书侧准备步骤与权限清单。

## 必要配置

1. 开启应用的机器人能力。
2. 事件订阅方式选择“长连接（long connection）”。
3. 订阅事件：
   - `im.message.receive_v1`
4. 开通接口权限（按当前代码实际调用）：
   - `im.v1.message.create`（发送文本/卡片/图片消息）
   - `im.v1.message.patch`（更新卡片）
   - `im.v1.image.create`（上传图片）
   - `im.v1.messageResource.get`（下载会话内图片）
   - `im.v1.image.get`（图片下载兜底）
   - `bot.v3.info`（可选，仅用于自动获取 `bot_open_id`）
5. 权限或事件变更后，发布应用版本。

## 权限清单 JSON

```json
{
  "subscription_mode": "long_connection",
  "events": [
    "im.message.receive_v1"
  ],
  "scopes": {
    "tenant": [
      "aily:message:read",
      "aily:message:write",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.group_msg",
      "im:message.p2p_msg:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": [
      "aily:message:read",
      "aily:message:write",
      "im:message"
    ]
  }
}
```
