import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parse } from "smol-toml";
import { z } from "zod";

const projectRuntimeDefaultsSchema = z
  .object({
    base_url: z.string().default(""),
    browser: z.string().default("chromium"),
    viewport: z.string().default("desktop"),
    locale: z.string().default("en-US"),
    capture: z.string().default("on-failure"),
    allowed_subdomains: z.array(z.string()).default([]),
    default_timeout_ms: z.number().int().default(10_000),
    assertion_timeout_ms: z.number().int().default(10_000),
    locator_resolution_timeout_ms: z.number().int().default(5_000),
    navigation_timeout_ms: z.number().int().default(30_000),
    max_retries: z.number().int().default(0),
    retry_on_flake: z.boolean().default(false),
    strict_mode: z.boolean().default(false),
  })
  .strict();

const projectPathsSchema = z
  .object({
    specs_pattern: z.string().default("tests/**/*.md"),
    results_dir: z.string().default("artifacts"),
  })
  .strict();

export const projectConfigSchema = z
  .object({
    paths: projectPathsSchema.default({}),
    runtime: projectRuntimeDefaultsSchema.default({}),
  })
  .strict();

export type ProjectRuntimeDefaults = z.infer<typeof projectRuntimeDefaultsSchema>;
export type ProjectPaths = z.infer<typeof projectPathsSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

function mapRuntimePayload(payload: Record<string, unknown>): ProjectRuntimeDefaults {
  const browserPayload =
    payload.browser && typeof payload.browser === "object"
      ? (payload.browser as Record<string, unknown>)
      : {};
  const runtimePayload =
    payload.runtime && typeof payload.runtime === "object"
      ? (payload.runtime as Record<string, unknown>)
      : {};

  return projectRuntimeDefaultsSchema.parse({
    base_url: payload.base_url,
    capture: payload.capture,
    allowed_subdomains: Array.isArray(payload.allowed_subdomains) ? payload.allowed_subdomains : [],
    browser: browserPayload.browser,
    viewport: browserPayload.viewport,
    locale: browserPayload.locale,
    default_timeout_ms: runtimePayload.default_timeout_ms,
    assertion_timeout_ms: runtimePayload.assertion_timeout_ms,
    locator_resolution_timeout_ms: runtimePayload.locator_resolution_timeout_ms,
    navigation_timeout_ms: runtimePayload.navigation_timeout_ms,
    max_retries: runtimePayload.max_retries,
    retry_on_flake: runtimePayload.retry_on_flake,
    strict_mode: runtimePayload.strict_mode,
  });
}

export function findProjectConfigPath(startPath: string = process.cwd()): string {
  const resolvedStart = path.resolve(startPath);
  const current = existsSync(resolvedStart) && statSync(resolvedStart).isDirectory()
    ? resolvedStart
    : path.dirname(resolvedStart);

  let candidateDir = current;
  while (true) {
    const specCandidate = path.join(candidateDir, ".spec", "spec.toml");
    if (existsSync(specCandidate)) {
      return specCandidate;
    }

    const legacyCandidate = path.join(candidateDir, ".ahente", "ahente.toml");
    if (existsSync(legacyCandidate)) {
      return legacyCandidate;
    }

    const parent = path.dirname(candidateDir);
    if (parent === candidateDir) {
      return path.join(process.cwd(), ".spec", "spec.toml");
    }
    candidateDir = parent;
  }
}

export function loadProjectConfig(configPath?: string): ProjectConfig {
  const resolvedPath = configPath ?? findProjectConfigPath();
  if (!existsSync(resolvedPath)) {
    return projectConfigSchema.parse({});
  }

  const payload = parse(readFileSync(resolvedPath, "utf8")) as Record<string, unknown>;
  const sectionName = path.basename(resolvedPath) === "spec.toml" ? "spec" : "ahente";
  const projectPayload = payload[sectionName];
  if (!projectPayload || typeof projectPayload !== "object") {
    return projectConfigSchema.parse({});
  }

  const section = projectPayload as Record<string, unknown>;
  return projectConfigSchema.parse({
    paths: {
      specs_pattern: section.specs_pattern,
      results_dir: section.results_dir,
    },
    runtime: mapRuntimePayload(section),
  });
}
