import { stopDaemon } from "../lib/daemon_control.js";

export async function runDown() {
  const result = await stopDaemon();
  // eslint-disable-next-line no-console
  console.log("codex-feishu down\n");
  // eslint-disable-next-line no-console
  console.log(`- Result: ${result.stopResult.action}${result.stopResult.pid ? ` (pid=${result.stopResult.pid})` : ""}`);
  // eslint-disable-next-line no-console
  console.log(`- PID file: ${result.pidPath}`);
  // eslint-disable-next-line no-console
  console.log(`- Log file: ${result.logPath}`);
  if (Array.isArray(result.stopResults) && result.stopResults.length > 1) {
    // eslint-disable-next-line no-console
    console.log(`- Stopped daemon processes: ${result.stopResults.length}`);
  }
}
