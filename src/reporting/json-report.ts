import { mkdirSync } from "node:fs";
import path from "node:path";

import type { SuiteResult } from "../models/result";

export async function writeJsonReport(result: SuiteResult, filePath: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify(result, null, 2));
}
