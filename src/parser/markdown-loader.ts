import { existsSync } from "node:fs";
import path from "node:path";

export async function loadMarkdown(filePath: string): Promise<string> {
  return Bun.file(filePath).text();
}

export async function listMarkdownSpecs(inputPath: string): Promise<string[]> {
  const resolved = path.resolve(inputPath);
  const stat = await Bun.file(resolved).stat().catch(() => null);

  if (stat?.isFile()) {
    return [resolved];
  }

  if (!existsSync(resolved)) {
    throw new Error(`Spec path does not exist: ${resolved}`);
  }

  const matches = Array.from(new Bun.Glob("**/*.md").scanSync({ cwd: resolved, absolute: true }));
  return matches.sort();
}
