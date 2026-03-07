import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { log, note, spinner } from "@clack/prompts";

import { findProjectConfigPath, loadProjectConfig } from "./config/project";
import { resolveLlmModel } from "./integrations";
import { testSuiteSchema, type TestSuite } from "./models/suite";
import { listMarkdownSpecs } from "./parser/markdown-loader";
import { SpecNormalizer, type NormalizerConfig } from "./parser/normalizer";
import { parseMarkdownToRaw } from "./parser/markdown-parser";
import { compiledPlanIsFresh, defaultCompiledOutputPath, fileSha256, writeCompiledPlan } from "./runtime/persistence";
import { runTui } from "./tui/app";

export const appName = "spec";

type CliCommand = "normalize" | "compile" | "run" | "report" | "init" | "tui" | "help";

type ParsedArgs = {
  command: CliCommand;
  positionals: string[];
  options: Record<string, string | boolean | string[]>;
};

const helpText = `spec CLI for markdown-to-browser execution.

Usage:
  bun run spec
  bun run spec tui
  bun run spec init
  bun run spec normalize <path> [--out file]
  bun run spec compile <path> [--out file]
  bun run spec run <path> [--out-dir dir] [--compiled-out file] [--tag value]
  bun run spec report <result.json> [--format markdown|html] [--out file]
`;

function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  const command = isCommand(first) ? first : "tui";
  const tokens = isCommand(first) ? rest : argv;
  const positionals: string[] = [];
  const options: Record<string, string | boolean | string[]> = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (token.startsWith("--no-")) {
      options[token.slice(5)] = false;
      continue;
    }

    const option = token.slice(2);
    const [rawKey, inlineValue] = option.split("=", 2);
    if (!rawKey) {
      continue;
    }
    if (inlineValue !== undefined) {
      appendOption(options, rawKey, inlineValue);
      continue;
    }

    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      options[rawKey] = true;
      continue;
    }

    appendOption(options, rawKey, next);
    index += 1;
  }

  return { command, positionals, options };
}

function isCommand(value: string | undefined): value is CliCommand {
  return value !== undefined && ["normalize", "compile", "run", "report", "init", "tui", "help"].includes(value);
}

function appendOption(target: ParsedArgs["options"], key: string, value: string): void {
  const current = target[key];
  if (current === undefined) {
    target[key] = value;
    return;
  }
  if (Array.isArray(current)) {
    current.push(value);
    return;
  }
  target[key] = [String(current), value];
}

function getStringOption(options: ParsedArgs["options"], key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

function getBooleanOption(options: ParsedArgs["options"], key: string, fallback: boolean): boolean {
  const value = options[key];
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return !["false", "0", "no"].includes(value.toLowerCase());
  }
  return fallback;
}

function getListOption(options: ParsedArgs["options"], key: string): string[] {
  const value = options[key];
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function requirePositional(positionals: string[], name: string): string {
  const value = positionals[0];
  if (!value) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return value;
}

async function discoverSpecs(startPath: string = process.cwd()): Promise<string[]> {
  const configPath = findProjectConfigPath(startPath);
  const config = loadProjectConfig(configPath);
  const workspace = existsSync(configPath) ? path.dirname(path.dirname(configPath)) : process.cwd();
  const matches = Array.from(new Bun.Glob(config.paths.specs_pattern).scanSync({ cwd: workspace, absolute: true }));
  return matches.sort();
}

async function buildSuiteWithLlm(specPath: string, options: { strictMode: boolean; llmModel?: string; llmTemperature?: number; llmMaxAttempts?: number; onLlmCall?: NormalizerConfig["on_llm_call"] }): Promise<TestSuite> {
  const config = loadProjectConfig(findProjectConfigPath(specPath));
  const raw = parseMarkdownToRaw(readFileSync(specPath, "utf8"));
  const normalizer = new SpecNormalizer({
    config: {
      strict_mode: options.strictMode,
      llm_model: resolveLlmModel(options.llmModel),
      llm_temperature: options.llmTemperature,
      llm_max_attempts: options.llmMaxAttempts,
      on_llm_call: options.onLlmCall,
    },
    projectConfig: config,
  });
  return normalizer.normalize(raw);
}

async function compileSuites(specPath: string, strictMode: boolean, llmOptions?: { llmModel?: string; llmTemperature?: number; llmMaxAttempts?: number; onLlmCall?: NormalizerConfig["on_llm_call"] }): Promise<TestSuite[]> {
  const specs = await listMarkdownSpecs(specPath);
  const suites: TestSuite[] = [];
  for (const spec of specs) {
    suites.push(
      await buildSuiteWithLlm(spec, {
        strictMode,
        llmModel: llmOptions?.llmModel,
        llmTemperature: llmOptions?.llmTemperature,
        llmMaxAttempts: llmOptions?.llmMaxAttempts,
        onLlmCall: llmOptions?.onLlmCall,
      }),
    );
  }
  return suites;
}

function serializeSuites(suites: TestSuite[]): unknown {
  return suites.length === 1 ? suites[0] : { suites };
}

function loadCompiledSuites(filePath: string): TestSuite[] {
  const payload = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (Array.isArray(payload.suites)) {
    return payload.suites.map((suite) => testSuiteSchema.parse(suite));
  }
  return [testSuiteSchema.parse(payload)];
}

async function loadSuitesForExecution(specPath: string, strictMode: boolean, compiledOut?: string, llmOptions?: { llmModel?: string; llmTemperature?: number; llmMaxAttempts?: number; onLlmCall?: NormalizerConfig["on_llm_call"] }): Promise<TestSuite[]> {
  if (specPath.endsWith(".json")) {
    return loadCompiledSuites(specPath);
  }

  const projectConfigPath = findProjectConfigPath(specPath);
  const cachePath = path.resolve(compiledOut ?? defaultCompiledOutputPath(projectConfigPath, specPath));
  if (compiledPlanIsFresh(cachePath, specPath)) {
    log.message(`Reusing compiled plan: ${cachePath}`);
    return loadCompiledSuites(cachePath);
  }

  const suites = await compileSuites(specPath, strictMode, llmOptions);
  writeCompiledPlan({
    suites,
    destination: cachePath,
    sourceSpec: specPath,
    sourceHash: fileSha256(specPath),
  });
  log.success(`Compiled suite written to ${cachePath}`);
  return suites;
}

async function runSpecPath(specPath: string, options: { outputDir?: string; compiledOut?: string; tags?: string[]; strictMode?: boolean; compileOnly?: boolean }): Promise<void> {
  const outputDir = path.resolve(options.outputDir ?? ".spec/results");
  mkdirSync(outputDir, { recursive: true });

  const suites = await loadSuitesForExecution(specPath, options.strictMode ?? false, options.compiledOut, {
    llmModel: undefined,
    llmTemperature: 1,
    llmMaxAttempts: 2,
  });

  for (const suite of suites) {
    if (options.compileOnly) {
      log.success(`Compiled ${suite.name}`);
      continue;
    }

    const progress = spinner();
    progress.stop(`Direct CLI execution is not wired yet. Use the TUI with \`bun run spec\`.`);
    note("Compile succeeded, but real execution is currently available through the TUI runner.", suite.name);
  }
}

async function normalizeCommand(parsed: ParsedArgs): Promise<void> {
  const specPath = path.resolve(requirePositional(parsed.positionals, "SPEC_PATH"));
  const suites = await compileSuites(specPath, getBooleanOption(parsed.options, "strict-mode", false), {
    llmModel: getStringOption(parsed.options, "llm-model"),
    llmTemperature: Number(getStringOption(parsed.options, "llm-temperature") ?? "1"),
    llmMaxAttempts: Number(getStringOption(parsed.options, "llm-max-attempts") ?? "2"),
  });
  console.log(JSON.stringify(serializeSuites(suites), null, 2));
}

async function compileCommand(parsed: ParsedArgs): Promise<void> {
  const specPath = path.resolve(requirePositional(parsed.positionals, "SPEC_PATH"));
  const suites = await compileSuites(specPath, getBooleanOption(parsed.options, "strict-mode", false), {
    llmModel: getStringOption(parsed.options, "llm-model"),
    llmTemperature: Number(getStringOption(parsed.options, "llm-temperature") ?? "1"),
    llmMaxAttempts: Number(getStringOption(parsed.options, "llm-max-attempts") ?? "2"),
  });
  const output = path.resolve(getStringOption(parsed.options, "out") ?? defaultCompiledOutputPath(findProjectConfigPath(specPath), specPath));
  writeCompiledPlan({
    suites,
    destination: output,
    sourceSpec: specPath.endsWith(".md") ? specPath : undefined,
    sourceHash: specPath.endsWith(".md") ? fileSha256(specPath) : undefined,
  });
  log.success(`Normalized spec written to ${output}`);
}

async function runCommand(parsed: ParsedArgs): Promise<void> {
  const specPath = path.resolve(requirePositional(parsed.positionals, "SPEC_PATH"));
  await runSpecPath(specPath, {
    outputDir: getStringOption(parsed.options, "out-dir"),
    compiledOut: getStringOption(parsed.options, "compiled-out"),
    tags: getListOption(parsed.options, "tag"),
    strictMode: getBooleanOption(parsed.options, "strict-mode", false),
  });
}

async function reportCommand(parsed: ParsedArgs): Promise<void> {
  const resultPath = path.resolve(requirePositional(parsed.positionals, "RESULT_JSON"));
  const format = (getStringOption(parsed.options, "format") ?? "markdown").toLowerCase();
  const out = getStringOption(parsed.options, "out");
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as { suite_name: string; status: string };

  if (format === "markdown" || format === "md") {
    const destination = path.resolve(out ?? resultPath.replace(/\.json$/u, ".md"));
    await Bun.write(destination, `# ${result.suite_name}\n\nStatus: ${result.status}\n`);
    log.success(`Markdown report written to ${destination}`);
    return;
  }

  if (format === "html") {
    const destination = path.resolve(out ?? resultPath.replace(/\.json$/u, ".html"));
    await Bun.write(destination, `<html><body><h1>${result.suite_name}</h1><p>Status: ${result.status}</p></body></html>`);
    log.success(`HTML report written to ${destination}`);
    return;
  }

  throw new Error("--format must be one of: markdown, md, html");
}

async function initCommand(force: boolean): Promise<void> {
  const specDir = path.join(process.cwd(), ".spec");
  const configPath = path.join(specDir, "spec.toml");
  mkdirSync(specDir, { recursive: true });
  if (existsSync(configPath) && !force) {
    throw new Error(`Config already exists at ${configPath}. Use --force to overwrite.`);
  }

  await Bun.write(
    configPath,
    `# Spec configuration\n# This file is committed to version control\n\n[spec]\nspecs_pattern = "tests/**/*.md"\nresults_dir = ".spec/results"\nbase_url = "http://localhost:3000"\ncapture = "on-failure"\nallowed_subdomains = []\n\n[spec.browser]\nbrowser = "chromium"\nviewport = "desktop"\nlocale = "en-US"\n\n[spec.runtime]\ndefault_timeout_ms = 10000\nassertion_timeout_ms = 10000\nlocator_resolution_timeout_ms = 5000\nnavigation_timeout_ms = 30000\nmax_retries = 0\nretry_on_flake = false\nstrict_mode = false\n`,
  );
  mkdirSync(path.join(specDir, "results"), { recursive: true });
  log.success(`Created ${configPath}`);
  log.success(`Created ${path.join(specDir, "results")}/`);
}

function ensureProjectInitialized(): void {
  const configPath = path.join(process.cwd(), ".spec", "spec.toml");
  if (existsSync(configPath)) {
    return;
  }
  throw new Error(
    "Missing project config at .spec/spec.toml. Run `bun run spec init` and set `base_url` before running suites.",
  );
}

async function tuiCommand(): Promise<void> {
  ensureProjectInitialized();
  await runTui(await discoverSpecs());
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText);
    return;
  }

  const parsed = parseArgs(argv);
  switch (parsed.command) {
    case "help":
      console.log(helpText);
      return;
    case "normalize":
      await normalizeCommand(parsed);
      return;
    case "compile":
      await compileCommand(parsed);
      return;
    case "run":
      await runCommand(parsed);
      return;
    case "report":
      await reportCommand(parsed);
      return;
    case "init":
      await initCommand(getBooleanOption(parsed.options, "force", false));
      return;
    case "tui":
      await tuiCommand();
      return;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    log.error(message);
    process.exit(1);
  });
}
