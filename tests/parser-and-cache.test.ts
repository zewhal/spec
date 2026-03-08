import { expect, test } from "bun:test";
import path from "node:path";

import { MiniMaxClient } from "../src/integrations";
import { SpecNormalizer } from "../src/parser/normalizer";
import { parseMarkdownToRaw } from "../src/parser/markdown-parser";
import {
  compiledPlanIsFresh,
  defaultCompiledOutputPath,
  fileSha256,
  writeCompiledPlan,
} from "../src/runtime/persistence";

test("parseMarkdownToRaw extracts sections from markdown", () => {
  const markdown = `
# Suite: Registration Flows

## Config
base_url: https://example.com
browser: chromium
viewport: 1440x900

## Variables
valid_username: michael123
valid_password: Secret123!

## Test: Successful registration

### Steps
1. Go to /register
2. Enter "{{valid_username}}" into the username field
3. Enter "{{valid_password}}" into the password field
4. Click the "Submit" button

### Expect
- URL should be /dashboard
- Text "Welcome" should be visible
- A request POST /register should happen
`;

  const raw = parseMarkdownToRaw(markdown);
  expect(raw.name).toBe("Registration Flows");
  expect(raw.config.base_url).toBe("https://example.com");
  expect(raw.variables.valid_username).toBe("michael123");
  expect(raw.tests).toHaveLength(1);
  expect(raw.tests[0]?.name).toBe("Successful registration");
  expect(raw.tests[0]?.steps).toHaveLength(4);
  expect(raw.tests[0]?.expectations).toHaveLength(3);
});

test("parser tolerates nonstandard heading levels inside tests", () => {
  const markdown = `
# Suite: Nonstandard Headings

## Config
base_url: http://localhost:3000

## Test: Redirect to login

# Steps
- Go to /
- Wait for URL to be /en/login

# Expect
- URL should contain /en/login
- Text "Sign in" should be visible
`;

  const raw = parseMarkdownToRaw(markdown);
  expect(raw.tests).toHaveLength(1);
  expect(raw.tests[0]?.steps).toEqual(["Go to /", "Wait for URL to be /en/login"]);
  expect(raw.tests[0]?.expectations).toEqual([
    "URL should contain /en/login",
    'Text "Sign in" should be visible',
  ]);
  expect(raw.tests[0]?.authoring_mode).toBe("fixed");
});

test("parser marks prose-style tests as freeflow under auto mode", () => {
  const markdown = `
# Suite: Guided Authoring

## Test: Shopper checks out

Open the storefront, add the featured product to the cart, go to checkout, and confirm the thank-you screen appears.
`;

  const raw = parseMarkdownToRaw(markdown);
  expect(raw.tests).toHaveLength(1);
  expect(raw.tests[0]?.authoring_mode).toBe("freeflow");
  expect(raw.tests[0]?.freeflow_block).toContain("Open the storefront");
  expect(raw.tests[0]?.steps).toEqual([]);
  expect(raw.tests[0]?.expectations).toEqual([]);
});

test("freeflow normalization sanitizes mixed goto and wait payloads", async () => {
  const raw = parseMarkdownToRaw(`
# Suite: Guided Authoring

## Config
base_url: https://example.org

## Test: Another simple test

Open https://example.org/index.html and wait for one second.
`);

  const normalizer = new SpecNormalizer({
    projectConfig: {
      paths: { specs_pattern: "tests/**/*.md", results_dir: ".spec/results" },
      runtime: {
        base_url: "https://example.org",
        browser: "chromium",
        viewport: "desktop",
        locale: "en-US",
        capture: "on-failure",
        allowed_subdomains: ["example.org"],
        default_timeout_ms: 10_000,
        assertion_timeout_ms: 10_000,
        locator_resolution_timeout_ms: 5_000,
        navigation_timeout_ms: 30_000,
        max_retries: 0,
        retry_on_flake: false,
        strict_mode: false,
      },
    },
    llmClient: {
      normalizeStep: async () => ({
        kind: "goto",
        url: "https://example.org/index.html",
        duration_ms: 1000,
      }),
      normalizeExpectation: async () => ({ kind: "text_visible", text: "ok" }),
      extractTestOutline: async () => ({
        steps: ["Open https://example.org/index.html and wait for one second."],
        expectations: [],
      }),
    } as unknown as MiniMaxClient,
  });

  const normalized = await normalizer.normalize(raw);
  expect(normalized.tests[0]?.steps[0]?.kind).toBe("goto");
  expect(normalized.tests[0]?.steps[0]).not.toHaveProperty("duration_ms");
});

test("normalizer assigns stable ids when LLM omits them", async () => {
  const raw = parseMarkdownToRaw(`
# Suite: Stable IDs

## Config
base_url: https://example.org

## Test: Generated ids

- Open https://example.org
- Wait for timeout 1000

- URL should contain example.org
`);

  const normalizer = new SpecNormalizer({
    projectConfig: {
      paths: { specs_pattern: "tests/**/*.md", results_dir: ".spec/results" },
      runtime: {
        base_url: "https://example.org",
        browser: "chromium",
        viewport: "desktop",
        locale: "en-US",
        capture: "on-failure",
        allowed_subdomains: ["example.org"],
        default_timeout_ms: 10_000,
        assertion_timeout_ms: 10_000,
        locator_resolution_timeout_ms: 5_000,
        navigation_timeout_ms: 30_000,
        max_retries: 0,
        retry_on_flake: false,
        strict_mode: false,
      },
    },
    llmClient: {
      normalizeStep: async (step: string) => {
        if (step.toLowerCase().includes("open")) {
          return { kind: "goto", url: "https://example.org", readiness: "load" };
        }
        return { kind: "wait_for", wait_type: "timeout", duration_ms: 1000 };
      },
      normalizeExpectation: async () => ({ kind: "url_contains", value: "example.org" }),
      extractTestOutline: async () => ({ steps: [], expectations: [] }),
    } as unknown as MiniMaxClient,
  });

  const normalized = await normalizer.normalize(raw);
  expect(normalized.tests[0]?.steps[0]?.id).toBe("step-1");
  expect(normalized.tests[0]?.steps[1]?.id).toBe("step-2");
  expect(normalized.tests[0]?.expectations[0]?.id).toBe("expect-1");
});

test("normalizer coerces generic page text expectations to body visibility", async () => {
  const raw = parseMarkdownToRaw(`
# Suite: Generic Visibility

## Config
base_url: https://example.org

## Test: Page opens

Open https://example.org/ and wait for one second.
`);

  const normalizer = new SpecNormalizer({
    projectConfig: {
      paths: { specs_pattern: "tests/**/*.md", results_dir: ".spec/results" },
      runtime: {
        base_url: "https://example.org",
        browser: "chromium",
        viewport: "desktop",
        locale: "en-US",
        capture: "on-failure",
        allowed_subdomains: ["example.org"],
        default_timeout_ms: 10_000,
        assertion_timeout_ms: 10_000,
        locator_resolution_timeout_ms: 5_000,
        navigation_timeout_ms: 30_000,
        max_retries: 0,
        retry_on_flake: false,
        strict_mode: false,
      },
    },
    llmClient: {
      normalizeStep: async () => ({ kind: "goto", url: "https://example.org/", readiness: "load" }),
      normalizeExpectation: async () => ({ kind: "text_visible", text: "Page loads successfully without errors" }),
      extractTestOutline: async () => ({
        steps: ["Open https://example.org/ and wait for one second."],
        expectations: ["Page loads successfully without errors"],
      }),
    } as unknown as MiniMaxClient,
  });

  const normalized = await normalizer.normalize(raw);
  expect(normalized.tests[0]?.expectations[0]?.kind).toBe("element_visible");
  expect(normalized.tests[0]?.expectations[0]).toMatchObject({
    target: { css: "body" },
  });
});

test("defaultCompiledOutputPath uses compiled directory for markdown files", async () => {
  const tempRoot = (await Bun.$`mktemp -d`.text()).trim();
  const configPath = path.join(tempRoot, ".spec", "spec.toml");
  const specPath = path.join(tempRoot, "tests", "specs", "checkout.md");
  await Bun.$`mkdir -p ${path.dirname(configPath)} ${path.dirname(specPath)}`;
  await Bun.write(configPath, "[spec]\nbase_url = 'https://example.com'\n");
  await Bun.write(specPath, "# Suite: Checkout\n");

  expect(defaultCompiledOutputPath(configPath, specPath)).toBe(
    path.join(tempRoot, ".spec", "compiled", "checkout.json"),
  );
});

test("compiledPlanIsFresh only returns true when source hash matches", async () => {
  const tempRoot = (await Bun.$`mktemp -d`.text()).trim();
  const specPath = path.join(tempRoot, "flow.md");
  const compiledPath = path.join(tempRoot, "compiled.json");
  await Bun.write(specPath, "# Suite: Freshness\n");

  writeCompiledPlan({
    suites: [
      {
        id: "freshness",
        name: "Freshness",
        base_url: "https://example.com",
        browser: "chromium",
        viewport: "desktop",
        locale: "en-US",
        variables: {},
        datasets: {},
        tests: [],
        setup_steps: [],
        teardown_steps: [],
        artifact_policy: {
          capture_on_step: false,
          capture_on_failure: true,
          capture_console: true,
          capture_network: true,
          capture_trace: false,
          capture_video: false,
        },
        runtime_policy: {
          default_timeout_ms: 10000,
          assertion_timeout_ms: 10000,
          locator_resolution_timeout_ms: 5000,
          navigation_timeout_ms: 30000,
          max_retries: 0,
          retry_on_flake: false,
          strict_mode: false,
        },
        allowed_subdomains: ["example.com"],
      },
    ],
    destination: compiledPath,
    sourceSpec: specPath,
    sourceHash: fileSha256(specPath),
  });

  expect(compiledPlanIsFresh(compiledPath, specPath)).toBe(true);

  await Bun.write(specPath, "# Suite: Freshness changed\n");
  expect(compiledPlanIsFresh(compiledPath, specPath)).toBe(false);
});

test("compiledPlanIsFresh invalidates legacy plans without compiler version", async () => {
  const tempRoot = (await Bun.$`mktemp -d`.text()).trim();
  const specPath = path.join(tempRoot, "flow.md");
  const compiledPath = path.join(tempRoot, "compiled.json");
  await Bun.write(specPath, "# Suite: Legacy\n");

  writeCompiledPlan({
    suites: [
      {
        id: "legacy",
        name: "Legacy",
        base_url: "https://example.com",
        browser: "chromium",
        viewport: "desktop",
        locale: "en-US",
        variables: {},
        datasets: {},
        tests: [],
        setup_steps: [],
        teardown_steps: [],
        artifact_policy: {
          capture_on_step: false,
          capture_on_failure: true,
          capture_console: true,
          capture_network: true,
          capture_trace: false,
          capture_video: false,
        },
        runtime_policy: {
          default_timeout_ms: 10000,
          assertion_timeout_ms: 10000,
          locator_resolution_timeout_ms: 5000,
          navigation_timeout_ms: 30000,
          max_retries: 0,
          retry_on_flake: false,
          strict_mode: false,
        },
        allowed_subdomains: ["example.com"],
      },
    ],
    destination: compiledPath,
    sourceSpec: specPath,
    sourceHash: fileSha256(specPath),
  });

  const payload = JSON.parse(await Bun.file(compiledPath).text()) as Record<string, unknown>;
  const metadata = payload._spec as Record<string, unknown>;
  delete metadata.compiler_version;
  await Bun.write(compiledPath, JSON.stringify(payload, null, 2));

  expect(compiledPlanIsFresh(compiledPath, specPath)).toBe(false);
});
