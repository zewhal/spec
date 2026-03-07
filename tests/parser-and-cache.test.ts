import { expect, test } from "bun:test";
import path from "node:path";

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
