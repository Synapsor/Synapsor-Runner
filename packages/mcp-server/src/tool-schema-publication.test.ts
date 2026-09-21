import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mcpToolInputJsonSchema, portableDiscoveryInputJsonSchema } from "./tool-schema-publication.js";
import { semanticActionCatalogSchema, semanticActionCatalogJsonSchema } from "./semantic-action-schema.js";

describe("portable discovery declarations", () => {
  it("projects canonical fields without changing the canonical operation validator", () => {
    const before = mcpToolInputJsonSchema(semanticActionCatalogSchema);
    const declaration = semanticActionCatalogJsonSchema();
    expect(before.anyOf).toHaveLength(2);
    expect(declaration).toMatchObject({ type: "object", additionalProperties: false });
    expect(declaration).not.toHaveProperty("anyOf");
    expect(declaration).not.toHaveProperty("required");
    expect(Object.keys(declaration.properties!)).toEqual(["outcome", "query", "limit", "cursor"]);
    for (const args of [{}, { query: "label", limit: 2 }, { outcome: "example.action" },
      { outcome: "example.action", query: null, limit: null, cursor: null }]) {
      expect(semanticActionCatalogSchema.safeParse(args).success).toBe(true);
    }
    for (const args of [{ outcome: "example.action", query: "label" },
      { outcome: "example.action", limit: 2 }, { outcome: "example.action", cursor: `cur_${"a".repeat(43)}` },
      { cursor: "" }, { limit: 0 }, { extra: null }]) {
      expect(semanticActionCatalogSchema.safeParse(args).success).toBe(false);
    }
    expect(mcpToolInputJsonSchema(semanticActionCatalogSchema)).toEqual(before);
  });

  it("preserves nested grammar and only common required fields across closed branches", () => {
    const plan = z.union([z.object({ kind: z.literal("rows"), select: z.array(z.string()).min(1) }).strict(),
      z.object({ kind: z.literal("count") }).strict()]);
    const source = z.union([z.object({ contract: z.literal("source"), plan }).strict(),
      z.object({ contract: z.literal("settings"), section: z.enum(["summary"]) }).strict()]);
    const declared = portableDiscoveryInputJsonSchema(source);
    expect(declared.required).toEqual(["contract"]);
    expect(declared.properties!.plan).toEqual(mcpToolInputJsonSchema(z.object({ plan }).strict()).properties!.plan);
    expect(declared.properties!.plan).toHaveProperty("anyOf");
    expect(declared.additionalProperties).toBe(false);
    expect(JSON.stringify(declared)).not.toContain('"default"');
  });

  it("fails unsupported roots rather than dropping constraints or allowing unknown keys", () => {
    for (const schema of [z.string(), z.object({ a: z.string() }).passthrough(),
      z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))]) {
      expect(() => portableDiscoveryInputJsonSchema(schema)).toThrow();
    }
  });
});
