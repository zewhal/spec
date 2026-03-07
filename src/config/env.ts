import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let loaded = false;

export function loadEnvironment(dotenvPath?: string): boolean {
  if (loaded) {
    return true;
  }

  const resolvedPath = dotenvPath ?? path.join(process.cwd(), ".env");
  if (!existsSync(resolvedPath)) {
    return false;
  }

  const content = readFileSync(resolvedPath, "utf8");
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }

  loaded = true;
  return true;
}
