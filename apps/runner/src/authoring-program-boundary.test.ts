import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => vi.fn(async () => { throw new Error("OWNED_CONTEXT_REACHED"); }));
vi.mock("./boundary-commands.js", () => ({ loadBoundaryReviewContext: context }));
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { actionRuleModelDraftJsonSchema } from "./action-rule-model.js";

/** Renamed public draft shape; no stored authority, source adapter or provider. */
function parcelDraft(index: number) {
  const outcome = `studio.pack_parcel_${index}`;
  return { schema_version: "synapsor.action-rule-model-draft.v1", name: outcome, outcome,
    inputs: [{ name: "units", description: "Units supplied by the caller.", type: { kind: "integer" }, minimum: 1, maximum: 10 }],
    verification: { name: `${outcome}_verification`, resources: [{ binding: "parcel", resource: "studio.parcels",
      source: { kind: "subject_ref" }, fields: ["available"] }] },
    effect: { name: `${outcome}_effect`, operation: "update", target_resource: "studio.parcels", target_binding: "parcel",
      allowed_fields: [{ name: "units", minimum: 1, maximum: 10 }], set: { units: { kind: "input", name: "units" } }, writeback: "supervised" },
    require: { kind: "compare", operator: "eq", left: { kind: "field", binding: "parcel", field: "available" },
      right: { kind: "literal", value: true, value_type: { kind: "boolean" } } }, derive: {}, ttl_seconds: 300,
    approval: { class_name: "studio.human_review", mode: "human", required_role: "reviewer", required_approvals: 1, shared_limits: [] },
    review: { when: "The parcel is available.", then: "Record the requested units.", refused: ["The parcel is unavailable."],
      human_review: "A reviewer decides.", examples: [{ kind: "eligible", scenario: "Available parcel", result: "Review." },
        { kind: "ineligible", scenario: "Unavailable parcel", result: "Refuse." }] } };
}

describe("owned public larger-program early boundary", () => {
  it.each([13, 32, 50, 64])("admits the complete %i-entry v2 export envelope before checking its current saved project", async count => {
    const drafts = Array.from({ length: count }, (_, index) => parcelDraft(index + 1));
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(actionRuleModelDraftJsonSchema());
    for (const draft of drafts) expect(validate(draft), JSON.stringify(validate.errors)).toBe(true);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-parcel-program-boundary-"));
    const hash = `sha256:${"a".repeat(64)}`;
    const bindings = { draft_digest: hash, candidate_digest: hash, generation_lock_fingerprint: hash,
      schema_fingerprint: hash, role_posture_fingerprint: hash, review_revision: 1 };
    const input = { schema_version: "synapsor.boundary-draft-input.v2", review_bundle_digest: hash,
      bindings, read: { resources: [] }, actions: drafts };
    await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(input), { mode: 0o600 });
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
    try {
      const code = await structuredBoundaryAuthoringCommand(["--project-root", root, "--draft", "draft.json", "--dry-run", "--json"]);
      stdout.mockRestore();
      expect(code).toBe(2); // The intentionally uninitialized project stays refused.
      const result = JSON.parse(output);
      expect(result).toMatchObject({ source_database_changed: false, active_authority_changed: false, disabled_authority_changed: false });
      expect(result.message).toContain("OWNED_CONTEXT_REACHED");
    } finally { stdout.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each([["synapsor.boundary-draft-input.v1", 13, 12], ["synapsor.boundary-draft-input.v2", 65, 64]])("refuses %s overflow before project access", async (version, count, maximum) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-parcel-overflow-"));
    const hash = `sha256:${"a".repeat(64)}`;
    const input = { schema_version: version, review_bundle_digest: hash,
      bindings: { draft_digest: hash, candidate_digest: hash, generation_lock_fingerprint: hash, schema_fingerprint: hash,
        role_posture_fingerprint: hash, review_revision: 1 }, read: { resources: [] },
      actions: Array.from({ length: Number(count) }, (_, i) => parcelDraft(i + 1)) };
    await fs.writeFile(path.join(root, "draft.json"), JSON.stringify(input), { mode: 0o600 });
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
    try {
      context.mockClear();
      expect(await structuredBoundaryAuthoringCommand(["--project-root", root, "--draft", "draft.json", "--dry-run", "--json"])).toBe(2);
      expect(JSON.parse(output).message).toContain(`at most ${maximum}`);
      expect(context).not.toHaveBeenCalled();
    } finally { stdout.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
