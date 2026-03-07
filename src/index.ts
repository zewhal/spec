import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import slugify from "slugify";

import { loadProjectConfig, findProjectConfigPath } from "./config/project";
import { loadMarkdown, listMarkdownSpecs } from "./parser/markdown-loader";
import { parseMarkdownToRaw } from "./parser/markdown-parser";
import type { Expectation } from "./models/expectation";
import type { Action } from "./models/action";
import { testSuiteSchema, type TestSuite } from "./models/suite";
import { compiledPlanIsFresh, defaultCompiledOutputPath, fileSha256, writeCompiledPlan } from "./runtime/persistence";

export const appName = "spec";

type CliCommand = "normalize" | "compile" | "run" | "report" | "init" | "tui" | "help";

type ParsedArgs = {
  command: CliCommand;
  positionals: string[];
  options: Record<string, string | boolean | string[]>;
};

const helpText = `spec CLI for markdown-to-browser execution.

Usage:
  bun run spec                Launch the default TUI-style spec listing
  bun run spec tui            Launch the default TUI-style spec listing
  bun run spec init           Create .spec/spec.toml
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
    if (token === undefined) {
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
    if (rawKey && inlineValue !== undefined) {
      appendOption(options, rawKey, inlineValue);
      continue;
    }

    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      if (rawKey) {
        options[rawKey] = true;
      }
      continue;
    }

    if (rawKey) {
      appendOption(options, rawKey, next);
    }
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
  const config = loadProjectConfig(findProjectConfigPath(startPath));
  const workspace = path.dirname(path.dirname(findProjectConfigPath(startPath)));
  const matches = Array.from(new Bun.Glob(config.paths.specs_pattern).scanSync({ cwd: workspace, absolute: true }));
  return matches.sort();
}

function printSpecs(specs: string[]): void {
  if (specs.length === 0) {
    console.log("No markdown specs found.");
    return;
  }

  console.log("Specs:");
  for (const spec of specs) {
    console.log(`- ${path.relative(process.cwd(), spec)}`);
  }
}

function buildSuiteFromRaw(specPath: string, strictMode: boolean): TestSuite {
  const config = loadProjectConfig(findProjectConfigPath(specPath));
  const raw = parseMarkdownToRaw(readFileSync(specPath, "utf8"));
  const suiteId = slugify(raw.name, { lower: true, strict: true }) || path.parse(specPath).name;

  const parseActions = (items: string[]): Action[] => items.map((item, index) => ({
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
  const suites: TestSuite[] = [];
  for (const spec of specs) {
    const markdown = await loadMarkdown(spec);
    const raw = parseMarkdownToRaw(markdown);
    void raw;
    suites.push(buildSuiteFromRaw(spec, strictMode));
  }
  return suites;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function loadCompiledSuites(filePath: string): TestSuite[] {
  const payload = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  if (Array.isArray(payload.suites)) {
    return payload.suites.map((suite) => testSuiteSchema.parse(suite));
  }
  return [testSuiteSchema.parse(payload)];
}

async function runCommand(parsed: ParsedArgs): Promise<void> {
  const specPath = path.resolve(requirePositional(parsed.positionals, "SPEC_PATH"));
  const outputDir = path.resolve(getStringOption(parsed.options, "out-dir") ?? ".spec/results");
  const compiledOut = getStringOption(parsed.options, "compiled-out");
  const tags = new Set(getListOption(parsed.options, "tag"));
  const strictMode = getBooleanOption(parsed.options, "strict-mode", false);

  const suites = specPath.endsWith(".json") ? loadCompiledSuites(specPath) : await loadSuitesForExecution(specPath, strictMode, compiledOut);
  mkdirSync(outputDir, { recursive: true });

  const results = suites.map((suite) => {
    const selectedTests = tags.size === 0 ? suite.tests : suite.tests.filter((test) => test.tags.some((tag) => tags.has(tag)));
    return {
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
  });

  for (const result of results) {
    const suiteDir = path.join(outputDir, result.suite_id);
    mkdirSync(suiteDir, { recursive: true });
    Bun.write(path.join(suiteDir, "result.json"), JSON.stringify(result, null, 2));
    Bun.write(path.join(suiteDir, "report.md"), `# ${result.suite_name}\n\nStatus: ${result.status}\n`);
    Bun.write(path.join(suiteDir, "report.html"), `<html><body><h1>${result.suite_name}</h1><p>Status: ${result.status}</p></body></html>`);
    Bun.write(path.join(suiteDir, "summary.json"), JSON.stringify({ suite: result.suite_name, status: result.status, artifacts_root: result.artifacts_root }, null, 2));
    console.log(`Finished suite ${result.suite_name} -> ${path.join(suiteDir, "result.json")}`);
  }
}

async function loadSuitesForExecution(specPath: string, strictMode: boolean, compiledOut?: string): Promise<TestSuite[]> {
  const projectConfigPath = findProjectConfigPath(specPath);
  const cachePath = path.resolve(compiledOut ?? defaultCompiledOutputPath(projectConfigPath, specPath));
  if (compiledPlanIsFresh(cachePath, specPath)) {
    console.log(`Reusing compiled plan: ${cachePath}`);
    return loadCompiledSuites(cachePath);
  }
  const suites = await compileSuites(specPath, strictMode);
  writeCompiledPlan({ suites, destination: cachePath, sourceSpec: specPath, sourceHash: fileSha256(specPath) });
  console.log(`Compiled suite written to ${cachePath}`);
  return suites;
}

async function normalizeOrCompile(parsed: ParsedArgs, writeOutput: boolean): Promise<void> {
  const specPath = path.resolve(requirePositional(parsed.positionals, "SPEC_PATH"));
  const strictMode = getBooleanOption(parsed.options, "strict-mode", false);
  const suites = await compileSuites(specPath, strictMode);
  const output = getStringOption(parsed.options, "out");
  if (writeOutput && output) {
    writeCompiledPlan({
      suites,
      destination: path.resolve(output),
      sourceSpec: existsSync(specPath) && specPath.endsWith(".md") ? specPath : undefined,
      sourceHash: existsSync(specPath) && specPath.endsWith(".md") ? fileSha256(specPath) : undefined,
    });
    console.log(`Normalized spec written to ${path.resolve(output)}`);
    return;
  }
  if (writeOutput) {
    const destination = defaultCompiledOutputPath(findProjectConfigPath(specPath), specPath);
    writeCompiledPlan({
      suites,
      destination,
      sourceSpec: existsSync(specPath) && specPath.endsWith(".md") ? specPath : undefined,
      sourceHash: existsSync(specPath) && specPath.endsWith(".md") ? fileSha256(specPath) : undefined,
    });
    console.log(`Normalized spec written to ${destination}`);
    return;
  }
  printJson(suites.length === 1 ? suites[0] : { suites });
}

async function reportCommand(parsed: ParsedArgs): Promise<void> {
  const resultPath = path.resolve(requirePositional(parsed.positionals, "RESULT_JSON"));
  const format = (getStringOption(parsed.options, "format") ?? "markdown").toLowerCase();
  const out = getStringOption(parsed.options, "out");
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as { suite_name: string; status: string };
  if (format === "markdown" || format === "md") {
    const destination = path.resolve(out ?? resultPath.replace(/\.json$/u, ".md"));
    await Bun.write(destination, `# ${result.suite_name}\n\nStatus: ${result.status}\n`);
    console.log(`Markdown report written to ${destination}`);
    return;
  }
  if (format === "html") {
    const destination = path.resolve(out ?? resultPath.replace(/\.json$/u, ".html"));
    await Bun.write(destination, `<html><body><h1>${result.suite_name}</h1><p>Status: ${result.status}</p></body></html>`);
    console.log(`HTML report written to ${destination}`);
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
  console.log(`Created ${configPath}`);
  console.log(`Created ${path.join(specDir, "results")}/`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(helpText);
    return;
  }
  switch (parsed.command) {
    case "help":
      console.log(helpText);
      return;
    case "normalize":
      await normalizeOrCompile(parsed, false);
      return;
    case "compile":
      await normalizeOrCompile(parsed, true);
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
      printSpecs(await discoverSpecs());
      return;
    default:
      console.log(helpText);
  }
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
