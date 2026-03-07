import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import blessed from "neo-blessed";

import { findProjectConfigPath, loadProjectConfig } from "../config";
import type { ExecutionEvent } from "../runtime/events";
import { EventBus } from "../runtime/events";
import { SuiteExecutor } from "../runtime/executor";
import { defaultCompiledOutputPath, fileSha256, compiledPlanIsFresh, persistSuiteOutputs, writeCompiledPlan } from "../runtime/persistence";
import { loadMarkdown } from "../parser/markdown-loader";
import { parseMarkdownToRaw } from "../parser/markdown-parser";
import { SpecNormalizer } from "../parser/normalizer";

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
  let spinnerTimer: ReturnType<typeof setTimeout> | null = null;
  let spinnerActive = false;
  let spinnerFrameIndex = 0;

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
    spinnerActive = false;
    stopSpinner();
    logLines.push(message);
    logBox.log(message);
    screen.render();
  }

  function updateSpinnerLine(): void {
    const frame = ["[|]", "[/]", "[-]", "[\\]"][spinnerFrameIndex % 4] ?? "[|]";
    spinnerFrameIndex += 1;
    const line = `${frame} Running...`;
    if (spinnerActive && logLines.length > 0) {
      logLines[logLines.length - 1] = line;
    } else {
      logLines.push(line);
      spinnerActive = true;
    }
    logBox.setContent(logLines.join("\n"));
    screen.render();
    scheduleSpinner();
  }

  function scheduleSpinner(): void {
    if (!spinnerActive) {
      return;
    }
    stopSpinner();
    spinnerTimer = setTimeout(updateSpinnerLine, 120);
  }

  function startSpinner(): void {
    spinnerActive = true;
    updateSpinnerLine();
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearTimeout(spinnerTimer);
      spinnerTimer = null;
    }
  }

  function copyLog(): void {
    if (logLines.length === 0) {
      appendLog("No execution log to copy yet.");
      return;
    }

    const logText = `${logLines.join("\n").trim()}\n`;
    const logPath = writeLogSnapshot(logText);
    const copied = copyToClipboard(logText);
    appendLog(copied ? `Copied execution log to clipboard and saved ${logPath}` : `Clipboard unavailable. Saved execution log to ${logPath}`);
  }

  function writeLogSnapshot(logText: string): string {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const logDir = path.join(".spec", "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `execution-${timestamp}.log`);
    Bun.write(logPath, logText);
    return logPath;
  }

  function copyToClipboard(text: string): boolean {
    const commands = [
      ["wl-copy"],
      ["xclip", "-selection", "clipboard"],
      ["xsel", "--clipboard", "--input"],
    ];

    for (const command of commands) {
      const binary = command[0];
      if (!binary) {
        continue;
      }
      const result = spawnSync(binary, command.slice(1), { input: text, encoding: "utf8" });
      if (!result.error && result.status === 0) {
        return true;
      }
    }
    return false;
  }

  async function executeSelected(): Promise<void> {
    const selectedIndex = specsPanel.selected;
    const specPath = specs[selectedIndex] ?? specs[0];
    if (!specPath) {
      return;
    }

    state.passed = 0;
    state.failed = 0;
    state.total = 0;
    state.tests = [];
    state.status = "running";
    renderStatus();

    const eventBus = new EventBus();
    const projectConfig = loadProjectConfig(findProjectConfigPath(specPath));
    const compiledPath = defaultCompiledOutputPath(findProjectConfigPath(specPath), specPath);
    appendLog(`Starting: ${path.basename(specPath)}`);
    appendLog(`Mode: ${state.modeLabel}`);
    spinnerFrameIndex = 0;

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

      startSpinner();
      const executor = new SuiteExecutor({ eventBus });
      const result = await executor.runSuite(suite, {
        output_dir: projectConfig.paths.results_dir,
        headless: state.headless,
      });
      const persistedPaths = await persistSuiteOutputs(result, projectConfig.paths.results_dir, compiledPath);
      appendLog(`Completed! Status: ${result.status}`);
      appendLog(`Artifacts: ${result.artifacts_root}`);
      appendLog(`Result JSON: ${persistedPaths.result_json}`);
      appendLog(`Report MD: ${persistedPaths.report_md}`);
      appendLog(`Report HTML: ${persistedPaths.report_html}`);
      appendLog(`Summary JSON: ${persistedPaths.summary_json}`);
    } catch (error) {
      appendLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
      state.status = "completed";
      renderStatus();
    } finally {
      spinnerActive = false;
      stopSpinner();
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
  screen.key(["y"], () => {
    copyLog();
  });

  screen.render();
}
