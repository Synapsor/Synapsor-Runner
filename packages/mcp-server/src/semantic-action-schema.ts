import { z } from "zod";
import { portableDiscoveryInputJsonSchema } from "./tool-schema-publication.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const catalogFields = {
  outcome: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u).describe("Exact outcome; query is absent. Plain detail omits limit/cursor; section detail uses returned section grammar."),
  query: z.string().max(256).describe("Listing only; omit/null when outcome is supplied."),
  limit: z.number().int().min(1).max(20).describe("Listing/section maximum1–20; omit/null for plain exact detail."),
  cursor: z.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u).describe("Listing/section continuation: returned next_cursor with unchanged query or exact section, limit and context; omit/null for plain detail."),
  section: z.string().min(1).max(128).describe("Exact public section returned by contract_navigation; only with outcome."),
  contract_revision: z.string().regex(/^rev_[A-Za-z0-9_-]{43}$/u).describe("Exact opaque public revision returned by contract_navigation; a changed revision requires fresh discovery."),
  item: z.string().min(1).max(256).describe("One exact public item key or field/input id in the selected section; not a guessed value."),
};
const absent = z.null().optional();
// Null is omission for optional catalog fields. Empty/invalid cursors and
// meaningful listing values alongside an exact outcome are never discarded.
export const semanticActionCatalogSchema = z.union([
  z.object({ outcome: catalogFields.outcome, query: absent, limit: absent, cursor: absent, section: absent, contract_revision: absent, item: absent }).strict(),
  z.object({ outcome: catalogFields.outcome, section: catalogFields.section, contract_revision: catalogFields.contract_revision.nullish(), item: catalogFields.item.nullish(), query: absent,
    limit: catalogFields.limit.nullish(), cursor: catalogFields.cursor.nullish() }).strict(),
  z.object({ outcome: absent, query: catalogFields.query.nullish(), limit: catalogFields.limit.nullish(),
    cursor: catalogFields.cursor.nullish(), section: absent, contract_revision: absent, item: absent }).strict(),
]).describe("Exact detail: outcome alone. Exact section: outcome plus returned section, optional item/limit/section cursor. Listing: query/limit/server-issued cursor. Null means omitted; never mix query with exact detail/sections.");

export function semanticActionCatalogJsonSchema(alternate?: z.ZodTypeAny): Tool["inputSchema"] {
  const schema = alternate ? z.union([semanticActionCatalogSchema, alternate]) : semanticActionCatalogSchema;
  return portableDiscoveryInputJsonSchema(schema);
}

export function semanticActionInputSchema(name: string) {
  if (name === "app.describe_actions") return z.object({
    outcome: catalogFields.outcome.nullish(), query: catalogFields.query.nullish(),
    limit: catalogFields.limit.nullish(), cursor: catalogFields.cursor.nullish(),
    section: catalogFields.section.nullish(), contract_revision: catalogFields.contract_revision.nullish(), item: catalogFields.item.nullish(),
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
