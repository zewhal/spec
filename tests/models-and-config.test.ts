import { expect, test } from "bun:test";
import path from "node:path";

import { actionSchema } from "../src/models/action";
import { executionEventTypes } from "../src/models/enums";
import { expectationSchema } from "../src/models/expectation";
import { targetHintSchema } from "../src/models/selector";
import { testSuiteSchema } from "../src/models/suite";
import { findProjectConfigPath, loadProjectConfig } from "../src/config/project";

test("target hints require at least one selector field", () => {
  expect(() => targetHintSchema.parse({})).toThrow(
    "TargetHint must include at least one selector field.",
  );
});

test("action schema validates goto requirements", () => {
  expect(() => actionSchema.parse({ kind: "goto" })).toThrow("`goto` requires `url`.");
  expect(actionSchema.parse({ kind: "goto", url: "/login", readiness: "load" })).toMatchObject({
    kind: "goto",
    url: "/login",
    readiness: "load",
  });
});

test("expectation schema supports request seen assertions", () => {
  const expectation = expectationSchema.parse({
    kind: "request_seen",
    method: "POST",
    path: "/login",
  });

  expect(expectation.kind).toBe("request_seen");
});

test("suite schema rejects duplicate test ids", () => {
  expect(() =>
    testSuiteSchema.parse({
      id: "suite-1",
      name: "Suite 1",
      base_url: "https://example.com",
      tests: [
        { id: "test-1", name: "Test 1", steps: [{ kind: "comment", text: "step" }] },
        { id: "test-1", name: "Test 2", steps: [{ kind: "comment", text: "step" }] },
      ],
    }),
  ).toThrow("Duplicate test id found: 'test-1'.");
});

test("execution event types include suite lifecycle events", () => {
  expect(executionEventTypes).toContain("suite_started");
  expect(executionEventTypes).toContain("suite_finished");
});

test("findProjectConfigPath resolves .spec config", async () => {
  const tempRoot = await Bun.$`mktemp -d`.text();
  const workspace = tempRoot.trim();
  const nested = path.join(workspace, "tests", "specs");
  await Bun.$`mkdir -p ${nested}`;
  await Bun.$`mkdir -p ${path.join(workspace, ".spec")}`;
  await Bun.write(path.join(workspace, ".spec", "spec.toml"), "[spec]\nbase_url='https://example.com'\n");

  expect(findProjectConfigPath(nested)).toBe(path.join(workspace, ".spec", "spec.toml"));
});

test("loadProjectConfig reads spec runtime defaults", async () => {
  const tempRoot = (await Bun.$`mktemp -d`.text()).trim();
  const configPath = path.join(tempRoot, ".spec", "spec.toml");
  await Bun.$`mkdir -p ${path.dirname(configPath)}`;
  await Bun.write(
    configPath,
    [
      "[spec]",
      "base_url = 'https://example.com'",
      "allowed_subdomains = ['example.com']",
      "results_dir = '.spec/results'",
      "[spec.browser]",
      "browser = 'firefox'",
      "viewport = 'tablet'",
      "locale = 'fr-FR'",
      "[spec.runtime]",
      "strict_mode = true",
    ].join("\n"),
  );

  const config = loadProjectConfig(configPath);
  expect(config.runtime.base_url).toBe("https://example.com");
  expect(config.runtime.browser).toBe("firefox");
  expect(config.runtime.viewport).toBe("tablet");
  expect(config.runtime.locale).toBe("fr-FR");
  expect(config.runtime.allowed_subdomains).toEqual(["example.com"]);
  expect(config.runtime.strict_mode).toBe(true);
  expect(config.paths.results_dir).toBe(".spec/results");
});
