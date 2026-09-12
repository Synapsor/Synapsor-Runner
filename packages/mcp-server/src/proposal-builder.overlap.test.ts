import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compileActionRule, createActionRuleRegistry, createActionRuleApprovalClasses, createSemanticActionVerifier,
  evaluateActionRule, evaluateSemanticActionEligibility,
  type ActionRuleFactLoaderAdapterV1, type ActionRuleFactSetV1,
  type ActionRuleApprovalClassSourceV1, type SemanticActionEligibilityDecisionV1,
} from "@synapsor-runner/action-rules";
import { canonicalJsonDigest, parseWritebackJob } from "@synapsor-runner/protocol";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { buildDerivedChangeSet } from "./proposal-builder.js";

const digest = canonicalJsonDigest("overlap regression");
const now = "2026-09-12T06:25:00.000Z";
type Eligible = Extract<SemanticActionEligibilityDecisionV1, { result: "eligible" }>;
type Fixture = { compile: Parameters<typeof compileActionRule>[0]; approval_classes: ActionRuleApprovalClassSourceV1[];
  rows: Record<string, Record<string, string | number | boolean>[]> };

function fixture(renamed = false) {
  const text = readFileSync(new URL("./testing/insurance-target-overlap.json", import.meta.url), "utf8");
  const names: Record<string, string> = { selected_claim: "r1", portfolio_claims: "r2", selected_portfolio: "r3",
    reserve_ops: "opaque", claim_id: "k1", portfolio_id: "k2", insurer_id: "k3", adjuster_id: "k4",
    reserve_cents: "n1", version: "n2", claims: "entries", portfolios: "groups", freezes: "stops" };
  const rename = (value: unknown): unknown => typeof value === "string" ? value.split(".").map(part => names[part] ?? part).join(".")
    : Array.isArray(value) ? value.map(rename) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [names[key] ?? key, rename(item)])) : value;
  const saved = (renamed ? rename(JSON.parse(text)) : JSON.parse(text)) as Fixture;
  const compiled = compileActionRule(saved.compile);
  const target = compiled.bindings.find(binding => binding.binding === compiled.effect_envelope.target_binding)!;
  const selected = saved.rows[target.resource.table]!.find(row => Object.values(row).includes("CL-101"))!;
  const facts: ActionRuleFactSetV1 = { bindings: {}, trusted: { tenant: selected[target.resource.tenant_key!] as string,
    principal: selected[target.resource.principal_scope_key!] as string, transaction_time: now }, subject_provenance_digest: digest };
  for (const binding of compiled.bindings) facts.bindings[binding.binding] = { rows: (binding === target ? [selected] : saved.rows[binding.resource.table]!)
    .map(row => Object.fromEntries(binding.verification.fields.map(field => [field.name, row[field.name]!])) ) };
  const registry = createActionRuleRegistry({ name: "regression.actions",
    approval_classes: createActionRuleApprovalClasses({ rules: [compiled], sources: saved.approval_classes }),
    rules: [{ compiled, read_boundary_name: "reviewed_read", read_boundary_digest: digest,
      action_boundary_name: "regression.actions", action_boundary_digest: digest, activated_at: now }] });
  const subjects = [{ binding: target.binding, resource: target.resource.name,
    primary_key: { column: target.resource.primary_key, value: selected[target.resource.primary_key]! }, subject_ref_digest: digest }];
  const adapter: ActionRuleFactLoaderAdapterV1 = { engine: "postgres", assertCompleteCollection: async () => {},
    assertResourceCompatible: async () => {}, assertRelationshipCompatible: async () => {},
    load: async query => facts.bindings[query.binding]!.rows.filter(row => query.predicates.every(predicate =>
      predicate.operation === "eq" ? row[predicate.column] === predicate.value
        : predicate.operation === "in" ? predicate.values.includes(row[predicate.column]!)
          : predicate.tuples.some(tuple => predicate.columns.every((column, index) => row[column] === tuple[index])))) };
  const evaluate = () => evaluateActionRule({ compiled, facts, proposal_id: "overlap", inputs: { desired_cents: 30000 } });
  const decide = () => evaluateSemanticActionEligibility({ registry, subjects, adapter, trusted: facts.trusted,
    outcome: compiled.outcome, inputs: { desired_cents: 30000 }, proposal_id: "overlap", verified_at: now,
    trusted_context_digest: digest, evidence_provenance_digest: digest });
  return { compiled, target, facts, registry, subjects, adapter, evaluate, decide };
}

function build(decision: Eligible) {
  return buildDerivedChangeSet({ decision, context: { tenant_id: decision.semantic_authority.effect.tenant_guard!.value as string,
    principal: decision.semantic_authority.effect.principal_scope!.value as string, provenance: "environment" },
    proposalId: "overlap", createdAt: now, evidenceBundleId: "overlap-evidence", queryFingerprint: digest });
}

describe("saved selected-target/complete-collection rule", () => {
  it.each([false, true])("retains both bindings through proposal and worker reverification (renamed=%s)", async renamed => {
    const f = fixture(renamed), decision = await f.decide();
    expect(decision.result).toBe("eligible");
    if (decision.result !== "eligible") throw new Error("Expected eligible original rows");
    const dependencies = structuredClone(decision.semantic_authority.dependencies);
    const matches = dependencies.filter(row => row.resource === decision.semantic_authority.effect.resource
      && row.primary_key.value === decision.semantic_authority.effect.primary_key.value);
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map(row => row.row_digest)).size).toBe(2); // Digests include each binding's projection.
    const proposal = build(decision);
    expect(proposal.semantic_authority.dependencies).toEqual(dependencies);
    expect(proposal.before).toEqual({ [f.target.resource.primary_key]: decision.semantic_authority.effect.primary_key.value,
      [f.target.resource.version_field!]: decision.semantic_authority.effect.expected_version!.value });
    const store = new ProposalStore();
    try {
      store.createProposal(proposal);
      store.approveProposal(proposal.proposal_id, { approver: "regression-reviewer", proposal_hash: proposal.integrity.proposal_hash,
        proposal_version: 1 });
      const job = parseWritebackJob(store.createWritebackJobFromProposal(proposal.proposal_id));
      if (job.protocol_version !== "5.0") throw new Error("Expected semantic worker contract");
      expect(job.semantic_authority.dependencies).toEqual(dependencies);
      const verify = createSemanticActionVerifier({ registry: f.registry, clock: () => now });
      await expect(verify({ job, factLoader: f.adapter })).resolves.toMatchObject({ status: "reverified" });
      // Changing an unrelated collection member invalidates the exact dependency set.
      const collection = f.compiled.bindings.find(binding => binding.resource.name === f.target.resource.name
        && binding.verification.cardinality === "many")!;
      const rows = f.facts.bindings[collection.binding]!.rows;
      rows[1]![f.target.resource.version_field!] = 99;
      await expect(verify({ job, factLoader: f.adapter })).rejects.toThrow("Current authoritative facts");
    } finally { store.close(); }
  });

  it.each(["missing", "duplicate", "conflicting_value", "conflicting_version", "cross_tenant", "cross_principal", "wrong_relationship"])("refuses %s collection evidence", failure => {
    const f = fixture(), rows = f.facts.bindings.portfolio_claims!.rows;
    const selected = f.facts.bindings.selected_claim!.rows[0]!;
    const index = rows.findIndex(row => row.claim_id === selected.claim_id);
    if (failure === "missing") rows.splice(index, 1);
    if (failure === "duplicate") rows.push({ ...rows[index]! });
    if (failure === "conflicting_value") rows[index]!.reserve_cents = Number(rows[index]!.reserve_cents) + 1;
    if (failure === "conflicting_version") rows[index]!.version = Number(rows[index]!.version) + 1;
    if (failure === "cross_tenant") rows[index]!.insurer_id = "other-org";
    if (failure === "cross_principal") rows[index]!.adjuster_id = "other-person";
    if (failure === "wrong_relationship") rows[index]!.portfolio_id = "other-portfolio";
    expect(f.evaluate().result).not.toBe("eligible");
  });

  it.each(["missing", "duplicate", "wrong_binding", "wrong_resource", "wrong_key", "wrong_version", "forged_digest"])("refuses %s target dependencies", async failure => {
    const f = fixture(), decision = await f.decide();
    if (decision.result !== "eligible") throw new Error("Expected eligible fixture");
    const authority = decision.semantic_authority;
    const index = authority.dependencies.findIndex(row => row.binding === f.target.binding);
    const target = authority.dependencies[index]!;
    if (failure === "missing") authority.dependencies.splice(index, 1);
    if (failure === "duplicate") authority.dependencies.push(structuredClone(target));
    if (failure === "wrong_binding") target.binding = "unreviewed";
    if (failure === "wrong_resource") target.resource = "other.claims";
    if (failure === "wrong_key") target.primary_key.value = "other-row";
    if (failure === "wrong_version") target.version!.value = 99;
    if (failure === "forged_digest") target.row_digest = digest;
    expect(() => build(decision)).toThrow();
  });

  it.each(["wrong_binding", "wrong_resource", "wrong_key", "duplicate"])("refuses %s observed subject references before proposal", async failure => {
    const f = fixture();
    if (failure === "wrong_binding") f.subjects[0]!.binding = "portfolio_claims";
    if (failure === "wrong_resource") f.subjects[0]!.resource = "other.claims";
    if (failure === "wrong_key") f.subjects[0]!.primary_key.value = "other-row";
    if (failure === "duplicate") f.subjects.push(structuredClone(f.subjects[0]!));
    const result = await f.decide().then(decision => decision.result, () => "refused");
    expect(result).not.toBe("eligible");
  });
});
