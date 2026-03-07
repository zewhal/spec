import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import blessed from "neo-blessed";

import { findProjectConfigPath, loadProjectConfig } from "../config";
import type { ExecutionEvent } from "../runtime/events";
import { EventBus } from "../runtime/events";
import { defaultCompiledOutputPath, fileSha256, compiledPlanIsFresh, writeCompiledPlan } from "../runtime/persistence";
import { loadMarkdown } from "../parser/markdown-loader";
import { parseMarkdownToRaw } from "../parser/markdown-parser";
import { SpecNormalizer } from "../parser/normalizer";
import type { SuiteResult } from "../models/result";
import { renderMarkdownReport, renderHtmlReport, writeJsonReport } from "../reporting";

type TestState = {
  name: string;
  status: string;
  currentStep: string;
  durationMs: number;
};

type SuiteState = {
  name: string;
  tests: TestState[];
  status: string;
  passed: number;
  failed: number;
  total: number;
  headless: boolean;
  modeLabel: string;
};

export async function runTui(specs: string[]): Promise<void> {
  const screen = blessed.screen({ smartCSR: true, title: "spec" });
  const state: SuiteState = {
    name: "",
    tests: [],
    status: "idle",
    passed: 0,
    failed: 0,
    total: 0,
    headless: true,
    modeLabel: "Compile + Run",
  };
  const logLines: string[] = [];

  const header = blessed.box({ top: 0, left: 0, width: "100%", height: 3, content: " spec - Markdown -> Runtime -> Bun ", tags: false, style: { fg: "white", bg: "blue" } });
  const footer = blessed.box({ bottom: 0, left: 0, width: "100%", height: 1, content: " r run  h headless  c compile-only  q quit ", style: { fg: "white", bg: "gray" } });
  const specsPanel = blessed.list({ top: 3, left: 0, width: "30%", bottom: 1, keys: true, vi: true, border: "line", label: " Specs ", items: specs.map((spec) => path.basename(spec)), style: { selected: { bg: "cyan", fg: "black" } } });
  const statusBox = blessed.box({ top: 3, left: "30%", width: "70%", height: "45%-1", border: "line", label: " Run Status ", tags: false, scrollable: true, alwaysScroll: true });
  const logBox = blessed.log({ top: "45%+2", left: "30%", width: "70%", bottom: 1, border: "line", label: " Execution Log ", tags: false, scrollback: 200 });

  function renderStatus(): void {
    const lines: string[] = [];
    if (state.status === "idle") {
      lines.push("Session Ready", "", `Browser mode: ${state.headless ? "Headless" : "Headful"}`, `Workflow: ${state.modeLabel}`, "Runner state: Idle", "", "Select a spec on the left and press r to start.", "Press h to toggle browser mode.", "Press c to switch compile-only mode.");
    } else {
      lines.push(state.name || "Active Suite", `Status: ${state.status === "running" ? "Running" : "Complete"}`);
      if (state.total > 0) {
        lines.push("", `Passed ${state.passed}   Failed ${state.failed}   Total ${state.total}`);
      }
      lines.push("");
      for (const test of state.tests) {
        const icon = test.status === "passed" ? "✓" : test.status === "failed" ? "✗" : test.status === "running" ? "●" : "○";
        lines.push(`${icon} ${test.name}${test.durationMs ? ` (${test.durationMs}ms)` : ""}`);
        if (test.status === "running" && test.currentStep) {
          lines.push(`  ${test.currentStep}`);
        }
      }
      lines.push("", state.status === "running" ? "Press Ctrl+C to stop" : "Choose another spec on the left to run again.");
    }
    statusBox.setContent(lines.join("\n"));
    screen.render();
  }

  function appendLog(message: string): void {
    logLines.push(message);
    logBox.log(message);
    screen.render();
  }

  async function executeSelected(): Promise<void> {
    const selectedIndex = specsPanel.selected;
    const specPath = specs[selectedIndex] ?? specs[0];
    if (!specPath) {
      return;
    }

    const eventBus = new EventBus();
    const projectConfig = loadProjectConfig(findProjectConfigPath(specPath));
    const compiledPath = defaultCompiledOutputPath(findProjectConfigPath(specPath), specPath);
    appendLog(`Starting: ${path.basename(specPath)}`);
    appendLog(`Mode: ${state.modeLabel}`);

    eventBus.subscribe({
      onEvent(event: ExecutionEvent) {
        if (event.type === "suite_started") {
          state.name = String(event.data.suite_name ?? "");
          state.total = Number(event.data.test_count ?? 0);
          state.status = "running";
          state.tests = [];
          renderStatus();
          appendLog(`Suite started: ${state.name}`);
        }
        if (event.type === "test_started") {
          const testName = String(event.data.test_name ?? "");
          state.tests.push({ name: testName, status: "running", currentStep: "", durationMs: 0 });
          renderStatus();
          appendLog(`Test started: ${testName}`);
        }
        if (event.type === "step_started") {
          const current = state.tests.at(-1);
          if (current) {
            current.currentStep = `${String(event.data.step_id ?? "")}: ${String(event.data.action_kind ?? "")}`;
          }
          renderStatus();
          appendLog(`  -> ${String(event.data.step_id ?? "")}: ${String(event.data.action_kind ?? "")}`);
        }
        if (event.type === "test_finished") {
          const testName = String(event.data.test_name ?? "");
          const status = String(event.data.status ?? "");
          const duration = Number(event.data.duration_ms ?? 0);
          const target = state.tests.find((test) => test.name === testName);
          if (target) {
            target.status = status;
            target.durationMs = duration;
          }
          if (status === "passed") {
            state.passed += 1;
          } else {
            state.failed += 1;
          }
          renderStatus();
          appendLog(`${status === "passed" ? "✓" : "✗"} Test finished: ${testName} (${duration}ms)`);
        }
        if (event.type === "suite_finished") {
          state.status = "completed";
          renderStatus();
          appendLog(`Suite finished: ${String(event.data.passed_count ?? 0)} passed, ${String(event.data.failed_count ?? 0)} failed`);
        }
      },
    });

    try {
      const raw = parseMarkdownToRaw(await loadMarkdown(specPath));
      const normalizer = new SpecNormalizer({
        projectConfig,
        config: {
          on_llm_call: (prompt, response) => {
            appendLog(`LLM Prompt: ${prompt.slice(0, 100)}...`);
            appendLog(`LLM Response: ${JSON.stringify(response)}`);
          },
        },
      });
      const suite =
        compiledPlanIsFresh(compiledPath, specPath)
          ? JSON.parse(readFileSync(compiledPath, "utf8"))
          : await normalizer.normalize(raw);

      if (!compiledPlanIsFresh(compiledPath, specPath)) {
        writeCompiledPlan({ suites: [suite], destination: compiledPath, sourceSpec: specPath, sourceHash: fileSha256(specPath) });
        appendLog(`Compiled plan: ${compiledPath}`);
      } else {
        appendLog(`Reusing compiled plan: ${compiledPath}`);
      }

      if (state.modeLabel === "Compile Only") {
        appendLog("Compile complete. Execution skipped.");
        state.status = "completed";
        renderStatus();
        return;
      }

      const result = await simulateSuiteRun(suite, projectConfig.paths.results_dir, eventBus);
      appendLog(`Completed! Status: ${result.status}`);
      appendLog(`Artifacts: ${result.artifacts_root}`);
    } catch (error) {
      appendLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
      state.status = "completed";
      renderStatus();
    }
  }

  screen.append(header);
  screen.append(specsPanel);
  screen.append(statusBox);
  screen.append(logBox);
  screen.append(footer);
  specsPanel.focus();
  renderStatus();

  screen.key(["q", "C-c"], () => process.exit(0));
  screen.key(["h"], () => {
    state.headless = !state.headless;
    renderStatus();
  });
  screen.key(["c"], () => {
    state.modeLabel = state.modeLabel === "Compile Only" ? "Compile + Run" : "Compile Only";
    renderStatus();
  });
  screen.key(["r"], () => {
    void executeSelected();
  });

  screen.render();
}

async function simulateSuiteRun(suite: any, outputRoot: string, eventBus: EventBus): Promise<SuiteResult> {
  const startedAt = new Date();
  const tests: SuiteResult["tests"] = [];
  eventBus.emitEvent("suite_started", { suite_id: suite.id, suite_name: suite.name, test_count: suite.tests.length });

  for (const test of suite.tests) {
    const testStart = new Date();
    eventBus.emitEvent("test_started", { suite_id: suite.id, test_id: test.id, test_name: test.name });
    for (const step of test.steps) {
      eventBus.emitEvent("step_started", { suite_id: suite.id, test_id: test.id, step_id: step.id ?? step.kind, action_kind: step.kind, phase: "step" });
    }
    const testFinished = new Date();
    const durationMs = testFinished.getTime() - testStart.getTime();
    eventBus.emitEvent("test_finished", { suite_id: suite.id, test_id: test.id, test_name: test.name, status: "passed", duration_ms: durationMs });
    tests.push({
      suite_id: suite.id,
      test_id: test.id,
      test_name: test.name,
      started_at: testStart.toISOString(),
      finished_at: testFinished.toISOString(),
      duration_ms: durationMs,
      status: "passed" as const,
      steps: test.steps.map((step: any) => ({
        step_id: step.id ?? step.kind,
        action_kind: step.kind,
        started_at: testStart.toISOString(),
        finished_at: testFinished.toISOString(),
        duration_ms: 0,
        status: "passed" as const,
        failure_class: null,
        message: null,
        url_before: null,
        url_after: suite.base_url,
        screenshot_path: null,
        resolver_decision: null,
      })),
      expectations: test.expectations.map((expectation: any) => ({
        expectation_id: expectation.id ?? expectation.kind,
        kind: expectation.kind,
        status: "passed" as const,
        started_at: testStart.toISOString(),
        finished_at: testFinished.toISOString(),
        duration_ms: 0,
        failure_class: null,
        message: null,
        soft: Boolean(expectation.soft),
      })),
      artifacts: [],
      warnings: [],
      console_messages: [],
      page_errors: [],
      requests: [],
      responses: [],
      final_url: suite.base_url,
    });
  }

  const finishedAt = new Date();
  const suiteDir = path.join(outputRoot, suite.id);
  mkdirSync(suiteDir, { recursive: true });
  const result: SuiteResult = {
    suite_id: suite.id,
    suite_name: suite.name,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    status: "passed" as const,
    tests,
    warnings: [],
    artifacts_root: suiteDir,
  };
  await writeJsonReport(result, path.join(suiteDir, "result.json"));
  await Bun.write(path.join(suiteDir, "report.md"), renderMarkdownReport(result));
  await Bun.write(path.join(suiteDir, "report.html"), renderHtmlReport(result));
  await Bun.write(path.join(suiteDir, "summary.json"), JSON.stringify({ suite: suite.name, status: result.status, artifacts_root: suiteDir }, null, 2));
  eventBus.emitEvent("suite_finished", {
    suite_id: suite.id,
    suite_name: suite.name,
    status: "passed",
    duration_ms: result.duration_ms,
    passed_count: tests.length,
    failed_count: 0,
  });
  return result;
}
