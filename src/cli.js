import { runDaemon } from "./commands/daemon.js";
import { runDown } from "./commands/down.js";
import { runDoctor } from "./commands/doctor.js";
import { runInbound } from "./commands/inbound.js";
import { runInit } from "./commands/init.js";
import { runMcp } from "./commands/mcp.js";
import { runUninstall } from "./commands/uninstall.js";
import { runQrcode } from "./commands/qrcode.js";
import { restartDaemonDetached } from "./lib/daemon_control.js";
import { getBridgeHome, getBridgeProfile } from "./lib/paths.js";

const HELP = `codex-feishu

Usage:
  codex-feishu init [--app-id <id>] [--app-secret <secret>] [--bot-open-id <open_id>] [--encrypt-key <key>] [--verify-token <token>] [--codex-bin <path>] [daemon|--daemon]
  codex-feishu doctor
  codex-feishu daemon
  codex-feishu down
  codex-feishu uninstall
  codex-feishu qrcode [--purpose <text>] [--ascii] [--json]
  codex-feishu inbound --chat-id <chat_id> --text <message> [--user-id <id>]
  codex-feishu mcp (internal, for Codex MCP server)
  codex-feishu help
`;

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      flags[key] = value;
    } else {
      args.push(token);
    }
  }
  return { args, flags };
}

function watchLogCommand(logPath) {
  if (process.platform === "win32") {
    return `powershell -NoProfile -Command "Get-Content -Path '${logPath}' -Wait"`;
  }
  return `tail -f ${logPath}`;
}

function printDaemonStartSummary(result) {
  // eslint-disable-next-line no-console
  console.log("\nDaemon:");
  // eslint-disable-next-line no-console
  console.log(
    `- Previous: ${result.stopResult.action}${
      result.stopResult.pid ? ` (pid=${result.stopResult.pid})` : ""
    }`,
  );
  // eslint-disable-next-line no-console
  console.log(`- Started: pid=${result.startResult.pid} (background)`);
  // eslint-disable-next-line no-console
  console.log(`- PID file: ${result.pidPath}`);
  // eslint-disable-next-line no-console
  console.log(`- Log file: ${result.logPath}`);
  // eslint-disable-next-line no-console
  console.log(`- Home: ${getBridgeHome()} (profile=${getBridgeProfile()})`);
  if (Array.isArray(result.stopResults) && result.stopResults.length > 1) {
    // eslint-disable-next-line no-console
    console.log(`- Cleaned stale daemons: ${result.stopResults.length}`);
  }
  // eslint-disable-next-line no-console
  console.log(`- Watch log: ${watchLogCommand(result.logPath)}`);
}

export async function runCli(argv) {
  const { args, flags } = parseArgs(argv);
  const cmd = args[0] ?? "help";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return;
  }

  if (cmd === "init") {
    const startDaemon = args[1] === "daemon" || flags.daemon === "true";
    await runInit(flags, { startDaemon });
    if (startDaemon) {
      const result = await restartDaemonDetached();
      printDaemonStartSummary(result);
    }
    return;
  }

  if (cmd === "doctor") {
    await runDoctor();
    return;
  }

  if (cmd === "daemon") {
    if (flags.foreground === "true") {
      await runDaemon(flags);
      return;
    }
    const result = await restartDaemonDetached();
    printDaemonStartSummary(result);
    return;
  }

  if (cmd === "down" || cmd === "stop") {
    await runDown();
    return;
  }

  if (cmd === "uninstall") {
    await runUninstall();
    return;
  }

  if (cmd === "qrcode" || cmd === "qr") {
    await runQrcode(flags);
    return;
  }

  if (cmd === "mcp") {
    await runMcp();
    return;
  }

  if (cmd === "inbound") {
    await runInbound(flags);
    return;
  }

  throw new Error(`unknown command: ${cmd}\n\n${HELP}`);
}
