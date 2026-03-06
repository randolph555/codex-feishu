import fs from "node:fs/promises";
import { stopDaemon } from "../lib/daemon_control.js";
import { readTextIfExists, writeText } from "../lib/fs_utils.js";
import { removeManagedMcpBlock } from "../lib/install_config.js";
import { getBridgeHome, getCodexConfigPath } from "../lib/paths.js";

export async function runUninstall() {
  const down = await stopDaemon();
  const codexConfigPath = getCodexConfigPath();
  const bridgeHome = getBridgeHome();

  const currentConfig = (await readTextIfExists(codexConfigPath)) ?? "";
  const nextConfig = removeManagedMcpBlock(currentConfig);
  const mcpRemoved = nextConfig !== currentConfig;
  if (mcpRemoved) {
    await writeText(codexConfigPath, nextConfig);
  }

  let bridgeHomeRemoved = false;
  try {
    await fs.rm(bridgeHome, { recursive: true, force: true });
    bridgeHomeRemoved = true;
  } catch {
    bridgeHomeRemoved = false;
  }

  // eslint-disable-next-line no-console
  console.log("codex-feishu uninstall\n");
  // eslint-disable-next-line no-console
  console.log(`- Daemon: ${down.stopResult.action}${down.stopResult.pid ? ` (pid=${down.stopResult.pid})` : ""}`);
  // eslint-disable-next-line no-console
  console.log(`- MCP config removed: ${mcpRemoved ? "yes" : "no"}`);
  // eslint-disable-next-line no-console
  console.log(`- Bridge home removed: ${bridgeHomeRemoved ? bridgeHome : "no"}`);
  // eslint-disable-next-line no-console
  console.log("\nNext:");
  // eslint-disable-next-line no-console
  console.log("- If installed globally, optionally run: npm uninstall -g @openai-lite/codex-feishu");
}
