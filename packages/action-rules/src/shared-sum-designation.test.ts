import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseReviewedSharedSum, parseSharedSumDesignation, sharedSumDesignationDigest,
  type ReviewedSharedSumV1, type SharedSumDesignationV1 } from "./shared-sum-designation.js";

const hash = `sha256:${"a".repeat(64)}` as const;
const designation: SharedSumDesignationV1 = {
  schema_version: "synapsor.shared-sum-designation.v1", kind: "shared_sum", source: "reviewed_database",
  scope: { tenant_field: "tenant_id", principal_field: "principal_id" },
  limit: { resource: "public.teams", field: "limit" },
  populations: [{ resource: "public.credits", field: "amount" }, { resource: "public.waivers", field: "amount" }],
  unit: { kind: "integer", unit: "reviewed_credits", meaning: "One credit is one reviewed service unit." },
  time: "current_state", external_writers: "participating_only",
};
function reviewed(): ReviewedSharedSumV1 {
  return {
    schema_version: "synapsor.reviewed-shared-sum.v1", designation: structuredClone(designation),
    confirmation: { actor: "local_installation_operator", decision: "new_attributed_decision",
      recorded_at: "2026-10-09T00:00:00.000Z", question: { id: "12345678-1234-1234-1234-123456789abc", revision: 1, digest: hash },
      proposal_digest: hash, context_digest: hash, source_digest: hash, catalog_digest: hash, generation_lock_fingerprint: hash,
      read_dependencies: [{ name: "reviewed.read", digest: hash }], designation_digest: canonicalJsonDigest(designation) },
  };
}

describe("closed persisted shared-SUM meaning", () => {
  it("round trips the exact confirmed meaning and returns detached data", () => {
    const input = reviewed();
    const parsed = parseReviewedSharedSum(JSON.parse(JSON.stringify(input)));
    expect(parsed).toEqual(input);
    parsed.designation.unit.meaning = "Different units";
    parsed.confirmation.read_dependencies[0]!.digest = `sha256:${"b".repeat(64)}`;
    expect(input.designation.unit.meaning).toBe(designation.unit.meaning);
    expect(input.confirmation.read_dependencies[0]!.digest).toBe(hash);
    expect(sharedSumDesignationDigest(designation)).toBe(input.confirmation.designation_digest);
    expect(parsed.designation.unit).not.toHaveProperty("currency");
  });

  it.each([
    ["record", (r: any) => { r.optional_verifier = false; }],
    ["designation", (r: any) => { r.designation.formula = "credit+waiver"; }],
    ["scope", (r: any) => { r.designation.scope.cross_principal = true; }],
    ["limit", (r: any) => { r.designation.limit.constant = 500; }],
    ["population", (r: any) => { r.designation.populations[0].where = {}; }],
    ["unit", (r: any) => { r.designation.unit.currency = "USD"; }],
    ["confirmation", (r: any) => { r.confirmation.confirmed = true; }],
    ["question", (r: any) => { r.confirmation.question.origin = "model"; }],
    ["read reference", (r: any) => { r.confirmation.read_dependencies[0].active = true; }],
  ])("refuses additional %s authority fields", (_name, mutate) => {
    const input = reviewed(); mutate(input);
    expect(() => parseReviewedSharedSum(input)).toThrowError(expect.objectContaining({ code: "ACTION_RULE_INVALID", path: "authority.shared_sum" }));
  });

  it.each([
    ["experimental version", (r: any) => { r.designation.schema_version = "synapsor.experimental.shared-sum-protection.v1"; }],
    ["unknown reviewed version", (r: any) => { r.schema_version = "synapsor.reviewed-shared-sum.v2"; }],
    ["missing confirmation", (r: any) => { delete r.confirmation; }],
    ["model actor", (r: any) => { r.confirmation.actor = "assistant"; }],
    ["pending decision", (r: any) => { r.confirmation.decision = "pending"; }],
    ["missing question", (r: any) => { delete r.confirmation.question; }],
    ["bad question id", (r: any) => { r.confirmation.question.id = "pending"; }],
    ["zero question revision", (r: any) => { r.confirmation.question.revision = 0; }],
    ["fractional question revision", (r: any) => { r.confirmation.question.revision = 1.5; }],
    ["unsafe question revision", (r: any) => { r.confirmation.question.revision = Number.MAX_SAFE_INTEGER + 1; }],
    ["unbound proposal", (r: any) => { r.confirmation.proposal_digest = "a".repeat(64); }],
    ["bad question digest", (r: any) => { r.confirmation.question.digest = "sha256:bad"; }],
    ["noncanonical timestamp", (r: any) => { r.confirmation.recorded_at = "2026-10-09"; }],
    ["invalid timestamp", (r: any) => { r.confirmation.recorded_at = "pending"; }],
    ["no Read dependencies", (r: any) => { r.confirmation.read_dependencies = []; }],
    ["duplicate Read dependencies", (r: any) => { r.confirmation.read_dependencies.push(r.confirmation.read_dependencies[0]); }],
    ["too many Read dependencies", (r: any) => { r.confirmation.read_dependencies = Array.from({ length: 4097 }, (_, i) => ({ name: `r${i}`, digest: hash })); }],
    ["changed designation", (r: any) => { r.designation.limit.field = "other_limit"; }],
    ["changed unit meaning", (r: any) => { r.designation.unit.meaning = "USD cents"; }],
  ])("refuses %s instead of treating it as confirmed", (_name, mutate) => {
    const input = reviewed(); mutate(input);
    expect(() => parseReviewedSharedSum(input)).toThrowError(expect.objectContaining({ code: "ACTION_RULE_INVALID", path: "authority.shared_sum" }));
  });

  it.each([
    ["only one population", (d: any) => { d.populations.pop(); }],
    ["three populations", (d: any) => { d.populations.push({ resource: "public.other", field: "amount" }); }],
    ["repeated population", (d: any) => { d.populations[1] = d.populations[0]; }],
    ["limit included in population", (d: any) => { d.populations[0].resource = d.limit.resource; }],
    ["one scope column", (d: any) => { d.scope.principal_field = d.scope.tenant_field; }],
    ["blank Source", (d: any) => { d.source = " "; }],
    ["blank unit", (d: any) => { d.unit.unit = ""; }],
    ["blank meaning", (d: any) => { d.unit.meaning = " "; }],
    ["noninteger unit", (d: any) => { d.unit.kind = "money_minor"; }],
    ["delayed meaning", (d: any) => { d.time = "eventual"; }],
    ["external writers", (d: any) => { d.external_writers = "all_writers"; }],
  ])("keeps the bounded descriptor closed against %s", (_name, mutate) => {
    const input = structuredClone(designation); mutate(input);
    expect(() => parseSharedSumDesignation(input)).toThrowError(expect.objectContaining({ code: "ACTION_RULE_INVALID", path: "authority.shared_sum" }));
  });
});
