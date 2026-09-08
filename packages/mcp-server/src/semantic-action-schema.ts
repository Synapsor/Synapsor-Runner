import { z } from "zod";

export function semanticActionInputSchema(name: string) {
  if (name === "app.describe_actions") return z.object({
    outcome: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u).optional(),
    query: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(20).optional(),
    cursor: z.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u).optional(),
  }).strict().describe("Use outcome alone for exact detail, or query/limit/cursor for listing.");
  if (name !== "app.request_change") throw new Error("Unknown semantic Action tool.");
  return z.object({
    outcome: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u),
    subject_refs: z.record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u),
      z.string().regex(/^obj_[A-Za-z0-9_-]{32,128}$/u),
    ).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 8),
    inputs: z.record(z.union([z.string().max(4096), z.number().finite(), z.boolean()]))
      .refine((value) => Object.keys(value).length <= 32).optional(),
  }).strict();
}
