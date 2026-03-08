import slugify from "slugify";

import type { ProjectConfig } from "../config";
import { MiniMaxClient, type MiniMaxClientConfig } from "../integrations";
import type { Action } from "../models/action";
import { actionSchema } from "../models/action";
import { expectationSchema, type Expectation } from "../models/expectation";
import { DEFAULT_MINIMAX_MODEL } from "../integrations";
import type { TargetHint } from "../models/selector";
import type { TestCase, TestSuite } from "../models/suite";
import { artifactPolicySchema, retryPolicySchema, runtimePolicySchema, testSuiteSchema } from "../models/suite";
import type { RawSuiteDocument, RawTestCase } from "./raw-models";

export class SpecNormalizationError extends Error {}

export type NormalizerConfig = {
  authoring_mode?: "auto" | "fixed" | "freeflow";
  strict_mode?: boolean;
  llm_model?: string;
  llm_temperature?: number;
  llm_max_attempts?: number;
  llm_parse_tests?: boolean;
  on_llm_call?: (prompt: string, response: Record<string, unknown>) => void;
  on_authoring_mode_detected?: (info: { test_name: string; authoring_mode: "auto" | "fixed" | "freeflow" }) => void;
  on_deterministic_step?: (info: { test_name: string; step_text: string }) => void;
};

const defaultNormalizerConfig: Required<NormalizerConfig> = {
  strict_mode: false,
  authoring_mode: "auto",
  llm_model: DEFAULT_MINIMAX_MODEL,
  llm_temperature: 1,
  llm_max_attempts: 2,
  llm_parse_tests: true,
  on_llm_call: () => {},
  on_authoring_mode_detected: () => {},
  on_deterministic_step: () => {},
};

export class SpecNormalizer {
  readonly config: Required<NormalizerConfig>;
  readonly projectConfig: ProjectConfig;
  readonly llmClient: MiniMaxClient;

  constructor(options: {
    config?: NormalizerConfig;
    llmClient?: MiniMaxClient;
    projectConfig?: ProjectConfig;
  } = {}) {
    this.config = { ...defaultNormalizerConfig, ...options.config };
    this.projectConfig = options.projectConfig ?? {
      paths: { specs_pattern: "tests/**/*.md", results_dir: ".spec/results" },
      runtime: {
        base_url: "",
        browser: "chromium",
        viewport: "desktop",
        locale: "en-US",
        capture: "on-failure",
        allowed_subdomains: [],
        default_timeout_ms: 10_000,
        assertion_timeout_ms: 10_000,
        locator_resolution_timeout_ms: 5_000,
        navigation_timeout_ms: 30_000,
        max_retries: 0,
        retry_on_flake: false,
        strict_mode: false,
      },
    };
    this.llmClient =
      options.llmClient ??
      new MiniMaxClient(
        {
          model: this.config.llm_model,
          temperature: this.config.llm_temperature,
          max_attempts: this.config.llm_max_attempts,
        } satisfies MiniMaxClientConfig,
        this.config.on_llm_call,
      );
  }

  async normalize(rawSuite: RawSuiteDocument): Promise<TestSuite> {
    const mergedConfig = this.mergedSuiteConfig(rawSuite);
    const baseUrl = String(mergedConfig.base_url ?? "").trim();
    if (!baseUrl) {
      throw new SpecNormalizationError("A base_url is required. Set it in `.spec/spec.toml` or the suite config.");
    }

    const suiteId = slugify(rawSuite.name) || "suite";
    const resolvedVariables = this.resolveEnvVariables(rawSuite.variables);

    const setupSteps: Action[] = [];
    for (const [index, step] of rawSuite.setup_steps.entries()) {
      setupSteps.push(await this.normalizeStepText(step, resolvedVariables, index + 1));
    }

    const teardownSteps: Action[] = [];
    for (const [index, step] of rawSuite.teardown_steps.entries()) {
      teardownSteps.push(await this.normalizeStepText(step, resolvedVariables, index + 1));
    }

    const tests: TestCase[] = [];
    for (const [index, test] of rawSuite.tests.entries()) {
      tests.push(await this.normalizeTest(rawSuite, test, index + 1, resolvedVariables));
    }

    const allowedSubdomains = String(mergedConfig.allowed_subdomains ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    return testSuiteSchema.parse({
      id: suiteId,
      name: rawSuite.name,
      base_url: baseUrl,
      browser: mergedConfig.browser ?? "chromium",
      viewport: mergedConfig.viewport ?? "desktop",
      locale: mergedConfig.locale ?? "en-US",
      variables: resolvedVariables,
      datasets: rawSuite.datasets,
      tests,
      setup_steps: setupSteps,
      teardown_steps: teardownSteps,
      artifact_policy: this.buildArtifactPolicy(mergedConfig),
      runtime_policy: this.buildRuntimePolicy(mergedConfig),
      allowed_subdomains: allowedSubdomains.length > 0 ? allowedSubdomains : [new URL(baseUrl).host].filter(Boolean),
    });
  }

  private mergedSuiteConfig(rawSuite: RawSuiteDocument): Record<string, string | boolean | number | string[]> {
    const runtime = this.projectConfig.runtime;
    return {
      base_url: runtime.base_url,
      browser: runtime.browser,
      viewport: runtime.viewport,
      locale: runtime.locale,
      capture: runtime.capture,
      allowed_subdomains: runtime.allowed_subdomains.join(","),
      default_timeout_ms: runtime.default_timeout_ms,
      assertion_timeout_ms: runtime.assertion_timeout_ms,
      locator_resolution_timeout_ms: runtime.locator_resolution_timeout_ms,
      navigation_timeout_ms: runtime.navigation_timeout_ms,
      max_retries: runtime.max_retries,
      retry_on_flake: String(runtime.retry_on_flake),
      strict_mode: String(runtime.strict_mode),
      ...rawSuite.config,
    };
  }

  private async normalizeTest(
    _rawSuite: RawSuiteDocument,
    rawTest: RawTestCase,
    index: number,
    resolvedVariables: Record<string, string>,
  ): Promise<TestCase> {
    const testId = slugify(rawTest.name) || `test-${index}`;
    let parsedSteps = [...rawTest.steps];
    let parsedExpectations = [...rawTest.expectations];
    const authoringMode = this.resolveAuthoringMode(rawTest);
    this.config.on_authoring_mode_detected({
      test_name: rawTest.name,
      authoring_mode: authoringMode,
    });

    if (this.config.llm_parse_tests && this.requiresOutlineExtraction(rawTest, authoringMode)) {
      const outline = await this.llmClient.extractTestOutline(
        rawTest.name,
        rawTest.freeflow_block || rawTest.raw_block || rawTest.steps.join("\n"),
      );
      const outlinedSteps = Array.isArray(outline.steps) ? outline.steps.map((item) => String(item).trim()).filter(Boolean) : [];
      const outlinedExpectations = Array.isArray(outline.expectations)
        ? outline.expectations.map((item) => String(item).trim()).filter(Boolean)
        : [];
      if (outlinedSteps.length > 0) {
        parsedSteps = outlinedSteps;
      }
      if (outlinedExpectations.length > 0) {
        parsedExpectations = outlinedExpectations;
      }
    }

    const steps: Action[] = [];
    if (authoringMode === "fixed") {
      for (const [stepIndex, step] of parsedSteps.entries()) {
        steps.push(this.normalizeFixedStepText(rawTest.name, step, resolvedVariables, stepIndex + 1));
      }
    } else {
      for (const [stepIndex, step] of parsedSteps.entries()) {
        steps.push(await this.normalizeStepText(step, resolvedVariables, stepIndex + 1));
      }
    }

    const expectations: Expectation[] = [];
    if (authoringMode === "fixed") {
      for (const [expectIndex, expectation] of parsedExpectations.entries()) {
        expectations.push(this.normalizeFixedExpectationText(expectation, expectIndex + 1));
      }
    } else {
      for (const [expectIndex, expectation] of parsedExpectations.entries()) {
        expectations.push(await this.normalizeExpectationText(expectation, expectIndex + 1));
      }
    }

    return {
      id: testId,
      name: rawTest.name,
      description: null,
      tags: rawTest.tags,
      preconditions: rawTest.preconditions,
      steps,
      expectations,
      priority: "normal",
      retry_policy: retryPolicySchema.parse({
        max_retries: Number(rawTest.retry_policy.max_retries ?? 0),
        retry_on_flake: this.parseBool(String(rawTest.retry_policy.retry_on_flake ?? "false")),
      }),
      timeout_policy: {
        test_timeout_ms: null,
        navigation_timeout_ms: null,
        assertion_timeout_ms: null,
      },
      data_binding: null,
      enabled: true,
    };
  }

  private buildRuntimePolicy(config: Record<string, string | boolean | number | string[]>) {
    const strictValue = config.strict_mode;
    return runtimePolicySchema.parse({
      default_timeout_ms: Number(config.default_timeout_ms ?? 10_000),
      assertion_timeout_ms: Number(config.assertion_timeout_ms ?? 10_000),
      locator_resolution_timeout_ms: Number(config.locator_resolution_timeout_ms ?? 5_000),
      navigation_timeout_ms: Number(config.navigation_timeout_ms ?? 30_000),
      max_retries: Number(config.max_retries ?? 0),
      retry_on_flake: this.parseBool(String(config.retry_on_flake ?? "false")),
      strict_mode: strictValue === undefined ? this.config.strict_mode : this.parseBool(String(strictValue)),
    });
  }

  private buildArtifactPolicy(config: Record<string, string | boolean | number | string[]>) {
    const capture = String(config.capture ?? "on-failure").trim().toLowerCase();
    if (capture === "every-step") {
      return artifactPolicySchema.parse({ capture_on_step: true, capture_on_failure: true });
    }
    if (capture === "off") {
      return artifactPolicySchema.parse({ capture_on_step: false, capture_on_failure: false });
    }
    return artifactPolicySchema.parse({ capture_on_step: false, capture_on_failure: true });
  }

  private async normalizeStepText(stepText: string, variables: Record<string, string>, stepIndex: number): Promise<Action> {
    const resolved = this.interpolateVariables(stepText.trim(), variables);
    const actionData = this.sanitizeActionPayload(await this.llmClient.normalizeStep(resolved), resolved);
    if (actionData.id === undefined) {
      actionData.id = `step-${stepIndex}`;
    }
    return actionSchema.parse(actionData);
  }

  private normalizeFixedStepText(testName: string, stepText: string, variables: Record<string, string>, stepIndex: number): Action {
    const resolved = this.interpolateVariables(stepText.trim(), variables);
    this.config.on_deterministic_step({ test_name: testName, step_text: resolved });

    const gotoMatch = resolved.match(/^navigate to\s+(.+)$/iu);
    if (gotoMatch?.[1]) {
      return actionSchema.parse({
        id: `step-${stepIndex}`,
        kind: "goto",
        url: gotoMatch[1].trim(),
        readiness: "load",
      });
    }

    const waitTimeoutMatch = resolved.match(/^wait for timeout\s+(\d+)$/iu);
    if (waitTimeoutMatch?.[1]) {
      return actionSchema.parse({
        id: `step-${stepIndex}`,
        kind: "wait_for",
        wait_type: "timeout",
        duration_ms: Number(waitTimeoutMatch[1]),
      });
    }

    const waitTextMatch = resolved.match(/^wait for text\s+"(.+)"$/iu);
    if (waitTextMatch?.[1]) {
      return actionSchema.parse({
        id: `step-${stepIndex}`,
        kind: "wait_for",
        wait_type: "text",
        value: waitTextMatch[1],
      });
    }

    const clickQuotedMatch = resolved.match(/^click(?: the)?\s+"(.+)"(?:\s+button)?$/iu);
    if (clickQuotedMatch?.[1]) {
      return actionSchema.parse({
        id: `step-${stepIndex}`,
        kind: "click",
        target: {
          exact_text: clickQuotedMatch[1],
          human_label: clickQuotedMatch[1],
          role: "button",
          require_visible: true,
        },
      });
    }

    const fillMatch = resolved.match(/^fill\s+(.+?)\s+with\s+"(.+)"$/iu);
    if (fillMatch?.[1] && fillMatch?.[2]) {
      return actionSchema.parse({
        id: `step-${stepIndex}`,
        kind: "fill",
        target: {
          human_label: fillMatch[1].trim(),
          label_text: fillMatch[1].trim(),
          placeholder: fillMatch[1].trim(),
          require_visible: true,
        },
        value: fillMatch[2],
      });
    }

    return actionSchema.parse({
      id: `step-${stepIndex}`,
      kind: "comment",
      text: resolved,
    });
  }

  private async normalizeExpectationText(expectationText: string, expectationIndex: number): Promise<Expectation> {
    const expectationData = this.sanitizeExpectationPayload(await this.llmClient.normalizeExpectation(expectationText.trim()));
    if (expectationData.id === undefined) {
      expectationData.id = `expect-${expectationIndex}`;
    }
    try {
      return expectationSchema.parse(expectationData);
    } catch {
      return this.normalizeFreeflowExpectationFallback(expectationText, expectationIndex);
    }
  }

  private normalizeFixedExpectationText(expectationText: string, expectationIndex: number): Expectation {
    const resolved = expectationText.trim();
    const lower = resolved.toLowerCase();

    if (lower.startsWith("url should contain ")) {
      return expectationSchema.parse({
        id: `expect-${expectationIndex}`,
        kind: "url_contains",
        value: resolved.slice("URL should contain ".length),
      });
    }

    if (lower.startsWith("url should be ")) {
      return expectationSchema.parse({
        id: `expect-${expectationIndex}`,
        kind: "url_is",
        value: resolved.slice("URL should be ".length),
      });
    }

    const textVisibleMatch = resolved.match(/^text\s+"(.+)"\s+should be visible$/iu);
    if (textVisibleMatch?.[1]) {
      return expectationSchema.parse({
        id: `expect-${expectationIndex}`,
        kind: "text_visible",
        text: textVisibleMatch[1],
      });
    }

    const requestSeenMatch = resolved.match(/^a request\s+(\w+)\s+(.+)\s+should happen$/iu);
    if (requestSeenMatch?.[1] && requestSeenMatch?.[2]) {
      return expectationSchema.parse({
        id: `expect-${expectationIndex}`,
        kind: "request_seen",
        method: requestSeenMatch[1].toUpperCase(),
        path: requestSeenMatch[2].trim(),
      });
    }

    return expectationSchema.parse({
      id: `expect-${expectationIndex}`,
      kind: "text_visible",
      text: resolved,
    });
  }

  private normalizeFreeflowExpectationFallback(expectationText: string, expectationIndex: number): Expectation {
    const resolved = expectationText.trim();
    const lower = resolved.toLowerCase();

    const coercedGeneric = this.coerceGenericPageVisibilityExpectation({
      id: `expect-${expectationIndex}`,
      kind: "text_visible",
      text: resolved,
      soft: false,
    });
    if (coercedGeneric) {
      return expectationSchema.parse(coercedGeneric);
    }

    if (
      lower === "page loads successfully" ||
      lower === "page is visible" ||
      lower === "page should load successfully" ||
      lower === "page should be visible" ||
      lower === "page should be accessible" ||
      lower === "page is accessible"
    ) {
      return expectationSchema.parse({
        id: `expect-${expectationIndex}`,
        kind: "element_visible",
        target: {
          css: "body",
          human_label: "page body",
          require_visible: true,
        },
      });
    }

    return this.normalizeFixedExpectationText(resolved, expectationIndex);
  }

  private requiresOutlineExtraction(rawTest: RawTestCase, authoringMode: "auto" | "fixed" | "freeflow"): boolean {
    if (!this.config.llm_parse_tests) {
      return false;
    }
    if (authoringMode === "fixed") {
      return false;
    }
    return (rawTest.freeflow_block || rawTest.raw_block).trim().length > 0;
  }

  private resolveAuthoringMode(rawTest: RawTestCase): "auto" | "fixed" | "freeflow" {
    if (this.config.authoring_mode && this.config.authoring_mode !== "auto") {
      return this.config.authoring_mode;
    }
    if (rawTest.authoring_mode === "fixed" || rawTest.authoring_mode === "freeflow") {
      return rawTest.authoring_mode;
    }
    if (rawTest.steps.length > 0 || rawTest.expectations.length > 0) {
      return "fixed";
    }
    if ((rawTest.freeflow_block || rawTest.raw_block).trim().length > 0) {
      return "freeflow";
    }
    return "auto";
  }

  private sanitizeActionPayload(payload: Record<string, unknown>, sourceText?: string): Record<string, unknown> {
    const repaired: Record<string, unknown> = { ...payload };
    const kind = String(repaired.kind ?? "").trim().toLowerCase();
    const targetAlias = this.extractTargetAlias(repaired);
    const source = (sourceText ?? "").trim();

    const splitFreeflowAction = this.splitCombinedFreeflowStep(source);
    if (splitFreeflowAction) {
      return splitFreeflowAction;
    }

    if (
      [
        "click",
        "double_click",
        "right_click",
        "hover",
        "focus",
        "blur",
        "fill",
        "clear",
        "append_text",
        "select_option",
        "check",
        "uncheck",
      ].includes(kind) &&
      repaired.target === undefined
    ) {
      const targetPayload = this.coerceTargetPayload(targetAlias);
      if (targetPayload) {
        repaired.target = targetPayload;
      }
    }

    if (kind === "fill" && repaired.value === undefined) {
      if (typeof repaired.text === "string") {
        repaired.value = repaired.text;
      } else if (typeof repaired.input === "string") {
        repaired.value = repaired.input;
      } else if (typeof repaired.key === "string" && !this.looksLikeSelector(repaired.key)) {
        repaired.value = repaired.key;
      }
    }

    for (const alias of ["selector", "locator", "element", "field", "input"]) {
      delete repaired[alias];
    }

    if (kind === "fill" && repaired.target && typeof repaired.key === "string" && this.looksLikeSelector(repaired.key)) {
      delete repaired.key;
    }

    if (["click", "double_click", "right_click"].includes(kind) && repaired.target && typeof repaired.target === "object") {
      repaired.target = this.sanitizeClickTarget(repaired.target as Record<string, unknown>);
    }

    if (kind === "goto") {
      delete repaired.duration_ms;
      delete repaired.wait_type;
      delete repaired.value;
      delete repaired.method;
      delete repaired.path;
      delete repaired.status_code;
      delete repaired.target;
      if (typeof repaired.path === "string" && repaired.url === undefined) {
        repaired.url = repaired.path;
      }
      const readiness = String(repaired.readiness ?? "").trim().toLowerCase();
      if (!readiness || readiness === "domcontentloaded") {
        repaired.readiness = "load";
      }
    }

    if (kind === "wait_for") {
      delete repaired.url;
      delete repaired.readiness;
      delete repaired.readiness_text;
      delete repaired.readiness_target;
      const waitType = String(repaired.wait_type ?? "").trim().toLowerCase();
      if (["text", "url"].includes(waitType)) {
        if (typeof repaired.readiness_text === "string" && repaired.value === undefined) {
          repaired.value = repaired.readiness_text;
        }
        if (typeof repaired.text === "string" && repaired.value === undefined) {
          repaired.value = repaired.text;
        }
        if (typeof repaired.url === "string" && repaired.value === undefined) {
          repaired.value = repaired.url;
        }
        if (repaired.readiness_target && typeof repaired.readiness_target === "object" && repaired.value === undefined) {
          const target = repaired.readiness_target as Record<string, unknown>;
          const textValue = [target.exact_text, target.human_label, target.label_text, target.placeholder]
            .map((item) => (typeof item === "string" ? item.trim() : ""))
            .find(Boolean);
          if (textValue) {
            repaired.value = textValue;
          }
        }
      }
      if (waitType === "timeout" && repaired.duration_ms === undefined) {
        if (typeof repaired.value === "number") {
          repaired.duration_ms = repaired.value;
        } else if (typeof repaired.timeout_ms === "number") {
          repaired.duration_ms = repaired.timeout_ms;
        }
      }
    }

    return repaired;
  }

  private splitCombinedFreeflowStep(sourceText: string): Record<string, unknown> | null {
    const normalized = sourceText.trim();
    if (!normalized) {
      return null;
    }

    const openAndWait = normalized.match(/^open\s+(.+?)\s+and\s+wait\s+for\s+(one|\d+)\s+(second|seconds|ms|milliseconds)$/iu);
    if (openAndWait?.[1]) {
      return {
        kind: "goto",
        url: openAndWait[1].trim(),
        readiness: "load",
      };
    }

    const openOnly = normalized.match(/^open\s+(.+)$/iu);
    if (openOnly?.[1] && !normalized.toLowerCase().includes(" and wait ")) {
      return {
        kind: "goto",
        url: openOnly[1].trim(),
        readiness: "load",
      };
    }

    const waitWords = normalized.match(/^wait\s+for\s+(one|\d+)\s+(second|seconds|ms|milliseconds)$/iu);
    if (waitWords?.[1]) {
      const amount = waitWords[1].toLowerCase() === "one" ? 1 : Number(waitWords[1]);
      const unit = waitWords[2]?.toLowerCase() ?? "seconds";
      return {
        kind: "wait_for",
        wait_type: "timeout",
        duration_ms: unit.startsWith("ms") ? amount : amount * 1000,
      };
    }

    return null;
  }

  private sanitizeExpectationPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const repaired: Record<string, unknown> = { ...payload };
    const kind = String(repaired.kind ?? "").trim().toLowerCase();
    if (["text_visible", "text_not_visible"].includes(kind) && !repaired.text) {
      if (typeof repaired.value === "string") {
        repaired.text = repaired.value;
      }
      if (repaired.target && typeof repaired.target === "object") {
        const target = repaired.target as Record<string, unknown>;
        const textValue = [target.exact_text, target.human_label, target.label_text, target.placeholder]
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .find(Boolean);
        if (textValue) {
          repaired.text = textValue;
        }
        delete repaired.target;
      }
    }

    const genericPageVisibility = this.coerceGenericPageVisibilityExpectation(repaired);
    if (genericPageVisibility) {
      return genericPageVisibility;
    }

    return repaired;
  }

  private coerceGenericPageVisibilityExpectation(payload: Record<string, unknown>): Record<string, unknown> | null {
    if (String(payload.kind ?? "").trim().toLowerCase() !== "text_visible") {
      return null;
    }

    const text = typeof payload.text === "string" ? payload.text.trim().toLowerCase() : "";
    const genericPhrases = new Set([
      "page loads successfully",
      "page is visible",
      "page should load successfully",
      "page should be visible",
      "page should be accessible",
      "page is accessible",
      "the page loads successfully",
      "the page is visible",
      "the page should load successfully",
      "the page should be visible",
      "the page should be accessible",
      "the page is accessible",
    ]);

    const genericPatterns = [
      /\bpage\b.*\b(load|loaded|loads|visible|accessible)\b/iu,
      /\bpage\b.*\bwithout\s+errors?\b/iu,
      /\bwait\b.*\b(second|seconds|timeout|complete|completes|completed)\b/iu,
      /\bwithout\s+errors?\b/iu,
    ];

    if (!genericPhrases.has(text) && !genericPatterns.some((pattern) => pattern.test(text))) {
      return null;
    }

    return {
      id: payload.id,
      timeout_ms: payload.timeout_ms,
      soft: payload.soft,
      kind: "element_visible",
      target: {
        css: "body",
        human_label: "page body",
        require_visible: true,
      },
    };
  }

  private sanitizeClickTarget(target: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    const candidates = [result.exact_text, result.human_label, result.label_text]
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    const text = candidates[0] ?? "";
    if (!text) {
      return result;
    }

    const quotedButtonMatch = text.match(/^(?:the\s+)?["'](.+)["']\s+button$/iu);
    if (quotedButtonMatch) {
      result.role = "button";
      result.exact_text = quotedButtonMatch[1]?.trim();
      return result;
    }

    const plainButtonMatch = text.match(/^(?:the\s+)?(.+?)\s+button$/iu);
    if (plainButtonMatch) {
      result.role = "button";
      result.exact_text = plainButtonMatch[1]?.trim().replace(/^["']|["']$/gu, "");
      return result;
    }

    if (typeof result.exact_text === "string") {
      result.exact_text = result.exact_text.trim().replace(/^["']|["']$/gu, "");
    }
    if (typeof result.role !== "string" && text.toLowerCase().includes("button")) {
      result.role = "button";
    }
    return result;
  }

  private extractTargetAlias(payload: Record<string, unknown>): unknown {
    if (payload.target !== undefined) {
      return payload.target;
    }
    for (const key of ["selector", "locator", "element", "field", "key", "input"]) {
      if (payload[key] !== undefined) {
        return payload[key];
      }
    }
    return undefined;
  }

  private coerceTargetPayload(source: unknown): TargetHint | undefined {
    if (source && typeof source === "object") {
      return source as TargetHint;
    }
    if (typeof source !== "string") {
      return undefined;
    }
    const value = source.trim();
    if (!value) {
      return undefined;
    }
    if (this.looksLikeSelector(value)) {
      return { css: value, human_label: value, require_visible: true };
    }
    return { human_label: value, label_text: value, placeholder: value, require_visible: true };
  }

  private looksLikeSelector(value: string): boolean {
    const stripped = value.trim();
    return ["#", ".", "//", "[", "input", "button", "form"].some((prefix) => stripped.startsWith(prefix)) ||
      (stripped.includes("=") && !stripped.includes(" ")) ||
      stripped.includes(">") ||
      stripped.includes(":");
  }

  private interpolateVariables(value: string, variables: Record<string, string>): string {
    let output = value;
    for (const [key, replacement] of Object.entries(variables)) {
      output = output.replaceAll(`{{${key}}}`, replacement);
    }
    return output;
  }

  private resolveEnvVariables(variables: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};
    const envPattern = /^(?:\$|env:)([A-Za-z_][A-Za-z0-9_]*)$/u;
    for (const [key, value] of Object.entries(variables)) {
      const match = envPattern.exec(value.trim());
      if (!match) {
        resolved[key] = value;
        continue;
      }
      const envName = match[1];
      if (!envName) {
        resolved[key] = value;
        continue;
      }
      const envValue = process.env[envName];
      if (envValue === undefined) {
        throw new SpecNormalizationError(
          `Environment variable '${envName}' referenced in spec variable '${key}' is not set.`,
        );
      }
      resolved[key] = envValue;
    }
    return resolved;
  }

  private parseBool(value: string): boolean {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
}

export async function normalizeMarkdownSuite(options: {
  rawSuite: RawSuiteDocument;
  projectConfig: ProjectConfig;
  config?: NormalizerConfig;
}): Promise<TestSuite> {
  const normalizer = new SpecNormalizer({ config: options.config, projectConfig: options.projectConfig });
  return normalizer.normalize(options.rawSuite);
}
