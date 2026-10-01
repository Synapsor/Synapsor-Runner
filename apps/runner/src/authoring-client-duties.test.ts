import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import * as receiptConfiguration from "./authoring-receipt-configuration.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { clientDutyInventory, isClientDutyPassage, reviewClientDutyOwnership } from "./authoring-client-duties.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";
import { bindPolicyCoverage, loadPolicySources, savePolicySources, type PolicySourceSession } from "./authoring-policy-source.js";
import { ensurePreparedPolicyCoverage } from "./authoring-prepared-policy-review.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { derivedScopedResponse } from "./test-fixtures/coverage-derived.js";

const captured = JSON.parse(await fs.readFile(new URL("./test-fixtures/client-duty-matched-reviews.json", import.meta.url), "utf8"));
function fixture(name = "terra") {
  const sources: PolicySourceSession = structuredClone(captured.sessions[name]);
  const source = sources.snapshots.find(s => s.version === sources.active)!;
  const draft = structuredClone(captured.draft);
  draft.runner_evidence.counting_decisions = sources.counting_decisions;
  // The records are from each real session; provider prose is never changed.
  return { sources, source, draft, args: { passages: sources.coverage!.passages } };
}
const blockedDuties = (r: ReturnType<typeof policyReviewReadiness>) => r.items?.filter(i => i.clientDuty && i.blocksReview).map(i => i.clientDuty);

describe("intrinsic client duties independent of coverage wording", () => {
  it.each(["path", "field", "counter", "evidence", "business_choice", "contradiction", "implemented", "runner"])("ownership cannot discharge %s from a mixed duty", mode => {
    const { sources } = fixture("grok");
    const p = structuredClone(sources.coverage!.passages.find(p => p.application_obligations?.includes("customer_selection"))!);
    expect(isClientDutyPassage(p)).toBe(true);
    if (mode === "path") p.draft_paths.push("/actions/0/approval");
    if (mode === "field") p.field_checks = [{ resource: "r", field: "private", expectation: "private" }];
    if (mode === "counter") p.counter_requirements = [{ path: "/actions/0/approval", current_capability: null, required_capability: null }];
    if (mode === "evidence") p.evidence_checks = [{ path: "/runner_evidence/other", equals: true }];
    if (mode === "business_choice" || mode === "contradiction") p.issue_kind = mode;
    if (mode === "implemented") p.disposition = "implemented";
    if (mode === "runner") p.responsibility = "runner";
    expect(isClientDutyPassage(p)).toBe(false);
  });
  it.each(["terra", "grok"])("%s exact persisted report requires both current owners", async name => {
    const { sources, source, draft, args } = fixture(name);
    const report = parsePolicyCoverage(args, source, draft, sources.operator_messages ?? []);
    expect(blockedDuties(policyReviewReadiness(source, report, sources))).toEqual(["customer_selection", "status_presentation"]);
    const history = structuredClone(sources.application_assignments);
    const chooseOption = vi.fn().mockResolvedValue("assign");
    const accepted = await reviewClientDutyOwnership({ report, sources, session: { chooseOption }, assertCurrent: async () => {} });
    sources.application_assignments = [...sources.application_assignments!, ...accepted];
    expect(policyReviewReadiness(source, report, sources).ready).toBe(true);
    expect(sources.application_assignments.slice(0, history!.length)).toEqual(history);
    expect(accepted).toEqual([expect.objectContaining({ verified: false, origin: "PRODUCT-CLIENT-CONTRACT", obligations: ["customer_selection", "status_presentation"] })]);
    expect(accepted[0]).not.toHaveProperty("start");
    expect(await reviewClientDutyOwnership({ report, sources, session: { chooseOption }, assertCurrent: async () => {} })).toEqual([]);
    expect(chooseOption).toHaveBeenCalledTimes(1);
  });
  it.each(["neither", "selection", "status", "both", "combined", "reordered", "background", "empty"])("%s cannot erase inventory", mode => {
    const { sources, source, draft, args } = fixture();
    const duties = mode === "selection" ? ["customer_selection"] : mode === "status" ? ["status_presentation"] : ["customer_selection", "status_presentation"];
    if (!["neither", "empty", "background"].includes(mode)) {
      const groups = mode === "combined" ? [duties] : duties.map(d => [d]);
      for (const ds of groups) args.passages.push({ start: 1, end: 1, disposition: "needs_decision", responsibility: "application", issue_kind: "missing_configuration",
        interpretation: "Client integration remains unverified.", application_obligations: ds as any,
        draft_paths: ds.map(d => `/runner_evidence/runtime_contract/application_obligations/${d}`) });
    }
    if (mode === "background") args.passages.push({ start: 1, end: 1, disposition: "background", interpretation: "Client context.", draft_paths: [] });
    if (mode === "empty") args.passages[0]!.application_obligations = [];
    if (mode === "reordered") args.passages.reverse();
    if (mode === "empty") expect(() => parsePolicyCoverage(args, source, draft, sources.operator_messages!)).toThrow("application_obligations");
    else expect(blockedDuties(policyReviewReadiness(source, parsePolicyCoverage(args, source, draft, sources.operator_messages!), sources))).toHaveLength(2);
  });
  it("bases non-applicability on Read-only structure and leaves unknown mode unresolved", () => {
    expect(clientDutyInventory({ actions: [] })).toMatchObject({ mode: "read_only", duties: [] });
    expect(clientDutyInventory({})).toMatchObject({ mode: "unresolved", duties: [] });
    const { draft } = fixture(); draft.runner_evidence.runtime_contract.client_contract = { mode: "unknown", client: "custom" };
    expect(clientDutyInventory(draft).mode).toBe("unresolved");
  });
  it.each(["cancel", "drift"])("%s installs no acceptance", async mode => {
    const { sources, source, draft, args } = fixture();
    const before = structuredClone(sources);
    const report = parsePolicyCoverage(args, source, draft, sources.operator_messages!);
    let n = 0;
    const operation = reviewClientDutyOwnership({ report, sources, session: { chooseOption: async () => mode === "cancel" ? "back" : "assign" },
      assertCurrent: async () => { if (++n === 2) throw new Error("POLICY_SOURCE_CHANGED"); } });
    if (mode === "cancel") expect(await operation).toEqual([]); else await expect(operation).rejects.toThrow("POLICY_SOURCE_CHANGED");
    expect(sources).toEqual(before);
  });
  it("remembers Keep pending only within the live exact client-duty context", async () => {
    const { sources, source, draft, args } = fixture();
    const report = parsePolicyCoverage(args, source, draft, sources.operator_messages!);
    const before = structuredClone(sources), reviewState = {};
    const chooseOption = vi.fn(async () => "back");
    const input = { report, sources, session: { chooseOption }, assertCurrent: async () => {}, reviewState };
    expect(await reviewClientDutyOwnership(input as any)).toEqual([]);
    expect(await reviewClientDutyOwnership(input as any)).toEqual([]);
    expect(chooseOption).toHaveBeenCalledTimes(1);
    for (const changed of [
      { ...report, source_digest: canonicalJsonDigest("changed complete Source") },
      { ...report, draft_digest: canonicalJsonDigest("changed prepared draft") },
      { ...report, client_duties: { ...report.client_duties!, contract_digest: canonicalJsonDigest("changed client contract") } },
    ]) expect(await reviewClientDutyOwnership({ ...input, report: changed } as any)).toEqual([]);
    expect(chooseOption).toHaveBeenCalledTimes(4);
    expect(await reviewClientDutyOwnership({ ...input, reviewState: {} } as any)).toEqual([]);
    expect(chooseOption).toHaveBeenCalledTimes(5);
    expect(sources).toEqual(before);
    expect(blockedDuties(policyReviewReadiness(source, report, sources))).toHaveLength(2);
  });
  it("distinguishes an undefined menu cancellation from explicit Keep pending", async () => {
    const { sources, source, draft, args } = fixture();
    const report = parsePolicyCoverage(args, source, draft, sources.operator_messages!);
    const before = structuredClone(sources);
    await expect(reviewClientDutyOwnership({ report, sources, session: { chooseOption: async () => undefined },
      assertCurrent: async () => {} })).rejects.toMatchObject({ code: "ASK_CANCELLED" });
    expect(sources).toEqual(before);
  });
  it("preserves a consumed valid report on menu cancellation and reopens with no extra generation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-client-duty-pause-"));
    try {
      const { sources, draft, args } = fixture();
      vi.spyOn(receiptConfiguration, "authoringReceiptConfiguration").mockResolvedValue(draft.runner_evidence.runtime_contract.receipt_configuration);
      delete sources.coverage_context_digest;
      const conversation = createModelAuthoringConversation(); conversation.policySources = sources;
      const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "owned-valid-before-cancel",
        name: "runner__review_policy_coverage", arguments: JSON.stringify(args) }] } }));
      const modelSession = { provider: "openai" as const, model: "gpt-5.6-terra", apiKey: "test-only", conversation, dependencies: { requestJson } };
      await savePolicySources(root, sources);
      const assignments = structuredClone(sources.application_assignments), onValidated = vi.fn();
      const input = { projectRoot: root, sources, modelSession, currentDraft: () => draft,
        authorityDigest: sources.coverage_authority_digest!, clarifications: [], assertCurrent: async () => {}, state: {}, onValidated };
      await expect(ensurePreparedPolicyCoverage({ ...input, operatorSession: { chooseOption: async () => undefined, confirm: async () => false } as any }))
        .rejects.toMatchObject({ code: "ASK_CANCELLED" });
      const restarted = await loadPolicySources(root, sources.id);
      expect(restarted.application_assignments).toEqual(assignments);
      expect(restarted.coverage).toEqual(sources.coverage);
      expect(restarted.coverage_context_digest).toBeDefined();
      expect(restarted.coverage_episodes!.at(-1)!.submissions.at(-1)!.validated).toBe(true);
      expect(onValidated).toHaveBeenCalledTimes(1);
      expect(policyReviewReadiness(restarted.snapshots.find(s => s.version === restarted.active)!, restarted.coverage, restarted).ready).toBe(false);
      const reviewed = await ensurePreparedPolicyCoverage({ ...input, sources: restarted, state: {},
        operatorSession: { chooseOption: async () => "assign", confirm: async () => false } as any });
      expect(reviewed.activity).toBe("validated_reuse");
      expect(policyReviewReadiness(reviewed.source, reviewed.report, restarted).ready).toBe(true);
      expect(restarted.application_assignments!.at(-1)).toMatchObject({ owner: "client_application", verified: false });
      expect(requestJson).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains current ownership through save/reload while changed source, client and draft refuse reuse", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-client-duty-"));
    try {
      const { sources, source, draft, args } = fixture();
      const report = parsePolicyCoverage(args, source, draft, sources.operator_messages!);
      bindPolicyCoverage(sources, report, canonicalJsonDigest("authority"));
      sources.application_assignments!.push(...await reviewClientDutyOwnership({ report, sources, session: { chooseOption: async () => "assign" }, assertCurrent: async () => {} }));
      await savePolicySources(root, sources);
      const restored = await loadPolicySources(root, sources.id);
      expect(policyReviewReadiness(source, restored.coverage, restored).ready).toBe(true);
      for (const changed of [{ ...report, source_digest: canonicalJsonDigest("new source") }, { ...report, draft_digest: canonicalJsonDigest("new draft") },
        { ...report, client_duties: { ...report.client_duties!, contract_digest: canonicalJsonDigest("new client") } }])
        expect(policyReviewReadiness(source, changed, restored).ready).toBe(false);
      await expect(savePolicySources(root, { ...sources, application_assignments: [] }, { expectedDigest: canonicalJsonDigest("stale") })).rejects.toThrow("POLICY_SOURCE_CHANGED");
      expect(await loadPolicySources(root, sources.id)).toEqual(restored);
    } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(["source", "client", "abort"])("menu cancellation cannot bypass the prepared %s guard", async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-client-duty-cancel-race-"));
    try {
      const { sources, draft, args } = fixture();
      vi.spyOn(receiptConfiguration, "authoringReceiptConfiguration").mockResolvedValue(draft.runner_evidence.runtime_contract.receipt_configuration);
      delete sources.coverage_context_digest;
      const conversation = createModelAuthoringConversation(); conversation.policySources = sources;
      const requestJson = vi.fn(async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "valid-before-cancel-race",
        name: "runner__review_policy_coverage", arguments: JSON.stringify(args) }] } }));
      const modelSession = { provider: "openai" as const, model: "gpt-5.6-terra", apiKey: "test-only", conversation, dependencies: { requestJson } };
      await savePolicySources(root, sources);
      const before = structuredClone(sources), onValidated = vi.fn();
      let aborted = false;
      await expect(ensurePreparedPolicyCoverage({ projectRoot: root, sources, modelSession,
        operatorSession: { chooseOption: async () => {
          if (mode === "source") await savePolicySources(root, { ...sources, operator_messages: [...sources.operator_messages!, "A concurrent current decision"] });
          if (mode === "client") draft.runner_evidence.runtime_contract.client_contract = { mode: "interactive_four_tool", client: "changed" };
          if (mode === "abort") aborted = true;
          return undefined;
        }, confirm: async () => false } as any,
        currentDraft: () => draft, authorityDigest: sources.coverage_authority_digest!, clarifications: [], state: {}, onValidated,
        assertCurrent: async () => { if (aborted) throw new Error("OWNED_REVIEW_ABORTED"); } }))
        .rejects.toThrow(mode === "source" ? "POLICY_SOURCE_CHANGED" : mode === "client" ? "POLICY_CLIENT_CONTRACT_CHANGED" : "OWNED_REVIEW_ABORTED");
      expect(onValidated).not.toHaveBeenCalled();
      const restored = await loadPolicySources(root, sources.id);
      expect(restored.application_assignments).toEqual(before.application_assignments);
      expect(restored.coverage).toEqual(before.coverage);
      expect(requestJson).toHaveBeenCalledTimes(1);
    } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(["source", "client", "save_failure"])("prepared %s race/failure cannot persist partial ownership or complete review", async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-client-duty-race-"));
    try {
      const { sources, draft, args } = fixture();
      vi.spyOn(receiptConfiguration, "authoringReceiptConfiguration").mockResolvedValue(draft.runner_evidence.runtime_contract.receipt_configuration);
      delete sources.coverage_context_digest;
      const conversation = createModelAuthoringConversation(); conversation.policySources = sources;
      const modelSession = { provider: "openai" as const, model: "gpt-5.6-terra", apiKey: "test-only", conversation,
        dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "captured", name: "runner__review_policy_coverage", arguments: JSON.stringify(args) }] } }) } };
      await savePolicySources(root, sources);
      const before = structuredClone(sources), onValidated = vi.fn();
      const operation = ensurePreparedPolicyCoverage({ projectRoot: root, sources, modelSession,
        operatorSession: { chooseOption: async () => {
          if (mode === "source") await savePolicySources(root, { ...sources, operator_messages: [...sources.operator_messages!, "A concurrent decision"] });
          if (mode === "client") draft.runner_evidence.runtime_contract.client_contract = { mode: "interactive_four_tool", client: "changed" };
          if (mode === "save_failure") vi.spyOn(fs, "rename").mockRejectedValue(new Error("owned save failed"));
          return "assign";
        }, confirm: async () => false } as any,
        currentDraft: () => draft, authorityDigest: sources.coverage_authority_digest!, clarifications: [], assertCurrent: async () => {}, state: {}, onValidated });
      await expect(operation).rejects.toThrow(mode === "source" ? "POLICY_SOURCE_CHANGED" : mode === "client" ? "POLICY_CLIENT_CONTRACT_CHANGED" : "owned save failed");
      expect(onValidated).not.toHaveBeenCalled();
      const { coverage_episodes, ...unchanged } = sources;
      expect(unchanged).toEqual(before);
      expect(coverage_episodes?.[0]?.submissions).toHaveLength(1); // reserved attempt is durable, no partial ownership
      expect((await loadPolicySources(root, sources.id)).application_assignments).toEqual(before.application_assignments);
    } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
  });
  it("accepted ownership cannot discharge other claims or an invented duty", async () => {
    const { sources, source, draft, args } = fixture();
    const report = parsePolicyCoverage(args, source, draft, sources.operator_messages!);
    sources.application_assignments!.push(...await reviewClientDutyOwnership({ report, sources, session: { chooseOption: async () => "assign" }, assertCurrent: async () => {} }));
    for (const change of [
      { start: 1, end: 1, disposition: "conflict", responsibility: "runner", interpretation: "A required maximum is wrong.", draft_paths: ["/actions/0/approval"] },
      { start: 1, end: 1, disposition: "unsupported", responsibility: "runner", interpretation: "A separate obligation is not implemented.", draft_paths: [] },
    ]) expect(policyReviewReadiness(source, { ...report, passages: [...report.passages, change as any] }, sources).ready).toBe(false);
    const invented = { start: 1, end: 1, disposition: "needs_decision", responsibility: "application", interpretation: "Trust the client to waive eligibility.",
      application_obligations: ["waive_eligibility"], draft_paths: [] };
    expect(() => parsePolicyCoverage({ passages: [...args.passages, invented] }, source, draft, sources.operator_messages!)).toThrow("application_obligations");
  });
  it.each(["terra", "grok"])("runs %s saved-review producer, explicit assignment and validated reuse", async name => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-client-duty-prepared-"));
    try {
      const { sources, draft, args } = fixture(name);
      vi.spyOn(receiptConfiguration, "authoringReceiptConfiguration").mockResolvedValue(draft.runner_evidence.runtime_contract.receipt_configuration);
      delete sources.coverage_context_digest;
      const conversation = createModelAuthoringConversation(); conversation.policySources = sources;
      let call = 0;
      const requestJson = vi.fn(async (request) => {
        const response = name === "terra" ? (call++ === 0 ? captured.terra_arguments[0]
          : derivedScopedResponse(request, captured.terra_arguments[1])) : args;
        return { status: 200, body: { output: [{ type: "function_call", call_id: "captured", name: "runner__review_policy_coverage", arguments: JSON.stringify(response) }] } };
      });
      const modelSession = { provider: "openai" as const, model: "gpt-5.6-terra", apiKey: "test-only", conversation, dependencies: { requestJson } };
      if (name === "grok") sources.approvals.push({ digest: sources.snapshots.find(s => s.version === sources.active)!.digest,
        destination: "openai[gpt-5.6-terra] at https://api.openai.com/v1" }); // local captured-response adapter, not a Grok transport claim
      const chooseOption = vi.fn(async () => "assign");
      await savePolicySources(root, sources);
      const input = { projectRoot: root, sources, modelSession, operatorSession: { chooseOption, confirm: async () => false } as any,
        currentDraft: () => draft, authorityDigest: sources.coverage_authority_digest!, clarifications: [], assertCurrent: async () => {}, state: {} };
      const reviewed = await ensurePreparedPolicyCoverage(input);
      expect(reviewed.activity).toBe("provider");
      expect(policyReviewReadiness(reviewed.source, reviewed.report, sources).ready).toBe(true);
      const restarted = await loadPolicySources(root, sources.id);
      const rechecked = await ensurePreparedPolicyCoverage({ ...input, sources: restarted, state: {} });
      expect(rechecked.activity).toBe("validated_reuse");
      expect(chooseOption).toHaveBeenCalledTimes(1); expect(requestJson).toHaveBeenCalledTimes(name === "terra" ? 2 : 1);
    } finally { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); }
  });
});
