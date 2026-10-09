import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, proposeOperatorAnswer, confirmOperatorAnswer, operatorQuestionReadback } from "./authoring-operator-question.js";
import { parseActionRuleModelDraftProposal } from "./action-rule-draft.js";
import { STRUCTURED_AUTHORING_PROTOCOL_VERSION, STRUCTURED_AUTHORING_RESUME_VERSION } from "./authoring-protocol.js";
import { structuredTestAction } from "./structured-authoring-test-fixture.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseActionRequirementProposals, assertActionRequirementColumns, actionRequirementProposalsJsonSchema, actionRequirementsPending, actionRequirementsReadback } from "./authoring-action-requirements.js";
import { parseActionRequirementsQuestionBinding, assertActionRequirementsQuestionGeneration } from "./authoring-action-requirements-binding.js";
import { prepareActionRequirementsOperatorQuestion, assertActionRequirementsQuestionDependencies, projectConfirmedActionRequirements } from "./authoring-action-requirements-question.js";
import { parseActionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";

export function requirementFixture() {
  const hash = canonicalJsonDigest("closed requirement fixture");
  const proposals = [{ id: "execution", kind: "execution", target: { slot: "effect.writeback", outcome: "inventory.update" },
    value: { state: "proposed", mode: "proposal_only" } }];
  const completion = { operation_id: randomUUID(), request_digest: hash, context_digest: hash, response_digest: hash };
  const material = { intent_digest: hash, context_digest: hash, components: {}, requirement_proposals: proposals,
    question: { question: "Should this Action only prepare proposals?", operator_message: "Please review the execution setting.", policy_source_digest: null } };
  const checkpointBody = { schema_version: "synapsor.action-authoring-checkpoint.v4", authoring_protocol: { version: "synapsor.structured-authoring.v5" },
    intent_digest: hash, context_digest: hash, components: {}, requirement_proposals: proposals,
    pending_question: { question: material.question.question, operator_message: "Please review the execution setting.", completion },
    logical_turns: [{ id: randomUUID(), origin_context_digest: hash, iterations_used: 1, tool_calls_used: 1,
      completed: { kind: "ordinary_clarification", completion, material_digest: canonicalJsonDigest(material) } }] };
  const checkpoint = { ...checkpointBody, digest: canonicalJsonDigest(checkpointBody) };
  const ast = { outcome: "inventory.update", effect: { writeback: "proposal_only" } };
  const binding = { version: 1, proposals, origin: { kind: "ordinary_clarification", checkpoint, completion },
    dependencies: { root_digest: hash, source_digest: hash, store_digest: hash, session_digest: hash, context_digest: hash,
      catalog_digest: hash, generation_lock_fingerprint: hash, resume_revision: 1,
      read_dependencies: [{ name: "inventory.read", digest: hash }], participating_outcomes: ["inventory.update"],
      source_locator: { source_session: randomUUID(), source_digest: hash, store_digest: hash, start: 1, end: 1 },
      baseline_ast: ast, intended_ast: ast, columns: [], trusted_scopes: [] } };
  const body = { version: 4, id: randomUUID(), revision: 1, kind: "action_requirements", action_requirements: binding,
    scope_digest: canonicalJsonDigest(proposals.map(p => ({ id: p.id, kind: p.kind, target: p.target }))), context_digest: hash, target: { phase: "action_requirements", outcomes: ["inventory.update"] },
    material: [], evidence: [], continuation: "action_rule_review" };
  return { proposals, binding, question: { ...body, digest: canonicalJsonDigest(body) } };
}

describe("closed Action requirement format", () => {
  it("decodes a precompile typed question with its original partial material", () => {
    const f = requirementFixture();
    expect(parseOperatorQuestion(f.question)).toEqual(f.question);
  });
  it("keeps proposal separate from explicit local confirmation", () => {
    const f = requirementFixture(), q = parseOperatorQuestion(f.question);
    const proposed = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision,
      source_reference: canonicalJsonDigest(f.binding), disposition: "proposed", value: { kind: "action_requirements", proposals: f.proposals } });
    expect(proposed.confirmation).toBeUndefined();
    expect(confirmOperatorAnswer(proposed).confirmation?.actor).toBe("local_installation_operator");
  });
  it("renders the exact typed target and execution setting", () => {
    const f = requirementFixture(), q = parseOperatorQuestion(f.question);
    const proposed = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision,
      source_reference: canonicalJsonDigest(f.binding), disposition: "proposed", value: { kind: "action_requirements", proposals: f.proposals } });
    const lines = operatorQuestionReadback(proposed).join("\n");
    expect(lines).toContain("effect.writeback"); expect(lines).toContain("proposal_only"); expect(lines).toContain("inventory.update");
  });
  it("reserves a new protocol and Resume instead of changing emitted formats", () => {
    expect(STRUCTURED_AUTHORING_PROTOCOL_VERSION).toBe("synapsor.structured-authoring.v5");
    expect(STRUCTURED_AUTHORING_RESUME_VERSION).toBe("synapsor.boundary-authoring-resume.v6");
  });
  it("accepts only proposal DATA in its new Action draft version", () => {
    const f = requirementFixture(), legacy = structuredTestAction("inventory.update", "amount", 100, 10);
    const next = { ...legacy, schema_version: "synapsor.action-rule-model-draft.v3", requirement_proposals: f.proposals };
    expect(parseActionRuleModelDraftProposal(next as never)).toEqual(next);
    expect(() => parseActionRuleModelDraftProposal({ ...legacy, requirement_proposals: f.proposals } as never)).toThrow();
    expect(() => parseActionRuleModelDraftProposal({ ...next, confirmation: { actor: "local_installation_operator" } } as never)).toThrow();
  });
});

describe("Action requirement substitution and unsupported meaning fences", () => {
  const count = () => ({ id: "daily_approvals", kind: "approval_count", target: { slot: "approval.shared_limits", outcome: "inventory.update", limit_id: "daily" },
    intent: "replace", previous_limits: [], value: { state: "proposed", basis: "rolling_approved_events", scope: "tenant_object", maximum: 3,
      window_seconds: 86400, selector: { kind: "all_outcomes" } } });
  it("keeps calendar and distinct-customer counting explicitly unsupported", () => {
    const c = count(); expect(parseActionRequirementProposals([c])).toEqual([c]);
    for (const basis of ["calendar_day", "distinct_customers", "lifetime"])
      expect(() => parseActionRequirementProposals([{ ...c, value: { ...c.value, basis } }])).toThrow();
    for (const window_seconds of [0, 59, 31_536_001, 1.5, Infinity])
      expect(() => parseActionRequirementProposals([{ ...c, value: { ...c.value, window_seconds } }])).toThrow();
    expect(() => parseActionRequirementProposals([{ ...c, value: { ...c.value, maximum: Number.MAX_SAFE_INTEGER + 1 } }])).toThrow();
  });
  it("exports the same closed model grammar without actor or arbitrary patch fields", () => {
    const validate = new Ajv2020({ strict: false }).compile(actionRequirementProposalsJsonSchema());
    for (const valid of [requirementFixture().proposals, [count()]]) expect(validate(valid), JSON.stringify(validate.errors)).toBe(true);
    const c = count();
    for (const invalid of [[{ ...c, actor: "local_installation_operator" }], [{ ...c, target: { path: "/anything" } }],
      [{ ...c, value: { ...c.value, basis: "calendar_day" } }], [{ ...c, value: { ...c.value, selector: null } }]]) expect(validate(invalid)).toBe(false);
  });
  it("retains the exact old count tuple and distinguishes all outcomes from one outcome", () => {
    const c = count(), old = { id: "daily", kind: "count", scope: "tenant_object", maximum: 3, window_seconds: 86400 };
    const retained = { ...c, intent: "retain", previous_limits: [old] };
    expect(parseActionRequirementProposals([retained])).toEqual([retained]);
    expect(() => parseActionRequirementProposals([{ ...retained, value: { ...c.value, selector: { kind: "outcome", outcome: "inventory.update" } } }])).toThrow();
    expect(() => parseActionRequirementProposals([{ ...retained, value: { ...c.value, maximum: 4 } }])).toThrow();
    expect(() => parseActionRequirementProposals([{ ...c, value: { ...c.value, selector: null } }])).toThrow();
  });
  it("refuses a pooled selector in capability scope in parser and model grammar", () => {
    const c = count(), validate = new Ajv2020({ strict: false }).compile(actionRequirementProposalsJsonSchema());
    const conflict = { ...c, value: { ...c.value, scope: "capability" } };
    expect(() => parseActionRequirementProposals([conflict])).toThrow();
    expect(validate([conflict])).toBe(false);
    const exact = { ...conflict, value: { ...conflict.value, selector: { kind: "outcome", outcome: "inventory.update" } } };
    expect(parseActionRequirementProposals([exact])).toEqual([exact]); expect(validate([exact])).toBe(true);
  });
  it("keeps legacy capability selection bytes pending without relabelling them pooled", () => {
    const c = count(), prior = [{ id: "daily", kind: "count", scope: "capability", maximum: 3, window_seconds: 86400 }];
    const pending = [{ ...c, intent: "retain", previous_limits: prior, value: { state: "unknown", reason: "missing_meaning" } }];
    const before = structuredClone(pending), parsed = parseActionRequirementProposals(pending);
    expect(parsed).toEqual(before); expect(pending).toEqual(before); expect(actionRequirementsPending(parsed)).toEqual([c.id]);
    const readback = actionRequirementsReadback(parsed).join("\n");
    expect(readback).toContain("selection review pending"); expect(readback).toContain("each current outcome separately");
    expect(readback).not.toContain("all participating outcomes");
    expect(() => parseActionRequirementProposals([{ ...pending[0], value: { ...c.value, scope: "capability" } }])).toThrow();
    expect(() => parseActionRequirementProposals([{ ...pending[0], value: { ...c.value, scope: "capability", selector: { kind: "outcome", outcome: "inventory.update" } } }])).toThrow();
  });
  it("refuses unknown fields, kind/target substitutions and duplicate requirements", () => {
    const f = requirementFixture();
    for (const value of [{ ...f.proposals[0], confirmed: true }, { ...f.proposals[0], actor: "local_installation_operator" },
      { ...f.proposals[0], target: { slot: "catalog.column", resource: "inventory", field: "quantity" } },
      { ...f.proposals[0], value: { state: "proposed", mode: "automatic" } }]) expect(() => parseActionRequirementProposals([value])).toThrow();
    expect(() => parseActionRequirementProposals([...f.proposals, ...f.proposals])).toThrow();
    expect(() => parseActionRequirementProposals([...f.proposals, { ...f.proposals[0], id: "other" }])).toThrow();
  });
  it("never confirms an explicit unknown or projects pending proposal DATA", () => {
    const f = requirementFixture(), b = structuredClone(f.binding);
    const pending = [{ ...f.proposals[0], value: { state: "unknown", reason: "missing_meaning" } }];
    const cp = b.origin.checkpoint;
    cp.requirement_proposals = pending as never;
    const material = { intent_digest: cp.intent_digest, context_digest: cp.context_digest, components: cp.components, requirement_proposals: pending,
      question: { question: cp.pending_question.question, operator_message: cp.pending_question.operator_message, policy_source_digest: null } };
    cp.logical_turns[0]!.completed.material_digest = canonicalJsonDigest(material);
    const { digest: _, ...body } = cp; cp.digest = canonicalJsonDigest(body); b.proposals = pending as never;
    const q = prepareActionRequirementsOperatorQuestion({ binding: b as never });
    const proposed = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision, source_reference: canonicalJsonDigest(b),
      disposition: "proposed", value: { kind: "action_requirements", proposals: pending } });
    expect(() => confirmOperatorAnswer(proposed)).toThrow("pending");
    expect(() => projectConfirmedActionRequirements(proposed)).toThrow("UNCONFIRMED");
  });
  it("requires exact full original partial material and rejects completion grafts", () => {
    const f = requirementFixture();
    expect(() => assertActionRequirementsQuestionGeneration(f.binding as never)).toThrow();
    const changed = structuredClone(f.binding); changed.proposals[0]!.value.mode = "supervised";
    expect(() => parseActionRequirementsQuestionBinding(changed)).toThrow();
    const other = structuredClone(f.binding); other.origin.checkpoint.components = { approval: { substituted: true } } as never;
    expect(() => parseActionRequirementsQuestionBinding(other)).toThrow();
    for (const schema_version of ["synapsor.action-authoring-checkpoint.v1", "synapsor.action-authoring-checkpoint.v3"])
      expect(() => parseActionRuleAuthoringCheckpoint({ ...f.binding.origin.checkpoint, schema_version })).toThrow();
  });
  it("requires full current dependencies and exact confirmed proposal identity", () => {
    const f = requirementFixture(), q = prepareActionRequirementsOperatorQuestion({ binding: f.binding as never });
    const proposed = proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision, source_reference: canonicalJsonDigest(f.binding),
      disposition: "proposed", value: { kind: "action_requirements", proposals: f.proposals as never } });
    const confirmed = confirmOperatorAnswer(proposed);
    expect(projectConfirmedActionRequirements(confirmed).proposals).toEqual(f.proposals);
    expect(() => assertActionRequirementsQuestionDependencies(confirmed, f.binding.dependencies as never)).not.toThrow();
    for (const key of ["root_digest", "source_digest", "store_digest", "session_digest", "catalog_digest", "generation_lock_fingerprint"])
      expect(() => assertActionRequirementsQuestionDependencies(confirmed, { ...f.binding.dependencies, [key]: canonicalJsonDigest(key) } as never)).toThrow("CHANGED");
    expect(() => assertActionRequirementsQuestionDependencies(confirmed, { ...f.binding.dependencies, intended_ast: { different: true } } as never)).toThrow("CHANGED");
    expect(() => assertActionRequirementsQuestionDependencies(confirmed, { ...f.binding.dependencies, resume_revision: 2 } as never)).toThrow("CHANGED");
    expect(() => proposeOperatorAnswer(q, { question_id: q.id, revision: q.revision, source_reference: canonicalJsonDigest(f.proposals),
      disposition: "proposed", value: { kind: "action_requirements", proposals: f.proposals } })).toThrow();
  });
  it("binds units and transition values to complete inspected column types", () => {
    const column = { resource: "inventory", field: "quantity", source: "warehouse", physical_identity: "public.inventory.quantity",
      nullable: false, scalar_type: { kind: "integer" as const }, minimum: 0, maximum: 100 };
    const target = { slot: "catalog.column", resource: column.resource, field: column.field, type_fingerprint: canonicalJsonDigest(column) };
    const unit = { id: "quantity_unit", kind: "column_unit", target, value: { state: "proposed", kind: "integer", unit: "reviewed_units", scale: 1, meaning: "One unit is one reviewed item." } };
    const parsed = parseActionRequirementProposals([unit]);
    expect(() => assertActionRequirementColumns(parsed, [column])).not.toThrow();
    expect(() => assertActionRequirementColumns(parsed, [{ ...column, nullable: true }])).toThrow();
    expect(() => parseActionRequirementProposals([{ ...unit, value: { ...unit.value, scale: 100 } }])).toThrow();
    const transition = { id: "quantity_transition", kind: "transition", target: { ...target, slot: "patches" },
      value: { state: "proposed", to: 10, allowed_from: [0, 5] } };
    expect(() => assertActionRequirementColumns(parseActionRequirementProposals([transition]), [column])).not.toThrow();
    expect(() => assertActionRequirementColumns(parseActionRequirementProposals([{ ...transition, value: { ...transition.value, to: "10" } }]), [column])).toThrow();
    expect(() => assertActionRequirementColumns(parseActionRequirementProposals([{ ...transition, value: { ...transition.value, allowed_from: [101] } }]), [column])).toThrow();
    expect(() => parseActionRequirementProposals([{ ...transition, value: { ...transition.value, allowed_from: [10] } }])).toThrow();
  });
});
