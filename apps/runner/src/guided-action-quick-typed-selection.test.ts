import { describe, expect, it } from "vitest";
import type { GuidedActionOptions, GuidedActionResourceOption } from "./guided-action.js";
import { prepareQuickProposalAction, rankActionIntent, type ActionIntentHints, type QuickProposalDecisions } from "./guided-action-quick.js";

const shipments: GuidedActionResourceOption = {
  id: "warehouse.shipments", schema: "warehouse", table: "shipments", label: "Shipments", description: "Carrier mode and delay threshold",
  primary_key: "shipment_id", tenant_key: "tenant_id", conflict_candidates: ["version"], insert_dedup_candidates: ["shipment_id"],
  writable_fields: [
    { name: "carrier_mode", data_type: "text", enum_values: ["air", "ground"], nullable: false, required_for_insert: false },
    { name: "delay_threshold", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
  ],
  structurally_eligible_fields: [
    { name: "carrier_mode", data_type: "text", enum_values: ["air", "ground"], nullable: false, required_for_insert: false },
    { name: "delay_threshold", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
  ], kept_out_fields: ["tenant_id", "version"],
  operation_availability: { insert: { available: true, reason: "Exact reviewed identity" }, update: { available: true, reason: "Exact reviewed row" }, delete: { available: true, reason: "Exact reviewed row" } },
};
const preferences: GuidedActionResourceOption = { ...structuredClone(shipments), id: "warehouse.preferences", table: "preferences", label: "Preferences",
  writable_fields: [{ name: "mode_code", data_type: "text", enum_values: ["a", "b"], nullable: false, required_for_insert: false }],
  structurally_eligible_fields: [{ name: "mode_code", data_type: "text", enum_values: ["a", "b"], nullable: false, required_for_insert: false }] };
const options: GuidedActionOptions = { boundary_name: "reviewed", boundary_state: "active", boundary_digest: `sha256:${"a".repeat(64)}`,
  source: "local_postgres", deployment_profile: "staging", resources: [shipments, preferences], blocked_resources: [], safe_defaults: {} };
const intent = "Update shipments carrier mode and delay threshold; do not create or delete shipments.";
// The proposed adapter reuses existing QuickProposalDecisions. This before
// seam supplies the argument to the current two-argument implementation, which
// ignores it; no native currentness or operator confirmation is fabricated.
const rank = rankActionIntent as (resources: GuidedActionResourceOption[], narration?: string,
  decisions?: QuickProposalDecisions) => ActionIntentHints;
const empty = { fields: [], notes: expect.any(Array) };

describe("quick Action exact typed selection retirement", () => {
  it("does not infer resource, operation or fields from narration", () => {
    expect(rank(options.resources, intent)).toEqual(empty);
  });
  it("does not infer coded fields from human metadata labels", () => {
    const coded = { ...structuredClone(shipments), table: "r17", label: "Shipments", id: "warehouse.r17",
      structurally_eligible_fields: [{ ...shipments.structurally_eligible_fields[0]!, name: "f19", label: "Carrier mode" }] };
    expect(rank([coded, preferences], "Update shipment carrier mode")).toEqual(empty);
  });
  it("does not derive operation exclusions from English negation", () => {
    expect(rank([shipments], "Change carrier mode, but never create or delete shipments.")).toEqual(empty);
  });
  it("asks for an exact target when no typed target was supplied", () => {
    expect(prepareQuickProposalAction({ options, intent })).toMatchObject({ state: "needs_input", decision: { kind: "resource" } });
  });
  it("asks for an exact operation after a typed target without using prose verbs", () => {
    expect(prepareQuickProposalAction({ options, intent, decisions: { resource: shipments.id } })).toMatchObject({ state: "needs_input", decision: { kind: "operation" } });
  });
  it("asks for exact fields after typed target and operation without lexical matching", () => {
    expect(prepareQuickProposalAction({ options, intent, decisions: { resource: shipments.id, operation: "update" } })).toMatchObject({ state: "needs_input", decision: { kind: "fields" } });
  });
  it("keeps an explicit typed selection independent of contradictory narration", () => {
    expect(prepareQuickProposalAction({ options, intent: "Never update shipments; only create preferences.", decisions: {
      resource: shipments.id, operation: "update", guard_column: "version", fields: ["carrier_mode"],
    } })).toMatchObject({ state: "ready", action: { resource: shipments.id, operation: "update", patches: [{ column: "carrier_mode" }] }, authority_granted: false, source_database_changed: false });
  });
  it("projects only explicit current typed target, operation and fields", () => {
    expect(rank(options.resources, "Delete shipments carrier mode", { resource: preferences.id, operation: "update", fields: ["mode_code"] })).toMatchObject({
      resource: preferences.id, operation: "update", fields: ["mode_code"],
    });
  });
  it("refuses an exact target absent from current reviewed options", () => {
    expect(() => rank(options.resources, intent, { resource: "warehouse.old" })).toThrow();
  });
  it("refuses a typed operation without current structural availability", () => {
    const readOnly = { ...structuredClone(shipments), operation_availability: { ...shipments.operation_availability,
      update: { available: false, reason: "Current conflict proof missing" } } };
    expect(() => rank([readOnly], intent, { resource: readOnly.id, operation: "update" })).toThrow();
  });
  it("refuses cross-resource fields instead of ranking their names", () => {
    expect(() => rank(options.resources, intent, { resource: preferences.id, operation: "update", fields: ["carrier_mode"] })).toThrow();
  });
  it("preserves exact typed bounds, guard, tenant exclusions and disabled authority", () => {
    const result = prepareQuickProposalAction({ options, intent, decisions: { resource: shipments.id, operation: "update", guard_column: "version",
      fields: ["carrier_mode", "delay_threshold"], numeric_bounds: { delay_threshold: { minimum: 0, maximum: 45 } } } });
    expect(result).toMatchObject({ state: "ready", authority_granted: false, source_database_changed: false,
      action: { resource: shipments.id, operation: "update", conflict_column: "version", authority_posture: "proposal_only", writeback: { mode: "none" },
        patches: [{ column: "carrier_mode" }, { column: "delay_threshold", minimum: 0, maximum: 45 }] } });
    if (result.state !== "ready") throw new Error("Expected exact disabled draft");
    expect(result.action.patches?.map(p => p.column)).not.toContain("tenant_id");
    expect(result.action.patches?.map(p => p.column)).not.toContain("version");
  });
});
