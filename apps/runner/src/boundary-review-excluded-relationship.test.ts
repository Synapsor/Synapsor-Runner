import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAutoBoundary } from "./auto-boundary.js";
import { initializeGuidedProject } from "./guided-project.js";
import { initializeFreshGovernedAuthoring } from "./control-policy-fresh-authoring.js";
import { readRuntimeConfig } from "./cli-project.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";
import {
  commitBoundaryResourceReviewMutation, currentBoundaryReviewMutationBindings,
  loadBoundaryResourceReviewCatalog, prepareBoundaryResourceReviewMutation,
} from "./boundary-review-mutation.js";

const actor = "declared relationship reviewer";
const reason = "Review only the declared relationship; preserve all field and subject restrictions.";
type Variant = "source-private" | "target-private" | "both-private" | "scope-pair" | "unproven" | "missing-target";
async function fixture(variant: Variant) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "excluded-relationship-"));
  await fs.chmod(root, 0o700); await fs.mkdir(path.join(root, ".git"));
  const inspection = ownedProgramInspection();
  const source = structuredClone(inspection.tables[0]!); source.name = "q7";
  const target = structuredClone(source); target.name = "r8";
  source.columns.push({ ...structuredClone(source.columns[0]!), name: "join_key", ordinal_position: 9 });
  target.unique_constraints.push({ name: "r8_scope_unique", columns: ["tenant_id", "parcel_id"] });
  source.foreign_keys = [{ name: "rel_k9", columns: variant === "scope-pair" ? ["tenant_id", "join_key"] : ["join_key"],
    referenced_schema: "studio", referenced_table: "r8", referenced_columns: variant === "scope-pair"
      ? ["tenant_id", "parcel_id"] : [variant === "unproven" ? "label" : "parcel_id"], delete_rule: "RESTRICT" }];
  inspection.tables = variant === "missing-target" ? [source] : [source, target];
  const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "studio",
    project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  const guided = await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.8.0", instantOnboarding: true });
  await initializeFreshGovernedAuthoring({ projectRoot: root, build, config: await readRuntimeConfig(guided.config_path),
    storePath: guided.store_path, actor });
  for (const table of inspection.tables) {
    const fields = ["label", ...(table === source
      ? (["source-private", "both-private"].includes(variant) ? [] : ["join_key"])
      : (["target-private", "both-private"].includes(variant) ? [] : ["parcel_id"]))];
    const preview = await prepareBoundaryResourceReviewMutation(root, { resource_id: `studio.${table.name}`, include: true,
      tenant_key: "tenant_id", principal_key: "principal_id", selectable_fields: fields, allow_reviewed_fields: fields,
      actor, reason }, async () => inspection);
    await commitBoundaryResourceReviewMutation(root, preview);
  }
  return { root, inspection, request: (ids: string[], resource = "studio.q7") =>
    prepareBoundaryResourceReviewMutation(root, { resource_id: resource, relationship_ids: ids, actor, reason }, async () => inspection) };
}

async function refusal(variant: Variant, ids: string[], resource?: string) {
  const f = await fixture(variant);
  const before = await currentBoundaryReviewMutationBindings(f.root);
  const catalog = await loadBoundaryResourceReviewCatalog(f.root);
  const inspection = structuredClone(f.inspection);
  let error: unknown;
  try { await f.request(ids, resource); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect(await currentBoundaryReviewMutationBindings(f.root)).toEqual(before);
  expect(await loadBoundaryResourceReviewCatalog(f.root)).toEqual(catalog);
  expect(f.inspection).toEqual(inspection);
  return error as Error & { code?: string; relationships?: Array<{ id: string; reason: string; kept_out_fields?: Array<{ resource: string; field: string }> }> };
}

describe("inspected relationships excluded from the Read pack", () => {
  it.each(["source-private", "target-private", "both-private"] as const)("explains an exact inspected FK excluded by a %s join key without changing authority", async variant => {
    const error = await refusal(variant, ["rel_k9"]);
    expect(error.code).toBe("READ_RELATIONSHIP_UNAVAILABLE");
    expect(error.message).toContain('Relationship "rel_k9" is excluded because a join key is kept out');
    expect(error.message).not.toContain("Unknown");
    const fields = variant === "source-private" ? [{ resource: "studio.q7", field: "join_key" }]
      : variant === "target-private" ? [{ resource: "studio.r8", field: "parcel_id" }]
        : [{ resource: "studio.q7", field: "join_key" }, { resource: "studio.r8", field: "parcel_id" }];
    expect(error.relationships).toEqual([{ id: "rel_k9", reason: "kept_out_join_key", kept_out_fields: fields }]);
    for (const { resource, field } of fields) expect(error.message).toContain(`${resource}.${field}`);
    expect(error.message).not.toMatch(/tenant_id|principal_id|internal_note/);
  });
  it("keeps truly absent identifiers unknown", async () => {
    const error = await refusal("source-private", ["never_inspected"]);
    expect(error.message).toContain('Unknown relationship "never_inspected"');
    expect(error.message).not.toContain("join key is kept out");
    expect(error.relationships).toEqual([{ id: "never_inspected", reason: "unknown" }]);
  });
  it("does not borrow a matching constraint from another source resource", async () => {
    const error = await refusal("source-private", ["rel_k9"], "studio.r8");
    expect(error.message).toContain('Unknown relationship "rel_k9"');
  });
  it.each(["unproven", "missing-target"] as const)("reports an inspected but %s relationship unavailable without inventing a privacy cause", async variant => {
    const error = await refusal(variant, ["rel_k9"]);
    expect(error.message).toContain('Inspected relationship "rel_k9" is unavailable for Read review');
    expect(error.message).not.toMatch(/Unknown|join key is kept out/);
  });
  it("classifies mixed inspected and absent identifiers separately", async () => {
    const error = await refusal("source-private", ["rel_k9", "never_inspected"]);
    expect(error.message).toContain('Relationship "rel_k9" is excluded because a join key is kept out');
    expect(error.message).toContain('Unknown relationship "never_inspected"');
    expect(error.message).not.toContain('Unknown relationships "rel_k9"');
    expect(error.relationships).toEqual([
      { id: "rel_k9", reason: "kept_out_join_key", kept_out_fields: [{ resource: "studio.q7", field: "join_key" }] },
      { id: "never_inspected", reason: "unknown" },
    ]);
  });
  it("preserves a private typed scope pair and permits the otherwise reviewed composite join", async () => {
    const f = await fixture("scope-pair");
    const before = await currentBoundaryReviewMutationBindings(f.root);
    const preview = await f.request(["rel_k9"]);
    expect(preview.candidate.pack.resources.find(r => r.id === "studio.q7")!.relationships.map(r => r.id)).toContain("rel_k9");
    for (const resource of preview.candidate.pack.resources) {
      expect(resource.kept_out_fields).toEqual(expect.arrayContaining(["tenant_id", "principal_id"]));
      expect(resource.selectable_fields).not.toEqual(expect.arrayContaining(["tenant_id"]));
      expect(resource.tenant_key).toBe("tenant_id"); expect(resource.principal_key).toBe("principal_id");
    }
    expect(await currentBoundaryReviewMutationBindings(f.root)).toEqual(before);
    expect(preview.source_database_changed).toBe(false);
  });
});
