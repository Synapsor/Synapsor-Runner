import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";
import { authoringDestination, bindPolicyCoverage, loadPolicySources, newPolicySourceSession, savePolicySources } from "./authoring-policy-source.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";

const captured = JSON.parse(await fs.readFile(new URL("./test-fixtures/primary-maintenance-review.json", import.meta.url), "utf8"));
const pointer = "/runner_evidence/actions/league.result_ratification/effect/source_counter_maintenance";
// Derived structural correction for deterministic tests. The captured first
// response above is unchanged. Real model confirmation is a separate gate.
function corrected(requirement = "owner_maintenance") {
  const args = structuredClone(captured.arguments);
  const i = args.passages.findIndex((p: any) => p.topic === "Conflict-counter maintenance");
  const original = args.passages[i];
  args.passages.splice(i, 1, {
    start: original.start, end: original.end, disposition: "implemented", responsibility: "runner",
    interpretation: "Runner retains the compiled exact result update and maintained integer version advance.",
    draft_paths: ["/runner_evidence/actions/league.result_ratification/effect"],
    evidence_checks: [{ path: "/runner_evidence/actions/league.result_ratification/effect/operation", equals: "update" }],
  }, {
    ...original, interpretation: "The source-owner maintenance obligation is current; independent external assurance is unverified.",
    draft_paths: [pointer], source_counter_obligation: { path: pointer, requirement },
  });
  return args;
}
const parse = (args: Record<string, unknown>, draft = structuredClone(captured.draft), source = captured.source) =>
  parsePolicyCoverage(args, source, draft, captured.operator_messages);

describe("source counter responsibility uses exact owner evidence", () => {
  it("asks for the precise component correction on the unchanged captured mixed reply", () => {
    expect(() => parse(captured.arguments)).toThrow("SOURCE_COUNTER_CLASSIFICATION_REQUIRED");
  });
  it("separates the current operating contract from unverified external assurance and revalidates on reuse", () => {
    const report = parse(corrected()), component = report.passages.find(p => p.source_counter_obligation)!;
    expect(component.source_counter_resolution).toMatchObject({ source_digest: captured.source.digest,
      proof_digest: captured.draft.runner_evidence.actions["league.result_ratification"].effect.source_counter_maintenance.proof_digest,
      external_assurance: "unverified" });
    const readiness = policyReviewReadiness(captured.source, report);
    // Existing client selection is genuinely separate; it needs its preexisting assignment.
    expect(readiness.items?.find(x => x.title === "Conflict-counter maintenance")?.blocksReview).toBe(false);
    expect(readiness.summary.join("\n")).toContain("Independent external-writer and production assurance remain unverified");
    expect(parse({ passages: report.passages })).toEqual(report);
  });
  it("keeps an explicit independent-assurance requirement blocked despite current owner attestation", () => {
    const report = parse(corrected("independent_assurance"));
    expect(report.passages.find(p => p.source_counter_obligation)?.source_counter_resolution).toBeUndefined();
    expect(policyReviewReadiness(captured.source, report).items?.find(x => x.title === "Conflict-counter maintenance")?.blocksReview).toBe(true);
  });
  it.each(["effect", "privacy", "counting", "application", "evidence", "overview", "implemented"])("cannot discharge mixed %s claims", mode => {
    const args = corrected(), p = args.passages.find((p: any) => p.source_counter_obligation);
    if (mode === "effect") p.draft_paths.push("/runner_evidence/actions/league.result_ratification/effect");
    if (mode === "privacy") p.field_checks = [{ resource: "tournament_ops.results", field: "integrity_hold", expectation: "private" }];
    if (mode === "counting") p.counter_requirements = [{ path: "/runner_evidence/actions/league.result_ratification/automatic_limits/0/history_selector/capability", current_capability: null, required_capability: null }];
    if (mode === "application") p.application_obligations = ["customer_selection"];
    if (mode === "evidence") p.evidence_checks = [{ path: pointer + "/external_writers_verified", equals: false }];
    if (mode === "overview") p.source_counter_obligation.path = "/runner_evidence/runtime_contract/source_counter_maintenance";
    if (mode === "implemented") p.disposition = "implemented";
    expect(() => parse(args)).toThrow(mode === "overview" ? "SOURCE_COUNTER_OBLIGATION_INVALID" : "SOURCE_COUNTER_COMPONENT_MIXED");
  });
  it.each(["missing", "declined", "stale", "incomplete", "false_assurance"])("does not accept %s current owner evidence", mode => {
    const draft = structuredClone(captured.draft), effect = draft.runner_evidence.actions["league.result_ratification"].effect;
    if (mode === "missing") effect.source_counter_maintenance = null;
    if (mode === "declined") effect.source_counter_maintenance.status = "declined";
    if (mode === "stale") effect.source_counter_maintenance.proof_digest = "sha256:stale";
    if (mode === "incomplete") delete effect.source_counter_maintenance.role_posture_fingerprint;
    if (mode === "false_assurance") effect.source_counter_maintenance.external_writers_verified = true;
    expect(() => parse(corrected(), draft)).toThrow("SOURCE_COUNTER_ATTESTATION_REQUIRED");
  });
  it("retains an independently incorrect effect and refuses changed proof/source on reuse", () => {
    const args = corrected(); args.passages.find((p: any) => p.evidence_checks?.some((c: any) => c.path.endsWith('/effect/operation'))).evidence_checks[0].equals = "delete";
    expect(() => parse(args)).toThrow("Mechanical evidence mismatch");
    const report = parse(corrected()), draft = structuredClone(captured.draft);
    draft.runner_evidence.actions["league.result_ratification"].effect.source_counter_maintenance.proof_digest = canonicalJsonDigest("different current record");
    expect(() => parse({ passages: report.passages }, draft)).toThrow("SOURCE_COUNTER_EVIDENCE_STALE");
    expect(() => parse({ passages: report.passages }, captured.draft, { ...captured.source, digest: canonicalJsonDigest("new source") })).toThrow("SOURCE_COUNTER_EVIDENCE_STALE");
  });
  it("runs the captured reply, one real structural correction, persistence/restart and unchanged recheck", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-maintenance-review-"));
    try {
      const sources = newPolicySourceSession(); sources.snapshots = [captured.source]; sources.active = captured.source.version;
      sources.operator_messages = captured.operator_messages;
      // Authentic existing client responsibility from the same saved job. It
      // remains unverified and is not created by maintenance classification.
      sources.application_assignments = structuredClone(captured.application_assignments);
      const conversation = createModelAuthoringConversation(); conversation.policySources = sources;
      const requests: any[] = [];
      const session = { provider: "openai" as const, model: "gpt-test", apiKey: "test-only", conversation,
        dependencies: { requestJson: async (request: any) => {
          requests.push(request.body);
          return { status: 200, body: { output: [{ type: "function_call", call_id: String(requests.length), name: "runner__review_policy_coverage",
            arguments: JSON.stringify(requests.length === 1 ? captured.arguments : corrected()) }] } };
        } } };
      sources.approvals = [{ digest: captured.source.digest, destination: authoringDestination(session) }];
      await savePolicySources(root, sources);
      const report = await reviewPolicyCoverage({ session, source: captured.source, draft: captured.draft });
      expect(requests).toHaveLength(2);
      const tool = requests[0].tools.find((tool: any) => tool.name === "runner__review_policy_coverage");
      expect(tool.parameters.properties.passages.items.properties.draft_paths.items.enum).toContain(pointer);
      expect(JSON.stringify(requests[1])).toContain("SOURCE_COUNTER_CLASSIFICATION_REQUIRED");
      bindPolicyCoverage(sources, report, canonicalJsonDigest("unchanged authority"));
      await savePolicySources(root, sources);
      const restored = await loadPolicySources(root, sources.id);
      expect(restored.coverage).toEqual(report);
      const rechecked = parse({ passages: restored.coverage!.passages });
      expect(rechecked).toEqual(report);
      expect(policyReviewReadiness(captured.source, rechecked, restored).ready).toBe(true);
      expect(requests).toHaveLength(2); // Local revalidation is not a new provider call.
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
