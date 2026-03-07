import { expect } from "@playwright/test";
import type { Locator, Page } from "playwright";

import type { Expectation } from "../models/expectation";
import type { ResolverDecision } from "../models/result";
import { TargetResolver } from "../resolver/target-resolver";
import { BrowserObserver } from "../runtime/observer";

export class UnsupportedExpectationError extends Error {}

export class AssertionEngine {
  constructor(readonly resolver: TargetResolver) {}

  async evaluate(page: Page, expectation: Expectation, observer: BrowserObserver, strictMode: boolean, timeoutMs: number): Promise<{ message: string | null; resolverDecision: ResolverDecision | null }> {
    if (expectation.kind === "url_is") {
      const value = expectation.value.trim();
      if (value.startsWith("/")) {
        await expect(page).toHaveURL(new RegExp(`${escapeRegex(value)}$`), { timeout: timeoutMs });
      } else {
        await expect(page).toHaveURL(value, { timeout: timeoutMs });
      }
      return { message: null, resolverDecision: null };
    }

    if (expectation.kind === "url_contains") {
      await expect(page).toHaveURL(new RegExp(escapeRegex(expectation.value.trim())), { timeout: timeoutMs });
      return { message: null, resolverDecision: null };
    }

    if (expectation.kind === "text_visible" || expectation.kind === "text_not_visible") {
      const locator = expectation.container
        ? (await this.resolver.resolve(page, expectation.container, strictMode, timeoutMs)).locator.getByText(expectation.text)
        : page.getByText(expectation.text);
      if (expectation.kind === "text_visible") {
        await expect(locator.first()).toBeVisible({ timeout: timeoutMs });
      } else {
        await expect(locator).toBeHidden({ timeout: timeoutMs });
      }
      return { message: null, resolverDecision: null };
    }

    if (
      expectation.kind === "element_visible" ||
      expectation.kind === "element_hidden" ||
      expectation.kind === "element_enabled" ||
      expectation.kind === "element_disabled" ||
      expectation.kind === "element_checked" ||
      expectation.kind === "element_unchecked" ||
      expectation.kind === "focus_on" ||
      expectation.kind === "in_viewport"
    ) {
      const { locator, decision } = await this.resolver.resolve(page, expectation.target, strictMode, timeoutMs);
      await this.assertElementState(locator, expectation.kind, timeoutMs);
      return { message: null, resolverDecision: decision };
    }

    if (expectation.kind === "request_seen") {
      const seen = await waitUntil(() => observer.hasRequest(expectation.method, expectation.path), timeoutMs);
      if (!seen) {
        throw new Error(`Expected request ${expectation.method} ${expectation.path} was not observed.`);
      }
      return { message: null, resolverDecision: null };
    }

    if (expectation.kind === "console_clean") {
      const errorConsole = observer.console_messages.filter((line) => line.toLowerCase().startsWith("error"));
      if (observer.page_errors.length > 0) {
        throw new Error(`Page errors detected: ${observer.page_errors.join("; ")}`);
      }
      if (errorConsole.length > 0) {
        throw new Error(`Console errors detected: ${errorConsole.join("; ")}`);
      }
      return { message: null, resolverDecision: null };
    }

    if (expectation.kind === "page_error_absent") {
      if (observer.page_errors.length > 0) {
        throw new Error(`Unhandled page errors detected: ${observer.page_errors.join("; ")}`);
      }
      return { message: null, resolverDecision: null };
    }

    throw new UnsupportedExpectationError(`Expectation kind '${expectation.kind}' is not supported in MVP.`);
  }

  private async assertElementState(locator: Locator, kind: Expectation["kind"], timeoutMs: number): Promise<void> {
    if (kind === "element_visible") return expect(locator).toBeVisible({ timeout: timeoutMs });
    if (kind === "element_hidden") return expect(locator).toBeHidden({ timeout: timeoutMs });
    if (kind === "element_enabled") return expect(locator).toBeEnabled({ timeout: timeoutMs });
    if (kind === "element_disabled") return expect(locator).toBeDisabled({ timeout: timeoutMs });
    if (kind === "element_checked") return expect(locator).toBeChecked({ timeout: timeoutMs });
    if (kind === "element_unchecked") return expect(locator).not.toBeChecked({ timeout: timeoutMs });
    if (kind === "focus_on") return expect(locator).toBeFocused({ timeout: timeoutMs });
    if (kind === "in_viewport") return expect(locator).toBeInViewport({ timeout: timeoutMs });
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs: number = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await Bun.sleep(intervalMs);
  }
  return predicate();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
