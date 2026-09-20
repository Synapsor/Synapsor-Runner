import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { countingSourceRequirements } from "./authoring-counting-requirements.js";
import { reviewUnestablishedCounting } from "./authoring-counting-decision-review.js";
import { collectCoverageFeedback, parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { bindPolicyCoverage, loadPolicySources, policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";

const capture = JSON.parse(await fs.readFile(new URL("./test-fixtures/faithful-current-description.json", import.meta.url), "utf8"));
function fixture() {
  const { context, response } = structuredClone(capture), sources = context.source_document;
  const source = sources.snapshots.find((s: any) => s.version === sources.active), draft = context.draft;
  const corrected = structuredClone(response);
  for (const check of corrected.passages[9].counter_requirements) check.current_capability = check.required_capability = "release.clear_assessment";
  return { source, sources, draft, response, corrected, messages: sources.operator_messages };
}
const requirements = (f: ReturnType<typeof fixture>) => countingSourceRequirements(f.source, f.draft, f.messages);

describe("source counting association uses positive meaning, not missing words", () => {
  it("keeps the exact current description refusal and does not interpret A's empty phrase as all outcomes", () => {
    const f = fixture(), original = structuredClone(f);
    expect(requirements(f)).toHaveLength(2);
    expect(requirements(f).every(r => r.state !== "established" && r.required_capability === undefined)).toBe(true);
    expect(() => parsePolicyCoverage(f.corrected, f.source, f.draft, f.messages)).toThrow("COUNTING_REQUIREMENT_AMBIGUOUS");
    expect(collectCoverageFeedback(f.response, f.source, f.draft, f.messages).findings.map(f => f.code))
      .toEqual(["COUNTING_CURRENT_DESCRIPTION_MISMATCH", "COUNTING_CURRENT_DESCRIPTION_MISMATCH"]);
    expect(f).toEqual(original);
  });

  it("resolves the original source through one existing exact review per counter and retains it after save/restart/recheck", async () => {
    const f = fixture(), before = canonicalJsonDigest(f.draft), sourceBefore = structuredClone(f.source);
    const contexts: string[][] = []; let confirmations = 0;
    const decisions = await reviewUnestablishedCounting({ source: f.source, draft: f.draft, messages: f.messages,
      assertCurrent: async () => {}, session: {
        chooseOption: async (_title, _options, options) => { contexts.push(options!.context!); return "outcome-0"; },
        confirm: async () => { confirmations++; return true; },
      } });
    expect(contexts).toHaveLength(2); expect(confirmations).toBe(2);
    contexts.forEach(c => expect(c.join("\n")).toContain("Both counts are outcome-specific"));
    expect(canonicalJsonDigest(f.draft)).toBe(before); expect(f.source).toEqual(sourceBefore);
    f.draft.runner_evidence.counting_decisions = decisions; f.sources.counting_decisions = decisions;
    const report = parsePolicyCoverage(f.corrected, f.source, f.draft, f.messages);
    const bindings = report.passages[9]!.counting_requirement_bindings!;
    expect(bindings).toHaveLength(2);
    expect(bindings.every(b => b.required_capability === "release.clear_assessment"
      && b.operator_review?.source_digest === f.source.digest && b.operator_review?.path === b.path)).toBe(true);
    // Counting completion does not discharge A's other unresolved obligations.
    expect(report.passages[1]!.disposition).toBe("conflict");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-association-"));
    try {
      bindPolicyCoverage(f.sources, report, canonicalJsonDigest(f.draft.actions));
      await savePolicySources(root, f.sources, { expectedDigest: null });
      const loaded = await loadPolicySources(root, f.sources.id);
      f.draft.runner_evidence.counting_decisions = loaded.counting_decisions;
      const again = parsePolicyCoverage({ passages: loaded.coverage!.passages }, f.source, f.draft, loaded.operator_messages!);
      expect(again.passages[9]!.counting_requirement_bindings).toEqual(bindings);
      expect(await reviewUnestablishedCounting({ source: f.source, draft: f.draft, messages: f.messages,
        assertCurrent: async () => {}, session: { confirm: async () => { throw Error("settled question repeated"); } } })).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each([
    "At most two automatic approvals overall in a rolling day.",
    "At most two automatic approvals per organization for that outcome.",
    "At most two automatic approvals for the exact outcome.\nBoth counts are outcome-specific.",
    "Both counts are outcome-specific.\nAt most two automatic approvals for that outcome.",
    'The quoted instruction is "at most two automatic approvals across all outcomes".',
    "At most two automatic approvals across all outcomes except the restricted outcome.",
    "At most two automatic approvals across all outcomes and maximum three automatic unrecognized things.",
  ])("leaves synthetic unresolved/quoted/conflicting wording unresolved: %s", text => {
    const f = fixture(); f.source = policyTextSnapshot(Buffer.from(text), "association-control.txt");
    expect(requirements(f).every(r => r.state !== "established")).toBe(true);
    // Neither current selectors nor a singleton draft are source meaning.
    for (const a of f.draft.actions) for (const limit of a.approval.shared_limits) delete limit.capability;
    for (const a of Object.values<any>(f.draft.runner_evidence.actions)) for (const limit of a.automatic_limits) {
      delete limit.capability; limit.history_selector.capability = null;
    }
    expect(requirements(f).every(r => r.state !== "established")).toBe(true);
  });

  it("retains explicit all-outcomes meaning independently of configured selectors", () => {
    const f = fixture(); f.source = policyTextSnapshot(Buffer.from("At most two automatic approvals across all outcomes in a rolling day."), "all-outcomes.txt");
    expect(requirements(f).every(r => r.state === "established" && r.required_capability === null)).toBe(true);
  });

  it("keeps named, renamed and ambiguous outcomes separate from current filters", () => {
    const f = fixture(); f.source = policyTextSnapshot(Buffer.from("At most two automatic clear assessments per organization."), "named-control.txt");
    expect(requirements(f).every(r => r.state === "established" && r.required_capability === "release.clear_assessment")).toBe(true);
    const renamed = JSON.parse(JSON.stringify(f).replaceAll("release.clear_assessment", "example.check_item"));
    expect(requirements(renamed).every(r => r.state === "established" && r.required_capability === "example.check_item")).toBe(true);
    f.draft.actions.push({ ...structuredClone(f.draft.actions[0]), outcome: "other.clear_assessment" });
    f.draft.runner_evidence.actions["other.clear_assessment"] = structuredClone(f.draft.runner_evidence.actions["release.clear_assessment"]);
    expect(requirements(f).every(r => r.state !== "established")).toBe(true);
  });
});
