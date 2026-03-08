import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  Box,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  createCliRenderer,
  instantiate,
  type KeyEvent,
} from "@opentui/core";

import { findProjectConfigPath, loadProjectConfig } from "../config";
import type { Action } from "../models/action";
import type { SuiteResult, TestResult } from "../models/result";
import { testSuiteSchema } from "../models/suite";
import type { TestSuite } from "../models/suite";
import { parseMarkdownToRaw } from "../parser/markdown-parser";
import { SpecNormalizer } from "../parser/normalizer";
import { loadMarkdown } from "../parser/markdown-loader";
import type { RawSuiteDocument } from "../parser/raw-models";
import type { ExecutionEvent } from "../runtime/events";
import { EventBus } from "../runtime/events";
import { SuiteExecutor } from "../runtime/executor";
import { compiledPlanIsFresh, defaultCompiledOutputPath, fileSha256, persistSuiteOutputs, writeCompiledPlan } from "../runtime/persistence";

type TestState = {
  id: string;
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

type StepTraceMeta = {
  testId: string;
  testName: string;
  phase: "setup" | "step" | "teardown";
  stepId: string;
  markdownLine: number | null;
  markdownText: string;
  action: Action;
};

type ActiveTrace = {
  testId: string;
  testName: string;
  phase: "setup" | "step" | "teardown";
  stepId: string;
  markdownLine: number | null;
  markdownText: string;
  actionJson: string;
  status: "running" | "passed" | "failed";
  durationMs: number | null;
  message: string | null;
};

type RawStepLineMap = {
  testHeadingLines: Array<number | null>;
  setupLines: Array<number | null>;
  testLines: Array<Array<number | null>>;
  freeflowLines: Array<number | null>;
  teardownLines: Array<number | null>;
};

const uiTheme = {
  shellBg: "#060d15",
  shellBodyBg: "#08121d",
  topBarBg: "#12263a",
  footerBg: "#10263d",
  shellText: "#e6eef6",
  panelBg: "#0d1a29",
  panelMutedBg: "#0a1624",
  panelBorder: "#2e4f6c",
  panelTitle: "#a8c8e5",
  panelText: "#d4e0ed",
  panelSubtleText: "#8da8bf",
  accent: "#58b4e6",
} as const;

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
  let sourceSpecPath = "";
  let sourceMarkdownLines: string[] = [];
  let stepTraceMap = new Map<string, StepTraceMeta>();
  let activeTrace: ActiveTrace | null = null;
  const rendererRoot = renderer.root;

  const footerText = new TextRenderable(renderer, { content: "enter open runner  esc home  r run  h headless  c compile-only  y copy logs  q quit", fg: uiTheme.shellText });
  const shellNode = Box(
    { width: "100%", height: "100%", flexDirection: "column", backgroundColor: uiTheme.shellBg },
    Box(
      { width: "100%", height: 3, paddingLeft: 1, paddingRight: 1, backgroundColor: uiTheme.topBarBg, justifyContent: "space-between", flexDirection: "row", alignItems: "center" },
      new TextRenderable(renderer, { content: "SPEC Runner", fg: uiTheme.shellText }),
      new TextRenderable(renderer, { content: "Markdown -> Action JSON -> Browser", fg: uiTheme.panelSubtleText }),
    ),
    Box({ id: "body-root", width: "100%", flexGrow: 1, padding: 1, backgroundColor: uiTheme.shellBodyBg }),
    Box({ width: "100%", height: 1, paddingLeft: 1, backgroundColor: uiTheme.footerBg }, footerText),
  );

  const introHero = new TextRenderable(renderer, { content: "SPEC\n\nWrite markdown specs.\nWatch execution live.", fg: uiTheme.shellText });
  const introStats = new TextRenderable(renderer, { content: "", fg: uiTheme.panelText });
  const introKeys = new TextRenderable(renderer, { content: "", fg: uiTheme.panelText });
  const introRecent = new TextRenderable(renderer, { content: "", fg: uiTheme.panelText });

  const introViewNode = Box(
    { width: "100%", height: "100%", flexDirection: "column", gap: 1 },
    Box(
      { width: "100%", height: 10, borderStyle: "rounded", borderColor: uiTheme.accent, backgroundColor: uiTheme.panelBg, padding: 1, flexDirection: "row", gap: 2 },
      Box({ width: "60%", height: "100%", justifyContent: "center" }, introHero),
      Box({ width: "40%", height: "100%", borderStyle: "single", borderColor: uiTheme.panelBorder, backgroundColor: uiTheme.panelMutedBg, padding: 1 }, introStats),
    ),
    Box(
      { width: "100%", height: 8, flexDirection: "row", gap: 1 },
      Box({ width: "32%", height: "100%", borderStyle: "single", borderColor: uiTheme.panelBorder, backgroundColor: uiTheme.panelBg, padding: 1 }, introKeys),
      Box({ width: "68%", height: "100%", borderStyle: "single", borderColor: uiTheme.panelBorder, backgroundColor: uiTheme.panelMutedBg, padding: 1 }, introRecent),
    ),
  );

  const specList = new SelectRenderable(renderer, {
    id: "spec-list",
    width: 28,
    height: 24,
    options: specs.map((spec) => ({ name: path.basename(spec), description: path.relative(process.cwd(), spec), value: spec })),
    backgroundColor: uiTheme.panelMutedBg,
    textColor: uiTheme.panelText,
    selectedBackgroundColor: uiTheme.accent,
    selectedTextColor: "#051018",
    descriptionColor: uiTheme.panelSubtleText,
    selectedDescriptionColor: "#0f2233",
    showDescription: false,
  });

  const statusText = new TextRenderable(renderer, { content: "", fg: uiTheme.panelText });
  const logFeed = instantiate(renderer, Box({ id: "log-feed", width: "100%", flexDirection: "column", gap: 1 }));
  const traceText = new TextRenderable(renderer, { content: "", fg: uiTheme.panelText, width: "100%" });

  const panelTitle = (label: string) => new TextRenderable(renderer, { content: label, fg: uiTheme.panelTitle });

  const runnerViewNode = Box(
    { width: "100%", height: "100%", flexDirection: "row", gap: 1 },
    Box(
      { width: 30, height: "100%", borderStyle: "rounded", borderColor: uiTheme.panelBorder, backgroundColor: uiTheme.panelBg, padding: 1, flexDirection: "column", gap: 1 },
      panelTitle("Specs"),
      specList,
    ),
    Box(
      { flexGrow: 1, height: "100%", flexDirection: "column", gap: 1 },
      Box(
        { width: "100%", height: 12, borderStyle: "rounded", borderColor: uiTheme.panelBorder, backgroundColor: uiTheme.panelBg, padding: 1, flexDirection: "column", gap: 1 },
        panelTitle("Run Status"),
        Box({ id: "status-scroll-host", width: "100%", flexGrow: 1 }),
      ),
      Box(
        { width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 },
        Box(
          { width: "50%", height: "100%", borderStyle: "rounded", borderColor: uiTheme.panelBorder, backgroundColor: uiTheme.panelMutedBg, padding: 1, flexDirection: "column", gap: 1 },
          panelTitle("Execution Log"),
          Box({ id: "log-host", width: "100%", flexGrow: 1 }),
        ),
        Box(
          { width: "50%", height: "100%", borderStyle: "rounded", borderColor: uiTheme.panelBorder, backgroundColor: uiTheme.panelMutedBg, padding: 1, flexDirection: "column", gap: 1 },
          panelTitle("Markdown -> Runtime Trace"),
          Box({ id: "trace-host", width: "100%", flexGrow: 1 }),
        ),
      ),
    ),
  );

  const shell = instantiate(renderer, shellNode);
  const body = shell.findDescendantById("body-root");
  const introView = instantiate(renderer, introViewNode);
  const runnerView = instantiate(renderer, runnerViewNode);
  const statusScroll = new ScrollBoxRenderable(renderer, { width: "100%", height: "100%", stickyScroll: true, stickyStart: "top", rootOptions: { backgroundColor: uiTheme.panelBg } });
  const logScroll = new ScrollBoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    stickyScroll: true,
    stickyStart: "bottom",
    rootOptions: { backgroundColor: uiTheme.panelMutedBg, padding: 0 },
  });
  const traceScroll = new ScrollBoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    stickyScroll: true,
    stickyStart: "top",
    rootOptions: { backgroundColor: uiTheme.panelMutedBg, padding: 0 },
  });
  statusScroll.add(statusText);
  logScroll.add(logFeed);
  traceScroll.add(traceText);
  runnerView.findDescendantById("status-scroll-host")?.add(statusScroll);
  runnerView.findDescendantById("log-host")?.add(logScroll);
  runnerView.findDescendantById("trace-host")?.add(traceScroll);
  body?.add(introView);
  rendererRoot.add(shell);

  let spinnerTimer: ReturnType<typeof setTimeout> | null = null;
  let spinnerFrameIndex = 0;

  function setText(target: { content: string | unknown }, value: string): void {
    target.content = value;
  }

  function render(): void {
    setText(introStats, [
      "Session",
      "",
      `Specs discovered: ${specs.length}`,
      `Current view: ${state.view}`,
      "",
      `Workflow: ${state.compileOnly ? "Compile Only" : "Compile + Run"}`,
      `Browser mode: ${state.headless ? "Headless" : "Headful"}`,
      `Background task: ${state.spinnerActive ? state.spinnerLabel : "Idle"}`,
      "",
      "Tip: use fixed grammar for deterministic runs.",
    ].join("\n"));

    setText(introKeys, [
      "Keys",
      "",
      "enter  open runner",
      "r      run selected spec",
      "h      toggle browser",
      "c      toggle mode",
      "y      copy logs",
      "esc    go home",
      "q      quit",
    ].join("\n"));

    setText(introRecent, ["Recent Run", "", state.lastRunSummary].join("\n"));

    setText(statusText, renderStatusText());
    setText(traceText, renderTraceText());
    rebuildLogFeed();

    if (state.view === "intro") {
      body?.remove(runnerView.id);
      if (body && !body.findDescendantById(introView.id)) {
        body.add(introView);
      }
      setText(footerText, "enter open runner  h toggle browser  c toggle mode  q quit");
    } else {
      body?.remove(introView.id);
      if (body && !body.findDescendantById(runnerView.id)) {
        body.add(runnerView);
      }
      setText(footerText, "esc home  r run  h toggle browser  c toggle mode  y copy logs  q quit");
      specList.focus();
    }

    renderer.requestRender();
  }

  function renderStatusText(): string {
    if (state.suiteStatus === "idle") {
      return [
        "Session Ready",
        "",
        `Workflow : ${state.compileOnly ? "Compile Only" : "Compile + Run"}`,
        `Browser  : ${state.headless ? "Headless" : "Headful"}`,
        `Task     : ${state.spinnerActive ? state.spinnerLabel : "Idle"}`,
        "",
        "Select a spec and press r to start.",
      ].join("\n");
    }

    const lines = [
      state.suiteName || "Active Suite",
      `Status   : ${state.suiteStatus}`,
      `Progress : ${state.tests.length}/${state.total} tests finished`,
      `Results  : pass ${state.passed}  fail ${state.failed}`,
      "",
      "Tests",
    ];
    for (const test of state.tests) {
      const icon = test.status === "passed" ? "[ok]" : test.status === "failed" ? "[x]" : test.status === "running" ? "[..]" : "[ ]";
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

  function renderTraceText(): string {
    const lines = sourceMarkdownLines;
    if (lines.length === 0) {
      return [
        "Live Translation / Execution",
        "",
        "No source loaded yet.",
        "Run a spec to watch markdown map to runtime actions.",
      ].join("\n");
    }

    const focusLine = activeTrace?.markdownLine ?? 1;
    const windowSize = 3;
    const start = Math.max(1, focusLine - windowSize);
    const end = Math.min(lines.length, focusLine + windowSize);
    const snippet: string[] = [];
    for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
      const marker = lineNumber === focusLine ? ">>" : "  ";
      const rawLine = lines[lineNumber - 1] ?? "";
      snippet.push(`${marker} ${String(lineNumber).padStart(4, " ")} | ${rawLine}`);
    }

    return [
      "Trace Stream",
      "",
      `Spec: ${sourceSpecPath ? path.basename(sourceSpecPath) : "(none)"}`,
      `Line: ${activeTrace?.markdownLine ? `L${activeTrace.markdownLine}` : "(waiting)"}`,
      `Test: ${activeTrace?.testName ?? "-"}`,
      `Step: ${activeTrace?.phase ?? "-"} / ${activeTrace?.stepId ?? "-"}`,
      `Status: ${activeTrace?.status ?? "idle"}${activeTrace?.durationMs ? ` (${activeTrace.durationMs}ms)` : ""}`,
      activeTrace?.message ? `Error: ${activeTrace.message}` : "Error: -",
      "",
      "Markdown Context",
      ...snippet,
      "",
      "Action JSON",
      activeTrace?.actionJson ?? "(waiting for first step)",
    ].join("\n");
  }

  function rebuildLogFeed(): void {
    clearChildren(logFeed);
    const llmLaneWidth = "92%";

    if (logEntries.length === 0) {
      logFeed.add(new TextRenderable(renderer, { content: "No logs yet. Start a run to see live execution output.", fg: uiTheme.panelSubtleText }));
      return;
    }

    for (const entry of logEntries) {
      const isLlmExchange = entry.kind === "llm-prompt" || entry.kind === "llm-json";
      const alignRight = entry.kind === "llm-prompt";
      const row = instantiate(
        renderer,
        Box({ width: "100%", flexDirection: "row", justifyContent: alignRight ? "flex-end" : "flex-start" }),
      );
      const rowBody = instantiate(
        renderer,
        Box({ width: isLlmExchange ? llmLaneWidth : "100%", marginBottom: 1 }),
      );
      const message = new TextRenderable(renderer, {
        content: renderEntry(entry),
        fg: colorForEntry(entry.kind),
        width: "100%",
      });
      rowBody.add(message);
      row.add(rowBody);
      logFeed.add(row);
    }
  }

  function clearChildren(target: { getChildren(): Array<{ id: string }>; remove(id: string): void }): void {
    for (const child of target.getChildren()) {
      target.remove(child.id);
    }
  }

  function colorForEntry(kind: LogEntryKind): string {
    switch (kind) {
      case "llm-prompt":
        return "#f6c76a";
      case "llm-json":
        return "#67d0f5";
      case "result-pass":
        return "#79db95";
      case "result-fail":
        return "#f48a8a";
      case "result-info":
        return "#79b5ff";
      default:
        return uiTheme.panelText;
    }
  }

  function renderEntry(entry: LogEntry): string {
    const header = `${entryBadge(entry.kind)} ${entry.title}`;
    if (!entry.body || entry.body === entry.title) {
      return header;
    }

    if (entry.kind === "llm-json") {
      return `${header}\n\n${prettyJson(entry.body)}`;
    }

    return `${header}\n\n${entry.body}`;
  }

  function entryBadge(kind: LogEntryKind): string {
    switch (kind) {
      case "llm-prompt":
        return "[prompt]";
      case "llm-json":
        return "[json]";
      case "result-pass":
        return "[pass]";
      case "result-fail":
        return "[fail]";
      case "result-info":
        return "[info]";
      default:
        return "[log]";
    }
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
    sourceSpecPath = specPath;
    activeTrace = null;
    stepTraceMap = new Map();
    render();

    const projectConfigPath = findProjectConfigPath(specPath);
    const eventBus = new EventBus();
    const projectConfig = loadProjectConfig(projectConfigPath);
    const compiledPath = defaultCompiledOutputPath(projectConfigPath, specPath);
    appendLog(`Starting: ${path.basename(specPath)}`);
    appendLog(`Mode: ${state.compileOnly ? "Compile Only" : "Compile + Run"}`);

    eventBus.subscribe({
      onEvent(event: ExecutionEvent) {
        if (event.type === "suite_started") {
          state.suiteName = String(event.data.suite_name ?? "");
        }
        if (event.type === "test_started") {
          const testId = String(event.data.test_id ?? "");
          const existing = state.tests.find((test) => test.id === testId);
          if (!existing) {
            state.tests.push({
              id: testId,
              name: String(event.data.test_name ?? ""),
              status: "running",
              currentStep: "",
              durationMs: 0,
            });
          }
        }
        if (event.type === "step_started") {
          const testId = String(event.data.test_id ?? "");
          const stepId = String(event.data.step_id ?? "");
          const rawPhase = String(event.data.phase ?? "step");
          const phase: "setup" | "step" | "teardown" = rawPhase === "setup" || rawPhase === "teardown" ? rawPhase : "step";
          const current = state.tests.find((test) => test.id === testId) ?? state.tests.at(-1);
          if (current) {
            current.currentStep = `${stepId}: ${String(event.data.action_kind ?? "")}`;
          }

          const trace = stepTraceMap.get(stepTraceKey(testId, phase, stepId)) ?? stepTraceMap.get(stepTraceKey(testId, "step", stepId));
          if (trace) {
            activeTrace = {
              testId,
              testName: trace.testName,
              phase: trace.phase,
              stepId: trace.stepId,
              markdownLine: trace.markdownLine,
              markdownText: trace.markdownText,
              actionJson: JSON.stringify(trace.action, null, 2),
              status: "running",
              durationMs: null,
              message: null,
            };
            logEntries.push({
              kind: "result-info",
              title: `Executing ${trace.markdownLine ? `L${trace.markdownLine}` : "line ?"} ${trace.stepId}`,
              body: trace.markdownText,
            });
          } else {
            activeTrace = {
              testId,
              testName: String(event.data.test_name ?? "Unknown test"),
              phase,
              stepId,
              markdownLine: null,
              markdownText: "Source line unavailable for this step.",
              actionJson: "{}",
              status: "running",
              durationMs: null,
              message: null,
            };
          }
        }
        if (event.type === "step_finished") {
          const testId = String(event.data.test_id ?? "");
          const stepId = String(event.data.step_id ?? "");
          const status = String(event.data.status ?? "passed");
          const durationMs = Number(event.data.duration_ms ?? 0);
          const message = event.data.message ? String(event.data.message) : null;

          if (activeTrace && activeTrace.testId === testId && activeTrace.stepId === stepId) {
            activeTrace.status = status === "failed" ? "failed" : "passed";
            activeTrace.durationMs = durationMs;
            activeTrace.message = message;
          }

          logEntries.push({
            kind: status === "failed" ? "result-fail" : "result-pass",
            title: `${status === "failed" ? "Step failed" : "Step passed"}: ${stepId} (${durationMs}ms)`,
            body: message ?? undefined,
          });
        }
        if (event.type === "test_finished") {
          const testId = String(event.data.test_id ?? "");
          const target = state.tests.find((test) => test.id === testId)
            ?? state.tests.find((test) => test.name === String(event.data.test_name ?? ""));
          if (target) {
            target.status = String(event.data.status ?? "completed");
            target.durationMs = Number(event.data.duration_ms ?? 0);
          }
          state.passed = state.tests.filter((test) => test.status === "passed").length;
          state.failed = state.tests.filter((test) => test.status === "failed").length;
        }
        if (event.type === "suite_finished") {
          state.suiteStatus = String(event.data.status ?? state.suiteStatus);
        }
        render();
      },
    });

    try {
      const markdownSource = await loadMarkdown(specPath);
      sourceMarkdownLines = markdownSource.split(/\r?\n/u);
      const raw = parseMarkdownToRaw(markdownSource);
      const lineMap = buildRawStepLineMap(markdownSource, raw);
      const isFreshCompiled = compiledPlanIsFresh(compiledPath, specPath);

      const createNormalizer = () => new SpecNormalizer({
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
            setSpinner("Normalizing test...");
          },
        },
      });

      const runProgressiveSuite = async (suite: TestSuite): Promise<SuiteResult> => {
        const startedAt = new Date();
        const results: TestResult[] = [];
        state.total = suite.tests.length;
        for (const test of suite.tests) {
          const singleSuite = ensureStableActionIds({
            ...suite,
            tests: [test],
          });
          const executor = new SuiteExecutor({ eventBus });
          const singleResult = await executor.runSuite(singleSuite, {
            output_dir: projectConfig.paths.results_dir,
            headless: state.headless,
          });
          results.push(...singleResult.tests);
        }

        const finishedAt = new Date();
        return {
          suite_id: suite.id,
          suite_name: suite.name,
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          duration_ms: finishedAt.getTime() - startedAt.getTime(),
          status: results.some((test) => test.status === "failed") ? "failed" : "passed",
          tests: results,
          warnings: [],
          artifacts_root: projectConfig.paths.results_dir,
        };
      };

      if (state.compileOnly) {
        startSpinner(isFreshCompiled ? "Loading compiled suite..." : "Normalizing suite...");
        const compiledSuite = isFreshCompiled
          ? testSuiteSchema.parse(stripCompiledMetadata(JSON.parse(readFileSync(compiledPath, "utf8"))))
          : await createNormalizer().normalize(raw);
        const suite = ensureStableActionIds(compiledSuite);
        stopSpinner();
        dropSpinnerEntry();
        state.spinnerActive = false;
        if (!isFreshCompiled) {
          writeCompiledPlan({ suites: [suite], destination: compiledPath, sourceSpec: specPath, sourceHash: fileSha256(specPath) });
          appendLog(`Compiled plan: ${compiledPath}`);
        } else {
          appendLog(`Reusing compiled plan: ${compiledPath}`);
        }
        stepTraceMap = buildStepTraceMap(suite, raw, lineMap);
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

      let suiteForExecution: TestSuite;
      let suiteResult: SuiteResult;

      if (isFreshCompiled) {
        suiteForExecution = ensureStableActionIds(
          testSuiteSchema.parse(stripCompiledMetadata(JSON.parse(readFileSync(compiledPath, "utf8")))),
        );
        appendLog(`Reusing compiled plan: ${compiledPath}`);
        stepTraceMap = buildStepTraceMap(suiteForExecution, raw, lineMap);
        render();
        suiteResult = await runProgressiveSuite(suiteForExecution);
      } else {
        const normalizer = createNormalizer();
        startSpinner("Normalizing setup and teardown...");
        const baseSuite = ensureStableActionIds(await normalizer.normalize({ ...raw, tests: [] }));
        stopSpinner();
        dropSpinnerEntry();
        state.spinnerActive = false;

        const translatedTests: TestSuite["tests"] = [];
        const startedAt = new Date();
        const testResults: TestResult[] = [];
        state.total = raw.tests.length;

        for (const [index, rawTest] of raw.tests.entries()) {
          startSpinner(`Normalizing test ${index + 1}/${raw.tests.length}...`);
          const partialRaw: RawSuiteDocument = {
            ...raw,
            setup_steps: [],
            teardown_steps: [],
            tests: [rawTest],
          };
          const partialSuite = ensureStableActionIds(await normalizer.normalize(partialRaw));
          const normalizedTest = partialSuite.tests[0];
          if (!normalizedTest) {
            throw new Error(`Failed to normalize test ${index + 1}.`);
          }
          translatedTests.push(normalizedTest);
          const previewSuite = ensureStableActionIds({ ...baseSuite, tests: [...translatedTests] });
          stepTraceMap = buildStepTraceMap(previewSuite, raw, lineMap);
          stopSpinner();
          dropSpinnerEntry();
          state.spinnerActive = false;
          appendLog(`Translated test ${index + 1}/${raw.tests.length}: ${normalizedTest.name}`);
          render();

          const executor = new SuiteExecutor({ eventBus });
          const singleResult = await executor.runSuite(ensureStableActionIds({ ...baseSuite, tests: [normalizedTest] }), {
            output_dir: projectConfig.paths.results_dir,
            headless: state.headless,
          });
          testResults.push(...singleResult.tests);
        }

        suiteForExecution = ensureStableActionIds({ ...baseSuite, tests: translatedTests });
        writeCompiledPlan({ suites: [suiteForExecution], destination: compiledPath, sourceSpec: specPath, sourceHash: fileSha256(specPath) });
        appendLog(`Compiled plan: ${compiledPath}`);
        const finishedAt = new Date();
        suiteResult = {
          suite_id: suiteForExecution.id,
          suite_name: suiteForExecution.name,
          started_at: startedAt.toISOString(),
          finished_at: finishedAt.toISOString(),
          duration_ms: finishedAt.getTime() - startedAt.getTime(),
          status: testResults.some((test) => test.status === "failed") ? "failed" : "passed",
          tests: testResults,
          warnings: [],
          artifacts_root: projectConfig.paths.results_dir,
        };
      }

      startSpinner("Writing reports...");
      const persistedPaths = await persistSuiteOutputs(suiteResult, projectConfig.paths.results_dir, compiledPath);
      stopSpinner();
      state.spinnerActive = false;
      dropSpinnerEntry();
      appendResult(suiteResult.status === "passed" ? "success" : "failure", `Suite ${suiteResult.status}`, [
        `Suite: ${suiteResult.suite_name}`,
        `Artifacts: ${suiteResult.artifacts_root}`,
        `Result JSON: ${persistedPaths.result_json}`,
        `Report MD: ${persistedPaths.report_md}`,
        `Report HTML: ${persistedPaths.report_html}`,
        `Summary JSON: ${persistedPaths.summary_json}`,
      ]);
      state.suiteStatus = suiteResult.status;
      state.lastRunSummary = `Last suite: ${suiteResult.suite_name}\nStatus: ${suiteResult.status}\nArtifacts: ${suiteResult.artifacts_root}`;
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

function stepTraceKey(testId: string, phase: "setup" | "step" | "teardown", stepId: string): string {
  return `${testId}::${phase}::${stepId}`;
}

function ensureStableActionIds(suite: TestSuite): TestSuite {
  return {
    ...suite,
    setup_steps: suite.setup_steps.map((action, index) => ensureActionId(action, `setup-${index + 1}`)),
    teardown_steps: suite.teardown_steps.map((action, index) => ensureActionId(action, `teardown-${index + 1}`)),
    tests: suite.tests.map((test) => ({
      ...test,
      steps: test.steps.map((action, index) => ensureActionId(action, `step-${index + 1}`)),
      expectations: test.expectations.map((expectation, index) => ({
        ...expectation,
        id: expectation.id ?? `expect-${index + 1}`,
      })),
    })),
  };
}

function ensureActionId(action: Action, fallbackId: string): Action {
  if (action.id) {
    return action;
  }
  return {
    ...action,
    id: fallbackId,
  } as Action;
}

function buildRawStepLineMap(markdownSource: string, raw: RawSuiteDocument): RawStepLineMap {
  const lines = markdownSource.split(/\r?\n/u);
  const headingByTestName = new Map<string, number>();
  const headingPattern = /^\s*#{1,6}\s*test:\s*(.+?)\s*$/iu;
  for (const [index, line] of lines.entries()) {
    const match = line.match(headingPattern);
    const headingName = match?.[1]?.trim().toLowerCase();
    if (headingName && !headingByTestName.has(headingName)) {
      headingByTestName.set(headingName, index + 1);
    }
  }

  const testHeadingLines = raw.tests.map((test) => headingByTestName.get(test.name.trim().toLowerCase()) ?? null);
  let cursor = 0;
  const setupLines = raw.setup_steps.map((step) => {
    const located = findSourceLine(lines, step, cursor);
    cursor = located.nextCursor;
    return located.line;
  });

  const testLines = raw.tests.map((test, testIndex) => {
    const headingLine = testHeadingLines[testIndex];
    if (headingLine && headingLine - 1 > cursor) {
      cursor = headingLine - 1;
    }
    return test.steps.map((step) => {
      const located = findSourceLine(lines, step, cursor);
      cursor = located.nextCursor;
      return located.line;
    });
  });

  const freeflowLines = raw.tests.map((test, testIndex) => {
    const freeflowPreview = summarizeFreeflow(test.freeflow_block ?? "");
    if (!freeflowPreview) {
      return null;
    }
    const headingLine = testHeadingLines[testIndex];
    const startCursor = headingLine && headingLine - 1 > cursor ? headingLine - 1 : cursor;
    const located = findSourceLine(lines, freeflowPreview, startCursor);
    return located.line;
  });

  const teardownLines = raw.teardown_steps.map((step) => {
    const located = findSourceLine(lines, step, cursor);
    cursor = located.nextCursor;
    return located.line;
  });

  return {
    testHeadingLines,
    setupLines,
    testLines,
    freeflowLines,
    teardownLines,
  };
}

function buildStepTraceMap(
  suite: TestSuite,
  raw: RawSuiteDocument,
  lineMap: RawStepLineMap,
): Map<string, StepTraceMeta> {
  const map = new Map<string, StepTraceMeta>();

  for (const [testIndex, test] of suite.tests.entries()) {
    const rawTest = raw.tests[testIndex];
    const headingLine = lineMap.testHeadingLines[testIndex] ?? null;

    for (const [setupIndex, action] of suite.setup_steps.entries()) {
      const line = lineMap.setupLines[setupIndex] ?? headingLine;
      const text = raw.setup_steps[setupIndex] ?? "(setup step)";
      const stepId = action.id ?? `setup-${setupIndex + 1}`;
      map.set(stepTraceKey(test.id, "setup", stepId), {
        testId: test.id,
        testName: test.name,
        phase: "setup",
        stepId,
        markdownLine: line,
        markdownText: text,
        action,
      });
    }

    for (const [stepIndex, action] of test.steps.entries()) {
      const line = lineMap.testLines[testIndex]?.[stepIndex] ?? lineMap.freeflowLines[testIndex] ?? headingLine;
      const freeflowFallback = summarizeFreeflow(rawTest?.freeflow_block ?? "");
      const text = rawTest?.steps[stepIndex] ?? freeflowFallback ?? `(step ${stepIndex + 1})`;
      const stepId = action.id ?? `step-${stepIndex + 1}`;
      map.set(stepTraceKey(test.id, "step", stepId), {
        testId: test.id,
        testName: test.name,
        phase: "step",
        stepId,
        markdownLine: line,
        markdownText: text,
        action,
      });
    }

    for (const [teardownIndex, action] of suite.teardown_steps.entries()) {
      const line = lineMap.teardownLines[teardownIndex] ?? headingLine;
      const text = raw.teardown_steps[teardownIndex] ?? "(teardown step)";
      const stepId = action.id ?? `teardown-${teardownIndex + 1}`;
      map.set(stepTraceKey(test.id, "teardown", stepId), {
        testId: test.id,
        testName: test.name,
        phase: "teardown",
        stepId,
        markdownLine: line,
        markdownText: text,
        action,
      });
    }
  }

  return map;
}

function findSourceLine(lines: string[], sourceText: string, cursor: number): { line: number | null; nextCursor: number } {
  const target = normalizeSourceLine(sourceText);
  if (!target) {
    return { line: null, nextCursor: cursor };
  }

  for (let index = cursor; index < lines.length; index += 1) {
    if (normalizeSourceLine(lines[index] ?? "") === target) {
      return { line: index + 1, nextCursor: index + 1 };
    }
  }

  for (let index = cursor; index < lines.length; index += 1) {
    const line = normalizeSourceLine(lines[index] ?? "");
    if ((line.length > 0 && line.includes(target)) || (line.length > 0 && target.includes(line))) {
      return { line: index + 1, nextCursor: index + 1 };
    }
  }

  return { line: null, nextCursor: cursor };
}

function normalizeSourceLine(value: string): string {
  return value
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/u, "")
    .replace(/^\s*>\s?/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function summarizeFreeflow(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const firstLine = trimmed.split(/\r?\n/u).find((line) => line.trim().length > 0)?.trim();
  if (!firstLine) {
    return null;
  }
  const cleaned = firstLine.replace(/^test:\s*.+?(?=\b(open|click|go|navigate|fill|enter|wait)\b)/iu, "").trim();
  if (cleaned) {
    return cleaned;
  }
  return firstLine ?? null;
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
