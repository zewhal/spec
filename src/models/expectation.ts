import { z } from "zod";

import { targetHintSchema } from "./selector";

const expectationBaseSchema = z
  .object({
    id: z.string().optional(),
    timeout_ms: z.number().int().min(1).optional(),
    soft: z.boolean().default(false),
  })
  .strict();

const urlExpectationSchema = expectationBaseSchema.extend({
  kind: z.enum(["url_is", "url_contains"]),
  value: z.string(),
});

const textExpectationSchema = expectationBaseSchema.extend({
  kind: z.enum(["text_visible", "text_not_visible"]),
  text: z.string(),
  container: targetHintSchema.optional(),
});

const elementStateExpectationSchema = expectationBaseSchema.extend({
  kind: z.enum([
    "element_visible",
    "element_hidden",
    "element_enabled",
    "element_disabled",
    "element_checked",
    "element_unchecked",
    "focus_on",
    "in_viewport",
  ]),
  target: targetHintSchema,
});

const requestSeenExpectationSchema = expectationBaseSchema.extend({
  kind: z.literal("request_seen"),
  method: z.string(),
  path: z.string(),
});

export const expectationSchema = z.discriminatedUnion("kind", [
  urlExpectationSchema,
  textExpectationSchema,
  elementStateExpectationSchema,
  requestSeenExpectationSchema,
]);

export type Expectation = z.infer<typeof expectationSchema>;
