import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { Box, ScrollBoxRenderable, SelectRenderable, SelectRenderableEvents, TextRenderable, createCliRenderer, instantiate, type KeyEvent } from "@opentui/core";

import { findProjectConfigPath, loadProjectConfig } from "../config";
import { testSuiteSchema } from "../models/suite";
import { parseMarkdownToRaw } from "../parser/markdown-parser";
import { SpecNormalizer } from "../parser/normalizer";
import { loadMarkdown } from "../parser/markdown-loader";
import type { ExecutionEvent } from "../runtime/events";
import { EventBus } from "../runtime/events";
import { SuiteExecutor } from "../runtime/executor";
import { compiledPlanIsFresh, defaultCompiledOutputPath, fileSha256, persistSuiteOutputs, writeCompiledPlan } from "../runtime/persistence";

type TestState = {
  name: string;
  status: string;
  currentStep: string;
  durationMs: number;
};

type ViewMode = "intro" | "runner";

type AppState = {
  view: ViewMode;
  suiteName: string;
  suiteStatus: string;
  tests: TestState[];
  passed: number;
  failed: number;
  total: number;
  headless: boolean;
  compileOnly: boolean;
  lastRunSummary: string;
  spinnerLabel: string;
  spinnerActive: boolean;
  spinnerGeneration: number;
  selectedIndex: number;
};

type LogEntryKind = "system" | "llm-prompt" | "llm-json" | "result-pass" | "result-fail" | "result-info";

type LogEntry = {
  kind: LogEntryKind;
  title: string;
  body?: string;
};

export async function runTui(specs: string[]): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const state: AppState = {
    view: "intro",
    suiteName: "",
    suiteStatus: "idle",
    tests: [],
    passed: 0,
    failed: 0,
    total: 0,
    headless: true,
    compileOnly: false,
    lastRunSummary: "No runs yet.",
    spinnerLabel: "Idle",
    spinnerActive: false,
    spinnerGeneration: 0,
    selectedIndex: 0,
  };

  const logEntries: LogEntry[] = [];
  const rendererRoot = renderer.root;

  const footerText = new TextRenderable(renderer, { content: "enter open runner  esc home  r run  h headless  c compile-only  y copy logs  q quit", fg: "#d9e2ec" });
  const shellNode = Box(
    { width: "100%", height: "100%", flexDirection: "column", backgroundColor: "#08111b" },
    Box({ width: "100%", height: 3, paddingLeft: 1, paddingRight: 1, backgroundColor: "#10233a", justifyContent: "center" }, new TextRenderable(renderer, { content: "spec - Markdown -> Runtime -> Bun - live", fg: "#f5f7fa" })),
    Box({ id: "body-root", width: "100%", flexGrow: 1, padding: 1, backgroundColor: "#07111b" }),
    Box({ width: "100%", height: 1, paddingLeft: 1, backgroundColor: "#102a43" }, footerText),
  );

  const introHero = new TextRenderable(renderer, { content: "SPEC\n\nWrite markdown. Run real browsers.", fg: "#e6f1f8" });
  const introStats = new TextRenderable(renderer, { content: "", fg: "#d9e2ec" });
  const introKeys = new TextRenderable(renderer, { content: "", fg: "#d9e2ec" });
  const introRecent = new TextRenderable(renderer, { content: "", fg: "#d9e2ec" });

  const introViewNode = Box(
    { width: "100%", height: "100%", flexDirection: "column", gap: 1 },
    Box(
      { width: "100%", height: 10, borderStyle: "rounded", borderColor: "#3aaed8", backgroundColor: "#0c1824", padding: 1, flexDirection: "row", gap: 2 },
      Box({ width: "60%", height: "100%", justifyContent: "center" }, introHero),
      Box({ width: "40%", height: "100%", borderStyle: "single", borderColor: "#4cc9f0", backgroundColor: "#10202d", padding: 1 }, introStats),
    ),
    Box(
      { width: "100%", height: 8, flexDirection: "row", gap: 1 },
      Box({ width: "32%", height: "100%", borderStyle: "single", borderColor: "#7bdff2", backgroundColor: "#0f1c2a", padding: 1 }, introKeys),
      Box({ width: "68%", height: "100%", borderStyle: "single", borderColor: "#7bdff2", backgroundColor: "#09131d", padding: 1 }, introRecent),
    ),
  );

  const specList = new SelectRenderable(renderer, {
    id: "spec-list",
    width: 28,
    height: 24,
    options: specs.map((spec) => ({ name: path.basename(spec), description: path.relative(process.cwd(), spec), value: spec })),
    backgroundColor: "#0f1c2a",
    textColor: "#d9e2ec",
    selectedBackgroundColor: "#56c1ff",
    selectedTextColor: "#000000",
    descriptionColor: "#7a8b9a",
    selectedDescriptionColor: "#1f2933",
    showDescription: false,
  });

  const statusText = new TextRenderable(renderer, { content: "", fg: "#f0f4f8" });
  const logText = new TextRenderable(renderer, { content: "", fg: "#d9e2ec" });

  const runnerViewNode = Box(
    { width: "100%", height: "100%", flexDirection: "row", gap: 1 },
    Box({ width: 30, height: "100%", borderStyle: "rounded", borderColor: "#315f7d", backgroundColor: "#0f1c2a", padding: 1 }, specList),
    Box(
      { flexGrow: 1, height: "100%", flexDirection: "column", gap: 1 },
      Box({ width: "100%", height: 12, borderStyle: "rounded", borderColor: "#315f7d", backgroundColor: "#111f2d", padding: 1 }, Box({ id: "status-scroll-host", width: "100%", height: "100%" })),
      Box({ width: "100%", flexGrow: 1, borderStyle: "rounded", borderColor: "#315f7d", backgroundColor: "#08121b", padding: 0 }, Box({ id: "log-host", width: "100%", height: "100%" })),
    ),
  );

  const shell = instantiate(renderer, shellNode);
  const body = shell.findDescendantById("body-root");
  const introView = instantiate(renderer, introViewNode);
  const runnerView = instantiate(renderer, runnerViewNode);
  const statusScroll = new ScrollBoxRenderable(renderer, { width: "100%", height: "100%", stickyScroll: true, stickyStart: "top", rootOptions: { backgroundColor: "#111f2d" } });
  const logScroll = new ScrollBoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
    rootOptions: { backgroundColor: "#08121b", padding: 1 },
  });
  statusScroll.add(statusText);
  logScroll.add(logText);
  runnerView.findDescendantById("status-scroll-host")?.add(statusScroll);
  runnerView.findDescendantById("log-host")?.add(logScroll);
  body?.add(introView);
  rendererRoot.add(shell);

  let spinnerTimer: ReturnType<typeof setTimeout> | null = null;
  let spinnerFrameIndex = 0;

  function setText(target: { content: string | unknown }, value: string): void {
    target.content = value;
  }

  function render(): void {
    setText(introStats, [
      `Specs: ${specs.length}`,
      "",
      `Mode: ${state.compileOnly ? "Compile Only" : "Compile + Run"}`,
      `Browser: ${state.headless ? "Headless" : "Headful"}`,
      `Spinner: ${state.spinnerActive ? state.spinnerLabel : "Idle"}`,
      "",
      "Auto mode prefers fixed parsing first.",
    ].join("\n"));

    setText(introKeys, [
      "enter  open runner",
      "h      toggle browser",
      "c      toggle mode",
      "y      copy logs",
      "esc    go home",
      "q      quit",
    ].join("\n"));

    setText(introRecent, state.lastRunSummary);

    setText(statusText, renderStatusText());
    logText.content = renderStyledLogText();

    if (state.view === "intro") {
      body?.remove(runnerView.id);
      if (body && !body.findDescendantById(introView.id)) {
        body.add(introView);
      }
      setText(footerText, "enter open runner  h headless  c compile-only  q quit");
    } else {
      body?.remove(introView.id);
      if (body && !body.findDescendantById(runnerView.id)) {
        body.add(runnerView);
      }
      setText(footerText, "esc home  r run  h headless  c compile-only  y copy logs  q quit");
      specList.focus();
    }

    renderer.requestRender();
  }

  function renderStatusText(): string {
    if (state.suiteStatus === "idle") {
      return [
        "Session Ready",
        "",
        `Browser mode: ${state.headless ? "Headless" : "Headful"}`,
        `Workflow: ${state.compileOnly ? "Compile Only" : "Compile + Run"}`,
        `Spinner: ${state.spinnerActive ? state.spinnerLabel : "Idle"}`,
        "",
        "Select a spec and press r to start.",
      ].join("\n");
    }

    const lines = [state.suiteName || "Active Suite", `Status: ${state.suiteStatus}`, "", `Passed ${state.passed}   Failed ${state.failed}   Total ${state.total}`, ""];
    for (const test of state.tests) {
      const icon = test.status === "passed" ? "[pass]" : test.status === "failed" ? "[fail]" : test.status === "running" ? "[run]" : "[wait]";
      lines.push(`${icon} ${test.name}${test.durationMs ? ` (${test.durationMs}ms)` : ""}`);
      if (test.currentStep) {
        lines.push(`  ${test.currentStep}`);
      }
    }
    if (state.spinnerActive) {
      lines.push("", `Spinner: ${state.spinnerLabel}`);
    }
    return lines.join("\n");
  }

  function renderStyledLogText(): string {
    if (logEntries.length === 0) {
      return "No logs yet. Start a run to see live execution output.";
    }

    return logEntries.map((entry) => renderStyledEntry(entry)).join("\n\n");
  }

  function renderEntry(entry: LogEntry): string {
    const badge = entryBadge(entry.kind);
    const lines = [`${badge} ${entry.title}`];
    if (entry.body && entry.body !== entry.title) {
      if (entry.kind === "llm-json") {
        lines.push("```json");
        lines.push(indentBlock(prettyJson(entry.body)));
        lines.push("```");
      } else if (entry.kind === "llm-prompt") {
        lines.push("```text");
        lines.push(indentBlock(entry.body));
        lines.push("```");
      } else {
        lines.push(indentBlock(entry.body));
      }
    }
    return lines.join("\n");
  }

  function renderStyledEntry(entry: LogEntry): string {
    if (entry.kind === "llm-prompt") {
      return renderChatBubble("right", "YOU -> LLM", entry.body ?? entry.title, "text");
    }
    if (entry.kind === "llm-json") {
      return renderChatBubble("left", "LLM -> SPEC", prettyJson(entry.body ?? "{}"), "json");
    }
    if (entry.kind === "result-pass") {
      return renderBanner("PASS", entry.title, entry.body);
    }
    if (entry.kind === "result-fail") {
      return renderBanner("FAIL", entry.title, entry.body);
    }
    if (entry.kind === "result-info") {
      return renderBanner("INFO", entry.title, entry.body);
    }
    return renderEntry(entry);
  }

  function renderChatBubble(side: "left" | "right", label: string, body: string, format: "text" | "json"): string {
    const availableWidth = Math.max(36, Math.min(72, terminalWidthEstimate() - 40));
    const width = side === "left" ? availableWidth : availableWidth;
    const content = format === "json" ? prettyJson(body) : body;
    const lines = content.split("\n");
    const indent = side === "left" ? 0 : Math.max(0, terminalWidthEstimate() - width - 6);
    const prefix = " ".repeat(indent);
    const top = `${prefix}┌─ ${label}`;
    const wrapped = lines.flatMap((line) => wrapLine(line, width));
    const bubble = wrapped.map((line) => {
      const padded = line.padEnd(width, " ");
      return `${prefix}│ ${padded} │`;
    });
    const bottom = `${prefix}└${"─".repeat(width + 2)}┘`;
    return [top, ...bubble, bottom].join("\n");
  }

  function terminalWidthEstimate(): number {
    return Number(process.stdout.columns ?? 100);
  }

  function renderBanner(kind: "PASS" | "FAIL" | "INFO", title: string, body?: string): string {
    const lines = [`${kind} ${title}`];
    if (body) {
      lines.push(indentBlock(body));
    }
    return lines.join("\n");
  }

  function entryBadge(kind: LogEntryKind): string {
    switch (kind) {
      case "llm-prompt":
        return "LLM";
      case "llm-json":
        return "JSON";
      case "result-pass":
        return "PASS";
      case "result-fail":
        return "FAIL";
      case "result-info":
        return "INFO";
      default:
        return "LOG";
    }
  }

  function indentBlock(value: string): string {
    return value
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
  }

  function wrapLine(value: string, width: number): string[] {
    if (value.length <= width) {
      return [value];
    }
    const parts: string[] = [];
    let remaining = value;
    while (remaining.length > width) {
      parts.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    if (remaining.length > 0) {
      parts.push(remaining);
    }
    return parts;
  }

  function prettyJson(value: string): string {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }

  function appendLog(message: string): void {
    dropSpinnerEntry();
    stopSpinner();
    state.spinnerActive = false;
    state.spinnerGeneration += 1;
    logEntries.push({ kind: "system", title: message, body: message });
    render();
  }

  function appendResult(kind: "success" | "failure" | "info", title: string, details: string[]): void {
    dropSpinnerEntry();
    stopSpinner();
    state.spinnerActive = false;
    state.spinnerGeneration += 1;

    logEntries.push({
      kind: kind === "success" ? "result-pass" : kind === "failure" ? "result-fail" : "result-info",
      title,
      body: details.join("\n"),
    });
    render();
  }

  function updateSpinnerLine(): void {
    const generation = state.spinnerGeneration;
    const frames = ["[|]", "[/]", "[-]", "[\\]"];
    const frame = frames[spinnerFrameIndex % frames.length] ?? "[|]";
    spinnerFrameIndex += 1;
    const line = `${frame} ${state.spinnerLabel}`;
    const lastEntry = logEntries.at(-1);
    if (lastEntry?.kind === "system" && lastEntry.title.startsWith("[")) {
      lastEntry.title = line;
      lastEntry.body = line;
    } else {
      logEntries.push({ kind: "system", title: line, body: line });
    }
    render();
    spinnerTimer = setTimeout(() => {
      if (!state.spinnerActive || generation !== state.spinnerGeneration) {
        return;
      }
      updateSpinnerLine();
    }, 120);
  }

  function dropSpinnerEntry(): void {
    const lastEntry = logEntries.at(-1);
    if (state.spinnerActive && lastEntry?.kind === "system" && lastEntry.title.startsWith("[")) {
      logEntries.pop();
    }
  }

  function startSpinner(label: string): void {
    stopSpinner();
    state.spinnerLabel = label;
    state.spinnerActive = true;
    state.spinnerGeneration += 1;
    spinnerFrameIndex = 0;
    updateSpinnerLine();
  }

  function setSpinner(label: string): void {
    state.spinnerLabel = label;
    if (state.spinnerActive) {
      updateSpinnerLine();
    } else {
      render();
    }
  }

  function stopSpinner(): void {
    if (spinnerTimer) {
      clearTimeout(spinnerTimer);
      spinnerTimer = null;
    }
    state.spinnerGeneration += 1;
  }

  function copyLog(): void {
    if (logEntries.length === 0) {
      appendLog("No execution log to copy yet.");
      return;
    }

    const logTextValue = `${logEntries.map((entry) => `${entryBadge(entry.kind)} ${entry.title}${entry.body && entry.body !== entry.title ? `\n${entry.body}` : ""}`).join("\n\n").trim()}\n`;
    const logPath = writeLogSnapshot(logTextValue);
    const copied = copyToClipboard(logTextValue);
    appendLog(copied ? `Copied execution log to clipboard and saved ${logPath}` : `Clipboard unavailable. Saved execution log to ${logPath}`);
  }

  function writeLogSnapshot(logTextValue: string): string {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const logDir = path.join(".spec", "logs");
    mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `execution-${timestamp}.log`);
    void Bun.write(logPath, logTextValue);
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
      if (!binary) continue;
      const result = spawnSync(binary, command.slice(1), { input: text, encoding: "utf8" });
      if (!result.error && result.status === 0) {
        return true;
      }
    }
    return false;
  }

  async function executeSelected(): Promise<void> {
    const specPath = specs[state.selectedIndex] ?? specs[0];
    if (!specPath) {
      appendLog("No specs found.");
      return;
    }

    state.passed = 0;
    state.failed = 0;
    state.total = 0;
    state.tests = [];
    state.suiteStatus = "running";
    state.suiteName = path.basename(specPath);
    render();

    const eventBus = new EventBus();
    const projectConfig = loadProjectConfig(findProjectConfigPath(specPath));
    const compiledPath = defaultCompiledOutputPath(findProjectConfigPath(specPath), specPath);
    appendLog(`Starting: ${path.basename(specPath)}`);
    appendLog(`Mode: ${state.compileOnly ? "Compile Only" : "Compile + Run"}`);

    eventBus.subscribe({
      onEvent(event: ExecutionEvent) {
        if (event.type === "suite_started") {
          state.suiteName = String(event.data.suite_name ?? "");
          state.total = Number(event.data.test_count ?? 0);
        }
        if (event.type === "test_started") {
          state.tests.push({ name: String(event.data.test_name ?? ""), status: "running", currentStep: "", durationMs: 0 });
        }
        if (event.type === "step_started") {
          const current = state.tests.at(-1);
          if (current) {
            current.currentStep = `${String(event.data.step_id ?? "")}: ${String(event.data.action_kind ?? "")}`;
          }
        }
        if (event.type === "test_finished") {
          const name = String(event.data.test_name ?? "");
          const target = state.tests.find((test) => test.name === name);
          if (target) {
            target.status = String(event.data.status ?? "completed");
            target.durationMs = Number(event.data.duration_ms ?? 0);
          }
          if (target?.status === "passed") state.passed += 1;
          if (target?.status === "failed") state.failed += 1;
        }
        if (event.type === "suite_finished") {
          state.suiteStatus = String(event.data.status ?? "completed");
        }
        render();
      },
    });

    try {
      const raw = parseMarkdownToRaw(await loadMarkdown(specPath));
      const normalizer = new SpecNormalizer({
        projectConfig,
        config: {
          on_authoring_mode_detected: ({ test_name, authoring_mode }) => {
            if (authoring_mode === "freeflow") {
              logEntries.push({
                kind: "result-info",
                title: `Freeflow detected for "${test_name}"`,
                body: "This test was interpreted as freeform prose, so outline extraction was used before normalization.",
              });
              render();
            } else if (authoring_mode === "fixed") {
              logEntries.push({
                kind: "result-info",
                title: `Fixed grammar detected for "${test_name}"`,
                body: "This test already uses structured steps, so no freeflow outline extraction was needed.",
              });
              render();
            }
          },
          on_deterministic_step: ({ test_name, step_text }) => {
            logEntries.push({
              kind: "result-info",
              title: `Deterministic fixed step in "${testNameShort(test_name)}"`,
              body: `No LLM call was needed for this step.\n\n${step_text}`,
            });
            render();
          },
          on_llm_call: (prompt, response) => {
            setSpinner("Waiting for LLM...");
            logEntries.push({ kind: "llm-prompt", title: `Prompt: ${prompt.slice(0, 80)}...`, body: prompt });
            logEntries.push({ kind: "llm-json", title: "LLM JSON output", body: JSON.stringify(response, null, 2) });
            render();
            setSpinner("Normalizing suite...");
          },
        },
      });

      startSpinner("Normalizing suite...");
      const suite = testSuiteSchema.parse(
        compiledPlanIsFresh(compiledPath, specPath)
        ? stripCompiledMetadata(JSON.parse(readFileSync(compiledPath, "utf8")))
        : await normalizer.normalize(raw),
      );

      if (!compiledPlanIsFresh(compiledPath, specPath)) {
        writeCompiledPlan({ suites: [suite], destination: compiledPath, sourceSpec: specPath, sourceHash: fileSha256(specPath) });
        appendLog(`Compiled plan: ${compiledPath}`);
      } else {
        appendLog(`Reusing compiled plan: ${compiledPath}`);
      }

      if (state.compileOnly) {
        stopSpinner();
        state.spinnerActive = false;
        appendResult("info", "Compile complete", [
          `Suite: ${suite.name}`,
          `Compiled plan: ${compiledPath}`,
          "Execution skipped because Compile Only mode is enabled.",
        ]);
        state.suiteStatus = "completed";
        state.lastRunSummary = `Last suite: ${suite.name}\nStatus: compiled\nCompiled: ${compiledPath}`;
        render();
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
      stopSpinner();
      state.spinnerActive = false;
      dropSpinnerEntry();
      appendResult(result.status === "passed" ? "success" : "failure", `Suite ${result.status}`, [
        `Suite: ${result.suite_name}`,
        `Artifacts: ${result.artifacts_root}`,
        `Result JSON: ${persistedPaths.result_json}`,
        `Report MD: ${persistedPaths.report_md}`,
        `Report HTML: ${persistedPaths.report_html}`,
        `Summary JSON: ${persistedPaths.summary_json}`,
      ]);
      state.lastRunSummary = `Last suite: ${result.suite_name}\nStatus: ${result.status}\nArtifacts: ${result.artifacts_root}`;
      render();
    } catch (error) {
      stopSpinner();
      state.spinnerActive = false;
      dropSpinnerEntry();
      appendResult("failure", "Suite failed", [`Reason: ${error instanceof Error ? error.message : String(error)}`]);
      state.suiteStatus = "failed";
      state.lastRunSummary = `Last suite failed\nReason: ${error instanceof Error ? error.message : String(error)}`;
      render();
    } finally {
      state.spinnerActive = false;
      stopSpinner();
      render();
    }
  }

  specList.on(SelectRenderableEvents.SELECTION_CHANGED, (index) => {
    state.selectedIndex = index;
    render();
  });

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      process.exit(0);
    }

    if (key.name === "q") {
      renderer.destroy();
      process.exit(0);
    }

    if (key.name === "return" && state.view === "intro") {
      state.view = "runner";
      render();
      return;
    }

    if (key.name === "escape" && state.view === "runner") {
      state.view = "intro";
      render();
      return;
    }

    if (key.name === "h") {
      state.headless = !state.headless;
      render();
      return;
    }

    if (key.name === "c") {
      state.compileOnly = !state.compileOnly;
      render();
      return;
    }

    if (key.name === "y") {
      copyLog();
      return;
    }

    if (key.name === "r" && state.view === "runner") {
      void executeSelected();
    }
  });

  render();
}

function testNameShort(name: string): string {
  return name.length > 42 ? `${name.slice(0, 39)}...` : name;
}

function stripCompiledMetadata(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const cloned = { ...(payload as Record<string, unknown>) };
  delete cloned._spec;
  return cloned;
}
