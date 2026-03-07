import { z } from "zod";

import { actionKinds, readinessModes, waitTypes } from "./enums";
import { targetHintSchema } from "./selector";

const actionBaseSchema = z
  .object({
    id: z.string().optional(),
    timeout_ms: z.number().int().min(1).optional(),
  })
  .strict();

const navigationActionSchema = actionBaseSchema
  .extend({
    kind: z.enum(actionKinds.slice(0, 4) as [string, ...string[]]),
    url: z.string().optional(),
    readiness: z.enum(readinessModes).default("domcontentloaded"),
    readiness_target: targetHintSchema.optional(),
    readiness_text: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "goto" && !value.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`goto` requires `url`." });
    }
    if (value.kind !== "goto" && value.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Only `goto` may set `url`." });
    }
    if (value.readiness === "locator_visible" && !value.readiness_target) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`locator_visible` readiness requires `readiness_target`.",
      });
    }
    if (value.readiness === "text_visible" && !value.readiness_text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`text_visible` readiness requires `readiness_text`.",
      });
    }
  });

const targetedActionSchema = actionBaseSchema.extend({
  kind: z.enum(["click", "double_click", "right_click", "hover", "focus", "blur"]),
  target: targetHintSchema,
});

const fillActionSchema = actionBaseSchema.extend({
  kind: z.literal("fill"),
  target: targetHintSchema,
  value: z.string(),
  append: z.boolean().default(false),
  secret: z.boolean().default(false),
});

const waitForActionSchema = actionBaseSchema
  .extend({
    kind: z.literal("wait_for"),
    wait_type: z.enum(waitTypes),
    value: z.string().optional(),
    target: targetHintSchema.optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    status_code: z.number().int().min(100).max(599).optional(),
    duration_ms: z.number().int().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if ((value.wait_type === "url" || value.wait_type === "text") && !value.value) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "URL/TEXT waits require `value`." });
    }
    if (value.wait_type === "locator" && !value.target) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "LOCATOR waits require `target`." });
    }
    if ((value.wait_type === "request" || value.wait_type === "response") && (!value.method || !value.path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "REQUEST/RESPONSE waits require `method` and `path`.",
      });
    }
    if (value.wait_type === "timeout" && value.duration_ms === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TIMEOUT waits require `duration_ms`." });
    }
  });

const commentActionSchema = actionBaseSchema.extend({
  kind: z.literal("comment"),
  text: z.string(),
});

export const actionSchema = z.discriminatedUnion("kind", [
  navigationActionSchema,
  targetedActionSchema,
  fillActionSchema,
  waitForActionSchema,
  commentActionSchema,
]);

export type Action = z.infer<typeof actionSchema>;
