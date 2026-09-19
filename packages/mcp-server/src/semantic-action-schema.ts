import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const catalogFields = {
  outcome: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u),
  query: z.string().max(256),
  limit: z.number().int().min(1).max(20),
  cursor: z.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u),
};
const absent = z.null().optional();
// Null is omission for optional catalog fields. Empty/invalid cursors and
// meaningful listing values alongside an exact outcome are never discarded.
export const semanticActionCatalogSchema = z.union([
  z.object({ outcome: catalogFields.outcome, query: absent, limit: absent, cursor: absent }).strict(),
  z.object({ outcome: absent, query: catalogFields.query.nullish(), limit: catalogFields.limit.nullish(),
    cursor: catalogFields.cursor.nullish() }).strict(),
]).describe("Exact detail: outcome alone. Listing: query/limit/server-issued cursor. Optional null means omitted; never mix meaningful detail and listing arguments.");

export function semanticActionCatalogJsonSchema(alternate?: z.ZodTypeAny): Tool["inputSchema"] {
  const schema = alternate ? z.union([semanticActionCatalogSchema, alternate]) : semanticActionCatalogSchema;
  return { ...zodToJsonSchema(schema, { $refStrategy: "none" }), type: "object" } as Tool["inputSchema"];
}

export function semanticActionInputSchema(name: string) {
  if (name === "app.describe_actions") return z.object({
    outcome: catalogFields.outcome.nullish(), query: catalogFields.query.nullish(),
    limit: catalogFields.limit.nullish(), cursor: catalogFields.cursor.nullish(),
  }).strict().describe(semanticActionCatalogSchema.description!);
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
