import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { SuiteResult } from "../models/result";
import type { TestSuite } from "../models/suite";
import { writeHtmlReport, writeJsonReport, writeMarkdownReport } from "../reporting";

const compiledPlanMetadataSchema = {
  key: "_spec",
};

const compiledPlanVersion = "2026-03-08.2";

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
  metadata.compiler_version = compiledPlanVersion;

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
  const compilerVersion = typedMetadata.compiler_version;
  if (typeof sourceHash !== "string" || typeof sourceSpecPath !== "string" || typeof compilerVersion !== "string") {
    return false;
  }

  if (compilerVersion !== compiledPlanVersion) {
    return false;
  }

  return path.resolve(sourceSpecPath) === path.resolve(sourceSpec) && sourceHash === fileSha256(sourceSpec);
}

export async function writeResultIndex(options: {
  result: SuiteResult;
  compiledPath?: string;
  resultJsonPath: string;
  markdownReportPath: string;
  htmlReportPath: string;
  suiteOutputDir: string;
}): Promise<string> {
  const payload = {
    suite_id: options.result.suite_id,
    suite_name: options.result.suite_name,
    status: options.result.status,
    duration_ms: options.result.duration_ms,
    artifacts_root: options.result.artifacts_root,
    compiled_plan: options.compiledPath ? path.resolve(options.compiledPath) : null,
    result_json: path.resolve(options.resultJsonPath),
    report_markdown: path.resolve(options.markdownReportPath),
    report_html: path.resolve(options.htmlReportPath),
    tests: options.result.tests,
  };
  const manifestPath = path.join(options.suiteOutputDir, "summary.json");
  await Bun.write(manifestPath, JSON.stringify(payload, null, 2));
  return manifestPath;
}

export async function persistSuiteOutputs(result: SuiteResult, outputRoot: string, compiledPath?: string): Promise<Record<string, string>> {
  const suiteOutputDir = path.join(outputRoot, result.suite_id);
  mkdirSync(suiteOutputDir, { recursive: true });
  const jsonPath = path.join(suiteOutputDir, "result.json");
  const mdPath = path.join(suiteOutputDir, "report.md");
  const htmlPath = path.join(suiteOutputDir, "report.html");
  await writeJsonReport(result, jsonPath);
  await writeMarkdownReport(result, mdPath);
  await writeHtmlReport(result, htmlPath);
  const summaryPath = await writeResultIndex({
    result,
    compiledPath,
    resultJsonPath: jsonPath,
    markdownReportPath: mdPath,
    htmlReportPath: htmlPath,
    suiteOutputDir,
  });
  return {
    suite_dir: suiteOutputDir,
    result_json: jsonPath,
    report_md: mdPath,
    report_html: htmlPath,
    summary_json: summaryPath,
  };
}
