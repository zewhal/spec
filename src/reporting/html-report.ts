import { mkdirSync } from "node:fs";
import path from "node:path";

import type { SuiteResult } from "../models/result";

export function renderHtmlReport(result: SuiteResult): string {
  const rows = result.tests
    .map(
      (test) => `
        <tr>
          <td>${escapeHtml(test.test_name)}</td>
          <td class="${test.status}">${escapeHtml(test.status)}</td>
          <td>${test.duration_ms}ms</td>
          <td>${escapeHtml(test.final_url ?? "n/a")}</td>
        </tr>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>QA Report - ${escapeHtml(result.suite_name)}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; }
      h1, h2, h3 { margin-top: 1.5rem; }
      table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
      th, td { border: 1px solid #ddd; padding: 0.5rem; text-align: left; }
      .passed { color: #0f766e; font-weight: 600; }
      .failed { color: #b91c1c; font-weight: 600; }
      .muted { color: #6b7280; }
    </style>
  </head>
  <body>
    <h1>QA Report: ${escapeHtml(result.suite_name)}</h1>
    <p>
      Status:
      <span class="${escapeHtml(result.status)}">${escapeHtml(result.status)}</span>
      <span class="muted">(duration: ${result.duration_ms}ms)</span>
    </p>

    <h2>Tests</h2>
    <table>
      <thead>
        <tr>
          <th>Test</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Final URL</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </body>
</html>`;
}

export async function writeHtmlReport(result: SuiteResult, filePath: string): Promise<void> {
  mkdirSync(path.dirname(filePath), { recursive: true });
  await Bun.write(filePath, renderHtmlReport(result));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
