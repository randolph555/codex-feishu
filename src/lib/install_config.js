export const CODEX_FEISHU_MARK_BEGIN = "# BEGIN codex-feishu";
export const CODEX_FEISHU_MARK_END = "# END codex-feishu";

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function tomlArray(items = []) {
  const safeItems = Array.isArray(items) ? items : [];
  return `[${safeItems.map((item) => tomlString(item)).join(", ")}]`;
}

export function buildManagedMcpBlock(command = "codex-feishu", args = ["mcp"]) {
  return `${CODEX_FEISHU_MARK_BEGIN}
[mcp_servers.codex_feishu]
command = ${tomlString(command)}
args = ${tomlArray(args)}
${CODEX_FEISHU_MARK_END}
`;
}

export function hasManagedMcpBlock(content = "") {
  return String(content).includes(CODEX_FEISHU_MARK_BEGIN) && String(content).includes(CODEX_FEISHU_MARK_END);
}

export function removeManagedMcpBlock(content = "") {
  const text = String(content ?? "");
  const blockPattern = new RegExp(
    `${CODEX_FEISHU_MARK_BEGIN.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}[\\s\\S]*?${CODEX_FEISHU_MARK_END.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\n?`,
    "m",
  );
  return text.replace(blockPattern, "").replace(/\n{3,}/g, "\n\n").trimEnd() + (text.endsWith("\n") ? "\n" : "");
}

export function upsertManagedMcpBlock(content = "", command = "codex-feishu", args = ["mcp"]) {
  const block = buildManagedMcpBlock(command, args);
  const cleaned = hasManagedMcpBlock(content) ? removeManagedMcpBlock(content) : String(content ?? "");
  const joiner = cleaned.length === 0 || cleaned.endsWith("\n") ? "" : "\n";
  return `${cleaned}${joiner}${cleaned.trim() ? "\n" : ""}${block}`;
}
