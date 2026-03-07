import { mkdirSync } from "node:fs";
import path from "node:path";

import type { SuiteResult } from "../models/result";

export function renderMarkdownReport(result: SuiteResult): string {
  const totalTests = result.tests.length;
  const passedTests = result.tests.filter((test) => test.status === "passed").length;
  const failedTests = result.tests.filter((test) => test.status === "failed").length;

  const lines: string[] = [
    `# QA Report: ${result.suite_name}`,
    "",
    "## Summary",
    `- Suite ID: \`${result.suite_id}\``,
    `- Status: **${result.status}**`,
    `- Tests: ${totalTests} total / ${passedTests} passed / ${failedTests} failed`,
    `- Duration: ${result.duration_ms}ms`,
    `- Artifacts root: \`${result.artifacts_root}\``,
    "",
    "## Test Results",
  ];

  for (const test of result.tests) {
    lines.push(`### ${test.test_name} (\`${test.test_id}\`)`);
    lines.push(`- Status: **${test.status}**`);
    lines.push(`- Duration: ${test.duration_ms}ms`);
    lines.push(`- Final URL: \`${test.final_url ?? "n/a"}\``);
    if (test.warnings.length > 0) {
      lines.push(`- Warnings: ${test.warnings.join("; ")}`);
    }
    if (test.steps.length > 0) {
      lines.push("- Steps:");
      for (const step of test.steps) {
        const marker = step.status === "passed" ? "PASS" : "FAIL";
        const detail = step.message ? ` (${step.message})` : "";
        lines.push(`  - [${marker}] \`${step.step_id}\` \`${step.action_kind}\`${detail}`);
      }
    }
    if (test.expectations.length > 0) {
      lines.push("- Expectations:");
      for (const expectation of test.expectations) {
        const marker = expectation.status === "passed" ? "PASS" : "FAIL";
        const detail = expectation.message ? ` (${expectation.message})` : "";
        lines.push(`  - [${marker}] \`${expectation.kind}\`${detail}`);
      }
    }
    if (test.artifacts.length > 0) {
      lines.push("- Artifacts:");
      for (const artifact of test.artifacts) {
        lines.push(`  - \`${artifact}\``);
      }
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeMarkdownReport(result: SuiteResult, filePath: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, renderMarkdownReport(result));
}
