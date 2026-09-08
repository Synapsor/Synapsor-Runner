import { describe, expect, it, vi } from "vitest";
import { validateOwnerPolicyParent, type PolicyManagementParent } from "@synapsor-runner/mcp-server";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import { draftOperatorParentPolicy, OwnerPolicyParentModelError, type ParentDelegationCatalog,
  buildOperatorParentCatalog, type TrustedParentIdentityBindings } from "./owner-policy-parent-model.js";

function fixture() {
  const f = ownerPolicyTestFixture();
  const bindings: TrustedParentIdentityBindings = {
    managers: [{ subject: "trusted-manager", actor_kind: "human", tenant_id: "acme", scope: { mode: "deployment" }, permissions: ["inspect", "draft", "activate", "revoke", "audit"] }],
    agent_owners: [{ agent: "agent-a", scope: { level: "principal", tenant_id: "acme", principal: "maya" } },
      { agent: "agent-b", scope: { level: "principal", tenant_id: "beta", principal: "maya" } }],
  };
  const current: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", ...bindings, delegation: f.parent };
  const catalog: ParentDelegationCatalog = { outcomes: f.parent.outcomes.map((outcome) => ({ ...outcome,
    effect_envelope: { operation: f.compiled.effect_envelope.operation, target_resource: f.compiled.effect_envelope.target_resource,
      allowed_fields: f.compiled.effect_envelope.allowed_fields, writeback: f.compiled.effect_envelope.writeback } })) };
  return { f, bindings, current, catalog };
}

function response(args: unknown) {
  return { status: 200, body: { output: [{ type: "function_call", call_id: "parent", name: "runner__draft_operator_parent", arguments: JSON.stringify(args) }] } };
}
function prose(content: string) {
  return { status: 200, body: { choices: [{ message: { role: "assistant", content } }] } };
}

type DraftInput = Parameters<typeof draftOperatorParentPolicy>[0];
type TestDraftInput = Omit<DraftInput, "session" | "operatorMessage" | "egressAcknowledged"> & {
  session?: Partial<DraftInput["session"]>;
  operatorMessage?: string;
  egressAcknowledged?: boolean;
};

function request(input: TestDraftInput) {
  const { session, operatorMessage = "Permit routine inventory adjustments through reviewed owner rules.", egressAcknowledged = true, ...rest } = input;
  return draftOperatorParentPolicy({ ...rest, session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", ...session },
    operatorMessage, egressAcknowledged });
}

describe("operator parent model drafting", () => {
  it("lets the operator correct an unactivated approval choice without treating it as the parent ceiling", async () => {
    const x = fixture();
    const candidate = structuredClone(x.current);
    candidate.delegation.outcomes[0]!.allow_automatic_approval = false;
    const next = structuredClone(x.f.parent);
    next.outcomes[0]!.allow_automatic_approval = true;
    const requestJson = vi.fn(async (_request: unknown) => response({ state: "candidate", delegation: next,
      summary: "Eligible requests may inherit the existing Action approval policy; all compiled checks remain mandatory." }));
    const result = await request({ session: { dependencies: { requestJson } }, currentParent: candidate, activeParent: null,
      identityBindings: x.bindings, catalog: x.catalog, compiledRules: [x.f.compiled],
      operatorMessage: "Correct this unactivated draft: permit routine requests to inherit the Action approval policy." });
    expect(result).toMatchObject({ state: "candidate", authority_granted: false, correction_used: false });
    expect(result.state === "candidate" && result.parent.delegation.outcomes[0]!.allow_automatic_approval).toBe(true);
    expect(candidate.delegation.outcomes[0]!.allow_automatic_approval).toBe(false);
    const prompt = JSON.stringify(requestJson.mock.calls[0]![0]);
    expect(prompt).toContain("Editable candidate delegation");
    expect(prompt).toContain("Currently activated delegation: null");
    expect(prompt).toContain("not an immutable parent ceiling");
    expect(requestJson).toHaveBeenCalledOnce();
  });
  it("builds a bounded catalog from compiler facts with raw identifiers for ambiguous fields", () => {
    const f = ownerPolicyTestFixture("inventory", true);
    const catalog = buildOperatorParentCatalog([f.compiled]);
    expect(catalog.outcomes[0]!.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "quantity", title: "Requested units", source: { kind: "input", name: "quantity" } }),
      expect.objectContaining({ name: "current_time", source: { kind: "trusted", binding: "transaction_time" } }),
    ]));
    expect(catalog.outcomes[0]!.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "request.f09", title: "request.f09", ambiguous_label: true,
        source: { kind: "field", binding: "request", field: "f09" } }),
      expect.objectContaining({ name: "derived.next_units", title: "derived.next_units", ambiguous_label: true }),
    ]));

    const preserved = buildOperatorParentCatalog([f.compiled], { schema_version: "synapsor.policy-management-parent.v1",
      ...fixture().bindings, delegation: f.parent });
    expect(preserved.outcomes[0]!.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "current_units", title: "Current units", operators: ["lte", "gte", "eq"] }),
    ]));
    const noRange = ownerPolicyTestFixture();
    const quantity = noRange.compiled.rule.inputs?.find((input) => input.name === "quantity");
    if (!quantity) throw new Error("Expected quantity input.");
    delete (quantity as { minimum?: number }).minimum;
    delete (quantity as { maximum?: number }).maximum;
    expect(buildOperatorParentCatalog([noRange.compiled]).outcomes[0]!.facts.find((fact) => fact.source.kind === "input")?.literal_range)
      .toBeUndefined();
    expect(() => buildOperatorParentCatalog(Array.from({ length: 33 }, () => f.compiled))).toThrow(/PARENT_MODEL_CATALOG_TOO_LARGE/);
  });

  it("clarifies an ambiguous coded field, then accepts its exact source with an operator-supplied title", async () => {
    const f = ownerPolicyTestFixture("inventory", true), x = fixture();
    const catalog = buildOperatorParentCatalog([f.compiled]);
    const fresh = {
      schema_version: "synapsor.owner-policy-parent.v1" as const,
      agents: ["agent-a", "agent-b"],
      outcomes: catalog.outcomes.map(({ effect_envelope: _effect, ...outcome }) => ({ ...outcome,
        facts: outcome.facts.map(({ ambiguous_label: _ambiguous, ...fact }) => fact) })),
    };
    const coded = fresh.outcomes[0]!.facts.find((fact) => fact.source.kind === "field" && fact.source.field === "f09");
    if (!coded) throw new Error("Expected coded field.");
    coded.title = "Available units";
    const clarification = await request({ session: { dependencies: { requestJson: async () => response({ state: "clarification",
      question: "What does request.f09 represent?" }) } }, currentParent: null, identityBindings: x.bindings, catalog, compiledRules: [f.compiled] });
    expect(clarification).toMatchObject({ state: "clarification", question: "What does request.f09 represent?" });
    const result = await request({ session: { dependencies: { requestJson: async () => response({ state: "candidate", delegation: fresh,
      summary: "Use the reviewed available-units field." }) } }, operatorMessage: "request.f09 means available units.", currentParent: null,
      identityBindings: x.bindings, catalog, compiledRules: [f.compiled] });
    expect(result).toMatchObject({ state: "candidate" });
    expect(result.state === "candidate" && result.parent.delegation.outcomes[0]!.facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Available units", source: { kind: "field", binding: "request", field: "f09" } }),
    ]));
  });

  it("returns a validated candidate while preserving trusted bindings and existing settings", async () => {
    const x = fixture();
    const requestJson = vi.fn(async (_request: unknown) => response({ state: "candidate", delegation: x.f.parent, summary: "Keep the reviewed inventory policy." }));
    const result = await request({ session: { dependencies: { requestJson } }, currentParent: x.current, identityBindings: x.bindings,
      compiledRules: [x.f.compiled] });
    expect(result).toMatchObject({ state: "candidate", correction_used: false, authority_granted: false, source_database_changed: false });
    if (result.state !== "candidate") throw new Error("Expected candidate.");
    expect(result.parent.managers).toEqual(x.bindings.managers);
    expect(result.parent.agent_owners).toEqual(x.bindings.agent_owners);
    expect(result.parent.delegation).toEqual(x.f.parent);
    expect(JSON.stringify(requestJson.mock.calls[0]![0])).not.toContain("trusted-manager");
    expect(JSON.stringify(requestJson.mock.calls[0]![0])).not.toContain('"maya"');
    expect(JSON.stringify(requestJson.mock.calls[0]![0])).toContain("Allowed delegable agent IDs");
    expect(JSON.stringify(requestJson.mock.calls[0]![0])).toContain("eligibility check remains mandatory at runtime");
    expect(JSON.stringify(requestJson.mock.calls[0]![0])).toContain("agent-a");
  });

  it("allows operator-reviewed limits on a verified fact without a prior literal restriction", async () => {
    const x = fixture();
    const delegation = structuredClone(x.f.parent);
    delegation.outcomes[0]!.facts.find((fact) => fact.name === "current_units")!.literal_range = { minimum: 0, maximum: 100 };
    expect(() => validateOwnerPolicyParent({ parent: delegation, rules: [x.f.compiled] })).not.toThrow();
    const result = await request({ session: { dependencies: { requestJson: async () => response({
      state: "candidate", delegation, summary: "Owners may compare current units against thresholds from zero through one hundred.",
    }) } }, operatorMessage: "Allow current-unit comparison thresholds only from zero through one hundred.",
    currentParent: x.current, identityBindings: x.bindings, catalog: x.catalog, compiledRules: [x.f.compiled] });
    expect(result).toMatchObject({ state: "candidate", correction_used: false });
  });

  it("returns one business clarification without assembling bindings", async () => {
    const x = fixture();
    const result = await request({ session: { dependencies: { requestJson: async () => response({ state: "clarification", question: "Which reviewed outcome should be delegated?" }) } },
      currentParent: x.current, identityBindings: x.bindings, catalog: x.catalog, compiledRules: [x.f.compiled] });
    expect(result).toEqual({ state: "clarification", question: "Which reviewed outcome should be delegated?", correction_used: false,
      authority_granted: false, source_database_changed: false });
  });

  it("bounds recursive model documents before parsing and permits one corrected draft", async () => {
    const x = fixture();
    let predicate: unknown = { kind: "constant", value: true };
    for (let depth = 0; depth < 80; depth++) predicate = { kind: "all", predicates: [predicate] };
    const invalid = structuredClone(x.f.parent);
    Object.assign(invalid.outcomes[0]!, { require: predicate });
    let calls = 0;
    const requestJson = vi.fn(async (_request: unknown) => response(calls++ === 0
      ? { state: "candidate", delegation: invalid, summary: "Excessive recursive input." }
      : { state: "candidate", delegation: x.f.parent, summary: "Use the bounded reviewed policy." }));
    const result = await request({ session: { dependencies: { requestJson } }, currentParent: x.current,
      identityBindings: x.bindings, catalog: x.catalog, compiledRules: [x.f.compiled] });
    expect(result).toMatchObject({ state: "candidate", correction_used: true, authority_granted: false });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(result.state === "candidate" && result.parent).toEqual(x.current);
  });

  it("uses one correction for an unknown fact and never accepts an injected binding", async () => {
    const x = fixture(); let calls = 0;
    const invalid = structuredClone(x.f.parent);
    invalid.outcomes[0]!.facts[0]!.name = "invented_fact";
    const requestJson = vi.fn(async (_request: unknown) => response(calls++ === 0
      ? { state: "candidate", delegation: invalid, summary: "Bad fact." }
      : { state: "candidate", delegation: x.f.parent, summary: "Corrected reviewed policy." }));
    const result = await request({ session: { dependencies: { requestJson } }, currentParent: x.current, identityBindings: x.bindings,
      catalog: x.catalog, compiledRules: [x.f.compiled] });
    expect(result).toMatchObject({ state: "candidate", correction_used: true });
    expect(requestJson).toHaveBeenCalledTimes(2);

    calls = 0;
    const injected = vi.fn(async (_request: unknown) => response(calls++ === 0
      ? { state: "candidate", delegation: x.f.parent, summary: "Injected.", managers: [] }
      : { state: "candidate", delegation: x.f.parent, summary: "Corrected." }));
    const safe = await request({ session: { dependencies: { requestJson: injected } }, currentParent: x.current, identityBindings: x.bindings,
      catalog: x.catalog, compiledRules: [x.f.compiled] });
    expect(safe).toMatchObject({ state: "candidate", correction_used: true });
    expect(safe.state === "candidate" && safe.parent.managers).toEqual(x.bindings.managers);
  });

  it("allows normalized multiline operator text but corrects invented fact bounds", async () => {
    const x = fixture(); let calls = 0;
    const widened = structuredClone(x.f.parent);
    widened.outcomes[0]!.facts[0]!.literal_range = { minimum: 0, maximum: 100 };
    const requestJson = vi.fn(async (_request: unknown) => response(calls++ === 0
      ? { state: "candidate", delegation: widened, summary: "Widen the limit." }
      : { state: "clarification", question: "Which reviewed range should apply?" }));
    const result = await request({ session: { dependencies: { requestJson } }, operatorMessage: "Line one\r\n\tLine two",
      currentParent: x.current, identityBindings: x.bindings, catalog: x.catalog, compiledRules: [x.f.compiled] });
    expect(result).toMatchObject({ state: "clarification", correction_used: true });
    expect(JSON.stringify(requestJson.mock.calls[0]![0])).toContain("Line one\\\\n\\\\tLine two");
  });

  it("refuses stale bindings, missing known owner scopes, and provider egress without writing", async () => {
    const x = fixture();
    await expect(request({ session: {}, currentParent: { ...x.current, managers: [] }, identityBindings: x.bindings,
      catalog: x.catalog, compiledRules: [x.f.compiled] })).rejects.toMatchObject({ code: "PARENT_MODEL_BINDINGS_STALE" });
    const missing = structuredClone(x.f.parent); missing.agents.push("agent-missing");
    await expect(request({ session: { dependencies: { requestJson: async () => response({ state: "candidate", delegation: missing, summary: "Missing scope." }) } },
      currentParent: x.current, identityBindings: x.bindings, catalog: x.catalog, compiledRules: [x.f.compiled] })).rejects.toBeInstanceOf(OwnerPolicyParentModelError);
    await expect(draftOperatorParentPolicy({ session: { provider: "openai", model: "gpt-test", apiKey: "memory-key" },
      operatorMessage: "Draft parent.", currentParent: x.current, identityBindings: x.bindings, catalog: x.catalog,
      compiledRules: [x.f.compiled], egressAcknowledged: false })).rejects.toThrow();
  });

  it("does not retry provider authentication failures and preserves their sanitized category", async () => {
    const x = fixture();
    const requestJson = vi.fn(async (_request: unknown) => {
      throw Object.assign(new Error("credential=do-not-display"), { code: "ASK_PROVIDER_AUTHENTICATION_FAILED" });
    });
    await expect(request({ session: { dependencies: { requestJson } }, currentParent: x.current,
      identityBindings: x.bindings, catalog: x.catalog, compiledRules: [x.f.compiled] }))
      .rejects.toMatchObject({ code: "ASK_PROVIDER_AUTHENTICATION_FAILED" });
    expect(requestJson).toHaveBeenCalledTimes(1);
  });

  it("retries one missing required tool call, then returns the corrected candidate", async () => {
    const x = fixture(); let calls = 0;
    const requestJson = vi.fn(async (_request: unknown) => calls++ === 0
      ? prose("I would delegate the reviewed inventory action.")
      : response({ state: "candidate", delegation: x.f.parent, summary: "Corrected structured candidate." }));
    const result = await request({ session: { dependencies: { requestJson } }, currentParent: x.current,
      identityBindings: x.bindings, catalog: x.catalog, compiledRules: [x.f.compiled] });
    expect(result).toMatchObject({ state: "candidate", correction_used: true });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});
