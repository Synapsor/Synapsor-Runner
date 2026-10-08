import { describe, expect, it, vi } from "vitest";
import { planModelBoundaryJob, type BoundaryJobCurrentState } from "./boundary-job-model.js";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { authoringDestination, newPolicySourceSession, policyTextSnapshot } from "./authoring-policy-source.js";
import { readWorkloadAssistanceCheckpoint, type ReadWorkloadAssistanceCheckpoint } from "./read-workload-assistance-checkpoint.js";

// Public fixture facts: seven requested areas and their actual inspected IDs.
// The response is a routing summary, not a replacement business policy.
const resources = ["studio.accounts", "studio.subscriptions", "studio.service_lines", "studio.usage_daily",
  "studio.invoices", "studio.payments", "studio.plan_change_offers"];
const original = "Read the customer's own accounts, subscriptions, service lines, recent usage, invoices, payments, and plan change offers. "
  + "Plan change offers are the currently active offers available to that customer. Keep internal identifiers private. "
  + "No proposal, approval, execution, or source write is requested.";
const state: BoundaryJobCurrentState = {
  read: { boundary_name: "studio_review", authority: "disabled", fully_reviewed: false,
    resource_ids: [], exact_reusable_revision_count: 0 }, actions: [],
  control_plane: { trusted_scope: "runner_injected", approval_history: "runner_proposal_ledger",
    model_may_supply_scope_values: false, model_may_supply_approval_history: false },
};

function planning(readIntent: string) {
  const frames: string[] = [];
  const requestJson = vi.fn(async (request: { body: unknown }) => {
    frames.push(JSON.stringify(request.body));
    return { status: 200, body: { output: [{ type: "function_call", call_id: `plan_${frames.length}`,
      name: "runner__plan_boundary_job", arguments: JSON.stringify({ status: "planned", read_mode: "create",
        read_intent: readIntent, action_mode: "none", summary: "Prepare the seven requested read areas." }) }] } };
  });
  return { frames, requestJson, run: () => planModelBoundaryJob({ jobIntent: original,
    availableResourceIds: resources, currentState: structuredClone(state), egressAcknowledged: true,
    session: { provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only", dependencies: { requestJson } } }) };
}

describe("original requested Read scope versus routing summary", () => {
  it("accepts declared active-offer paraphrase without alleging an omitted requested area", async () => {
    const summary = "Customer accounts, subscriptions, service lines, recent usage, invoices, payments, and active offers.";
    const probe = planning(summary);
    await expect(probe.run()).resolves.toMatchObject({ state: "planned", read_intent: summary,
      correction_used: false, authority_granted: false, source_database_changed: false });
    expect(probe.requestJson).toHaveBeenCalledOnce();
    expect(probe.frames[0]).toContain(original);
    expect(probe.frames[0]).toContain("studio.plan_change_offers");
  });

  it.each([500, 501])("keeps the existing %i-character summary boundary without truncating business text", async size => {
    const summary = "Read accounts, subscriptions, service lines, recent usage, invoices, payments, and plan change offers."
      .padEnd(size, "x");
    const probe = planning(summary);
    if (size === 500) await expect(probe.run()).resolves.toMatchObject({ state: "planned", read_intent: summary });
    else await expect(probe.run()).rejects.toThrow("maximum is 500");
    expect(probe.frames[0]).toContain(original);
  });

  it.each([
    ["studio.usage_daily", false], ["studio.plan_change_offers", false],
    ["studio.usage_daily", true], ["studio.plan_change_offers", true],
  ] as const)("does not accept missing %s with exact association=%s", async (omitted, exact) => {
    // Natural names alone require a question. The explicit variant adds a
    // declared literal request, establishing the exact omission lower bound.
    const requested = exact ? `${original} Read ${resources.join(", ")}.` : original;
    const boundary = scopeBoundary();
    const bodies: string[] = [];
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      const wire = JSON.stringify(request.body);
      bodies.push(wire);
      // Every submitted identity/field is actually present in this transmitted catalog.
      for (const id of resources) expect(wire).toContain(id);
      expect(wire).toContain(requested);
      return { status: 200, body: { output: [{ type: "function_call", call_id: `map_${bodies.length}`,
        name: "runner__submit_read_workloads", arguments: JSON.stringify({
          allowed: resources.filter(resource => resource !== omitted).map((resource, index) => ({ id: `read_${index}`, description: `Read ${resource} status`,
            plan: { kind: "rows", resource, select: ["status"] } })), forbidden: [],
        }) }] } };
    });
    await expect(generateModelReadWorkload({ name: "studio_reads", generatedBoundary: boundary,
      allowedQuestions: ["Read accounts, subscriptions, service lines, recent usage, invoices, payments, and plan change offers."],
      operatorNamingContext: requested, provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only",
      egressAcknowledged: true, deferNarration: true, dependencies: { requestJson },
    })).rejects.toThrow(exact ? /REQUIRED_RESOURCE_OMITTED/iu : /CLARIFICATION_REQUIRED/iu);
  });
  it.each(["Read only studio.accounts.", "Read only `studio.accounts`.", 'Read only "studio.accounts".'])("does not expand an exact only-request: %s", async request => {
    const response = { allowed: ["studio.accounts", "studio.payments"].map((resource, index) => ({ id: `extra_${index}`,
      description: `Read ${resource} status`, plan: { kind: "rows", resource, select: ["status"] } })), forbidden: [] };
    const requestJson = vi.fn(async (wire: { body: unknown }) => {
      const strings = (value: unknown): string[] => typeof value === "string" ? [value]
        : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
      const prefix = "Original operator naming context: ";
      const line = strings(wire.body).flatMap(value => value.split("\n")).find(value => value.startsWith(prefix));
      expect(JSON.parse(line!.slice(prefix.length))).toEqual([request]);
      return { status: 200, body: { output: [{ type: "function_call", call_id: "unrequested",
        name: "runner__submit_read_workloads", arguments: JSON.stringify(response) }] } };
    });
    await expect(generateModelReadWorkload({ name: "studio_reads", generatedBoundary: scopeBoundary(),
      allowedQuestions: ["Read accounts and payments."], operatorNamingContext: request,
      provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true,
      deferNarration: true, dependencies: { requestJson },
    })).rejects.toThrow(/UNREQUESTED|outside.*request/iu);
  });

  it("uses the existing business question when an unqualified request matches two inspected resources", async () => {
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "ambiguous",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "accounts", description: "Read account status",
        plan: { kind: "rows", resource: "studio.accounts", select: ["status"] } }], forbidden: [] }) }] } }));
    const clarificationHandler = vi.fn(async () => ({ state: "declined" as const }));
    await expect(generateModelReadWorkload({ name: "studio_reads", generatedBoundary: scopeBoundary([...resources, "archive.accounts"]),
      allowedQuestions: ["Read accounts."], operatorNamingContext: "Read accounts.",
      provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true,
      deferNarration: true, dependencies: { requestJson }, clarificationHandler,
    })).rejects.toThrow("READ_WORKLOAD_CLARIFICATION_DECLINED");
    expect(clarificationHandler).toHaveBeenCalledOnce();
    expect(requestJson).toHaveBeenCalledOnce();
  });

  it.each([false, true])("reopens the native ambiguous question with changed-mapping=%s and rejects stale context", async changedMapping => {
    const boundary = scopeBoundary([...resources, "archive.accounts"]);
    const base = { name: "studio_reads", generatedBoundary: boundary, allowedQuestions: ["Read accounts."], operatorNamingContext: "Read accounts.",
      provider: "openai" as const, model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true, deferNarration: true };
    const mapped = { status: 200, body: { output: [{ type: "function_call", call_id: "saved_ambiguity",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "accounts", description: "Read account status",
        plan: { kind: "rows", resource: "studio.accounts", select: ["status"] } }], forbidden: [] }) }] } };
    let checkpoint: ReadWorkloadAssistanceCheckpoint | undefined;
    const first = vi.fn(async () => mapped);
    await expect(generateModelReadWorkload({ ...base, dependencies: { requestJson: first }, clarificationHandler: async () => undefined,
      onCheckpoint: async value => { checkpoint = structuredClone(value); },
    })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
    expect(first).toHaveBeenCalledOnce();
    expect(checkpoint?.stage).toBe("waiting");
    expect(checkpoint?.stage === "waiting" && checkpoint.pending_question.request).toMatchObject({
      reason_binding: { kind: "requested_read_scope", digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u) },
    });
    const retained = structuredClone(checkpoint);
    if (checkpoint?.stage !== "waiting" || checkpoint.pending_question.kind !== "clarification") throw new Error("native scope question not reached");
    const { digest: _digest, schema_version: _schema, ...legacyBody } = structuredClone(checkpoint);
    delete legacyBody.pending_question.request.reason_binding;
    const legacy = readWorkloadAssistanceCheckpoint(legacyBody);
    const noLegacySend = vi.fn(), noLegacyAnswer = vi.fn(), noLegacySave = vi.fn();
    await expect(generateModelReadWorkload({ ...base, resumeCheckpoint: legacy,
      dependencies: { requestJson: noLegacySend }, clarificationHandler: noLegacyAnswer, onCheckpoint: noLegacySave,
    })).rejects.toThrow("READ_WORKLOAD_AUTHORING_PAUSED");
    expect(noLegacySend).not.toHaveBeenCalled(); expect(noLegacyAnswer).not.toHaveBeenCalled(); expect(noLegacySave).not.toHaveBeenCalled();
    expect(legacy.state.call_count).toBe(checkpoint.state.call_count);
    const { digest: _hash, schema_version: _version, ...wrongBody } = structuredClone(checkpoint);
    wrongBody.pending_question.request.reason_binding!.digest = `sha256:${"f".repeat(64)}`;
    const wrong = readWorkloadAssistanceCheckpoint(wrongBody);
    await expect(generateModelReadWorkload({ ...base, resumeCheckpoint: wrong,
      dependencies: { requestJson: noLegacySend }, clarificationHandler: noLegacyAnswer,
    })).rejects.toThrow("CHECKPOINT_STALE");
    expect(noLegacySend).not.toHaveBeenCalled(); expect(noLegacyAnswer).not.toHaveBeenCalled();
    const noSend = vi.fn(), noAnswer = vi.fn();
    await expect(generateModelReadWorkload({ ...base, operatorNamingContext: "Read payments.", resumeCheckpoint: checkpoint,
      dependencies: { requestJson: noSend }, clarificationHandler: noAnswer,
    })).rejects.toThrow("CHECKPOINT_STALE");
    expect(noSend).not.toHaveBeenCalled();
    expect(noAnswer).not.toHaveBeenCalled();
    expect(checkpoint).toEqual(retained);
    const answer = "Show the live studio.accounts customer records, not archive.accounts historical records.";
    const resumed = vi.fn(async (request: { body: unknown }) => {
      expect(JSON.stringify(request.body)).toContain(answer);
      return changedMapping ? JSON.parse(JSON.stringify(mapped).replaceAll("studio.accounts", "archive.accounts")) : mapped;
    });
    const operation = generateModelReadWorkload({ ...base, resumeCheckpoint: checkpoint,
      dependencies: { requestJson: resumed }, clarificationHandler: async request => ({ state: "answered", answer, resource: request.resource }),
      onCheckpoint: async value => { checkpoint = structuredClone(value); },
    });
    if (changedMapping) {
      await expect(operation).rejects.toThrow("READ_WORKLOAD_SCOPE_MAPPING_CHANGED");
      expect(resumed).toHaveBeenCalledTimes(2); // Original mapping plus the existing single correction.
      return;
    }
    const result = await operation;
    expect(result.analysis.status).toBe("ready");
    expect(result.workload.allowed.map(entry => entry.plan.resource)).toEqual(["studio.accounts"]);
    expect(resumed).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ authority_granted: false, source_database_changed: false, source_query_executed: false });
  });


  it.each(["select", "filter", "group", "measure"])("retains approved Source exclusions through native %s validation", async operation => {
    const boundary = scopeBoundary(["studio.accounts"]);
    const resource = boundary.pack.resources[0]!;
    resource.field_types.private_amount = "numeric";
    resource.kept_out_fields.push("private_amount");
    const before = structuredClone(boundary);
    const source = "Read studio.accounts status. Internal identifiers and private_amount are private verification data; do not expose, filter, group, or total them for the customer.";
    const conversation = createModelAuthoringConversation();
    const policy = newPolicySourceSession(), snapshot = policyTextSnapshot(Buffer.from(source), "Rules.txt");
    policy.snapshots.push(snapshot); policy.active = snapshot.version;
    // Declared below-UI setup: this exact text/destination is already approved.
    policy.approvals.push({ digest: snapshot.digest, destination: authoringDestination({ provider: "openai", model: "declared-scope-fixture" }) });
    conversation.policySources = policy;
    const plan = operation === "select" ? { kind: "rows", resource: resource.id, select: ["private_amount"] }
      : operation === "filter" ? { kind: "rows", resource: resource.id, select: ["status"], where: [{ field: "private_amount", op: "eq", value: 1 }] }
      : operation === "group" ? { kind: "aggregate", resource: resource.id, measures: [{ function: "count" }], dimensions: [{ field: "private_amount" }] }
      : { kind: "aggregate", resource: resource.id, measures: [{ function: "sum", field: "private_amount" }] };
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      const wire = JSON.stringify(request.body);
      expect(wire).toContain(source);
      return { status: 200, body: { output: [{ type: "function_call", call_id: `private_${operation}`,
        name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "customer_status", description: "Read customer status", plan }], forbidden: [] }) }] } };
    });
    const committed = vi.fn();
    const result = await generateModelReadWorkload({ name: "private_scope", generatedBoundary: boundary,
      allowedQuestions: ["Read customer status"], operatorNamingContext: "Read studio.accounts status.", conversation,
      provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true,
      deferNarration: true, dependencies: { requestJson }, onCheckpoint: async (_checkpoint, _boundary, accepted) => { if (accepted) committed(accepted); },
    });
    expect(result.analysis.status).toBe("blocked");
    expect(JSON.stringify(result.analysis.blockers)).toContain("private_amount");
    expect(result).toMatchObject({ authority_granted: false, source_query_executed: false, source_database_changed: false });
    expect(committed).not.toHaveBeenCalled();
    expect(boundary).toEqual(before);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

});


describe("field-only Source restrictions preserve public root Reads", () => {
  it.each(["Do not show service.cases.private_note.", "Never show private notes from customer cases.", "Never show private notes from service.cases."])("does not exclude the whole resource for %s", async restriction => {
    const boundary = scopeBoundary(["service.cases"]);
    boundary.pack.resources[0]!.field_types.private_note = "text";
    boundary.pack.resources[0]!.kept_out_fields.push("private_note");
    const source = `service.cases represents customer cases.\n${restriction}`;
    const conversation = createModelAuthoringConversation(), policy = newPolicySourceSession();
    const snapshot = policyTextSnapshot(Buffer.from(source), "Rules.txt");
    policy.snapshots.push(snapshot); policy.active = snapshot.version;
    policy.approvals.push({ digest: snapshot.digest, destination: authoringDestination({ provider: "openai", model: "declared-scope-fixture" }) });
    conversation.policySources = policy;
    const requestJson = vi.fn(async (wire: { body: unknown }) => {
      for (const line of source.split("\n")) expect(JSON.stringify(wire.body)).toContain(line);
      return { status: 200, body: { output: [{ type: "function_call", call_id: "public_status", name: "runner__submit_read_workloads",
        arguments: JSON.stringify({ allowed: [{ id: "public_status", description: "Read customer case status", plan: { kind: "rows", resource: "service.cases", select: ["status"] } }], forbidden: [] }) }] } };
    });
    const result = await generateModelReadWorkload({ name: "public_case_status", generatedBoundary: boundary,
      allowedQuestions: ["Read customer case status"], operatorNamingContext: "Read customer cases.", conversation,
      provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true,
      deferNarration: true, dependencies: { requestJson } });
    expect(result.analysis.status).toBe("ready");
    expect(result.workload.allowed[0]!.plan).toMatchObject({ resource: "service.cases", select: ["status"] });
    expect(result).toMatchObject({ authority_granted: false, source_query_executed: false, source_database_changed: false });
    expect(boundary.pack.resources[0]!.kept_out_fields).toContain("private_note");
  });
});

describe("requested business areas through current attributed Source mappings", () => {
  it.each(["substitution", "excluded_addition", "duplicate_labels", "duplicate_definitions", "duplicate_definitions_answer", "unresolved_phrase", "source_disambiguation", "source_outside_homonyms", "source_outside_single_homonym", "source_outside_homonyms_same_line"])("preserves native scope for %s", async scenario => {
    const ids = scenario === "source_outside_single_homonym" ? ["service.requests", "archive.cases"] : scenario.startsWith("source_outside_homonyms") ? ["service.requests", "archive.cases", "audit.cases"] : scenario === "source_disambiguation" ? ["current.accounts", "archive.accounts"] : ["current.member_cards", "archive.old_cards", "current.invoices"];
    const boundary = scopeBoundary(ids);
    const request = scenario.startsWith("source_outside_") ? "Read customer cases." : scenario === "source_disambiguation" ? "Read customer accounts." : "Read customer memberships.";
    const source = scenario === "source_outside_homonyms_same_line" ? "service.requests represents customer cases. archive.cases represents archived records. audit.cases represents audit history." : scenario.startsWith("source_outside_") ? "service.requests represents customer cases." : scenario.startsWith("duplicate_definitions") ? "current.member_cards represents customer memberships.\narchive.old_cards represents customer memberships."
      : scenario === "unresolved_phrase" ? "current.member_cards represents current member records."
      : scenario === "source_disambiguation"
      ? "current.accounts represents customer accounts.\narchive.accounts represents archived records."
      : "current.member_cards represents customer memberships.\narchive.old_cards represents archived memberships.\nDo not read archive.old_cards.";
    if (scenario === "duplicate_labels") for (const r of boundary.pack.resources.slice(0,2)) r.label="Customer memberships";
    const conversation=createModelAuthoringConversation(), policy=newPolicySourceSession();
    // The collision-only case deliberately has no attributed root meaning.
    if (scenario !== "duplicate_labels") {
      const snapshot=policyTextSnapshot(Buffer.from(source),"Rules.txt");policy.snapshots.push(snapshot);policy.active=snapshot.version;
      policy.approvals.push({digest:snapshot.digest,destination:authoringDestination({provider:"openai",model:"declared-scope-fixture"})});
      conversation.policySources=policy;
    }
    const targets=scenario === "substitution" ? ["current.invoices"] : scenario === "excluded_addition" ? ["current.member_cards","archive.old_cards"] : [ids[0]!];
    const requestJson=vi.fn(async (wire:{body:unknown})=>{
      expect(JSON.stringify(wire.body)).toContain(request);
      if(scenario!=="duplicate_labels")for(const line of source.split("\n"))expect(JSON.stringify(wire.body)).toContain(line);
      return {status:200,body:{output:[{type:"function_call",call_id:"declared_area",name:"runner__submit_read_workloads",
        arguments:JSON.stringify({allowed:targets.map((resource,index)=>({id:`area_${index}`,description:"Read the requested business status",plan:{kind:"rows",resource,select:["status"]}})),forbidden:[]})}]}};
    });
    const question=vi.fn(async()=>scenario === "duplicate_definitions_answer"
      ? {state:"answered" as const,answer:"These are the current customer memberships for this view; the archive is outside the request."}
      : {state:"declined" as const}), accepted=vi.fn();
    const operation=generateModelReadWorkload({name:"source_area",generatedBoundary:boundary,allowedQuestions:[request],operatorNamingContext:request,
      conversation,provider:"openai",model:"declared-scope-fixture",apiKey:"local-fixture-only",egressAcknowledged:true,deferNarration:true,
      dependencies:{requestJson},clarificationHandler:question,onCheckpoint:async(_c,_b,result)=>{if(result)accepted(result);}});
    if(scenario==="source_disambiguation" || scenario.startsWith("source_outside_") || scenario==="duplicate_definitions_answer"){
      const result=await operation;expect(result.analysis.status).toBe("ready");
      if(scenario!=="duplicate_definitions_answer")expect(question).not.toHaveBeenCalled();else expect(question).toHaveBeenCalledOnce();
      expect(accepted).toHaveBeenCalledOnce();
      expect(result.workload.allowed.map(entry=>entry.plan.resource)).toEqual([ids[0]!]);
    }else if(["duplicate_labels","duplicate_definitions","unresolved_phrase"].includes(scenario)){
      await expect(operation).rejects.toThrow("READ_WORKLOAD_CLARIFICATION_DECLINED");expect(question).toHaveBeenCalledOnce();expect(accepted).not.toHaveBeenCalled();
    }else{
      await expect(operation).rejects.toThrow(scenario==="substitution" ? "READ_WORKLOAD_REQUIRED_RESOURCE_OMITTED" : "READ_WORKLOAD_EXCLUDED_RESOURCE");
      expect(accepted).not.toHaveBeenCalled();
    }
  });
});

function scopeBoundary(ids = resources): ExplorationBoundaryDraft {
  return {
      schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed",
      deployment_profile: "staging", source: "local_postgres", compiler_version: "1.7.0", spec_version: "1.9.0",
      reporting_timezone: "UTC", trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL_ID" },
      generation_lock_fingerprint: `sha256:${"1".repeat(64)}`, role_posture_fingerprint: `sha256:${"2".repeat(64)}`,
      pack: { name: "studio_review", resources: ids.map(id => ({
        id, schema: id.split(".")[0]!, table: id.split(".")[1]!, primary_key: "id", tenant_key: "tenant_id", principal_key: "principal_id",
        field_types: { id: "uuid", tenant_id: "text", principal_id: "text", status: "text" },
        field_enums: {},
        selectable_fields: ["status"], filterable_fields: {}, sortable_fields: [], groupable_fields: [],
        aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {},
        kept_out_fields: ["id", "tenant_id", "principal_id"], relationships: [],
        minimum_cohort_size: 5, suppression_aware_totals: true,
      })) }, budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [],
    };
}


describe("native bounded requested-scope evidence", () => {
  it.each([
    ["Read `finance.accounts`.", "finance.payments", "REQUIRED_RESOURCE_OMITTED"],
    ["Read finance.accounts but not finance.payments.", "finance.accounts", null],
    ["Don’t read finance.payments.", "finance.payments", "EXCLUDED_RESOURCE"],
  ] as const)("retains original literal request at native mapping: %s", async (original, selected, refusal) => {
    const boundary = scopeBoundary(["finance.accounts", "finance.payments"]);
    const before = structuredClone(boundary);
    const requestJson = vi.fn(async (request: { body: unknown }) => {
      const wire = JSON.stringify(request.body);
      expect(wire).toContain(original);
      expect(wire).toContain(selected);
      return { status: 200, body: { output: [{ type: "function_call", call_id: "literal_scope",
        name: "runner__submit_read_workloads", arguments: JSON.stringify({ allowed: [{ id: "public_status",
          description: `Read ${selected} status`, plan: { kind: "rows", resource: selected, select: ["status"] } }], forbidden: [] }) }] } };
    });
    const operation = generateModelReadWorkload({ name: "finance_reads", generatedBoundary: boundary,
      allowedQuestions: ["Read public status."], operatorNamingContext: original, provider: "openai",
      model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true,
      deferNarration: true, dependencies: { requestJson } });
    if (refusal) await expect(operation).rejects.toThrow(refusal);
    else expect(await operation).toMatchObject({ analysis: { status: "ready" }, authority_granted: false,
      source_database_changed: false, source_query_executed: false });
    expect(boundary).toEqual(before);
  });
});


describe("host-only scope reason binding", () => {
  it("refuses a model-supplied scope-purpose tag without asking or accepting it", async () => {
    const boundary = scopeBoundary(["finance.accounts"]), before = structuredClone(boundary);
    const clarificationHandler = vi.fn(async () => ({ state: "answered" as const, answer: "Not a host question." }));
    const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "false_scope_purpose",
      name: "runner__submit_read_workloads", arguments: JSON.stringify({ clarification_request: { resource: "finance.accounts",
        reason: "Business records", question: "Which records?", reason_binding: { kind: "requested_read_scope",
          alternatives: ["finance.accounts"], digest: `sha256:${"0".repeat(64)}` } } }) }] } }));
    await expect(generateModelReadWorkload({ name: "finance_reads", generatedBoundary: boundary,
      allowedQuestions: ["Read account status."], operatorNamingContext: "Read finance.accounts.",
      provider: "openai", model: "declared-scope-fixture", apiKey: "local-fixture-only", egressAcknowledged: true,
      deferNarration: true, dependencies: { requestJson }, clarificationHandler })).rejects.toThrow(/reason_binding|CLARIFICATION_REFUSED/u);
    expect(clarificationHandler).not.toHaveBeenCalled();
    expect(requestJson).toHaveBeenCalledTimes(2);
    expect(boundary).toEqual(before);
  });
});
