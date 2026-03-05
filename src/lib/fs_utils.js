import fs from "node:fs/promises";
import path from "node:path";

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function writeText(filePath, content) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, filePath);
}

export async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

export async function writeJson(filePath, value) {
  await writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
