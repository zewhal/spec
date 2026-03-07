import { z } from "zod";

export const rawTestCaseSchema = z
  .object({
    name: z.string(),
    authoring_mode: z.enum(["auto", "fixed", "freeflow"]).default("auto"),
    tags: z.array(z.string()).default([]),
    preconditions: z.array(z.string()).default([]),
    steps: z.array(z.string()).default([]),
    expectations: z.array(z.string()).default([]),
    raw_block: z.string().default(""),
    freeflow_block: z.string().default(""),
    notes: z.array(z.string()).default([]),
    retry_policy: z.record(z.string(), z.string()).default({}),
  })
  .strict();

export const rawSuiteDocumentSchema = z
  .object({
    name: z.string(),
    config: z.record(z.string(), z.string()).default({}),
    variables: z.record(z.string(), z.string()).default({}),
    datasets: z.record(z.string(), z.array(z.record(z.string(), z.string()))).default({}),
    setup_steps: z.array(z.string()).default([]),
    teardown_steps: z.array(z.string()).default([]),
    tests: z.array(rawTestCaseSchema).default([]),
  })
  .strict();

export type RawTestCase = z.infer<typeof rawTestCaseSchema>;
export type RawSuiteDocument = z.infer<typeof rawSuiteDocumentSchema>;
