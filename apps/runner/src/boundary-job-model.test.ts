import { declaredReadContext, preparedNativeReadContext } from "./test-fixtures/typed-read-context.js";
import { localProviderRefusal } from "./test-fixtures/provider-refusal.js";
import { describe, expect, it, vi } from "vitest";
import { BoundaryJobPlanningError, planningDiagnosticLines, type BoundaryJobPlanningDiagnostic } from "./boundary-job-diagnostics.js";
import { AskError } from "./model-ask.js";
import { authoringDestination, newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { READ_SCOPE_PROTOCOL, type ReadScopeProposal } from "./read-structured-scope.js";
import {
  planModelBoundaryJob,
  type BoundaryJobCurrentState,
} from "./boundary-job-model.js";

const reusableState: BoundaryJobCurrentState = {
  read: {
    boundary_name: "reviewed_staging",
    authority: "disabled",
    fully_reviewed: true,
    resource_ids: ["telecom.accounts", "telecom.billing_preferences"],
    exact_reusable_revision_count: 1,
  },
  actions: [],
  control_plane: {
    trusted_scope: "runner_injected",
    approval_history: "runner_proposal_ledger",
    model_may_supply_scope_values: false,
    model_may_supply_approval_history: false,
  },
};

describe("B64 structured planning scope", () => {
  const original = "Show the customer's selected account information.";
  const hash = canonicalJsonDigest;
  const context = () => ({ binding: { request_digest: hash(original), source_digest: hash(null), catalog_digest: hash("catalog"),
    meaning_digest: hash("meaning"), applicability_digest: hash("use"), operation_digest: hash("baseline") },
    references: [{ id: "job", kind: "request" as const, digest: hash(original), text: original }],
    catalog: { resources: [{ id: "telecom.accounts", fields: [{ id: "name" }] }], relationships: [] } });
  const scope = (): ReadScopeProposal => ({ protocol: READ_SCOPE_PROTOCOL, original_request: "job", applicability: "read_requested",
    requirements: [{ id: "account", references: ["job"], intended_use: "Selected account information", disposition: "include",
      targets: [{ root_resource: "telecom.accounts", resource: "telecom.accounts", operation: "resource" },
        { root_resource: "telecom.accounts", resource: "telecom.accounts", operation: "return", field: "name" }] }] });
  const planned = () => ({ status: "planned", read_mode: "create", read_intent: "Show selected account information", action_mode: "none",
    summary: "Prepare the requested disabled Read mapping", read_scope: scope() });
  const response = (args: unknown) => ({ status: 200, body: { output: [{ type: "function_call", call_id: "typed_plan",
    name: "runner__plan_boundary_job", arguments: JSON.stringify(args) }] } });
  function run(reply: () => unknown, current = context()) {
    const send = vi.fn(async () => response(reply()));
    return { send, result: planModelBoundaryJob({ session: { provider: "openai", model: "scripted", apiKey: "test-key", dependencies: { requestJson: send } },
      jobIntent: original, currentState: reusableState, egressAcknowledged: true,
      structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => current } }) };
  }
  it.each(["missing", "unsupported"] as const)("refuses %s planning scope protocol before provider access", async mode => {
    const send = vi.fn(async () => response(planned()));
    await expect(planModelBoundaryJob({ session: { provider: "openai", model: "scripted", apiKey: "test-key", dependencies: { requestJson: send } },
      jobIntent: original, currentState: reusableState, egressAcknowledged: true,
      structuredScope: mode === "missing" ? undefined : { protocol: "retired-protocol" as typeof READ_SCOPE_PROTOCOL, current: context } }))
      .rejects.toThrow(/READ_SCOPE_PROTOCOL_(REQUIRED|UNSUPPORTED)/u);
    expect(send).not.toHaveBeenCalled();
  });
  it("proposes an exact scope without inferring meaning from narration or marking it confirmed", async () => {
    const tested = run(planned); const result = await tested.result;
    expect(result).toMatchObject({ state: "planned", read_mode: "create", read_scope: { proposal: scope() }, authority_granted: false });
    expect(result).not.toHaveProperty("read_scope.confirmation");
    expect(tested.send).toHaveBeenCalledOnce();
  });
  it("does not use legacy inference when the typed field is missing", async () => {
    const tested = run(() => { const { read_scope: _scope, ...legacy } = planned(); return legacy; });
    await expect(tested.result).rejects.toThrow(/READ_SCOPE_INVALID/u);
    expect(tested.send).toHaveBeenCalledTimes(2);
  });
  it("cannot call explicitly requested Reads none", async () => {
    const tested = run(() => ({ ...planned(), read_mode: "none" }));
    await expect(tested.result).rejects.toThrow(/READ_SCOPE_ROUTE_INVALID/u);
    expect(tested.send).toHaveBeenCalledTimes(2);
  });
  it("represents an explicit no-Read interpretation without pretending its semantics are verified", async () => {
    const tested = run(() => ({ ...planned(), read_mode: "none", read_scope: { ...scope(), applicability: "no_read_requested", requirements: [] } }));
    const result = await tested.result;
    expect(result).toMatchObject({ state: "planned", read_mode: "none", read_scope: { proposal: { applicability: "no_read_requested" } } });
    expect(result).not.toHaveProperty("read_scope.confirmation");
  });
  it("does not infer reusable native scope from familiar names or counts", async () => {
    const tested = run(() => ({ ...planned(), read_mode: "reuse" }));
    await expect(tested.result).rejects.toThrow(/READ_SCOPE_NATIVE_COVERAGE_REQUIRED/u);
  });
  it("stops when reference identity changes during the actual planning turn", async () => {
    const current = context();
    const tested = run(() => { current.binding.request_digest = hash("different request"); return planned(); }, current);
    await expect(tested.result).rejects.toThrow();
    expect(tested.send).toHaveBeenCalledOnce();
  });
});

describe("model Boundary job planning", () => {
  it.each(["ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION","ASK_GENERATION_OUTCOME_UNKNOWN","ASK_GENERATION_NOT_SENT"])("preserves %s after planning diagnostics without a semantic retry",async code=>{
    const failure=new AskError(code,"DERIVED transport stop"),requestJson=vi.fn(async()=>{throw failure;});
    let diagnostic:BoundaryJobPlanningDiagnostic|undefined;
    await expect(planModelBoundaryJob({session:{provider:"openai",model:"gpt-test",apiKey:"memory-key",dependencies:{requestJson}},
      jobIntent:"Read my services.",currentState:reusableState,egressAcknowledged:true,onDiagnostic:d=>{diagnostic=d;}})).rejects.toBe(failure);
    expect(requestJson).toHaveBeenCalledOnce();expect(diagnostic?.attempts).toHaveLength(1);expect(diagnostic?.attempts[0]?.code).toBe(code);
  });

  it.each(["claude-code", "cursor", "vscode", "later", undefined])("carries an already selected client as a bounded setup preference (%s)", async intendedClient => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "plan",
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: "reuse", action_mode: "none",
        ...(intendedClient ? { intended_client: intendedClient } : {}), summary: "Keep the reviewed access." }) }] } }));
    const before = structuredClone(reusableState);
    const result = await planModelBoundaryJob({ session: { provider: "openai", model: "fixture", apiKey: "test-key", dependencies: { requestJson } },
      jobIntent: intendedClient ? `Use ${intendedClient} with the existing access.` : "Keep the current access.",
      currentState: reusableState, egressAcknowledged: true });
    expect(result).toMatchObject({ state: "planned", authority_granted: false, source_database_changed: false });
    if (intendedClient) expect(result).toHaveProperty("intended_client", intendedClient);
    else expect(result).not.toHaveProperty("intended_client");
    expect(requestJson).toHaveBeenCalledOnce();
    expect(reusableState).toEqual(before);
  });
  it("rejects custom paths or configuration objects in the client preference", async () => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "plan",
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: "reuse", action_mode: "none",
        intended_client: { command: "unreviewed", args: [] }, summary: "Keep the reviewed access." }) }] } }));
    await expect(planModelBoundaryJob({ session: { provider: "openai", model: "fixture", apiKey: "test-key", dependencies: { requestJson } },
      jobIntent: "Keep the current access.", currentState: reusableState, egressAcknowledged: true })).rejects.toThrow("supported client choice");
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
  it.each([
    { fully_reviewed: false, revision_eligible: true },
    { fully_reviewed: true, revision_eligible: false },
    { fully_reviewed: true, revision_eligible: undefined },
  ])("advertises mode-specific Read intent bounds for $fully_reviewed/$revision_eligible", async (readState) => {
    const state = { ...reusableState, read: { ...reusableState.read, ...readState, resumable_draft_count: 1 } };
    const before = structuredClone(state);
    const requestJson = vi.fn(async (request) => {
      const tool = (request.body.tools as Array<Record<string, unknown>>).find(candidate => candidate.name === "runner__plan_boundary_job")!;
      const schema = tool.parameters as { oneOf: Array<{ required: string[]; properties: Record<string, { enum?: string[]; maxLength?: number }> }> };
      const plans = schema.oneOf.filter(branch => branch.properties.action_mode?.enum?.includes("none"));
      expect(plans.find(branch => branch.properties.read_mode?.enum?.includes("create"))).toMatchObject({
        required: expect.arrayContaining(["read_intent"]),
        properties: { read_mode: { enum: ["create"] }, read_intent: { maxLength: 500 } },
      });
      const revise = plans.find(branch => branch.properties.read_mode?.enum?.includes("revise"));
      if (readState.revision_eligible ?? readState.fully_reviewed) {
        expect(revise).toMatchObject({ required: expect.arrayContaining(["read_intent"]),
          properties: { read_mode: { enum: ["revise"] }, read_intent: { maxLength: 2000 } } });
      } else expect(revise).toBeUndefined();
      expect(plans.flatMap(branch => branch.properties.read_mode?.enum ?? [])).toEqual(
        expect.arrayContaining(["create", "resume", "reuse", "none"]));
      return { status: 200, body: { output: [{ type: "function_call", call_id: "schema", name: "runner__plan_boundary_job",
        arguments: JSON.stringify({ status: "planned", read_mode: "create", read_intent: "x".repeat(500), action_mode: "none", summary: "Map the requested reads." }) }] } };
    });
    await expect(planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "test-key", dependencies: { requestJson } },
      jobIntent: "Prepare the requested reads.", currentState: state, egressAcknowledged: true })).resolves.toMatchObject({ state: "planned", read_mode: "create" });
    expect(requestJson).toHaveBeenCalledOnce();
    expect(state).toEqual(before);
  });

  it.each([500, 505])("diagnoses unavailable revise then a %i-character create correction without changing saved state", async length => {
    const state: BoundaryJobCurrentState = { ...reusableState,
      read: { ...reusableState.read, fully_reviewed: true, revision_eligible: false, exact_reusable_revision_count: 0, resumable_draft_count: 0 },
      actions: ["student.accept_offer", "student.restore_drop"].map(outcome => ({ capability: "app.request_change", kind: "rule_derived", outcome, authority: "disabled" })) };
    const before = structuredClone(state);
    const requests: string[] = [];
    const privateText = "Private fixture business wording must not appear in diagnostics. ";
    let diagnostic: BoundaryJobPlanningDiagnostic | undefined;
    const result = planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "test-key", dependencies: {
      requestJson: async request => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { status: "completed", output: [{ type: "function_call", call_id: `attempt_${requests.length}`,
          name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned",
            read_mode: requests.length === 1 ? "revise" : "create", read_intent: privateText.padEnd(length, "x"), action_mode: "reuse",
            summary: "Preserve both prepared actions and the unanswered advising limits." }) }] } };
      },
    } }, jobIntent: "Correct only Read privacy. Preserve both prepared actions and leave advising limits unanswered.",
      currentState: state, egressAcknowledged: true, onDiagnostic: value => { diagnostic = value; } });
    if (length === 505) await expect(result).rejects.toThrow("read_mode=create read_intent is 505 characters; maximum is 500");
    else await expect(result).resolves.toMatchObject({ state: "planned", read_mode: "create", action_mode: "reuse", correction_used: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("read_mode=create requires read_intent of at most 500 characters");
    expect(diagnostic).toMatchObject({ model_requests: 2, authority_changed: false, source_database_changed: false,
      attempts: [{ phase: "initial", category: "contract_validation", message: expect.stringContaining("read_mode=revise requires an exact current Read revision") },
        { phase: "correction", category: length === 505 ? "contract_validation" : "accepted", response: { http_status: 200, status: "completed" } }] });
    expect(JSON.stringify(diagnostic)).not.toContain(privateText.trim());
    expect(state).toEqual(before);
  });

  it("keeps correction guidance consistent with an eligible incomplete Read revision", async () => {
    const state = { ...reusableState, read: { ...reusableState.read, fully_reviewed: false, revision_eligible: true,
      exact_reusable_revision_count: 0, resumable_draft_count: 1, resumable_resource_ids: ["telecom.accounts"] } };
    const requests: string[] = [];
    const result = await planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "test-key", dependencies: {
      requestJson: async request => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: `mode_${requests.length}`, name: "runner__plan_boundary_job",
          arguments: JSON.stringify({ status: "planned", read_mode: requests.length === 1 ? "resume" : "revise",
            read_intent: "Read telecom.accounts and telecom.billing_preferences.", action_mode: "none", summary: "Correct the saved access." }) }] } };
      },
    } }, jobIntent: "Read telecom.accounts and telecom.billing_preferences.", availableResourceIds: ["telecom.accounts", "telecom.billing_preferences"],
      currentState: state, egressAcknowledged: true });
    expect(result).toMatchObject({ state: "planned", read_mode: "revise", correction_used: true });
    expect(requests[1]).toContain("Choose revise or create.");
    expect(requests[1]).not.toContain("revise is unavailable until");
  });

  it.each([566, 611, 631, 683, 2000])("retains a %i-character access revision without forcing it into a read-question limit", async (length) => {
    const read_intent = "Keep the original student privacy policy and current admission check. ".padEnd(length, "x");
    const state = { ...reusableState, actions: [{ capability: "app.request_change", kind: "rule_derived" as const,
      outcome: "student.accept_offer", authority: "disabled" as const }] };
    const before = structuredClone(state);
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: "revise", read_intent,
        action_mode: "reuse", summary: "Revise access; preserve both saved business rules and unfinished advising work." }) }] } }));
    const result = await planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "test-key", dependencies: { requestJson } },
      jobIntent: "Keep only the public fields from the original policy, preserving admission and all three behaviors.", currentState: state, egressAcknowledged: true });
    expect(result).toMatchObject({ state: "planned", read_mode: "revise", read_intent, action_mode: "reuse", correction_used: false });
    expect(requestJson).toHaveBeenCalledOnce();
    expect(state).toEqual(before);
  });

  it.each([["revise", 2001, 2000], ["create", 501, 500]] as const)("keeps %s text bounded without truncating its content", async (read_mode, length, maximum) => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "long",
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode, read_intent: "x".repeat(length),
        action_mode: "none", summary: "Prepare access." }) }] } }));
    await expect(planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "test-key", dependencies: { requestJson } },
      jobIntent: "Adjust customer access.", currentState: reusableState, egressAcknowledged: true })).rejects.toThrow(`maximum is ${maximum}`);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("revises an exact incomplete candidate without remapping or claiming review readiness", async () => {
    const state: BoundaryJobCurrentState = { ...reusableState, read: { ...reusableState.read,
      fully_reviewed: false, revision_eligible: true, exact_reusable_revision_count: 0, resumable_draft_count: 1 },
      actions: [{ capability: "app.request_change", kind: "rule_derived", outcome: "billing.change", authority: "disabled" }] };
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "edit",
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: "revise",
        read_intent: "Keep internal identifiers private without changing customer-facing references.", action_mode: "reuse",
        summary: "Change only saved access settings; retain the billing rule." }) }] } }));
    const result = await planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "test-key", dependencies: { requestJson } },
      jobIntent: "Keep internal identifiers private. Preserve the billing rule.", currentState: state, egressAcknowledged: true });
    expect(result).toMatchObject({ state: "planned", read_mode: "revise", action_mode: "reuse", correction_used: false });
    expect(requestJson).toHaveBeenCalledOnce();
    expect(state.read.fully_reviewed).toBe(false);
  });
  it("repairs an incomplete resumed mapping using an available mode, not an impossible reviewed revision", async () => {
    const requests: string[] = [];
    const state = { ...reusableState, read: { ...reusableState.read, fully_reviewed: false,
      exact_reusable_revision_count: 0, resumable_draft_count: 1, resumable_resource_ids: ["telecom.accounts"] } };
    const before = structuredClone(state);
    const result = await planModelBoundaryJob({
      session: { provider: "openai", model: "gpt-test", apiKey: "test-key", dependencies: {
        requestJson: async (request) => {
          requests.push(JSON.stringify(request.body));
          return { status: 200, body: { output: [{ type: "function_call", call_id: `plan_${requests.length}`, name: "runner__plan_boundary_job",
            arguments: JSON.stringify({ status: "planned", read_mode: requests.length === 1 ? "resume" : "create",
              read_intent: "Read the customer's telecom.accounts and telecom.billing_preferences.", action_mode: "none", summary: "Prepare both requested customer read areas." }) }] } };
        },
      } },
      jobIntent: "Read the customer's telecom.accounts and telecom.billing_preferences.", availableResourceIds: ["telecom.accounts", "telecom.billing_preferences"],
      currentState: state, egressAcknowledged: true,
    });
    expect(result).toMatchObject({ state: "planned", read_mode: "create", correction_used: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("Use read_mode=create to prepare the corrected disabled mapping; revise is unavailable");
    expect(requests[1]).not.toContain("Choose revise or create.");
    expect(state).toEqual(before);
  });
  it.each(["Customer account, subscription and recent usage.", "Read the customer's account, subscription and recent usage."])("accepts a concise typed Read intent without requiring a particular verb: %s", async (read_intent) => {
    const typed = declaredReadContext("Read customer account, subscription and recent usage.", ["telecom.accounts", "telecom.subscriptions", "telecom.usage_daily"]);
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "plan", name: "runner__plan_boundary_job",
      arguments: JSON.stringify({ status: "planned", read_mode: "create", read_intent, action_mode: "none", summary: "Prepare the requested customer information.", read_scope: typed.proposal }),
    }] } }));
    const result = await planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      jobIntent: "Read customer account, subscription and recent usage.",
      availableResourceIds: ["telecom.accounts", "telecom.subscriptions", "telecom.usage_daily"],
      currentState: reusableState, egressAcknowledged: true, structuredScope: typed.structuredScope });
    expect(result).toMatchObject({ state: "planned", correction_used: false });
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it("does not invent explicit resource requests from individual words in a mixed business job", async () => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "plan", name: "runner__plan_boundary_job",
      arguments: JSON.stringify({ status: "planned", read_mode: "create", read_intent: "Customer information according to the attached policy.",
        action_mode: "create", action_intent: "Handle offered plan changes according to the policy with separately reviewed automatic completion.",
        summary: "Map the policy's customer information and one plan-change outcome." }),
    }] } }));
    const result = await planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      jobIntent: "Help customers understand their services and handle offered plan changes according to this policy, including automatic completion where allowed.",
      availableResourceIds: ["telecom.plan_change_offers", "telecom.service_lines"], currentState: reusableState, egressAcknowledged: true });
    expect(result).toMatchObject({ state: "planned", correction_used: false });
    expect(requestJson).toHaveBeenCalledOnce();
  });
  it.each(["schema", "missing_intent", "incomplete", "wrong_tool", "malformed"])("preserves precise %s failure and the approved source through exactly one correction", async (failure) => {
    const bodies: Array<Record<string, unknown>> = [];
    let diagnostic: BoundaryJobPlanningDiagnostic | undefined;
    const policy = newPolicySourceSession();
    const source = policyTextSnapshot(Buffer.from("Allow routine changes. Keep account IDs private.\nAt most 10 overall, 3 per account. Complete only after separate execution review."), "policy.txt");
    policy.snapshots = [source]; policy.active = 1;
    policy.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "gpt-test" }) }];
    const valid = { status: "planned", read_mode: "reuse", action_mode: "create", action_strategy: "rule_derived",
      action_intent: "Apply the attached policy to offered plan changes, including approval limits and separately reviewed automatic completion.", summary: "Preserve Read and draft one bounded action." };
    const stateBefore = structuredClone(reusableState);
    const result = await planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "secret-test-key",
      conversation: { turns: [], policySources: policy }, dependencies: { requestJson: async (request) => {
        bodies.push(request.body);
        const first = bodies.length === 1;
        const args = first && failure === "schema" ? { ...valid, properties: { sensitive: "private-value-not-diagnostic" } }
          : first && failure === "missing_intent" ? { ...valid, action_intent: undefined } : valid;
        return { status: 200, body: { status: first && failure === "incomplete" ? "incomplete" : "completed",
          ...(first && failure === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          output: [{ type: "function_call", call_id: "plan",
            name: first && failure === "wrong_tool" ? "untrusted_secret_tool_name" : "runner__plan_boundary_job",
            arguments: first && failure === "malformed" ? "{unparseable" : JSON.stringify(args) }],
        } };
      } } }, jobIntent: "Draft the changes in my attached policy.", currentState: reusableState, egressAcknowledged: true,
      onDiagnostic: (value) => { diagnostic = value; } });
    expect(result).toMatchObject({ correction_used: true, state: "planned", action_mode: "create", read_mode: "reuse" });
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(JSON.stringify(body)).toContain(JSON.stringify(source.text).slice(1, -1).replaceAll("\\n", "\\\\n"));
      expect(body).toHaveProperty("tool_choice", { type: "function", name: "runner__plan_boundary_job" });
    }
    expect(diagnostic?.attempts).toHaveLength(2);
    expect(diagnostic?.attempts[0]?.code).not.toBe("PLANNING_ACCEPTED");
    expect(diagnostic?.attempts[1]?.code).toBe("PLANNING_ACCEPTED");
    expect(diagnostic?.source_digest).toBe(source.digest);
    expect(diagnostic?.model_requests).toBe(2);
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret-test-key|private-value-not-diagnostic|untrusted_secret_tool_name|Allow routine changes/u);
    expect(reusableState).toEqual(stateBefore);
  });

  it("does not give a second correction after a malformed response followed by a refused plan", async () => {
    let calls = 0;
    let diagnostic: BoundaryJobPlanningDiagnostic | undefined;
    const operation = planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "memory-key",
      dependencies: { requestJson: async () => { calls++;
        return { status: 200, body: { output: [{ type: "function_call", call_id: "bad", name: "runner__plan_boundary_job",
          arguments: calls === 1 ? "{bad" : JSON.stringify({ status: "planned", read_mode: "create", action_mode: "none", summary: "Missing Read intent" }),
        }] } };
      } } }, jobIntent: "Read my services.", currentState: reusableState, egressAcknowledged: true,
      onDiagnostic: (value) => { diagnostic = value; } });
    await expect(operation).rejects.toBeInstanceOf(BoundaryJobPlanningError);
    expect(calls).toBe(2);
    expect(diagnostic?.attempts[1]).toMatchObject({ category: "contract_validation", code: "PLANNING_CONTRACT_INVALID" });
    expect(planningDiagnosticLines(diagnostic!).join("\n")).toContain("read_mode=create requires one bounded read_intent");
  });

  it("retains a provider failure category without retrying a rejected credential", async () => {
    const requestJson = vi.fn(localProviderRefusal);
    let diagnostic: BoundaryJobPlanningDiagnostic | undefined;
    await expect(planModelBoundaryJob({ session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      jobIntent: "Read my services.", currentState: reusableState, egressAcknowledged: true,
      onDiagnostic: (value) => { diagnostic = value; } })).rejects.toBeInstanceOf(BoundaryJobPlanningError);
    expect(diagnostic?.attempts[0]).toMatchObject({ category: "provider_request", code: "ASK_PROVIDER_AUTHENTICATION_FAILED" });
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it("resumes an exact disabled Read mapping instead of asking the model to map it again", async () => {
    let requestBody = "";
    const requestJson = vi.fn(async (request) => {
      requestBody = JSON.stringify(request.body);
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_resume_boundary_job",
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "resume",
              action_mode: "create",
              action_intent: "Continue the bounded spend-alert proposal against the already mapped customer reads.",
              action_strategy: "discretionary",
              summary: "I will keep the exact disabled Read mapping and continue only its pending Action setup.",
            }),
          }],
        },
      };
    });

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Continue the saved customer setup and finish its spend-alert proposal.",
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          exact_reusable_revision_count: 0,
          resumable_draft_count: 1,
          resumable_resource_ids: ["telecom.accounts", "telecom.billing_preferences"],
        },
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "resume",
      action_mode: "create",
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    });
    expect(requestBody).toContain("resumable_draft_count");
    expect(requestBody).toContain("read_mode=resume");
    expect(requestBody).toContain("branches of ONE business action, not separate action_intents");
    expect(requestBody).toContain("never create a refusal-only or approval-routing-only action");
    expect(requestBody).not.toContain("memory-key");
  });

  it("keeps Action thresholds out of job routing and repairs to a focused Action intent", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_policy_routing_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify(attempt === 1
              ? {
                  status: "clarification",
                  question: "What maximum approval count and rolling window should apply to this proposal?",
                }
              : {
                  status: "planned",
                  read_mode: "reuse",
                  action_mode: "create",
                  action_intent: "Prepare the bounded spend-alert proposal and retain its unresolved rolling approval policy for focused Action authoring.",
                  action_strategy: "discretionary",
                  summary: "I will keep the reviewed reads and continue the requested Action setup.",
                }),
          }],
        },
      };
    });

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Keep the current reads and add a spend-alert proposal with a rolling approval limit.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "create",
      correction_used: true,
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("routes new outcomes to fixed tools even when a model uses the legacy strategy label", async () => {
    let attempt = 0;
    const requestBodies: string[] = [];
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      attempt += 1;
      requestBodies.push(JSON.stringify(request.body));
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_exact_refund_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "reuse",
              action_mode: "create",
              action_intent: "For a selected posted charge confirmed as duplicate, request an exact refund equal to that charge.",
              action_strategy: attempt === 1 ? "discretionary" : "rule_derived",
              summary: "Keep the reviewed reads and prepare one disabled exact-refund outcome.",
            }),
          }],
        },
      };
    });

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "For a selected posted charge that is authoritatively confirmed as duplicate, let the agent request an exact refund equal to that charge.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "create",
      action_strategy: "rule_derived",
      correction_used: false,
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestBodies[0]).toContain("bounded business inputs");
  });

  it("routes a copied source-row refund through verified Action Rules", async () => {
    let attempt = 0;
    const requestBodies: string[] = [];
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      attempt += 1;
      requestBodies.push(JSON.stringify(request.body));
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_copied_refund_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "create",
              read_intent: "Let the authenticated customer inspect only their own account, tickets, and charges.",
              action_mode: "create",
              action_intent: "For a posted duplicate-confirmed charge at most 2500 cents, insert one submitted account-credit refund copying the charge and amount.",
              action_strategy: attempt === 1 ? "discretionary" : "rule_derived",
              summary: "Prepare scoped customer reads and one disabled verified refund outcome.",
            }),
          }],
        },
      };
    });
    const job = "Let an authenticated support customer inspect only their own account, tickets, and charges. For a posted, duplicate-confirmed charge at most 2500 cents, let the agent propose one submitted account-credit refund copying the charge and amount. Auto-approve at most 100 per 24 hours and one per trusted tenant plus principal per 15 days; otherwise require one support_reviewer. Proposal only; never apply or write source data.";

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: job,
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          resource_ids: [],
          exact_reusable_revision_count: 0,
        },
      },
      availableResourceIds: [
        "support_ops.charges",
        "support_ops.customer_accounts",
        "support_ops.refund_requests",
        "support_ops.support_tickets",
      ],
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "create",
      action_mode: "create",
      action_strategy: "rule_derived",
      correction_used: false,
    });
    expect(requestJson).toHaveBeenCalledTimes(1);
    expect(requestBodies[0]).toContain("bounded business inputs");
  });

  it("reuses an exact Read revision and routes an action-only continuation to Action drafting", async () => {
    const requests: string[] = [];
    const requestJson = vi.fn(async (request) => {
      requests.push(JSON.stringify(request.body));
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_boundary_job",
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "reuse",
              action_mode: "create",
              action_intent: "Propose changing only monthly_spend_alert_cents with reviewed bounds and rolling approval limits.",
              summary: "I will keep the reviewed reads unchanged and prepare only the requested proposal action.",
            }),
          }],
        },
      };
    });

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Reuse the existing Read Boundary and add only a bounded spend-alert proposal.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "create",
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    });
    expect(requests[0]).toContain("Runner's proposal ledger");
    expect(requests[0]).toContain("read_mode=reuse");
    expect(requests[0]).not.toContain("memory-key");
  });

  it("accepts a bounded expanded Action routing intent", async () => {
    const expandedIntent = `Propose only the reviewed spend-alert update. ${"Keep proposal-only policy detail. ".repeat(18)}`.trim();
    expect([...expandedIntent].length).toBeGreaterThan(500);
    expect([...expandedIntent].length).toBeLessThanOrEqual(1_000);
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_expanded_action_intent",
          name: "runner__plan_boundary_job",
          arguments: JSON.stringify({
            status: "planned",
            read_mode: "reuse",
            action_mode: "create",
            action_intent: expandedIntent,
            summary: "Keep the reviewed Read revision and prepare only the proposal action.",
          }),
        }],
      },
    }));

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Reuse the reviewed reads and add only the bounded spend-alert proposal.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "create",
      action_intent: expandedIntent,
    });
  });

  it("plans a realistic job longer than 500 characters without truncating policy intent", async () => {
    const job = [
      "Let an authenticated support customer inspect only their own account, tickets, charges, and refund history.",
      "For a selected posted charge that Runner verifies as duplicate and still refundable, let the agent propose one submitted refund request that copies the exact charge amount and account association.",
      "Allow account credit or original payment method, but never let the model supply a tenant, principal, account key, charge key, SQL fragment, approval decision, or source patch.",
      "Auto-approve only duplicate-charge refunds at or below 2500 cents, at most 100 for this outcome per rolling 24 hours and one per trusted tenant plus principal per rolling 15 days.",
      "Anything missing, stale, ineligible, or outside those limits requires one support_reviewer, and source writeback must remain disabled.",
    ].join(" ");
    expect([...job].length).toBeGreaterThan(500);
    expect([...job].length).toBeLessThanOrEqual(2_000);
    const requestBodies: string[] = [];
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      requestBodies.push(JSON.stringify(request.body));
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_long_job",
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "create",
              read_intent: "Let the authenticated customer inspect only their own account, tickets, charges, and refund history.",
              action_mode: "create",
              action_intent: "For a selected posted duplicate charge, propose one exact bounded refund. Auto-approve at most 100 per rolling 24 hours and one per trusted tenant plus principal per rolling 15 days; otherwise require one support_reviewer. Keep writeback disabled.",
              action_strategy: "rule_derived",
              summary: "Prepare customer-scoped reads and one verified refund proposal outcome.",
            }),
          }],
        },
      };
    });

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: job,
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          resource_ids: [],
          exact_reusable_revision_count: 0,
        },
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "create",
      action_mode: "create",
      action_strategy: "rule_derived",
    });
    expect(requestBodies[0]).toContain(job);
  });

  it("splits fresh Read and Action intent instead of sending policy wording as a Read question", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_boundary_job",
          name: "runner__plan_boundary_job",
          arguments: JSON.stringify({
            status: "planned",
            read_mode: "create",
            read_intent: "Let the authenticated customer inspect their own account and invoices.",
            action_mode: "create",
            action_intent: "Propose a bounded update to monthly_spend_alert_cents with rolling approval limits.",
            summary: "I separated customer reads from the spend-alert proposal.",
          }),
        }],
      },
    }));

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Read my account and propose a spend-alert update, but never apply it.",
      availableResourceIds: ["telecom.accounts", "telecom.billing_preferences"],
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          exact_reusable_revision_count: 0,
          resource_ids: [],
        },
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "create",
      read_intent: "Let the authenticated customer inspect their own account and invoices.",
      action_mode: "create",
      action_intent: "Propose a bounded update to monthly_spend_alert_cents with rolling approval limits.",
    });
  });

  it("retains the full request when a routing summary does not repeat every area", async () => {
    let attempt = 0;
    const requests: string[] = [];
    const requestJson = vi.fn(async (request) => {
      requests.push(JSON.stringify(request.body));
      attempt += 1;
      const readIntent = attempt === 1
        ? "Let the authenticated customer read their own account, subscription, service lines, invoices, payments, billing preferences, and support cases."
        : "Let the authenticated customer read their own account, subscription, service lines, recent usage, invoices, payments, billing preferences, and support cases.";
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_boundary_job_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "create",
              read_intent: readIntent,
              action_mode: "create",
              action_intent: "Propose changing only monthly_spend_alert_cents with reviewed bounds and human approval.",
              summary: attempt === 1
                ? "I prepared seven customer read areas and one proposal action."
                : "I preserved all eight requested read areas, including recent usage, and separated the proposal action.",
            }),
          }],
        },
      };
    });

    const result = await planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Let the authenticated telecom customer read only their own account, subscription, service lines, recent usage, invoices, payments, billing preferences, and support cases. Let the agent propose changing only monthly_spend_alert_cents. Never apply or write source changes.",
      availableResourceIds: [
        "telecom.account_memberships",
        "telecom.accounts",
        "telecom.billing_preferences",
        "telecom.invoices",
        "telecom.payments",
        "telecom.service_lines",
        "telecom.subscribers",
        "telecom.subscriptions",
        "telecom.support_case_notes",
        "telecom.support_cases",
        "telecom.usage_daily",
      ],
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          fully_reviewed: false,
          exact_reusable_revision_count: 0,
          resource_ids: [],
        },
      },
      egressAcknowledged: true,
    });

    expect(result).toMatchObject({
      state: "planned",
      correction_used: false,
      read_mode: "create",
      read_intent: "Let the authenticated customer read their own account, subscription, service lines, invoices, payments, billing preferences, and support cases.",
    });
    expect(requestJson).toHaveBeenCalledOnce();
    expect(requests[0]).toContain("telecom.usage_daily");
    expect(requests[0]).toContain("recent usage");
    // Actual omitted usage/offer plans are refused by the native workload
    // producer in boundary-requested-read-scope.test.ts, not by prose shape.
  });

  it("returns one model clarification rather than inventing a source field", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_boundary_job",
          name: "runner__plan_boundary_job",
          arguments: JSON.stringify({
            status: "clarification",
            question: "Should the existing reviewed customer reads remain unchanged while I add only the spend-alert proposal?",
          }),
        }],
      },
    }));

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Continue the customer setup.",
      currentState: reusableState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "clarification",
      question: expect.stringContaining("remain unchanged"),
      authority_granted: false,
      source_database_changed: false,
    });
  });

  it("gives a new conversation both live authority and disabled Action changes without exposing values", async () => {
    let requestBody = "";
    const requestJson = vi.fn(async (request) => {
      requestBody = JSON.stringify(request.body);
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: "call_existing_state",
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "reuse",
              action_mode: "reuse",
              summary: "I will keep the live Read authority and the existing Action revisions unchanged.",
            }),
          }],
        },
      };
    });

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Keep the current customer reads and spend-alert action unchanged.",
      currentState: {
        ...reusableState,
        read: {
          ...reusableState.read,
          authority: "active_with_disabled_changes",
        },
        actions: [
          {
            capability: "billing_preference.propose_update",
            operation: "update",
            resource: "telecom.billing_preferences",
            authority: "active",
          },
          {
            capability: "billing_preference.propose_update",
            operation: "update",
            resource: "telecom.billing_preferences",
            authority: "disabled",
          },
        ],
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "reuse",
      authority_granted: false,
      source_database_changed: false,
    });
    expect(requestBody).toContain("active_with_disabled_changes");
    expect(requestBody.match(/billing_preference\.propose_update/gu)).toHaveLength(2);
    expect(requestBody).toContain("Do not merely repeat the operator request");
    expect(requestBody).not.toContain("memory-key");
  });

  it("selects one exact semantic outcome for a natural-language revision", async () => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      return {
        status: 200,
        body: {
          output: [{
            type: "function_call",
            call_id: `call_action_revision_${attempt}`,
            name: "runner__plan_boundary_job",
            arguments: JSON.stringify({
              status: "planned",
              read_mode: "reuse",
              action_mode: "revise",
              action_intent: "Keep the pause outcome but require two billing reviewers.",
              action_strategy: "rule_derived",
              ...(attempt === 1 ? {} : { action_outcome: "billing.pause_account" }),
              summary: "Keep the Read Boundary and prepare a disabled replacement for the pause policy.",
            }),
          }],
        },
      };
    });
    const currentState: BoundaryJobCurrentState = {
      ...reusableState,
      actions: [
        {
          capability: "app.request_change",
          kind: "rule_derived",
          action_boundary_name: "billing_actions",
          outcome: "billing.pause_account",
          operation: "update",
          resource: "billing.accounts",
          authority: "active",
        },
        {
          capability: "app.request_change",
          kind: "rule_derived",
          action_boundary_name: "billing_actions",
          outcome: "billing.request_refund",
          operation: "insert",
          resource: "billing.refund_requests",
          authority: "active",
        },
      ],
    };

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Change the account pause policy to require two billing reviewers.",
      currentState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "revise",
      action_strategy: "rule_derived",
      action_outcome: "billing.pause_account",
      correction_used: true,
    });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("canonicalizes a redundant Read intent while revising the sole semantic outcome", async () => {
    const requestJson = vi.fn(async () => ({
      status: 200,
      body: {
        output: [{
          type: "function_call",
          call_id: "call_existing_refund_revision",
          name: "runner__plan_boundary_job",
          arguments: JSON.stringify({
            status: "planned",
            read_mode: "reuse",
            read_intent: "Keep the current customer Read Boundary unchanged.",
            action_mode: "revise",
            action_intent: "Require two support_reviewer approvals for the existing refund request outcome.",
            action_strategy: "discretionary",
            summary: "Keep the current reads and prepare one disabled approval-policy replacement.",
          }),
        }],
      },
    }));
    const currentState: BoundaryJobCurrentState = {
      ...reusableState,
      read: { ...reusableState.read, authority: "active" },
      actions: [{
        capability: "app.request_change",
        kind: "rule_derived",
        action_boundary_name: "support_actions",
        outcome: "support.refund_request.proposed",
        operation: "insert",
        resource: "support.refund_requests",
        authority: "active",
      }],
    };

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Keep the active Read boundary unchanged. Change only the existing refund request outcome to require two support_reviewer approvals.",
      currentState,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "revise",
      action_outcome: "support.refund_request.proposed",
      action_strategy: "rule_derived",
      correction_used: false,
    });
    const result = await planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-test",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent: "Keep the active Read boundary unchanged. Change only the existing refund request outcome to require two support_reviewer approvals.",
      currentState,
      egressAcknowledged: true,
    });
    expect(result).not.toHaveProperty("read_intent");
  });

  it("exposes a bounded removal route and prepares only one exact disabled outcome replacement", async () => {
    let removalSchema: Record<string, unknown> | undefined;
    const requestJson = vi.fn(async (request) => {
      const tool = (request.body.tools as Array<Record<string, unknown>>).find((candidate) =>
        candidate.name === "runner__plan_boundary_job")!;
      const schema = tool.parameters as { oneOf: Array<Record<string, unknown>> };
      removalSchema = schema.oneOf.find((candidate) =>
        (candidate.properties as Record<string, { enum?: string[] }>).action_mode?.enum?.includes("remove"));
      return { status: 200, body: { output: [{ type: "function_call", call_id: "remove",
        name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: "reuse",
          action_mode: "remove", action_outcome: "billing.pause_account",
          summary: "Prepare a disabled replacement without the pause-account outcome." }) }] } };
    });
    const state: BoundaryJobCurrentState = {
      ...reusableState,
      actions: [
        { capability: "app.request_change", kind: "rule_derived", outcome: "billing.pause_account", authority: "active" },
        { capability: "app.request_change", kind: "rule_derived", outcome: "billing.request_refund", authority: "active" },
      ],
    };

    await expect(planModelBoundaryJob({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      jobIntent: "Remove the existing pause-account outcome and keep the other action.", currentState: state,
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "remove",
      action_outcome: "billing.pause_account",
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    });
    expect(removalSchema).toMatchObject({
      additionalProperties: false,
      required: ["status", "read_mode", "action_mode", "action_outcome", "summary"],
      properties: {
        read_mode: { enum: ["none", "reuse"] },
        action_mode: { enum: ["remove"] },
        action_outcome: { enum: ["billing.pause_account", "billing.request_refund"] },
      },
    });
    expect((removalSchema!.properties as Record<string, unknown>)).not.toHaveProperty("action_intent");
    expect((removalSchema!.properties as Record<string, unknown>)).not.toHaveProperty("action_intents");
    expect((removalSchema!.properties as Record<string, unknown>)).not.toHaveProperty("action_strategy");
  });

  it.each(["unknown", "missing", "read_create", "action_intent", "action_intents", "action_strategy"])("repairs a refused removal route without substituting create (%s)", async (failure) => {
    let attempt = 0;
    const requestJson = vi.fn(async () => {
      attempt += 1;
      const first = attempt === 1;
      const invalid = failure === "unknown"
        ? { action_outcome: "billing.unknown" }
        : failure === "missing"
          ? { action_outcome: undefined }
            : failure === "read_create"
              ? { read_mode: "create" }
              : failure === "action_intent"
                ? { action_intent: "Remove the pause outcome." }
                : failure === "action_intents"
                  ? { action_intents: ["Remove the pause outcome."] }
                  : { action_strategy: "rule_derived" };
      return { status: 200, body: { output: [{ type: "function_call", call_id: `remove_${attempt}`,
        name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned",
          read_mode: "reuse", action_mode: "remove", action_outcome: "billing.pause_account",
          summary: "Prepare the exact disabled removal replacement.", ...(first ? invalid : {}) }) }] } };
    });
    const state: BoundaryJobCurrentState = {
      ...reusableState,
      actions: [{ capability: "app.request_change", kind: "rule_derived", outcome: "billing.pause_account", authority: "active" }],
    };

    await expect(planModelBoundaryJob({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      jobIntent: "Remove the existing pause-account outcome.", currentState: state, egressAcknowledged: true,
    })).resolves.toMatchObject({ state: "planned", read_mode: "reuse", action_mode: "remove",
      action_outcome: "billing.pause_account", correction_used: true });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it("asks for clarification instead of guessing which semantic outcome to remove", async () => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "clarify_remove",
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "clarification",
        question: "Which current semantic outcome should be removed?" }) }] } }));
    const state: BoundaryJobCurrentState = {
      ...reusableState,
      actions: [
        { capability: "app.request_change", kind: "rule_derived", outcome: "billing.pause_account", authority: "active" },
        { capability: "app.request_change", kind: "rule_derived", outcome: "billing.request_refund", authority: "active" },
      ],
    };

    await expect(planModelBoundaryJob({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      jobIntent: "Remove one billing outcome.", currentState: state, egressAcknowledged: true,
    })).resolves.toMatchObject({ state: "clarification", correction_used: false });
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it("does not let the sole-outcome revision shortcut preempt an explicit removal", async () => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "remove_sole",
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: "reuse",
        action_mode: "remove", action_outcome: "support.refund_request_submitted",
        summary: "Prepare the disabled removal replacement and leave activation separate." }) }] } }));
    const state: BoundaryJobCurrentState = {
      ...reusableState,
      actions: [{ capability: "app.request_change", kind: "rule_derived", outcome: "support.refund_request_submitted", authority: "active" }],
    };

    await expect(planModelBoundaryJob({
      session: { provider: "openai", model: "gpt-test", apiKey: "memory-key", dependencies: { requestJson } },
      jobIntent: "Remove the existing refund outcome, but keep the Read boundary unchanged.", currentState: state,
      egressAcknowledged: true,
    })).resolves.toMatchObject({ state: "planned", action_mode: "remove", correction_used: false });
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it("routes an explicit policy-only edit of the sole semantic outcome without a fragile model split", async () => {
    const requestJson = vi.fn(async () => {
      throw new Error("The general planner must not be needed for an exact sole-outcome revision.");
    });
    const jobIntent = "Change only the existing refund outcome's human fallback quorum from one reviewer to two reviewers. Keep the active Read and Action baseline, scopes, eligibility, copied fields, reason, method, status, automatic approval threshold, limits, proposal-only behavior, and every unrelated policy and effect unchanged.";

    await expect(planModelBoundaryJob({
      session: {
        provider: "openai",
        model: "gpt-5.6-terra",
        apiKey: "memory-key",
        dependencies: { requestJson },
      },
      jobIntent,
      currentState: {
        ...reusableState,
        read: { ...reusableState.read, authority: "active" },
        actions: [{
          capability: "app.request_change",
          kind: "rule_derived",
          action_boundary_name: "support_actions",
          outcome: "support.refund_request_submitted",
          operation: "insert",
          resource: "support_ops.refund_requests",
          authority: "active",
        }],
      },
      egressAcknowledged: true,
    })).resolves.toMatchObject({
      state: "planned",
      read_mode: "reuse",
      action_mode: "revise",
      action_outcome: "support.refund_request_submitted",
      action_strategy: "rule_derived",
      action_intent: jobIntent,
      correction_used: false,
      authority_granted: false,
      source_database_changed: false,
    });
    expect(requestJson).not.toHaveBeenCalled();
  });
});

describe("typed review-only job routing", () => {
  it.each(["Recheck the current saved rules against the attached policy and existing decisions without changing the rules or authority.",
    "Check this saved job against my attached rules; keep its settings.", "Review whether the current policy is implemented. Do not draft changes."])("retains a review-only operation for %s", async jobIntent => {
    const typed = await preparedNativeReadContext(reusableState.read.resource_ids);
    const requests: string[] = [];
    const result = await planModelBoundaryJob({ jobIntent, currentState: reusableState, egressAcknowledged: true, structuredScope: typed.structuredScope,
      session: { provider: "openai", model: "fixture", apiKey: "captured-only", dependencies: { requestJson: async request => {
        requests.push(JSON.stringify(request.body));
        return { status: 200, body: { output: [{ type: "function_call", call_id: "review", name: "runner__plan_boundary_job",
          arguments: JSON.stringify({ status: "planned", operation: "review_rules", read_mode: "reuse", action_mode: "none", summary: "Review the current candidate without edits.", read_scope: typed.proposal }) }] } };
      } } } });
    expect(result).toMatchObject({ state: "planned", operation: "review_rules", read_mode: "reuse", action_mode: "none", authority_granted: false });
    expect(requests).toHaveLength(1); expect(requests[0]).toContain(jobIntent); expect(requests[0]).toContain("combining review and changes needs the clarification branch");
  });
  it.each([{ read_intent: "Change the grouping limit to three." }, { action_intent: "Change the approval maximum." },
    { action_intents: ["Add another action."] }, { operation: "publish" }, { read_mode: "revise", read_intent: "Change access." }])("refuses a review label that hides an edit: %j", async extra => {
    const result = planModelBoundaryJob({ jobIntent: "Review and then change the maximum.", currentState: reusableState, egressAcknowledged: true,
      session: { provider: "openai", model: "fixture", apiKey: "captured-only", dependencies: { requestJson: async () => ({ status: 200, body: { output: [{
        type: "function_call", call_id: "mixed", name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", operation: "review_rules",
          read_mode: "reuse", action_mode: "none", summary: "Review and edit.", ...extra }) }] } }) } } });
    await expect(result).rejects.toThrow();
  });
});


it("replays both complete captured planning requests and unchanged submitted tool replies", async () => {
  const fs = await import("node:fs/promises");
  const { createModelAuthoringConversation } = await import("./model-authoring-conversation.js");
  const captures = JSON.parse(await fs.readFile(new URL("./fixtures/review-routing-captures.json", import.meta.url), "utf8"));
  for (const capture of captures) {
    const conversation = createModelAuthoringConversation(); conversation.policySources = capture.source_session;
    const sent: string[] = [];
    const result = await planModelBoundaryJob({ jobIntent: capture.operator_job, currentState: capture.current_state,
      availableResourceIds: capture.current_state.read.resource_ids, egressAcknowledged: true,
      session: { provider: "openai", model: "gpt-5.6-terra", apiKey: "captured-only", conversation, dependencies: { requestJson: async request => {
        sent.push(JSON.stringify(request.body)); return { status: 200, body: capture.response };
      } } } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(capture.source_session.snapshots.find((s: { version: number }) => s.version === capture.source_session.active).digest);
    expect(result.state).toBe(capture.case === "counting-wording-control" ? "clarification" : "planned");
    if (result.state === "clarification") expect(result.question).toBe(JSON.parse(capture.response.output[0].arguments).question);
    else expect(result.operation).toBeUndefined(); // Historical no-change plan is not retroactively rewritten as a review verdict.
  }
});


describe("unestablished requested Read routing", () => {
  it.each([
    ["Read customer accounts.", "none"], ["Read customer accounts.", "reuse"],
    ["Read outstanding obligations.", "none"], ["Read outstanding obligations.", "reuse"],
  ])("retains unresolved %s before %s routing", async (jobIntent, readMode) => {
    const currentState = { ...reusableState, read: { ...reusableState.read, resource_ids: ["finance.accounts"] } };
    const before = structuredClone(currentState);
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      expect(JSON.stringify(request.body)).toContain(jobIntent);
      const args = requestJson.mock.calls.length === 1
        ? { status: "planned", read_mode: readMode, action_mode: "none", summary: "Keep existing access." }
        : { status: "clarification", question: "Which business records should this request cover, and should the reviewed access remain unchanged?" };
      return { status: 200, body: { output: [{ type: "function_call", call_id: "scope_route",
        name: "runner__plan_boundary_job", arguments: JSON.stringify(args) }] } };
    });
    const result = await planModelBoundaryJob({ jobIntent, currentState, availableResourceIds: ["finance.accounts"],
      session: { provider: "openai", model: "declared-routing-fixture", apiKey: "local-fixture-only", dependencies: { requestJson } }, egressAcknowledged: true });
    expect(result).toMatchObject({ state: "clarification", authority_granted: false, source_database_changed: false });
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(currentState).toEqual(before);
  });
});


describe("current exact Read request bindings", () => {
  it.each(["reuse", "resume"] as const)("retains a current exact %s request without another question", async readMode => {
    const description = "Read membership names and expiry dates.";
    const state = { ...reusableState, read: { ...reusableState.read,
      resource_ids: ["club.members"], resumable_draft_count: 1, resumable_resource_ids: ["club.members"],
      [readMode === "reuse" ? "reviewed_requests" : "resumable_requests"]: [{ description, resource_ids: ["club.members"] }],
    } };
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "retained_read",
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: readMode, action_mode: "none", summary: "Retain the exact saved request." }) }] } }));
    const result = await planModelBoundaryJob({ jobIntent: `Prepare the requested program. ${description}`, currentState: state,
      availableResourceIds: ["club.members"], egressAcknowledged: true,
      session: { provider: "openai", model: "declared-request-binding", apiKey: "local-only", dependencies: { requestJson } } });
    expect(result).toMatchObject({ state: "planned", read_mode: readMode, authority_granted: false, source_database_changed: false });
    expect(requestJson).toHaveBeenCalledOnce();
  });
});


describe("exact saved Read association boundaries", () => {
  it.each(["changed", "added", "ambiguous", "other_mode", "none"] as const)("keeps %s request pending", async control => {
    const description = "Read membership names and expiry dates.";
    const binding = { description, resource_ids: ["club.members"] };
    const state = { ...reusableState, read: { ...reusableState.read, resource_ids: ["club.members", "archive.members"],
      reviewed_requests: control === "other_mode" ? [] : [binding, ...(control === "ambiguous" ? [{ ...binding, resource_ids: ["archive.members"] }] : [])],
      resumable_requests: control === "other_mode" ? [binding] : [],
    } };
    const jobIntent = control === "changed" ? "Read membership names and expiry dates for all customers."
      : control === "added" ? `${description} Read outstanding obligations.` : description;
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "scope_boundary",
      name: "runner__plan_boundary_job", arguments: JSON.stringify(requestJson.mock.calls.length === 1
        ? { status: "planned", read_mode: control === "none" ? "none" : "reuse", action_mode: "none", summary: "Keep access." }
        : { status: "clarification", question: "Which records should the changed request cover?" }) }] } }));
    const result = await planModelBoundaryJob({ jobIntent, currentState: state, availableResourceIds: state.read.resource_ids,
      egressAcknowledged: true, session: { provider: "openai", model: "declared-request-binding", apiKey: "local-only", dependencies: { requestJson } } });
    expect(result).toMatchObject({ state: "clarification", authority_granted: false, source_database_changed: false });
    expect(requestJson).toHaveBeenCalledTimes(2);
  });
});
