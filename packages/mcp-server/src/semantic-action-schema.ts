import { z } from "zod";
import { portableDiscoveryInputJsonSchema } from "./tool-schema-publication.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const catalogFields = {
  outcome: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u).describe("Exact detail id; omit/null query, limit and cursor."),
  query: z.string().max(256).describe("Listing only; omit/null when outcome is supplied."),
  limit: z.number().int().min(1).max(20).describe("Listing maximum; omit/null for exact detail. No detail default."),
  cursor: z.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u).describe("Listing only: use returned next_cursor with the same query/context; omit/null for detail."),
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
  return portableDiscoveryInputJsonSchema(schema);
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
