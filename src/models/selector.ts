import { z } from "zod";

export const targetHintSchema = z
  .object({
    human_label: z.string().optional(),
    exact_text: z.string().optional(),
    role: z.string().optional(),
    placeholder: z.string().optional(),
    label_text: z.string().optional(),
    test_id: z.string().optional(),
    css: z.string().optional(),
    xpath: z.string().optional(),
    nth: z.number().int().min(0).optional(),
    frame_hint: z.string().optional(),
    nearby_text: z.string().optional(),
    parent_hint: z.string().optional(),
    require_visible: z.boolean().default(true),
  })
  .strict()
  .refine(
    (value) =>
      Boolean(
        value.human_label ??
          value.exact_text ??
          value.role ??
          value.placeholder ??
          value.label_text ??
          value.test_id ??
          value.css ??
          value.xpath ??
          value.nearby_text ??
          value.parent_hint,
      ),
    {
      message: "TargetHint must include at least one selector field.",
    },
  );

export type TargetHint = z.infer<typeof targetHintSchema>;
