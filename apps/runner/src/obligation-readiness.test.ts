import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";
import { authoringDestination, bindPolicyCoverage, loadPolicySources, newPolicySourceSession, savePolicySources } from "./authoring-policy-source.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { deferredReviewObligation } from "./authoring-obligation-review.js";

const captured = JSON.parse(await fs.readFile(new URL("./test-fixtures/primary-receipt-review.json", import.meta.url), "utf8"));
const selectionCapture = JSON.parse(await fs.readFile(new URL("./test-fixtures/receipt-selection-development.json", import.meta.url), "utf8"));
export const receiptPath = "/runner_evidence/runtime_contract/receipts";
const parse = (args = captured.arguments[1], draft = captured.draft, source = captured.source) =>
  parsePolicyCoverage(args, source, draft, captured.operator_messages);

describe("host obligation readiness on primary B's exact review", () => {
  it.each([0, 1])("preserves development response %i's valid selected-mode claim with separate pending duty", index => {
    const report = parsePolicyCoverage(selectionCapture.arguments[index], captured.source, selectionCapture.draft, selectionCapture.operator_messages);
    expect(policyReviewReadiness(captured.source, report).items?.filter(i => i.blocksReview).map(i => i.clientDuty)).toEqual(["customer_selection", "status_presentation"]);
    expect(report.passages.find(p => p.draft_paths.includes("/runner_evidence/runtime_contract/receipt_configuration"))?.disposition).toBe("implemented");
    const pending = report.passages.find(p => p.obligation_assessment?.family === "receipt_setup")!;
    expect(pending.disposition).toBe("needs_decision");
    expect(pending.obligation_assessment).toMatchObject({ verified: false, phase: "after_authority_review", state: "pending", requirement: "runner_ledger" });
    expect(parsePolicyCoverage({ passages: report.passages }, captured.source, selectionCapture.draft, selectionCapture.operator_messages)).toEqual(report);
  });
  it.each(["wrong_mode", "unknown_mode", "mixed_field", "observation"])("rejects %s in the selected-mode component", mode => {
    const draft = structuredClone(selectionCapture.draft), args = structuredClone(selectionCapture.arguments[1]);
    const p = args.passages.find((p: any) => p.draft_paths.includes("/runner_evidence/runtime_contract/receipt_configuration"));
    if (mode === "wrong_mode") draft.runner_evidence.runtime_contract.receipt_configuration.modes[0].authority = "source_db";
    if (mode === "unknown_mode") draft.runner_evidence.runtime_contract.receipt_configuration.modes = [];
    if (mode === "mixed_field") p.field_checks = [{ resource: "tournament_ops.results", field: "integrity_hold", expectation: "private" }];
    if (mode === "observation") p.evidence_checks = [{ path: "/runner_evidence/runtime_contract/receipt_configuration/receipt_produced", equals: true }];
    expect(() => parsePolicyCoverage(args, captured.source, draft, selectionCapture.operator_messages)).toThrow();
  });
  it.each(["extra_path", "field", "counter", "evidence", "implemented", "runner", "host_removed", "host_path"])("does not defer a receipt with %s", mode => {
    const report = parse(), p = structuredClone(report.passages.find(p => p.obligation_assessment?.family === "receipt_setup")!);
    expect(deferredReviewObligation(p)?.family).toBe("receipt_setup");
    if (mode === "extra_path") p.draft_paths.push("/actions/0/approval");
    if (mode === "field") p.field_checks = [{ resource: "results", field: "private_note", expectation: "private" }];
    if (mode === "counter") p.counter_requirements = [{ path: "irrelevant", current_capability: null, required_capability: null }];
    if (mode === "evidence") p.evidence_checks = [{ path: receiptPath, equals: false }];
    if (mode === "implemented") p.disposition = "implemented";
    if (mode === "runner") p.responsibility = "runner";
    if (mode === "host_removed") delete p.obligation_assessment;
    if (mode === "host_path") p.obligation_assessment!.path = "/unrelated";
    expect(deferredReviewObligation(p)).toBeUndefined();
  });
  it.each(["unknown", "negated", "ambiguous", "unsupported", "unavailable"])("keeps %s receipt association unresolved", mode => {
    const source = structuredClone(captured.source), draft = structuredClone(captured.draft);
    if (mode === "unknown") source.text = source.text.replace("stored Runner-ledger receipt", "durable globally delivered receipt");
    if (mode === "negated") source.text = source.text.replace("Request a stored", "Do not request a stored");
    if (mode === "ambiguous") source.text = source.text.replace("stored Runner-ledger receipt", "stored Runner-ledger receipt or source_db receipt");
    if (mode === "unsupported") draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.receipt_modes_supported = [];
    if (mode === "unavailable") draft.runner_evidence.runtime_contract.receipt_configuration = { status: "unavailable", modes: [] };
    // A changed source needs fresh counting decisions independently. Isolate this
    // synthetic receipt component while retaining the full source line coverage.
    const p = captured.arguments[1].passages.find((p: any) => p.draft_paths.length === 1 && p.draft_paths[0] === receiptPath);
    const s = { ...source, text: source.text.split("\n")[6], lines: 1, digest: canonicalJsonDigest(source.text) };
    const d = { runner_evidence: { runtime_contract: draft.runner_evidence.runtime_contract } };
    const report = parse({ passages: [{ ...p, start: 1, end: 1 }] }, d, s);
    expect(report.passages[0]!.obligation_assessment).toBeUndefined();
    expect(policyReviewReadiness(s, report).ready).toBe(false);
  });
  it("refuses a source-atomic requirement against a Runner-ledger configuration", () => {
    const draft = structuredClone(captured.draft);
    draft.runner_evidence.runtime_contract.receipt_configuration = { status: "current", modes: [{ authority: "runner_ledger" }] };
    const source = { ...captured.source, text: "Request a stored source_db receipt.", lines: 1, digest: canonicalJsonDigest("source_db") };
    const p = captured.arguments[1].passages.find((p: any) => p.draft_paths.length === 1 && p.draft_paths[0] === receiptPath);
    expect(() => parse({ passages: [{ ...p, start: 1, end: 1 }] }, { runner_evidence: { runtime_contract: draft.runner_evidence.runtime_contract } }, source)).toThrow("OBLIGATION_RECEIPT_MODE_MISMATCH");
  });
  it("refuses observation claims and stale setup/source/candidate evidence on reuse", () => {
    const args = structuredClone(captured.arguments[1]);
    args.passages.find((p: any) => p.draft_paths.length === 1 && p.draft_paths[0] === receiptPath).disposition = "implemented";
    expect(() => parse(args)).toThrow("OBLIGATION_OBSERVATION_UNESTABLISHED");
    const report = parse(), draft = structuredClone(captured.draft);
    draft.runner_evidence.runtime_contract.deployment_prerequisites.runner_execution_setup.supported = false;
    expect(() => parse({ passages: report.passages }, draft)).toThrow();
    expect(() => parse({ passages: report.passages }, captured.draft, { ...captured.source, digest: canonicalJsonDigest("new source") })).toThrow();
    const candidate = structuredClone(captured.draft);
    candidate.runner_evidence.actions["league.result_ratification"].effect.operation = "delete";
    expect(() => parse({ passages: report.passages }, candidate)).toThrow();
  });
  it("keeps reordered/split source components equivalent without discharging a wrong business field", () => {
    const original = parse(), args = structuredClone(captured.arguments[1]);
    args.passages.reverse();
    const reordered = parse(args);
    expect(reordered.passages.filter(p => p.obligation_assessment).map(p => p.obligation_assessment).sort((a, b) => a!.path.localeCompare(b!.path)))
      .toEqual(original.passages.filter(p => p.obligation_assessment).map(p => p.obligation_assessment).sort((a, b) => a!.path.localeCompare(b!.path)));
    args.passages.push({ start: 7, end: 7, disposition: "conflict", interpretation: "A separate eligibility requirement is unresolved.", responsibility: "deployment", issue_kind: "contradiction", draft_paths: ["/actions/0/approval"] });
    expect(policyReviewReadiness(captured.source, parse(args)).ready).toBe(false);
  });
  it("retains the exact initial structural refusal, independently of phase association", () => {
    expect(() => parse(captured.arguments[0])).toThrow('runner_execution_setup draft_paths must contain only');
  });
  it("replays both complete replies through producer, correction, save, reload and readiness", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-receipt-review-"));
    try {
      const sources = newPolicySourceSession(); sources.snapshots = structuredClone(captured.snapshots); sources.active = captured.source.version;
      sources.operator_messages = captured.operator_messages;
      sources.application_assignments = structuredClone(captured.application_assignments);
      const conversation = createModelAuthoringConversation(); conversation.policySources = sources;
      const requests: any[] = [];
      const session = { provider: "openai" as const, model: "gpt-test", apiKey: "test-only", conversation,
        dependencies: { requestJson: async (request: any) => {
          requests.push(request.body);
          const reply = requests.length <= 2 ? captured.arguments[requests.length - 1]
            : { passages: captured.arguments[1].passages.filter((p: any) => !p.draft_paths.includes(receiptPath)
              && !p.application_obligations?.includes("independent_source_readback")) };
          return { status: 200, body: { output: [{ type: "function_call", call_id: String(requests.length), name: "runner__review_policy_coverage",
            arguments: JSON.stringify(reply) }] } };
        } } };
      sources.approvals = [{ digest: captured.source.digest, destination: authoringDestination(session) }];
      await savePolicySources(root, sources);
      const report = await reviewPolicyCoverage({ session, source: captured.source, draft: captured.draft });
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1])).toContain('runner_execution_setup draft_paths must contain only');
      bindPolicyCoverage(sources, report, canonicalJsonDigest("unchanged authority"));
      await savePolicySources(root, sources);
      const restored = await loadPolicySources(root, sources.id);
      expect(restored.coverage).toEqual(report);
      const rechecked = parse({ passages: restored.coverage!.passages });
      expect(rechecked).toEqual(report);
      expect(report.passages.find(p => p.draft_paths.length === 1 && p.draft_paths[0] === receiptPath)?.disposition).toBe("needs_decision");
      expect(policyReviewReadiness(captured.source, rechecked, restored).items?.filter(i => i.blocksReview).map(i => i.clientDuty)).toEqual(["customer_selection", "status_presentation"]);
      // Separately labelled synthetic omission after the two exact captures.
      const omitted = await reviewPolicyCoverage({ session, source: captured.source, draft: captured.draft, previousReport: report });
      expect(requests).toHaveLength(3);
      expect(omitted.passages.filter(p => p.obligation_assessment).map(p => p.obligation_assessment!.family).sort())
        .toEqual(report.passages.filter(p => p.obligation_assessment).map(p => p.obligation_assessment!.family).sort());
      const savedDigest = canonicalJsonDigest(restored);
      const competing = structuredClone(restored); competing.operator_messages = [...competing.operator_messages!, "An independently saved decision."];
      await savePolicySources(root, competing, { expectedDigest: savedDigest });
      await expect(savePolicySources(root, restored, { expectedDigest: savedDigest })).rejects.toThrow("POLICY_SOURCE_CHANGED");
      expect(await loadPolicySources(root, sources.id)).toEqual(competing);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
