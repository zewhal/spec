import { z } from "zod";

import { actionSchema } from "./action";
import { expectationSchema } from "./expectation";

export const artifactPolicySchema = z
  .object({
    capture_on_step: z.boolean().default(false),
    capture_on_failure: z.boolean().default(true),
    capture_console: z.boolean().default(true),
    capture_network: z.boolean().default(true),
    capture_trace: z.boolean().default(false),
    capture_video: z.boolean().default(false),
  })
  .strict();

export const runtimePolicySchema = z
  .object({
    default_timeout_ms: z.number().int().min(1).default(10_000),
    assertion_timeout_ms: z.number().int().min(1).default(10_000),
    locator_resolution_timeout_ms: z.number().int().min(1).default(5_000),
    navigation_timeout_ms: z.number().int().min(1).default(30_000),
    max_retries: z.number().int().min(0).default(0),
    retry_on_flake: z.boolean().default(false),
    strict_mode: z.boolean().default(true),
  })
  .strict();

export const retryPolicySchema = z
  .object({
    max_retries: z.number().int().min(0).default(0),
    retry_on_flake: z.boolean().default(false),
  })
  .strict();

export const timeoutPolicySchema = z
  .object({
    test_timeout_ms: z.number().int().min(1).nullable().default(null),
    navigation_timeout_ms: z.number().int().min(1).nullable().default(null),
    assertion_timeout_ms: z.number().int().min(1).nullable().default(null),
  })
  .strict();

export const testCaseSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().default(null),
    tags: z.array(z.string()).default([]),
    preconditions: z.array(z.string()).default([]),
    steps: z.array(actionSchema).default([]),
    expectations: z.array(expectationSchema).default([]),
    priority: z.string().default("normal"),
    retry_policy: retryPolicySchema.default({}),
    timeout_policy: timeoutPolicySchema.default({}),
    data_binding: z.string().nullable().default(null),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.enabled && value.steps.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Test '${value.name}' must contain at least one step.`,
      });
    }
  });

export const testSuiteSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    base_url: z.string(),
    browser: z.string().default("chromium"),
    viewport: z.string().default("desktop"),
    locale: z.string().default("en-US"),
    variables: z.record(z.string(), z.string()).default({}),
    datasets: z.record(z.string(), z.array(z.record(z.string(), z.string()))).default({}),
    tests: z.array(testCaseSchema).default([]),
    setup_steps: z.array(actionSchema).default([]),
    teardown_steps: z.array(actionSchema).default([]),
    artifact_policy: artifactPolicySchema.default({}),
    runtime_policy: runtimePolicySchema.default({}),
    allowed_subdomains: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const test of value.tests) {
      if (seen.has(test.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate test id found: '${test.id}'.`,
        });
      }
      seen.add(test.id);
    }
  });

export type ArtifactPolicy = z.infer<typeof artifactPolicySchema>;
export type RuntimePolicy = z.infer<typeof runtimePolicySchema>;
export type RetryPolicy = z.infer<typeof retryPolicySchema>;
export type TimeoutPolicy = z.infer<typeof timeoutPolicySchema>;
export type TestCase = z.infer<typeof testCaseSchema>;
export type TestSuite = z.infer<typeof testSuiteSchema>;
