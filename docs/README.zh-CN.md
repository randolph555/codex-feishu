# codex-feishu 中文文档

Codex 远程化：飞书直连。你可以在飞书或终端任意一端继续同一条对话，上下文自动同步。

## 目标

在不修改 Codex 本体的前提下，通过 sidecar/daemon + MCP，把飞书与终端接到同一条会话链路。

## 快速架构图

```text
飞书用户 -> 飞书 -> codex-feishu daemon -> codex(app-server/proto) -> 结果回传飞书
                               ^
                               |
                          Codex CLI / MCP
```

完整架构与时序图： [ARCHITECTURE.md](./ARCHITECTURE.md)

## 安装

### Linux / macOS

```bash
npm i -g @openai-lite/codex-feishu
codex-feishu init --app-id <FEISHU_APP_ID> --app-secret <FEISHU_APP_SECRET> daemon
```

### Windows

```powershell
npm i -g @openai-lite/codex-feishu
codex-feishu init --app-id <FEISHU_APP_ID> --app-secret <FEISHU_APP_SECRET> daemon
```

Windows 说明：
- 默认 RPC 端点：`tcp://127.0.0.1:9765`
- 可通过 `CODEX_FEISHU_RPC_ENDPOINT` 覆盖

## init/daemon 说明

- `init ... daemon` 会自动重启后台 daemon。
- daemon 按单实例运行；`init ... daemon` 会先停止旧进程，再启动新进程。
- 私聊/群聊默认自动绑定；二维码/绑定码仅作为备用手段。

- 日志文件：`~/.codex-feishu/run/daemon.log`
- Linux/macOS 实时看日志：`tail -f ~/.codex-feishu/run/daemon.log`
- Windows 实时看日志：

```powershell
Get-Content -Path "$env:USERPROFILE\.codex-feishu\run\daemon.log" -Wait
```

- 可选检查命令（不是安装必需）：

```bash
codex-feishu doctor
codex
```

## 飞书准备与权限

- [FEISHU_SETUP.zh-CN.md](./FEISHU_SETUP.zh-CN.md)

## 飞书侧命令

### 基础

- `/status`：查看当前会话状态（会话ID、目录、待审批等）
- `/help`：查看命令帮助
- `/group`：查看群聊触发与绑定说明
- `/new`：新建会话并切换到新会话
- `/stop`：中断当前生成
- `/pending`：查看当前待审批/待输入项

### 会话与目录

- `/resume [序号|会话ID]`
- `/fork [序号|会话ID]`
- `/threads`
- `/sw <序号|会话ID>`
- `/cwd`
- `/cwd <PATH>`
- `/cwd <PATH> new`

### Codex 能力桥接

- `/review [说明|branch:<分支>|commit:<sha>]`
- `/compact`
- `/model [list|clear|<model_id>]`
- `/approvals [untrusted|on-failure|on-request|never]`
- `/permissions [read-only|workspace-write|danger-full-access]`
- `/plan [on|off|toggle]`（兼容模式）
- `/init`（通过 Codex 生成/补全 `AGENTS.md`）
- `/skills`
- `/mcp [list|get|add|remove|login|logout] ...`

### 审批快捷

- 直接回复 `1` / `2` / `3`
- `/approve [pending_id] [session]`
- `/deny [pending_id]`
- `/cancel [pending_id]`
- `/answer <pending_id> <text|json>`

## 行为细节

- 私聊/群聊均支持自动绑定：首次消息可自动建立映射并继续转发。
- 群聊建议 `@机器人` 触发（避免被其他聊天刷屏）。
- `/mcp` 返回是对原生 `codex mcp ...` 的透传，通常是代码块/表格样式。
- 线程失效时，daemon 会自动新建线程并重试一次。

## 运行文件

- `~/.codex/config.toml`（MCP 配置）
- `~/.codex-feishu/config.json`
- `~/.codex-feishu/state.json`
- `~/.codex-feishu/run/daemon.pid`
- `~/.codex-feishu/run/daemon.log`

## 相关文档

- 架构说明：[ARCHITECTURE.md](./ARCHITECTURE.md)
- 薄桥接重构草案：[THIN_BRIDGE_ARCHITECTURE.md](./THIN_BRIDGE_ARCHITECTURE.md)
- 迭代清单：[PRIORITY_PLAN.md](./PRIORITY_PLAN.md)
