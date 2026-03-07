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
  let spinnerLabel = "Running...";
  let currentView: "intro" | "runner" = "intro";
  let introPulse = 0;
  let introTimer: ReturnType<typeof setInterval> | null = null;
  let lastRunSummary = "No runs yet";

  const header = blessed.box({ top: 0, left: 0, width: "100%", height: 3, content: " spec - Markdown -> Runtime -> Bun ", tags: true, style: { fg: "#f5f7fa", bg: "#10233a" } });
  const footer = blessed.box({ bottom: 0, left: 0, width: "100%", height: 1, content: " enter open runner  esc home  r run  h headless  c compile-only  y copy logs  q quit ", style: { fg: "#d9e2ec", bg: "#102a43" } });

  const introBackdrop = blessed.box({ top: 3, left: 0, width: "100%", bottom: 1, style: { bg: "#07111b" } });

  const introBox = blessed.box({
    top: 4,
    left: "center",
    width: "74%",
    height: 21,
    border: "line",
    label: " Launch Pad ",
    tags: true,
    style: { fg: "#f0f4f8", bg: "#0c1824", border: { fg: "#3aaed8" } },
  });

  const heroBox = blessed.box({ top: 1, left: 2, width: "60%-1", height: 10, parent: introBox, tags: true, style: { fg: "#f0f4f8", bg: "#0c1824" } });
  const statsBox = blessed.box({ top: 1, right: 2, width: "34%-1", height: 10, parent: introBox, tags: true, border: "line", label: " Stats ", style: { fg: "#d9e2ec", bg: "#10202d", border: { fg: "#4cc9f0" } } });
  const actionsBox = blessed.box({ top: 11, left: 2, width: "28%-1", height: 8, parent: introBox, tags: true, border: "line", label: " Keys ", style: { fg: "#d9e2ec", bg: "#0f1c2a", border: { fg: "#7bdff2" } } });
  const recentBox = blessed.box({ top: 11, left: "30%", width: "68%-2", height: 8, parent: introBox, tags: true, border: "line", label: " Last Run ", style: { fg: "#d9e2ec", bg: "#09131d", border: { fg: "#7bdff2" } } });

  const runnerShell = blessed.box({ top: 3, left: 0, width: "100%", bottom: 1, hidden: true });
  const specsPanel = blessed.list({ top: 0, left: 0, width: "30%", bottom: 0, parent: runnerShell, keys: true, vi: true, border: "line", label: " Specs ", items: specs.map((spec) => path.basename(spec)), style: { fg: "#d9e2ec", bg: "#0f1c2a", border: { fg: "#315f7d" }, selected: { bg: "#56c1ff", fg: "black" } } });
  const statusBox = blessed.box({ top: 0, left: "30%", width: "70%", height: "45%-1", parent: runnerShell, border: "line", label: " Run Status ", tags: false, scrollable: true, alwaysScroll: true, style: { fg: "#f0f4f8", bg: "#111f2d", border: { fg: "#315f7d" } } });
  const logBox = blessed.log({ top: "45%+2", left: "30%", width: "70%", bottom: 0, parent: runnerShell, border: "line", label: " Execution Log ", tags: false, scrollback: 200, style: { fg: "#d9e2ec", bg: "#08121b", border: { fg: "#315f7d" } } });

  function introContent(): void {
    const pulseColor = ["#4cc9f0", "#7bdff2", "#c8f7ff", "#7bdff2"][introPulse % 4] ?? "#4cc9f0";
    header.setContent(` {bold}spec{/bold} {gray-fg}- Markdown -> Runtime -> Bun{/gray-fg} {right}{${pulseColor}-fg}live{/}`);
    const compact = (screen.width as number) < 110 || (screen.height as number) < 30;
    heroBox.setContent([
      "",
      ...(compact
        ? [
            ` {${pulseColor}-fg}{bold}SPEC{/bold}{/}`,
            "",
            " {bold}Markdown -> LLM -> Playwright{/bold}",
            "",
            " Open the runner, pick a spec, and execute.",
          ]
        : [
            ` {${pulseColor}-fg}  _____ ____  ______ _____{/}`,
            ` {${pulseColor}-fg} / ___// __ \\/ ____// ___/{/}`,
            ` {${pulseColor}-fg} \__ \\/ /_/ / __/   \__ \\ {/}`,
            ` {${pulseColor}-fg}___/ / ____/ /___  ___/ /{/}`,
            ` {${pulseColor}-fg}/____/_/   /_____//____/ {/}`,
            "",
            " {bold}Launch markdown specs into LLM-guided Playwright runs{/bold}",
            "",
            " Spec feels best when it opens like a tool, not a menu.",
          ]),
      ` {gray-fg}Current mode{/gray-fg}: ${state.modeLabel}`,
      ` {gray-fg}Browser{/gray-fg}: ${state.headless ? "Headless" : "Headful"}`,
    ].join("\n"));
    statsBox.setContent([
      "",
      ` {bold}Specs{/bold}        ${specs.length}`,
      "",
      " {bold}Mode{/bold}",
      ` ${state.modeLabel}`,
      "",
      " {bold}Browser{/bold}",
      ` ${state.headless ? "Headless" : "Headful"}`,
      "",
      " {bold}Logs{/bold}",
      " Clipboard + file export",
    ].join("\n"));
    actionsBox.setContent([
      "",
      " {bold}enter{/bold} open",
      " {bold}h{/bold}     browser",
      " {bold}c{/bold}     mode",
      " {bold}y{/bold}     logs",
      " {bold}esc{/bold}   home",
      " {bold}q{/bold}     quit",
    ].join("\n"));
    recentBox.setContent([
      "",
      ` ${lastRunSummary}`,
      "",
      " Updated after each suite run.",
    ].join("\n"));
  }

  function showIntro(): void {
    currentView = "intro";
    introContent();
    introBackdrop.show();
    introBox.show();
    runnerShell.hide();
    screen.render();
  }

  function showRunner(): void {
    currentView = "runner";
    introBackdrop.hide();
    introBox.hide();
    runnerShell.show();
    specsPanel.focus();
    screen.render();
  }

  function renderStatus(): void {
    const lines: string[] = [];
    if (state.status === "idle") {
      lines.push(
        "Session Ready",
        "",
        `Browser mode: ${state.headless ? "Headless" : "Headful"}`,
        `Workflow: ${state.modeLabel}`,
        "Runner state: Idle",
        "",
        "Select a spec on the left and press r to start.",
        "Press h to toggle browser mode.",
        "Press c to switch compile-only mode.",
      );
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
    const line = `${frame} ${spinnerLabel}`;
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

  function setSpinner(label: string): void {
    spinnerLabel = label;
    if (spinnerActive) {
      updateSpinnerLine();
    }
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
    spinnerLabel = "Preparing run...";

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
            setSpinner("Waiting for LLM...");
            appendLog(`LLM Prompt: ${prompt.slice(0, 100)}...`);
            appendLog(`LLM Response: ${JSON.stringify(response)}`);
            setSpinner("Normalizing suite...");
          },
        },
      });
      startSpinner();
      setSpinner("Normalizing suite...");
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

      setSpinner("Running Playwright suite...");
      const executor = new SuiteExecutor({ eventBus });
      const result = await executor.runSuite(suite, {
        output_dir: projectConfig.paths.results_dir,
        headless: state.headless,
      });
      setSpinner("Writing reports...");
      const persistedPaths = await persistSuiteOutputs(result, projectConfig.paths.results_dir, compiledPath);
      appendLog(`Completed! Status: ${result.status}`);
      appendLog(`Artifacts: ${result.artifacts_root}`);
      appendLog(`Result JSON: ${persistedPaths.result_json}`);
      appendLog(`Report MD: ${persistedPaths.report_md}`);
      appendLog(`Report HTML: ${persistedPaths.report_html}`);
      appendLog(`Summary JSON: ${persistedPaths.summary_json}`);
      lastRunSummary = `Last suite {bold}${result.suite_name}{/bold}\nStatus: ${result.status}\nArtifacts: ${result.artifacts_root}`;
    } catch (error) {
      appendLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
      state.status = "completed";
      lastRunSummary = `Last suite failed before completion\nReason: ${error instanceof Error ? error.message : String(error)}`;
      renderStatus();
    } finally {
      spinnerActive = false;
      stopSpinner();
    }
  }

  screen.append(header);
  screen.append(introBackdrop);
  screen.append(introBox);
  screen.append(runnerShell);
  screen.append(footer);
  renderStatus();
  showIntro();

  introTimer = setInterval(() => {
    if (currentView !== "intro") {
      return;
    }
    introPulse += 1;
    introContent();
    screen.render();
  }, 700);

  screen.key(["q", "C-c"], () => {
    if (introTimer) {
      clearInterval(introTimer);
    }
    process.exit(0);
  });
  screen.key(["enter"], () => {
    if (currentView === "intro") {
      showRunner();
    }
  });
  screen.key(["escape"], () => {
    if (currentView === "runner") {
      showIntro();
    }
  });
  screen.key(["h"], () => {
    state.headless = !state.headless;
    introContent();
    renderStatus();
  });
  screen.key(["c"], () => {
    state.modeLabel = state.modeLabel === "Compile Only" ? "Compile + Run" : "Compile Only";
    introContent();
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
