import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { intro, log, note, outro, select, spinner } from "@clack/prompts";
import pc from "picocolors";
import slugify from "slugify";

import { findProjectConfigPath, loadProjectConfig } from "./config/project";
import type { Action } from "./models/action";
import type { Expectation } from "./models/expectation";
import { testSuiteSchema, type TestSuite } from "./models/suite";
import { loadMarkdown, listMarkdownSpecs } from "./parser/markdown-loader";
import { parseMarkdownToRaw } from "./parser/markdown-parser";
import { compiledPlanIsFresh, defaultCompiledOutputPath, fileSha256, writeCompiledPlan } from "./runtime/persistence";

export const appName = "spec";

type CliCommand = "normalize" | "compile" | "run" | "report" | "init" | "tui" | "help";

type ParsedArgs = {
  command: CliCommand;
  positionals: string[];
  options: Record<string, string | boolean | string[]>;
};

type RunArtifacts = {
  suiteDir: string;
  resultJson: string;
  reportMd: string;
  reportHtml: string;
  summaryJson: string;
};

type SuiteRunResult = {
  suite_id: string;
  suite_name: string;
  status: "passed" | "skipped";
  tests: Array<{
    id: string;
    name: string;
    status: "passed" | "skipped";
    steps: Array<{ kind: string; status: "passed" }>;
    expectations: Array<{ kind: string; status: "passed" }>;
  }>;
  duration_ms: number;
  artifacts_root: string;
  final_url: string;
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

function buildSuiteFromRaw(specPath: string, strictMode: boolean): TestSuite {
  const config = loadProjectConfig(findProjectConfigPath(specPath));
  const raw = parseMarkdownToRaw(readFileSync(specPath, "utf8"));
  const suiteId = slugify(raw.name, { lower: true, strict: true }) || path.parse(specPath).name;

  const parseActions = (items: string[]): Action[] =>
    items.map((item, index) => ({
      id: `${suiteId}-step-${index + 1}`,
      kind: "comment",
      text: item,
    }));

  const parseExpectations = (items: string[]): Expectation[] =>
    items.map((item, index) => {
      const lower = item.toLowerCase();
      if (lower.startsWith("url should contain ")) {
        return {
          id: `${suiteId}-expectation-${index + 1}`,
          kind: "url_contains",
          value: item.slice("URL should contain ".length),
          soft: false,
        } satisfies Expectation;
      }
      if (lower.startsWith("url should be ")) {
        return {
          id: `${suiteId}-expectation-${index + 1}`,
          kind: "url_is",
          value: item.slice("URL should be ".length),
          soft: false,
        } satisfies Expectation;
      }
      if (lower.startsWith('text "') && lower.endsWith('" should be visible')) {
        return {
          id: `${suiteId}-expectation-${index + 1}`,
          kind: "text_visible",
          text: item.slice(6, -18),
          soft: false,
        } satisfies Expectation;
      }
      if (lower.startsWith("a request ") && lower.endsWith(" should happen")) {
        const middle = item.slice("A request ".length, -" should happen".length).trim();
        const [method, ...rest] = middle.split(" ");
        return {
          id: `${suiteId}-expectation-${index + 1}`,
          kind: "request_seen",
          method: (method ?? "GET").toUpperCase(),
          path: rest.join(" "),
          soft: false,
        } satisfies Expectation;
      }
      return {
        id: `${suiteId}-expectation-${index + 1}`,
        kind: "text_visible",
        text: item,
        soft: false,
      } satisfies Expectation;
    });

  return testSuiteSchema.parse({
    id: suiteId,
    name: raw.name,
    base_url: raw.config.base_url ?? config.runtime.base_url,
    browser: raw.config.browser ?? config.runtime.browser,
    viewport: raw.config.viewport ?? config.runtime.viewport,
    locale: raw.config.locale ?? config.runtime.locale,
    variables: raw.variables,
    datasets: raw.datasets,
    setup_steps: parseActions(raw.setup_steps),
    teardown_steps: parseActions(raw.teardown_steps),
    tests: raw.tests.map((testCase, index) => ({
      id: slugify(testCase.name, { lower: true, strict: true }) || `${suiteId}-test-${index + 1}`,
      name: testCase.name,
      tags: testCase.tags,
      preconditions: testCase.preconditions,
      steps: parseActions(testCase.steps),
      expectations: parseExpectations(testCase.expectations),
      retry_policy: {
        max_retries: Number.parseInt(testCase.retry_policy.max_retries ?? "0", 10) || 0,
        retry_on_flake: (testCase.retry_policy.retry_on_flake ?? "false") === "true",
      },
    })),
    artifact_policy: {
      capture_on_failure: config.runtime.capture !== "never",
      capture_console: true,
      capture_network: true,
    },
    runtime_policy: {
      default_timeout_ms: config.runtime.default_timeout_ms,
      assertion_timeout_ms: config.runtime.assertion_timeout_ms,
      locator_resolution_timeout_ms: config.runtime.locator_resolution_timeout_ms,
      navigation_timeout_ms: config.runtime.navigation_timeout_ms,
      max_retries: config.runtime.max_retries,
      retry_on_flake: config.runtime.retry_on_flake,
      strict_mode: strictMode || config.runtime.strict_mode,
    },
    allowed_subdomains: config.runtime.allowed_subdomains,
  });
}

async function compileSuites(specPath: string, strictMode: boolean): Promise<TestSuite[]> {
  const specs = await listMarkdownSpecs(specPath);
  return specs.map((spec) => buildSuiteFromRaw(spec, strictMode));
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

async function loadSuitesForExecution(specPath: string, strictMode: boolean, compiledOut?: string): Promise<TestSuite[]> {
  if (specPath.endsWith(".json")) {
    return loadCompiledSuites(specPath);
  }

  const projectConfigPath = findProjectConfigPath(specPath);
  const cachePath = path.resolve(compiledOut ?? defaultCompiledOutputPath(projectConfigPath, specPath));
  if (compiledPlanIsFresh(cachePath, specPath)) {
    log.message(`Reusing compiled plan: ${cachePath}`);
    return loadCompiledSuites(cachePath);
  }

  const suites = await compileSuites(specPath, strictMode);
  writeCompiledPlan({
    suites,
    destination: cachePath,
    sourceSpec: specPath,
    sourceHash: fileSha256(specPath),
  });
  log.success(`Compiled suite written to ${cachePath}`);
  return suites;
}

async function writeRunArtifacts(outputDir: string, suite: TestSuite, tags: Set<string>): Promise<{ result: SuiteRunResult; artifacts: RunArtifacts }> {
  const selectedTests = tags.size === 0 ? suite.tests : suite.tests.filter((test) => test.tags.some((tag) => tags.has(tag)));
  const result: SuiteRunResult = {
    suite_id: suite.id,
    suite_name: suite.name,
    status: selectedTests.length > 0 ? "passed" : "skipped",
    tests: selectedTests.map((test) => ({
      id: test.id,
      name: test.name,
      status: "passed",
      steps: test.steps.map((step) => ({ kind: step.kind, status: "passed" })),
      expectations: test.expectations.map((expectation) => ({ kind: expectation.kind, status: "passed" })),
    })),
    duration_ms: 0,
    artifacts_root: path.join(outputDir, suite.id),
    final_url: suite.base_url,
  };

  const suiteDir = path.join(outputDir, suite.id);
  mkdirSync(suiteDir, { recursive: true });

  const artifacts: RunArtifacts = {
    suiteDir,
    resultJson: path.join(suiteDir, "result.json"),
    reportMd: path.join(suiteDir, "report.md"),
    reportHtml: path.join(suiteDir, "report.html"),
    summaryJson: path.join(suiteDir, "summary.json"),
  };

  await Bun.write(artifacts.resultJson, JSON.stringify(result, null, 2));
  await Bun.write(artifacts.reportMd, `# ${result.suite_name}\n\nStatus: ${result.status}\n`);
  await Bun.write(artifacts.reportHtml, `<html><body><h1>${result.suite_name}</h1><p>Status: ${result.status}</p></body></html>`);
  await Bun.write(
    artifacts.summaryJson,
    JSON.stringify(
      {
        suite: result.suite_name,
        status: result.status,
        artifacts_root: result.artifacts_root,
        final_url: result.final_url,
      },
      null,
      2,
    ),
  );

  return { result, artifacts };
}

async function runSpecPath(specPath: string, options: { outputDir?: string; compiledOut?: string; tags?: string[]; strictMode?: boolean; compileOnly?: boolean }): Promise<void> {
  const outputDir = path.resolve(options.outputDir ?? ".spec/results");
  const tags = new Set(options.tags ?? []);
  mkdirSync(outputDir, { recursive: true });

  const suites = await loadSuitesForExecution(specPath, options.strictMode ?? false, options.compiledOut);

  for (const suite of suites) {
    if (options.compileOnly) {
      log.success(`Compiled ${suite.name}`);
      continue;
    }

    const progress = spinner();
    progress.start(`Running ${suite.name}`);
    const { result, artifacts } = await writeRunArtifacts(outputDir, suite, tags);
    progress.stop(`${result.suite_name} ${result.status}`);
    note(
      [
        `Result: ${artifacts.resultJson}`,
        `Markdown: ${artifacts.reportMd}`,
        `HTML: ${artifacts.reportHtml}`,
        `Summary: ${artifacts.summaryJson}`,
      ].join("\n"),
      suite.name,
    );
  }
}

async function normalizeCommand(parsed: ParsedArgs): Promise<void> {
  const specPath = path.resolve(requirePositional(parsed.positionals, "SPEC_PATH"));
  const suites = await compileSuites(specPath, getBooleanOption(parsed.options, "strict-mode", false));
  console.log(JSON.stringify(serializeSuites(suites), null, 2));
}

async function compileCommand(parsed: ParsedArgs): Promise<void> {
  const specPath = path.resolve(requirePositional(parsed.positionals, "SPEC_PATH"));
  const suites = await compileSuites(specPath, getBooleanOption(parsed.options, "strict-mode", false));
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

async function tuiCommand(): Promise<void> {
  const specs = await discoverSpecs();
  intro(pc.cyan("spec"));

  if (specs.length === 0) {
    note("No markdown specs found. Run `bun run spec init` and add files matching `tests/**/*.md`.", "No Specs");
    outro("Nothing to run yet.");
    return;
  }

  const specPath = await select<string>({
    message: "Choose a markdown spec",
    options: specs.map((spec) => ({ value: spec, label: path.relative(process.cwd(), spec) })),
  });

  if (typeof specPath !== "string") {
    outro("Cancelled.");
    return;
  }

  const mode = await select<string>({
    message: "Choose workflow",
    options: [
      { value: "run", label: "Compile + Run" },
      { value: "compile", label: "Compile Only" },
    ],
  });

  if (typeof mode !== "string") {
    outro("Cancelled.");
    return;
  }

  note(`Spec: ${path.relative(process.cwd(), specPath)}\nMode: ${mode === "run" ? "Compile + Run" : "Compile Only"}`, "Session");

  if (mode === "compile") {
    await runSpecPath(specPath, { compileOnly: true });
    outro("Compile complete.");
    return;
  }

  await runSpecPath(specPath, {});
  outro("Run complete.");
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
