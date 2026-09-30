import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ensurePreparedPolicyCoverage } from "./authoring-prepared-policy-review.js";
import { reviewUnestablishedCounting } from "./authoring-counting-decision-review.js";
import { applicableCountingDecisions } from "./authoring-counting-requirements.js";
import { authoringDestination, loadPolicySources, newPolicySourceSession, policyTextSnapshot, savePolicySources } from "./authoring-policy-source.js";

/** Composed host evidence using real attributed decisions, prepared review,
 * file persistence and reload. No installed UI or complete BUSINESS claim. */
async function fixture(records: number) {
  const source = policyTextSnapshot(Buffer.from("At most two automatic approvals per customer within 86400 seconds."), "count-history.txt");
  const sources = newPolicySourceSession(); sources.snapshots = [source]; sources.active = source.version;
  sources.operator_messages = []; sources.coverage_episodes = [];
  const outcomes = ["laboratory.assign_batch", "laboratory.return_batch"];
  const limits = outcomes.map((outcome, index) => ({ id: `same_ceiling_${index}`, kind: "count", scope: "principal", maximum: 2,
    window_seconds: 86400, capability: outcome, history_selector: { capability: outcome } }));
  const draft: any = { read: { source: "local_postgres", pack: { resources: [] } },
    actions: outcomes.map((outcome, index) => ({ outcome, approval: { shared_limits: [structuredClone(limits[index])] } })),
    runner_evidence: { actions: Object.fromEntries(outcomes.map((outcome, index) => [outcome, { automatic_limits: [structuredClone(limits[index])] }])) } };
  const current = () => ({ ...draft, runner_evidence: { ...draft.runner_evidence, counting_decisions: sources.counting_decisions ?? [] } });
  for (let index = 0; (sources.counting_decisions?.length ?? 0) < records; index++) {
    sources.operator_messages.push(`Attributed history context ${index}.`);
    let selected = 0;
    const decisions = await reviewUnestablishedCounting({ source, draft: current(), messages: sources.operator_messages,
      assertCurrent: async () => {}, session: { chooseOption: async () => `outcome-${selected++}`, confirm: async () => true } });
    expect(decisions).toHaveLength(2);
    sources.counting_decisions = [...(sources.counting_decisions ?? []), ...decisions!.slice(0, records - (sources.counting_decisions?.length ?? 0))];
  }
  let providerCalls = 0;
  const model: any = { provider: "openai", model: "count-history-local-only", apiKey: "no-network",
    dependencies: { requestJson: async () => { providerCalls++; throw Error("Provider path forbidden"); } } };
  sources.approvals = [{ digest: source.digest, destination: authoringDestination(model) }];
  return { source, sources, current, model, providerCalls: () => providerCalls };
}

describe("bounded attributable counting history", () => {
  it.each([119, 120])("refuses the entire new two-decision set before questions at %s records", async records => {
    const f = await fixture(records), root = await fs.mkdtemp(path.join(os.tmpdir(), "count-history-refusal-"));
    try {
      f.sources.operator_messages!.push("New current owner history; old meanings remain attributed history.");
      await savePolicySources(root, f.sources, { expectedDigest: null });
      const file = path.join(root, ".synapsor/boundary-authoring/policy-sources", `${f.sources.id}.json`), before = await fs.readFile(file);
      const old = structuredClone(f.sources); let questions = 0;
      await expect(ensurePreparedPolicyCoverage({ projectRoot: root, sources: f.sources, modelSession: f.model,
        operatorSession: { chooseOption: async () => { questions++; return "outcome-0"; }, confirm: async () => { questions++; return true; } } as any,
        currentDraft: f.current, authorityDigest: canonicalJsonDigest("DERIVED counting component"), clarifications: [],
        assertCurrent: async () => {}, state: {}, requireCountingChoice: true,
        savedReviewEpisode: { job: "Derived history component", subject: "Current exact counting interpretation" } })).rejects.toThrow("POLICY_COUNTING_HISTORY_FULL");
      expect(questions).toBe(0); expect(f.providerCalls()).toBe(0);
      expect(await fs.readFile(file)).toEqual(before); expect(await loadPolicySources(root, f.sources.id)).toEqual(old);
      expect(f.sources).toEqual(old);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each([118, 120])("admits only needed current decisions and preserves history at %s records", async records => {
    const f = await fixture(records), root = await fs.mkdtemp(path.join(os.tmpdir(), "count-history-fit-"));
    try {
      if (records === 118) f.sources.operator_messages!.push("New current owner history.");
      const before = structuredClone(f.sources.counting_decisions!);
      await savePolicySources(root, f.sources, { expectedDigest: null }); let choices = 0, confirmations = 0;
      await expect(ensurePreparedPolicyCoverage({ projectRoot: root, sources: f.sources, modelSession: f.model,
        operatorSession: { chooseOption: async () => `outcome-${choices++}`, confirm: async (question: string) => {
          if (question === "Run a new bounded model review?") return false;
          confirmations++; return true;
        } } as any, currentDraft: f.current, authorityDigest: canonicalJsonDigest("DERIVED counting component"), clarifications: [],
        assertCurrent: async () => {}, state: {}, requireCountingChoice: true,
        savedReviewEpisode: { job: "Derived history component", subject: "Current exact counting interpretation" } })).rejects.toThrow("POLICY_COVERAGE_EPISODE_PENDING");
      const loaded = await loadPolicySources(root, f.sources.id);
      expect(loaded.counting_decisions).toHaveLength(120); expect(loaded.counting_decisions!.slice(0, records)).toEqual(before);
      expect(loaded).toEqual(f.sources); expect(choices).toBe(records === 118 ? 2 : 0); expect(confirmations).toBe(choices);
      expect(applicableCountingDecisions(f.source, f.current(), f.sources.operator_messages!, loaded.counting_decisions)).toHaveLength(2);
      expect(f.providerCalls()).toBe(0);
      // This establishes current counting reuse, not a completed BUSINESS report.
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("refuses an oversized direct save and refuses silent loss on an already-oversized file", async () => {
    const f = await fixture(120), root = await fs.mkdtemp(path.join(os.tmpdir(), "count-history-storage-"));
    try {
      await savePolicySources(root, f.sources, { expectedDigest: null });
      const file = path.join(root, ".synapsor/boundary-authoring/policy-sources", `${f.sources.id}.json`), before = await fs.readFile(file);
      const oversized = structuredClone(f.sources); oversized.counting_decisions!.push(structuredClone(oversized.counting_decisions![0]!));
      await expect(savePolicySources(root, oversized, { expectedDigest: canonicalJsonDigest(f.sources) })).rejects.toThrow("POLICY_COUNTING_HISTORY_FULL");
      expect(await fs.readFile(file)).toEqual(before);
      // Deliberately corrupt a disposable file to challenge the real decoder;
      // this does not repair or alter the independent failed 122-record fixture.
      await fs.writeFile(file, JSON.stringify(oversized)); const invalidBytes = await fs.readFile(file);
      await expect(loadPolicySources(root, f.sources.id)).rejects.toThrow("POLICY_COUNTING_HISTORY_FULL");
      expect(await fs.readFile(file)).toEqual(invalidBytes);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(["omit", "reorder", "change"])("refuses a direct save that would %s attributed history", async mode => {
    const f = await fixture(2), root = await fs.mkdtemp(path.join(os.tmpdir(), "count-history-retention-"));
    try {
      await savePolicySources(root, f.sources, { expectedDigest: null });
      const file = path.join(root, ".synapsor/boundary-authoring/policy-sources", `${f.sources.id}.json`), before = await fs.readFile(file);
      const changed = structuredClone(f.sources);
      if (mode === "omit") delete changed.counting_decisions;
      else if (mode === "reorder") changed.counting_decisions!.reverse();
      else changed.counting_decisions![0]!.required_capability = null;
      await expect(savePolicySources(root, changed, { expectedDigest: canonicalJsonDigest(f.sources) })).rejects.toThrow("POLICY_COUNTING_HISTORY_CHANGED");
      expect(await fs.readFile(file)).toEqual(before); expect(await loadPolicySources(root, f.sources.id)).toEqual(f.sources);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("preserves invalid original bytes and explicitly refuses their canonical reload", async () => {
    const f = await fixture(2), root = await fs.mkdtemp(path.join(os.tmpdir(), "count-history-invalid-"));
    try {
      await savePolicySources(root, f.sources, { expectedDigest: null });
      const file = path.join(root, ".synapsor/boundary-authoring/policy-sources", `${f.sources.id}.json`);
      const invalid: any = structuredClone(f.sources); invalid.counting_decisions[0].operator_history_digest = "changed";
      await fs.writeFile(file, JSON.stringify(invalid)); const before = await fs.readFile(file);
      await expect(loadPolicySources(root, f.sources.id)).rejects.toThrow("POLICY_COUNTING_HISTORY_INVALID");
      await expect(savePolicySources(root, f.sources, { expectedDigest: canonicalJsonDigest(invalid) })).rejects.toThrow("POLICY_COUNTING_HISTORY_INVALID");
      expect(await fs.readFile(file)).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
