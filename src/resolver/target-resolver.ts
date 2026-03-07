import type { Frame, Locator, Page } from "playwright";

import type { ResolutionConfidence } from "../models/enums";
import type { ResolverDecision } from "../models/result";
import type { TargetHint } from "../models/selector";

export class TargetResolutionError extends Error {}

export class TargetResolver {
  async resolve(page: Page, target: TargetHint, strictMode: boolean, timeoutMs: number): Promise<{ locator: Locator; decision: ResolverDecision }> {
    const scope = this.resolveScope(page, target);
    const candidates = this.buildCandidates(scope, target);
    const errors: string[] = [];

    for (const candidateInfo of candidates) {
      if (strictMode && !["exact", "high"].includes(candidateInfo.confidence)) {
        errors.push(`Rejected ${candidateInfo.strategy} in strict mode (${candidateInfo.confidence}).`);
        continue;
      }

      const candidate = target.nth !== undefined ? candidateInfo.locator.nth(target.nth) : candidateInfo.locator;
      const probe = target.nth !== undefined ? candidate : candidate.first();
      const waitState = target.require_visible === false ? "attached" : "visible";

      try {
        await probe.waitFor({ state: waitState, timeout: timeoutMs });
      } catch {
        errors.push(`${candidateInfo.strategy} failed waitFor(state=${waitState}).`);
        continue;
      }

      const count = await candidate.count();
      if (count === 0) {
        errors.push(`${candidateInfo.strategy} matched zero nodes.`);
        continue;
      }
      if (count > 1 && target.nth === undefined) {
        errors.push(`${candidateInfo.strategy} matched ${count} nodes and no index was provided.`);
        continue;
      }

      return {
        locator: target.nth !== undefined ? candidate : candidate.first(),
        decision: {
          strategy: candidateInfo.strategy,
          selector: this.describeSelector(candidateInfo.strategy, target),
          confidence: candidateInfo.confidence as ResolutionConfidence,
          details: `Resolved with ${candidateInfo.strategy} and count=${count}.`,
        },
      };
    }

    throw new TargetResolutionError(
      `Unable to resolve target '${target.human_label ?? target.exact_text ?? "unknown"}': ${errors.join(" | ") || "No candidate selectors were produced."}`,
    );
  }

  private resolveScope(page: Page, target: TargetHint): Page | Frame {
    if (!target.frame_hint) {
      return page;
    }
    const byName = page.frame({ name: target.frame_hint });
    if (byName) {
      return byName;
    }
    const hint = target.frame_hint.toLowerCase();
    for (const frame of page.frames()) {
      if (frame.name().toLowerCase().includes(hint) || frame.url().toLowerCase().includes(hint)) {
        return frame;
      }
    }
    throw new TargetResolutionError(`Unable to locate frame matching hint '${target.frame_hint}'.`);
  }

  private buildCandidates(scope: Page | Frame, target: TargetHint): Array<{ strategy: string; confidence: string; locator: Locator }> {
    const candidates: Array<{ strategy: string; confidence: string; locator: Locator }> = [];
    if (target.test_id) {
      candidates.push({ strategy: "test_id", confidence: "exact", locator: scope.getByTestId(target.test_id) });
    }
    if (target.role) {
      const roleName = target.exact_text ?? target.label_text ?? target.human_label;
      const role = target.role as Parameters<Page["getByRole"]>[0];
      candidates.push({
        strategy: roleName ? "role_name" : "role_only",
        confidence: roleName ? "high" : "medium",
        locator: roleName ? scope.getByRole(role, { name: roleName }) : scope.getByRole(role),
      });
    }
    if (target.label_text) {
      candidates.push({ strategy: "label", confidence: "high", locator: scope.getByLabel(target.label_text) });
    }
    if (target.placeholder) {
      candidates.push({ strategy: "placeholder", confidence: "high", locator: scope.getByPlaceholder(target.placeholder) });
    }
    const semanticSelector = this.semanticFieldSelector(target);
    if (semanticSelector) {
      candidates.push({ strategy: "semantic_field", confidence: "high", locator: scope.locator(semanticSelector) });
    }
    if (target.label_text) {
      const escaped = this.escapeCssValue(target.label_text);
      candidates.push({
        strategy: "name_or_id",
        confidence: "high",
        locator: scope.locator(`input[name="${escaped}"], textarea[name="${escaped}"], input[id="${escaped}"], textarea[id="${escaped}"]`),
      });
    }
    if (target.exact_text) {
      candidates.push({ strategy: "text_exact", confidence: "medium", locator: scope.getByText(target.exact_text, { exact: true }) });
    }
    if (target.human_label && target.human_label !== target.exact_text) {
      candidates.push({ strategy: "text_human_label", confidence: "medium", locator: scope.getByText(target.human_label) });
    }
    if (target.css) {
      candidates.push({ strategy: "css", confidence: "low", locator: scope.locator(target.css) });
    }
    if (target.xpath) {
      candidates.push({ strategy: "xpath", confidence: "low", locator: scope.locator(target.xpath) });
    }
    return candidates;
  }

  private describeSelector(strategy: string, target: TargetHint): string {
    const mapping: Record<string, string | undefined> = {
      test_id: target.test_id,
      role_name: `role=${target.role}, name=${target.exact_text ?? target.label_text ?? target.human_label}`,
      role_only: `role=${target.role}`,
      label: target.label_text,
      placeholder: target.placeholder,
      semantic_field: target.human_label ?? target.label_text,
      name_or_id: target.label_text,
      text_exact: target.exact_text,
      text_human_label: target.human_label,
      css: target.css,
      xpath: target.xpath,
    };
    return `${strategy}:${mapping[strategy] ?? target.human_label ?? "unknown"}${target.nth !== undefined ? ` [nth=${target.nth}]` : ""}`;
  }

  private escapeCssValue(value: string): string {
    return value.replaceAll('"', '\\"');
  }

  private semanticFieldSelector(target: TargetHint): string | undefined {
    const text = [target.human_label ?? "", target.label_text ?? "", target.placeholder ?? ""].join(" ").toLowerCase();
    if (text.includes("password")) {
      return 'input[type="password"], input[name*="password" i], input[id*="password" i], input[autocomplete="current-password"], input[autocomplete="new-password"]';
    }
    if (text.includes("email") || text.includes("username") || text.includes("user name")) {
      return 'input[type="email"], input[name*="email" i], input[id*="email" i], input[autocomplete="username"], input[name*="user" i], input[id*="user" i]';
    }
    return undefined;
  }
}
