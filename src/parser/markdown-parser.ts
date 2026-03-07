import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

import { rawSuiteDocumentSchema, rawTestCaseSchema, type RawSuiteDocument, type RawTestCase } from "./raw-models";

type HeadingInfo = {
  tokenIndex: number;
  level: number;
  title: string;
};

export function parseMarkdownToRaw(markdown: string): RawSuiteDocument {
  const parser = new MarkdownIt("commonmark");
  const tokens = parser.parse(markdown, {});
  const headings = collectHeadings(tokens);

  const suite = rawSuiteDocumentSchema.parse({ name: extractSuiteName(headings) });

  headings.forEach((heading, index) => {
    if (heading.level !== 2) {
      return;
    }

    const sectionTitle = heading.title.trim();
    const sectionKey = sectionTitle.toLowerCase();
    const sectionEnd = sectionKey.startsWith("test:")
      ? sectionEndForTest(headings, index, tokens.length)
      : sectionEndForHeading(headings, index, tokens.length);

    if (sectionKey === "config") {
      Object.assign(suite.config, extractKeyValues(tokens, heading.tokenIndex, sectionEnd));
      return;
    }
    if (sectionKey === "variables") {
      Object.assign(suite.variables, extractKeyValues(tokens, heading.tokenIndex, sectionEnd));
      return;
    }
    if (sectionKey === "setup") {
      suite.setup_steps.push(...extractSectionItems(tokens, heading.tokenIndex, sectionEnd));
      return;
    }
    if (sectionKey === "teardown") {
      suite.teardown_steps.push(...extractSectionItems(tokens, heading.tokenIndex, sectionEnd));
      return;
    }
    if (sectionKey.startsWith("test:")) {
      suite.tests.push(parseTestSection(sectionTitle, heading.tokenIndex, sectionEnd, tokens, headings));
    }
  });

  return rawSuiteDocumentSchema.parse(suite);
}

function collectHeadings(tokens: Token[]): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  tokens.forEach((token, index) => {
    if (token.type !== "heading_open") {
      return;
    }
    const inlineToken = tokens[index + 1];
    headings.push({
      tokenIndex: index,
      level: Number.parseInt(token.tag.slice(1), 10),
      title: inlineToken?.content.trim() ?? "",
    });
  });
  return headings;
}

function extractSuiteName(headings: HeadingInfo[]): string {
  const firstHeading = headings.find((heading) => heading.level === 1);
  if (!firstHeading) {
    return "Unnamed Suite";
  }
  if (firstHeading.title.toLowerCase().startsWith("suite:")) {
    return firstHeading.title.split(":", 2)[1]?.trim() || "Unnamed Suite";
  }
  return firstHeading.title || "Unnamed Suite";
}

function sectionEndForHeading(headings: HeadingInfo[], index: number, fallback: number): number {
  const current = headings[index];
  if (!current) {
    return fallback;
  }

  for (const nextHeading of headings.slice(index + 1)) {
    if (nextHeading.level <= current.level) {
      return nextHeading.tokenIndex;
    }
  }
  return fallback;
}

function sectionEndForTest(headings: HeadingInfo[], index: number, fallback: number): number {
  const topLevelKeys = new Set(["config", "variables", "dataset", "setup", "teardown", "reuse"]);
  for (const nextHeading of headings.slice(index + 1)) {
    const lowered = nextHeading.title.trim().toLowerCase();
    if (nextHeading.level === 1 && lowered.startsWith("suite:")) {
      return nextHeading.tokenIndex;
    }
    if (nextHeading.level !== 2) {
      continue;
    }
    if (lowered.startsWith("test:") || topLevelKeys.has(lowered)) {
      return nextHeading.tokenIndex;
    }
  }
  return fallback;
}

function extractKeyValues(tokens: Token[], sectionStart: number, sectionEnd: number): Record<string, string> {
  const keyValues: Record<string, string> = {};
  for (const line of extractSectionItems(tokens, sectionStart, sectionEnd)) {
    if (!line.includes(":")) {
      continue;
    }
    const [key, ...rest] = line.split(":");
    keyValues[key.trim()] = rest.join(":").trim();
  }
  return keyValues;
}

function extractSectionItems(tokens: Token[], sectionStart: number, sectionEnd: number): string[] {
  const listItems = extractListItems(tokens, sectionStart, sectionEnd);
  return listItems.length > 0 ? listItems : extractInlineLines(tokens, sectionStart, sectionEnd);
}

function extractListItems(tokens: Token[], start: number, end: number): string[] {
  const items: string[] = [];
  let collecting = false;
  let currentParts: string[] = [];

  for (const token of tokens.slice(start, end)) {
    if (token.type === "list_item_open") {
      collecting = true;
      currentParts = [];
      continue;
    }
    if (token.type === "list_item_close") {
      const text = currentParts.filter(Boolean).join(" ").trim();
      if (text) {
        items.push(text);
      }
      collecting = false;
      currentParts = [];
      continue;
    }
    if (collecting && token.type === "inline") {
      currentParts.push(token.content.trim());
    }
  }

  return items;
}

function extractInlineLines(tokens: Token[], start: number, end: number): string[] {
  const lines: string[] = [];
  for (const token of tokens.slice(start, end)) {
    if (token.type !== "inline") {
      continue;
    }
    for (const line of token.content.split(/\r?\n/u)) {
      const cleaned = line.trim();
      if (cleaned) {
        lines.push(cleaned);
      }
    }
  }
  return lines;
}

function parseTestSection(
  sectionTitle: string,
  sectionStart: number,
  sectionEnd: number,
  tokens: Token[],
  headings: HeadingInfo[],
): RawTestCase {
  const rawTest = rawTestCaseSchema.parse({
    name: sectionTitle.split(":", 2)[1]?.trim() ?? sectionTitle,
    raw_block: extractInlineLines(tokens, sectionStart, sectionEnd).join("\n"),
  });

  const subsectionHeadings = headings
    .filter(
      (heading) =>
        heading.tokenIndex > sectionStart &&
        heading.tokenIndex < sectionEnd &&
        normalizeTestSubsectionKey(heading.title) !== null,
    )
    .sort((left, right) => left.tokenIndex - right.tokenIndex);

  if (subsectionHeadings.length === 0) {
    const [steps, expectations] = splitStepsAndExpectations(extractSectionItems(tokens, sectionStart, sectionEnd));
    rawTest.steps = steps;
    rawTest.expectations = expectations;
    return rawTestCaseSchema.parse(rawTest);
  }

  subsectionHeadings.forEach((heading, index) => {
    const subsectionEnd = subsectionHeadings[index + 1]?.tokenIndex ?? sectionEnd;
    const items = extractSectionItems(tokens, heading.tokenIndex, subsectionEnd);
    const key = normalizeTestSubsectionKey(heading.title);

    if (key === "steps") {
      rawTest.steps.push(...items);
    } else if (key === "expectations") {
      rawTest.expectations.push(...items);
    } else if (key === "tags") {
      rawTest.tags.push(...parseTagItems(items));
    } else if (key === "preconditions") {
      rawTest.preconditions.push(...items);
    } else if (key === "notes") {
      rawTest.notes.push(...items);
    } else if (key === "retrypolicy") {
      Object.assign(rawTest.retry_policy, parseKeyValuesFromItems(items));
    }
  });

  if (rawTest.expectations.length === 0 && rawTest.steps.length > 0) {
    const [steps, expectations] = splitStepsAndExpectations(rawTest.steps);
    rawTest.steps = steps;
    rawTest.expectations = expectations;
  }

  return rawTestCaseSchema.parse(rawTest);
}

function normalizeTestSubsectionKey(title: string): string | null {
  const key = title.trim().toLowerCase();
  if (!key) {
    return null;
  }
  if (key.includes("step")) {
    return "steps";
  }
  if (key.includes("expect") || key.includes("assert")) {
    return "expectations";
  }
  if (key.includes("tag")) {
    return "tags";
  }
  if (key.includes("precondition")) {
    return "preconditions";
  }
  if (key === "note" || key === "notes") {
    return "notes";
  }
  if (key.includes("retry")) {
    return "retrypolicy";
  }
  return null;
}

function splitStepsAndExpectations(items: string[]): [string[], string[]] {
  const steps: string[] = [];
  const expectations: string[] = [];
  let mode: "steps" | "expect" = "steps";

  for (const item of items) {
    const cleaned = item.trim();
    const lower = cleaned.toLowerCase();
    if (!cleaned) {
      continue;
    }

    if (lower === "steps" || lower === "step") {
      mode = "steps";
      continue;
    }
    if (["expect", "expectation", "expectations", "assert", "assertions"].includes(lower)) {
      mode = "expect";
      continue;
    }
    if (/^(expect|expectation|expectations|assert):/u.test(lower)) {
      mode = "expect";
      const content = cleaned.split(":", 2)[1]?.trim();
      if (content) {
        expectations.push(content);
      }
      continue;
    }

    if (mode === "expect" || looksLikeExpectationLine(lower)) {
      expectations.push(cleaned);
    } else {
      steps.push(cleaned);
    }
  }

  if (expectations.length > 0) {
    return [steps, expectations];
  }

  const inferredSteps: string[] = [];
  const inferredExpectations: string[] = [];
  for (const step of steps) {
    if (looksLikeExpectationLine(step.toLowerCase())) {
      inferredExpectations.push(step);
    } else {
      inferredSteps.push(step);
    }
  }
  return inferredExpectations.length > 0 ? [inferredSteps, inferredExpectations] : [steps, expectations];
}

function looksLikeExpectationLine(text: string): boolean {
  const prefixes = [
    "url should",
    "text ",
    "the ",
    "a request ",
    "request ",
    "response ",
    "no navigation",
    "title should",
  ];
  return prefixes.some((prefix) => text.startsWith(prefix)) && text.includes("should");
}

function parseTagItems(items: string[]): string[] {
  return items.flatMap((item) =>
    item
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function parseKeyValuesFromItems(items: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const item of items) {
    if (!item.includes(":")) {
      continue;
    }
    const [key, ...rest] = item.split(":");
    values[key.trim()] = rest.join(":").trim();
  }
  return values;
}
