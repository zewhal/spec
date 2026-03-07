import { expect } from "@playwright/test";
import type { Page } from "playwright";

import { AssertionEngine, UnsupportedExpectationError } from "../assertions/engine";
import type { Action } from "../models/action";
import type { ExecutionEventType, FailureClass, TestStatus } from "../models/enums";
import type { Expectation } from "../models/expectation";
import type { ExpectationResult, ResolverDecision, StepResult, SuiteResult, TestResult } from "../models/result";
import type { TestCase, TestSuite } from "../models/suite";
import { TargetResolutionError, TargetResolver } from "../resolver/target-resolver";
import { ArtifactManager } from "./artifacts";
import { BrowserSession, type BrowserLaunchConfig } from "./browser";
import { EventBus } from "./events";
import { BrowserObserver } from "./observer";

export type ExecutionConfig = {
  output_dir?: string;
  browser?: string;
  viewport?: string;
  locale?: string;
  headless?: boolean;
  slow_mo_ms?: number;
  hold_open_ms?: number;
};

export class SuiteExecutor {
  readonly resolver: TargetResolver;
  readonly assertionEngine: AssertionEngine;
  readonly eventBus?: EventBus;

  constructor(options: { resolver?: TargetResolver; assertionEngine?: AssertionEngine; eventBus?: EventBus } = {}) {
    this.resolver = options.resolver ?? new TargetResolver();
    this.assertionEngine = options.assertionEngine ?? new AssertionEngine(this.resolver);
    this.eventBus = options.eventBus;
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.eventBus?.emitEvent(type as ExecutionEventType, data);
  }

  async runSuite(suite: TestSuite, config: ExecutionConfig): Promise<SuiteResult> {
    const startedAt = new Date();
    const artifactManager = new ArtifactManager(config.output_dir ?? ".spec/results");
    this.emit("suite_started", { suite_id: suite.id, suite_name: suite.name, test_count: suite.tests.length });

    const launchConfig: BrowserLaunchConfig = {
      browser: config.browser ?? suite.browser,
      headless: config.headless ?? true,
      slow_mo_ms: config.slow_mo_ms ?? 0,
      viewport: config.viewport ?? suite.viewport,
      locale: config.locale ?? suite.locale,
    };

    const session = await new BrowserSession(launchConfig).start();
    const testResults: TestResult[] = [];
    try {
      for (const test of suite.tests) {
        if (!test.enabled) {
          testResults.push(this.buildSkippedTestResult(suite, test));
          continue;
        }
        await session.newContextPage(true);
        testResults.push(await this.runTest(suite, test, config, artifactManager, session));
      }
    } finally {
      await session.close();
    }

    const finishedAt = new Date();
    const status: TestStatus = testResults.some((result) => result.status === "failed") ? "failed" : "passed";
    this.emit("suite_finished", {
      suite_id: suite.id,
      suite_name: suite.name,
      status,
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      passed_count: testResults.filter((result) => result.status === "passed").length,
      failed_count: testResults.filter((result) => result.status === "failed").length,
    });

    return {
      suite_id: suite.id,
      suite_name: suite.name,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      status,
      tests: testResults,
      warnings: [],
      artifacts_root: config.output_dir ?? ".spec/results",
    };
  }

  private async runTest(suite: TestSuite, test: TestCase, config: ExecutionConfig, artifacts: ArtifactManager, session: BrowserSession): Promise<TestResult> {
    const startedAt = new Date();
    this.emit("test_started", { suite_id: suite.id, test_id: test.id, test_name: test.name });
    const page = session.page;
    const observer = new BrowserObserver();
    observer.install(page);
    const stepResults: StepResult[] = [];
    const expectationResults: ExpectationResult[] = [];
    const warnings: string[] = [];
    const artifactPaths: string[] = [];
    let failed = false;

    for (const [phase, action] of [...suite.setup_steps.map((action) => ["setup", action] as const), ...test.steps.map((action) => ["step", action] as const)]) {
      const { result, artifactPath } = await this.executeAction(page, suite, test, action, phase, observer, artifacts);
      stepResults.push(result);
      if (artifactPath) artifactPaths.push(artifactPath);
      if (result.status === "failed") {
        failed = true;
        break;
      }
    }

    if (!failed) {
      for (const expectation of test.expectations) {
        const result = await this.evaluateExpectation(page, suite, test, expectation, observer);
        expectationResults.push(result);
        if (result.status === "failed" && !result.soft) {
          failed = true;
          break;
        }
      }
    }

    for (const teardown of suite.teardown_steps) {
      const { result, artifactPath } = await this.executeAction(page, suite, test, teardown, "teardown", observer, artifacts);
      stepResults.push(result);
      if (artifactPath) artifactPaths.push(artifactPath);
      if (result.status === "failed") warnings.push(`Teardown failed: ${result.message}`);
    }

    if (config.hold_open_ms && !config.headless) {
      await page.waitForTimeout(config.hold_open_ms);
    }

    const finishedAt = new Date();
    const status: TestStatus = failed ? "failed" : "passed";
    this.emit("test_finished", {
      suite_id: suite.id,
      test_id: test.id,
      test_name: test.name,
      status,
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      passed_steps: stepResults.filter((step) => step.status === "passed").length,
      failed_steps: stepResults.filter((step) => step.status === "failed").length,
    });

    return {
      suite_id: suite.id,
      test_id: test.id,
      test_name: test.name,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      status,
      steps: stepResults,
      expectations: expectationResults,
      artifacts: artifactPaths,
      warnings,
      console_messages: observer.console_messages,
      page_errors: observer.page_errors,
      requests: observer.requests,
      responses: observer.responses,
      final_url: page.url(),
    };
  }

  private async executeAction(page: Page, suite: TestSuite, test: TestCase, action: Action, phaseName: string, observer: BrowserObserver, artifacts: ArtifactManager): Promise<{ result: StepResult; artifactPath: string | null }> {
    const startedAt = new Date();
    const urlBefore = page.url();
    const stepId = action.id ?? `${phaseName}-${action.kind}`;
    let resolverDecision: ResolverDecision | null = null;
    let artifactPath: string | null = null;
    this.emit("step_started", { suite_id: suite.id, test_id: test.id, step_id: stepId, action_kind: action.kind, phase: phaseName });

    try {
      resolverDecision = await this.executeActionImpl(page, suite, action, observer);
      this.assertAllowedDomain(suite, page.url());
      const finishedAt = new Date();
      this.emit("step_finished", { suite_id: suite.id, test_id: test.id, step_id: stepId, action_kind: action.kind, status: "passed", duration_ms: finishedAt.getTime() - startedAt.getTime() });
      return {
        result: {
          step_id: stepId,
          action_kind: action.kind,
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          duration_ms: finishedAt.getTime() - startedAt.getTime(),
          status: "passed",
          failure_class: null,
          message: null,
          url_before: urlBefore,
          url_after: page.url(),
          screenshot_path: null,
          resolver_decision: resolverDecision,
        },
        artifactPath,
      };
    } catch (error) {
      const failureClass = this.classifyException(error);
      if (suite.artifact_policy.capture_on_failure) {
        artifactPath = artifacts.buildPath(suite.id, test.id, `${stepId}-failure`, "png");
        try {
          await page.screenshot({ path: artifactPath, fullPage: true });
        } catch {
          artifactPath = null;
        }
      }
      const finishedAt = new Date();
      this.emit("step_finished", {
        suite_id: suite.id,
        test_id: test.id,
        step_id: stepId,
        action_kind: action.kind,
        status: "failed",
        failure_class: failureClass,
        message: error instanceof Error ? error.message : String(error),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
      });
      return {
        result: {
          step_id: stepId,
          action_kind: action.kind,
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          duration_ms: finishedAt.getTime() - startedAt.getTime(),
          status: "failed",
          failure_class: failureClass,
          message: error instanceof Error ? error.message : String(error),
          url_before: urlBefore,
          url_after: page.url(),
          screenshot_path: artifactPath,
          resolver_decision: resolverDecision,
        },
        artifactPath,
      };
    }
  }

  private async executeActionImpl(page: Page, suite: TestSuite, action: Action, observer: BrowserObserver): Promise<ResolverDecision | null> {
    const timeoutMs = action.timeout_ms ?? suite.runtime_policy.default_timeout_ms;

    if (["goto", "refresh", "back", "forward"].includes(action.kind)) {
      return this.runNavigationAction(page, suite, action, timeoutMs);
    }

    if (["click", "double_click", "right_click", "hover", "focus", "blur"].includes(action.kind)) {
      const targetAction = action as Extract<Action, { target: unknown }>;
      const { locator, decision } = await this.resolver.resolve(page, targetAction.target, suite.runtime_policy.strict_mode, suite.runtime_policy.locator_resolution_timeout_ms);
      if (action.kind === "click") await locator.click({ timeout: timeoutMs });
      if (action.kind === "double_click") await locator.dblclick({ timeout: timeoutMs });
      if (action.kind === "right_click") await locator.click({ button: "right", timeout: timeoutMs });
      if (action.kind === "hover") await locator.hover({ timeout: timeoutMs });
      if (action.kind === "focus") await locator.focus({ timeout: timeoutMs });
      if (action.kind === "blur") await locator.evaluate("(el) => el.blur()");
      return decision;
    }

    if (action.kind === "fill") {
      const fillAction = action as Extract<Action, { kind: "fill" }>;
      const { locator, decision } = await this.resolver.resolve(page, fillAction.target, suite.runtime_policy.strict_mode, suite.runtime_policy.locator_resolution_timeout_ms);
      if (fillAction.append) await locator.type(fillAction.value, { timeout: timeoutMs });
      else await locator.fill(fillAction.value, { timeout: timeoutMs });
      return decision;
    }

    if (action.kind === "clear") {
      const clearAction = action as unknown as { kind: "clear"; target: NonNullable<Action extends infer T ? T extends { target?: infer U } ? U : never : never> };
      const { locator, decision } = await this.resolver.resolve(page, clearAction.target, suite.runtime_policy.strict_mode, suite.runtime_policy.locator_resolution_timeout_ms);
      await locator.fill("", { timeout: timeoutMs });
      return decision;
    }

    if (action.kind === "append_text") {
      const appendAction = action as unknown as { kind: "append_text"; target: NonNullable<Action extends infer T ? T extends { target?: infer U } ? U : never : never>; value: string };
      const { locator, decision } = await this.resolver.resolve(page, appendAction.target, suite.runtime_policy.strict_mode, suite.runtime_policy.locator_resolution_timeout_ms);
      await locator.type(appendAction.value, { timeout: timeoutMs });
      return decision;
    }

    if (action.kind === "wait_for") {
      return this.runWaitForAction(page, action, suite, observer, timeoutMs);
    }

    if (action.kind === "comment") {
      return null;
    }

    throw new Error(`Action kind '${action.kind}' is not supported in MVP executor.`);
  }

  private async runNavigationAction(page: Page, suite: TestSuite, action: Action, timeoutMs: number): Promise<null> {
    if (action.kind === "goto") {
      const targetUrl = new URL(action.url!, suite.base_url).toString();
      const waitUntil = action.readiness === "load" ? "load" : action.readiness === "networkidle" ? "networkidle" : "domcontentloaded";
      await page.goto(targetUrl, { waitUntil, timeout: timeoutMs });
      if (action.readiness === "text_visible" && action.readiness_text) {
        await expect(page.getByText(action.readiness_text)).toBeVisible({ timeout: timeoutMs });
      }
      if (action.readiness === "locator_visible" && action.readiness_target) {
        const { locator } = await this.resolver.resolve(page, action.readiness_target, suite.runtime_policy.strict_mode, suite.runtime_policy.locator_resolution_timeout_ms);
        await expect(locator).toBeVisible({ timeout: timeoutMs });
      }
      return null;
    }
    if (action.kind === "refresh") {
      await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
      return null;
    }
    if (action.kind === "back") {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: timeoutMs });
      return null;
    }
    if (action.kind === "forward") {
      await page.goForward({ waitUntil: "domcontentloaded", timeout: timeoutMs });
      return null;
    }
    throw new Error(`Unsupported navigation action kind '${action.kind}'.`);
  }

  private async runWaitForAction(page: Page, action: Action, suite: TestSuite, observer: BrowserObserver, timeoutMs: number): Promise<ResolverDecision | null> {
    const waitAction = action as Extract<Action, { kind: "wait_for" }>;
    if (waitAction.wait_type === "url") {
      await page.waitForURL(`**${waitAction.value}`, { timeout: timeoutMs });
      return null;
    }
    if (waitAction.wait_type === "text") {
      await expect(page.getByText(waitAction.value!)).toBeVisible({ timeout: timeoutMs });
      return null;
    }
    if (waitAction.wait_type === "locator") {
      const { locator, decision } = await this.resolver.resolve(page, waitAction.target!, suite.runtime_policy.strict_mode, suite.runtime_policy.locator_resolution_timeout_ms);
      await expect(locator).toBeVisible({ timeout: timeoutMs });
      return decision;
    }
    if (waitAction.wait_type === "request") {
      await page.waitForEvent("request", {
        predicate: (request) => request.method().toUpperCase() === waitAction.method!.toUpperCase() && request.url().includes(waitAction.path!),
        timeout: timeoutMs,
      });
      return null;
    }
    if (waitAction.wait_type === "response") {
      await page.waitForEvent("response", {
        predicate: (response) =>
          response.request().method().toUpperCase() === waitAction.method!.toUpperCase() &&
          response.url().includes(waitAction.path!) &&
          (waitAction.status_code === undefined || response.status() === waitAction.status_code),
        timeout: timeoutMs,
      });
      return null;
    }
    if (waitAction.wait_type === "download") {
      await page.waitForEvent("download", { timeout: timeoutMs });
      return null;
    }
    if (waitAction.wait_type === "dialog") {
      await page.waitForEvent("dialog", { timeout: timeoutMs });
      return null;
    }
    if (waitAction.wait_type === "timeout") {
      await page.waitForTimeout(waitAction.duration_ms ?? timeoutMs);
      return null;
    }
    throw new Error(`Wait type '${waitAction.wait_type}' is not supported.`);
  }

  private async evaluateExpectation(page: Page, suite: TestSuite, test: TestCase, expectation: Expectation, observer: BrowserObserver): Promise<ExpectationResult> {
    const startedAt = new Date();
    const timeoutMs = expectation.timeout_ms ?? suite.runtime_policy.assertion_timeout_ms;
    this.emit("expectation_started", {
      suite_id: suite.id,
      test_id: test.id,
      expectation_id: expectation.id ?? expectation.kind,
      expectation_kind: expectation.kind,
    });

    try {
      await this.assertionEngine.evaluate(page, expectation, observer, suite.runtime_policy.strict_mode, timeoutMs);
      const finishedAt = new Date();
      this.emit("expectation_finished", {
        suite_id: suite.id,
        test_id: test.id,
        expectation_id: expectation.id ?? expectation.kind,
        expectation_kind: expectation.kind,
        status: "passed",
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
      });
      return {
        expectation_id: expectation.id ?? expectation.kind,
        kind: expectation.kind,
        status: "passed",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        failure_class: null,
        message: null,
        soft: expectation.soft,
      };
    } catch (error) {
      const finishedAt = new Date();
      const failureClass = this.classifyException(error);
      this.emit("expectation_finished", {
        suite_id: suite.id,
        test_id: test.id,
        expectation_id: expectation.id ?? expectation.kind,
        expectation_kind: expectation.kind,
        status: "failed",
        failure_class: failureClass,
        message: error instanceof Error ? error.message : String(error),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
      });
      return {
        expectation_id: expectation.id ?? expectation.kind,
        kind: expectation.kind,
        status: "failed",
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: finishedAt.getTime() - startedAt.getTime(),
        failure_class: failureClass,
        message: error instanceof Error ? error.message : String(error),
        soft: expectation.soft,
      };
    }
  }

  private assertAllowedDomain(suite: TestSuite, currentUrl: string): void {
    const host = new URL(currentUrl).host.toLowerCase();
    if (!host || suite.allowed_subdomains.length === 0) {
      return;
    }
    const allowed = suite.allowed_subdomains.map((entry) => entry.toLowerCase());
    if (allowed.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`))) {
      return;
    }
    throw new Error(`Navigation left allowed domains. host=${host}, allowed=${suite.allowed_subdomains.join(",")}`);
  }

  private classifyException(error: unknown): FailureClass {
    if (error instanceof TargetResolutionError) return "locator_resolution_failure";
    if (error instanceof UnsupportedExpectationError) return "unsupported_widget";
    if (error instanceof Error && error.name === "TimeoutError") return "timeout";
    if (error instanceof Error && error.name === "AssertionError") return "assertion_failure";
    if (error instanceof Error && error.message.includes("allowed domains")) return "environment_issue";
    if (error instanceof Error && error.message.includes("not supported")) return "unsupported_widget";
    return "action_failure";
  }

  private buildSkippedTestResult(suite: TestSuite, test: TestCase): TestResult {
    const now = new Date().toISOString();
    return {
      suite_id: suite.id,
      test_id: test.id,
      test_name: test.name,
      started_at: now,
      finished_at: now,
      duration_ms: 0,
      status: "skipped",
      steps: [],
      expectations: [],
      artifacts: [],
      warnings: ["Test was disabled by spec configuration."],
      console_messages: [],
      page_errors: [],
      requests: [],
      responses: [],
      final_url: null,
    };
  }
}
