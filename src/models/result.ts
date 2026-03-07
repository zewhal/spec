import { z } from "zod";

import { failureClasses, resolutionConfidences, stepStatuses, testStatuses } from "./enums";

export const resolverDecisionSchema = z
  .object({
    strategy: z.string(),
    selector: z.string(),
    confidence: z.enum(resolutionConfidences),
    details: z.string().nullable().default(null),
  })
  .strict();

export const networkRequestLogSchema = z
  .object({
    method: z.string(),
    url: z.string(),
    resource_type: z.string().nullable().default(null),
    timestamp: z.string().datetime(),
  })
  .strict();

export const networkResponseLogSchema = z
  .object({
    method: z.string(),
    url: z.string(),
    status: z.number().int().nullable().default(null),
    timestamp: z.string().datetime(),
  })
  .strict();

export const stepResultSchema = z
  .object({
    step_id: z.string(),
    action_kind: z.string(),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
    duration_ms: z.number().int(),
    status: z.enum(stepStatuses),
    failure_class: z.enum(failureClasses).nullable().default(null),
    message: z.string().nullable().default(null),
    url_before: z.string().nullable().default(null),
    url_after: z.string().nullable().default(null),
    screenshot_path: z.string().nullable().default(null),
    resolver_decision: resolverDecisionSchema.nullable().default(null),
  })
  .strict();

export const expectationResultSchema = z
  .object({
    expectation_id: z.string(),
    kind: z.string(),
    status: z.enum(stepStatuses),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
    duration_ms: z.number().int(),
    failure_class: z.enum(failureClasses).nullable().default(null),
    message: z.string().nullable().default(null),
    soft: z.boolean().default(false),
  })
  .strict();

export const testResultSchema = z
  .object({
    suite_id: z.string(),
    test_id: z.string(),
    test_name: z.string(),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
    duration_ms: z.number().int(),
    status: z.enum(testStatuses),
    steps: z.array(stepResultSchema).default([]),
    expectations: z.array(expectationResultSchema).default([]),
    artifacts: z.array(z.string()).default([]),
    warnings: z.array(z.string()).default([]),
    console_messages: z.array(z.string()).default([]),
    page_errors: z.array(z.string()).default([]),
    requests: z.array(networkRequestLogSchema).default([]),
    responses: z.array(networkResponseLogSchema).default([]),
    final_url: z.string().nullable().default(null),
  })
  .strict();

export const suiteResultSchema = z
  .object({
    suite_id: z.string(),
    suite_name: z.string(),
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
    duration_ms: z.number().int(),
    status: z.enum(testStatuses),
    tests: z.array(testResultSchema).default([]),
    warnings: z.array(z.string()).default([]),
    artifacts_root: z.string(),
  })
  .strict();

export type ResolverDecision = z.infer<typeof resolverDecisionSchema>;
export type NetworkRequestLog = z.infer<typeof networkRequestLogSchema>;
export type NetworkResponseLog = z.infer<typeof networkResponseLogSchema>;
export type StepResult = z.infer<typeof stepResultSchema>;
export type ExpectationResult = z.infer<typeof expectationResultSchema>;
export type TestResult = z.infer<typeof testResultSchema>;
export type SuiteResult = z.infer<typeof suiteResultSchema>;
