import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { prepareActionVersionField, reviewActionVersionField } from "./action-rule-version-review.js";
import { actionRuleAuthoringCheckpoint, parseActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { rebuildActionCatalogAfterMetadataRefresh } from "./action-rule-read-revision.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

function fixture(selection: string | undefined = "confirm") {
  const column = (name: string, data_type: string): TableInfo["columns"][number] => ({ name, data_type, nullable: false,
    generated: false, identity: false, ordinal_position: 1, suggestions: { tenant: name === "tenant_id", conflict: false,
      sensitive: false, immutable: ["record_id", "tenant_id", "person_id"].includes(name), large_or_binary: false } });
  const inspection: SchemaInspection = { engine: "postgres", server_version: "17", current_user: "reader",
    inspected_at: "2026-09-11T00:00:00.000Z", schemas: ["inventory"], warnings: [], tables: [{
      schema: "inventory", name: "items", type: "table", writable: true,
      columns: [column("record_id", "uuid"), column("tenant_id", "uuid"), column("person_id", "uuid"),
        column("c09", "integer"), column("quantity", "integer")],
      primary_key: ["record_id"], foreign_keys: [], indexes: [], unique_constraints: [],
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["quantity"] },
    }] };
  return fromInspection(inspection, selection);
}
function fromInspection(inspection: SchemaInspection, selection: string | undefined = "confirm") {
  const built = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL", inspectedSchema: "inventory",
    project: { root: "/owned-version-test", package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
  const readBoundary = built.exploration_boundary;
  readBoundary.pack.resources = [{ id: "inventory.items", schema: "inventory", table: "items", primary_key: "record_id",
    tenant_key: "tenant_id", principal_key: "person_id", field_types: {}, field_enums: {}, selectable_fields: ["quantity"],
    filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [], count_distinct_fields: [],
    time_bucket_fields: {}, kept_out_fields: ["record_id", "tenant_id", "person_id", "c09"], relationships: [],
    minimum_cohort_size: 5, suppression_aware_totals: true }];
  const context = { readBoundary, readBoundaryDigest: canonicalJsonDigest(readBoundary),
    builtCatalog: buildActionRuleAuthoringCatalog({ boundary: readBoundary, inspection }) };
  return { context, inspection, generationLock: built.lock, resource: "inventory.items", field: "c09",
    assertCurrent: vi.fn(async () => {}),
    session: { chooseOption: vi.fn(async () => selection) } as unknown as BoundaryReviewInteractiveSession };
}

describe("reviewed conflict-counter mapping", () => {
  it("does not infer coded or ordinary integers as counters, but retains an explicitly reviewed private mapping", async () => {
    const args = fixture(), original = structuredClone(args.context), source = structuredClone(args.inspection);
    expect(args.context.builtCatalog.catalog.resources[0]!.version_field).toBeUndefined();
    expect(args.context.builtCatalog.authoring.resources[0]).toMatchObject({ version_candidates: [], version_field_options: ["c09", "quantity"], operations: { update: false } });
    const prepared = (await reviewActionVersionField(args))!;
    expect(prepared.builtCatalog.authoring.resources[0]).toMatchObject({ selected_version_field: "c09", operations: { update: true } });
    expect(prepared.builtCatalog.authoring.resources[0]!.fields.find(field => field.name === "c09"))
      .toMatchObject({ role: "guard", writable: false });
    const rebuilt = buildActionRuleAuthoringCatalog({ boundary: args.context.readBoundary, inspection: args.inspection, retainedCatalog: prepared.builtCatalog.catalog });
    expect(rebuilt.catalog.resources[0]!.version_field).toBe("c09");
    expect(args.context).toEqual(original); expect(args.inspection).toEqual(source);
    expect(prepared.readBoundary).toEqual(original.readBoundary);
    expect(args.session.chooseOption).toHaveBeenCalledOnce();
    const options = vi.mocked(args.session.chooseOption!).mock.calls[0]![2];
    expect(options).toMatchObject({ initialValue: "pending", requireExplicitSelection: true, explainOnRequest: true });
    expect(options?.exactDetails?.lines.join("\n")).toContain("every source writer");
    expect(options?.exactDetails?.lines.join("\n")).toContain("Read visibility is unchanged");
    expect(args.assertCurrent).toHaveBeenCalledTimes(2);
  });
  it.each(["nullable", "generated", "identity", "immutable", "text", "primary", "tenant", "person", "missing", "private_only"])("rejects unsuitable counter mappings (%s)", kind => {
    const source = fixture().inspection, counter = source.tables[0]!.columns.find(field => field.name === "c09")!;
    if (["nullable", "generated", "identity"].includes(kind)) Object.assign(counter, { [kind]: true });
    if (kind === "immutable") counter.suggestions.immutable = true;
    if (kind === "text") counter.data_type = "text";
    if (kind === "missing") source.tables[0]!.columns = source.tables[0]!.columns.filter(field => field.name !== "c09");
    const args = fromInspection(source);
    if (kind === "primary") args.field = "record_id";
    if (kind === "tenant") args.field = "tenant_id";
    if (kind === "person") args.field = "person_id";
    if (kind === "private_only") args.context.builtCatalog.catalog.resources[0]!.verification_only = true;
    expect(() => prepareActionVersionField(args)).toThrow("ACTION_VERSION_FIELD_UNSUPPORTED");
    expect(args.session.chooseOption).not.toHaveBeenCalled();
  });
  it.each(["lock", "inspection", "catalog", "role"])("refuses stale source evidence before asking (%s)", kind => {
    const args = fixture();
    if (kind === "lock") args.generationLock.schema_fingerprint = canonicalJsonDigest("changed");
    if (kind === "inspection") args.inspection.tables[0]!.columns.find(field => field.name === "c09")!.nullable = true;
    if (kind === "catalog") args.context.builtCatalog.catalog.generation_lock_fingerprint = canonicalJsonDigest("changed");
    if (kind === "role") args.context.readBoundary.role_posture_fingerprint = canonicalJsonDigest("changed");
    expect(() => prepareActionVersionField(args)).toThrow("ACTION_VERSION_REVIEW_STALE");
  });
  it.each(["pending", undefined])("decline/cancel preserves all state (%s)", async selection => {
    const args = fixture(selection), before = structuredClone(args.context);
    if (selection === undefined) vi.mocked(args.session.chooseOption!).mockResolvedValue(undefined);
    expect(await reviewActionVersionField(args)).toBeUndefined();
    expect(args.context).toEqual(before); expect(args.assertCurrent).toHaveBeenCalledOnce();
  });
  it("revalidates an exact saved decision without repeating confirmation, and requires review for a changed proof", async () => {
    const args = fixture(), review = prepareActionVersionField(args).review;
    expect((await reviewActionVersionField({ ...args, previousReview: review }))?.review).toEqual(review);
    expect(args.session.chooseOption).not.toHaveBeenCalled();
    expect((await reviewActionVersionField({ ...args, previousReview: { ...review, proof_digest: canonicalJsonDigest("old") } }))?.review).toEqual(review);
    expect(args.session.chooseOption).toHaveBeenCalledOnce();
  });
  it("refuses a concurrent project change after confirmation", async () => {
    const args = fixture();
    args.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("review changed"));
    await expect(reviewActionVersionField(args)).rejects.toThrow("review changed");
  });
  it.each(["writer_policy", "changed_type", "generated"])("revalidates the saved guard across metadata refresh (%s)", kind => {
    const before = fixture(), prepared = prepareActionVersionField(before), inspection = structuredClone(before.inspection);
    inspection.tables[0]!.row_level_security_policies = [{ name: "reviewed_writer", command: "UPDATE", permissive: true,
      roles: ["writer"], using_expression: "tenant_id = current_setting('app.tenant')", check_expression: "tenant_id = current_setting('app.tenant')" }];
    if (kind === "changed_type") inspection.tables[0]!.columns.find(field => field.name === "c09")!.data_type = "boolean";
    if (kind === "generated") inspection.tables[0]!.columns.find(field => field.name === "c09")!.generated = true;
    const after = fromInspection(inspection);
    const refresh = () => rebuildActionCatalogAfterMetadataRefresh({ catalog: prepared.builtCatalog.catalog, previousLock: before.generationLock,
      nextLock: after.generationLock, nextBoundary: after.context.readBoundary, inspection });
    if (kind === "writer_policy") {
      expect(refresh().resources[0]!.version_field).toBe("c09");
      expect(prepareActionVersionField(after).review).toEqual(prepared.review);
    } else expect(refresh).toThrow("ACTION_RULE_REVALIDATION_REQUIRED");
  });
  it("binds the saved mapping to the checkpoint and rejects tampering, duplicate resources and unreviewed maintenance", () => {
    const review = prepareActionVersionField(fixture()).review;
    const core = { intent_digest: canonicalJsonDigest("job"), context_digest: canonicalJsonDigest("context"), components: {}, reviewed_version_fields: [review] };
    const saved = actionRuleAuthoringCheckpoint(core);
    expect(parseActionRuleAuthoringCheckpoint(saved)).toEqual(saved);
    expect(() => parseActionRuleAuthoringCheckpoint({ ...saved, reviewed_version_fields: [{ ...review, field: "quantity" }] })).toThrow("CHECKPOINT_INVALID");
    expect(() => actionRuleAuthoringCheckpoint({ ...core, reviewed_version_fields: [review, review] })).toThrow("CHECKPOINT_INVALID");
    expect(() => actionRuleAuthoringCheckpoint({ ...core, reviewed_version_fields: [{ ...review, maintenance: "unknown" as "all_writers_increment" }] })).toThrow("CHECKPOINT_INVALID");
  });
});
