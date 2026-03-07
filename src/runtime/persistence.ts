import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { TestSuite } from "../models/suite";

const compiledPlanMetadataSchema = {
  key: "_spec",
};

export function defaultCompiledOutputPath(projectConfigPath: string, specPath: string): string {
  const projectRoot = path.dirname(projectConfigPath);
  const compiledRoot = path.join(projectRoot, "compiled");
  const stat = Bun.file(specPath);
  if (existsSync(specPath) && !specPath.endsWith(path.sep) && specPath.toLowerCase().endsWith(".md")) {
    return path.join(compiledRoot, `${path.parse(specPath).name}.json`);
  }
  void stat;
  return path.join(compiledRoot, "compiled-suites.json");
}

export function fileSha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function writeCompiledPlan(options: {
  suites: TestSuite[];
  destination: string;
  sourceSpec?: string;
  sourceHash?: string;
}): string {
  mkdirSync(path.dirname(options.destination), { recursive: true });
  const suitePayloads = options.suites.map((suite) => structuredClone(suite));
  const metadata: Record<string, string> = {};

  if (options.sourceSpec) {
    metadata.source_spec = path.resolve(options.sourceSpec);
  }
  if (options.sourceHash) {
    metadata.source_hash = options.sourceHash;
  }

  const payload: Record<string, unknown> =
    suitePayloads.length === 1
      ? { ...suitePayloads[0] }
      : { suites: suitePayloads };

  if (Object.keys(metadata).length > 0) {
    payload[compiledPlanMetadataSchema.key] = metadata;
  }

  writeFileSync(options.destination, JSON.stringify(payload, null, 2));
  return options.destination;
}

export function compiledPlanIsFresh(compiledPath: string, sourceSpec: string): boolean {
  if (!existsSync(compiledPath) || !existsSync(sourceSpec)) {
    return false;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(readFileSync(compiledPath, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }

  const metadata = payload[compiledPlanMetadataSchema.key];
  if (!metadata || typeof metadata !== "object") {
    return false;
  }

  const typedMetadata = metadata as Record<string, unknown>;
  const sourceHash = typedMetadata.source_hash;
  const sourceSpecPath = typedMetadata.source_spec;
  if (typeof sourceHash !== "string" || typeof sourceSpecPath !== "string") {
    return false;
  }

  return path.resolve(sourceSpecPath) === path.resolve(sourceSpec) && sourceHash === fileSha256(sourceSpec);
}
