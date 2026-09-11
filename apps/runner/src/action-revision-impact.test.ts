import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LocalProposalState, StoredProposal, WorkerQueueItem, WorkerQueueStatus } from "@synapsor-runner/proposal-store";
import type { ActionRuleAuthorityActivationV1, ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { actionRevisionImpactLines, inspectActionRevisionImpact, reviewActionRevisionImpact } from "./action-revision-impact.js";

const previousDigest = `sha256:${"a".repeat(64)}`;
const row = (proposal_id: string, state: LocalProposalState, digest = previousDigest) => ({ proposal_id, state,
  change_set: { semantic_authority: { proof: { action_boundary_digest: digest } } } } as StoredProposal);
const queue = (proposal_id: string, status: WorkerQueueStatus): WorkerQueueItem => ({
  proposal_id, status, execution_mode: "supervised_worker", attempts: 0, max_attempts: 3,
  next_attempt_at: "2026-09-11T00:00:00.000Z", created_at: "2026-09-11T00:00:00.000Z", updated_at: "2026-09-11T00:00:00.000Z",
});

describe("operator review of requests affected by rule replacement", () => {
  it("counts the exact prior authority and separates waiting, authorized and uncertain requests", async () => {
    const proposals = [row("pending", "pending_review"), row("approved", "approved"), row("running", "pending_worker"),
      row("uncertain", "reconciliation_required"), row("done", "applied"), row("unrelated", "pending_review", "other")];
    const before = structuredClone(proposals);
    const listProposals = vi.fn(async filters => proposals.filter(row => row.state === filters.state));
    const getWorkerQueueItem = vi.fn(async (id: string) => id === "running" ? queue(id, "leased") : undefined);
    const impact = await inspectActionRevisionImpact({ store: { listProposals, getWorkerQueueItem }, previousDigest });
    expect(impact).toMatchObject({ complete: true, pending: 4, awaiting_review: 1, approved_or_running: 2, reconciliation: 1,
      examples: ["pending", "approved", "running", "uncertain"] });
    expect(proposals).toEqual(before);
    expect(listProposals.mock.calls.every(([filters]) => filters.limit === 201)).toBe(true);
    const text = actionRevisionImpactLines(impact).join("\n");
    expect(text).toContain("already dispatched may finish");
    expect(text).toContain("proposals reject <reference> --reason \"<reviewed reason>\" --yes --config ./synapsor.actions.runner.json");
    expect(text).not.toContain("worker cancel");
    expect(text).toContain("never undoes a completed database change");
    expect(getWorkerQueueItem.mock.calls.flat()).not.toContain("unrelated");
    expect(getWorkerQueueItem.mock.calls.flat()).not.toContain("done");
  });

  it.each(["pending_review", "approved"] as const)("recommends rejection for %s with no queue without mutating history", async state => {
    const proposal = row("proposal_only", state);
    const history = [{ action: "approved", authority: previousDigest }];
    const before = structuredClone({ proposal, history });
    const store = {
      listProposals: vi.fn(async filters => filters.state === state ? [proposal] : []),
      getWorkerQueueItem: vi.fn(async () => undefined),
      rejectProposal: vi.fn(() => { throw new Error("review must not reject"); }),
      cancelWorkerItem: vi.fn(() => { throw new Error("review must not cancel"); }),
    };
    const impact = await inspectActionRevisionImpact({ store, previousDigest });
    const text = actionRevisionImpactLines(impact).join("\n");
    expect(text).toContain("1 awaiting review or approved without a worker queue item");
    expect(text).toContain('proposals reject <reference> --reason "<reviewed reason>" --yes --config ./synapsor.actions.runner.json');
    expect(text).not.toContain("worker cancel");
    expect(text).toContain("Earlier requests and approvals are not rewritten");
    expect(text).toContain("No request is rejected or cancelled by this review");
    expect(store.getWorkerQueueItem).toHaveBeenCalledExactlyOnceWith("proposal_only");
    expect(store.rejectProposal).not.toHaveBeenCalled();
    expect(store.cancelWorkerItem).not.toHaveBeenCalled();
    expect({ proposal, history }).toEqual(before);
  });

  it.each(["queued", "retry_wait"] as const)("recommends worker cancellation only for an actual %s item", async status => {
    const item = queue("waiting", status);
    const before = structuredClone(item);
    const store = {
      listProposals: vi.fn(async filters => filters.state === "pending_worker" ? [row("waiting", "pending_worker")] : []),
      getWorkerQueueItem: vi.fn(async () => item),
    };
    const text = actionRevisionImpactLines(await inspectActionRevisionImpact({ store, previousDigest })).join("\n");
    expect(text).toContain("1 queued or waiting to retry");
    expect(text).toContain("worker cancel <reference> --yes --config ./synapsor.actions.runner.json");
    expect(text).not.toContain("proposals reject");
    expect(text).toContain("required operator authorization");
    expect(item).toEqual(before);
  });

  it.each(["leased", "completed", "dead_letter", "discarded", "cancelled", "blocked", "reconciliation_required"] as const)("does not suggest rejection or queue cancellation for %s work", async status => {
    const store = {
      listProposals: vi.fn(async filters => filters.state === "pending_worker" ? [row("in_progress", "pending_worker")] : []),
      getWorkerQueueItem: vi.fn(async () => queue("in_progress", status)),
    };
    const text = actionRevisionImpactLines(await inspectActionRevisionImpact({ store, previousDigest })).join("\n");
    expect(text).not.toContain("worker cancel");
    expect(text).not.toContain("proposals reject");
    expect(text).toContain("proposals show <reference> --details --config ./synapsor.actions.runner.json");
    expect(text).toContain("receipt before retrying");
  });

  it.each(["pending_worker", "reconciliation_required"] as const)("does not treat %s with a missing queue item as rejectable", async state => {
    const store = {
      listProposals: vi.fn(async filters => filters.state === state ? [row("unknown", state)] : []),
      getWorkerQueueItem: vi.fn(async () => undefined),
    };
    const text = actionRevisionImpactLines(await inspectActionRevisionImpact({ store, previousDigest })).join("\n");
    expect(text).not.toContain("worker cancel");
    expect(text).not.toContain("proposals reject");
    expect(text).toContain("inspect request details and receipts");
  });

  it("does not equate an absent queue API with no queued work", async () => {
    const store = { listProposals: vi.fn(async filters => filters.state === "approved" ? [row("unknown", "approved")] : []) };
    const text = actionRevisionImpactLines(await inspectActionRevisionImpact({ store, previousDigest })).join("\n");
    expect(text).toContain("queue state could not be established");
    expect(text).not.toContain("worker cancel");
    expect(text).not.toContain("proposals reject");
  });

  it("never guesses a safe decision when queue inspection fails", async () => {
    const store = {
      listProposals: vi.fn(async filters => filters.state === "approved" ? [row("unknown", "approved")] : []),
      getWorkerQueueItem: vi.fn(async () => { throw new Error("ledger unavailable"); }),
    };
    await expect(inspectActionRevisionImpact({ store, previousDigest })).rejects.toThrow("ledger unavailable");
    const text = actionRevisionImpactLines().join("\n");
    expect(text).not.toContain("worker cancel");
    expect(text).not.toContain("proposals reject");
    expect(text).toContain("not checked");
  });

  it("separates an approved queued request from an approved unqueued proposal", async () => {
    const proposals = [row("unqueued", "approved"), row("queued", "approved")];
    const store = {
      listProposals: vi.fn(async filters => filters.state === "approved" ? proposals : []),
      getWorkerQueueItem: vi.fn(async (id: string) => id === "queued" ? queue(id, "queued") : undefined),
    };
    const impact = await inspectActionRevisionImpact({ store, previousDigest });
    expect(impact).toMatchObject({ pending: 2, unqueued: 1, queued: 1, queue_unknown: 0, other_queue_state: 0 });
    const text = actionRevisionImpactLines(impact).join("\n");
    expect(text).toContain("proposals reject <reference>");
    expect(text).toContain("worker cancel <reference>");
    expect(text).toContain("From the project directory");
  });

  it.each(["mismatched_queue", "pending_review_with_queue"])("does not invent a lifecycle operation for %s", async kind => {
    const state = kind === "mismatched_queue" ? "approved" : "pending_review";
    const store = {
      listProposals: vi.fn(async filters => filters.state === state ? [row("request", state)] : []),
      getWorkerQueueItem: vi.fn(async () => queue(kind === "mismatched_queue" ? "other_request" : "request", "queued")),
    };
    const text = actionRevisionImpactLines(await inspectActionRevisionImpact({ store, previousDigest })).join("\n");
    expect(text).not.toContain("worker cancel");
    expect(text).not.toContain("proposals reject");
    expect(text).toContain("inspect request details and receipts");
  });

  it("does not suggest a mutation when the complete snapshot has no affected requests", async () => {
    const getWorkerQueueItem = vi.fn(async () => undefined);
    const impact = await inspectActionRevisionImpact({ store: { listProposals: async () => [], getWorkerQueueItem }, previousDigest });
    const text = actionRevisionImpactLines(impact).join("\n");
    expect(text).toContain("Existing requests: 0");
    expect(text).not.toContain("worker cancel");
    expect(text).not.toContain("proposals reject");
    expect(getWorkerQueueItem).not.toHaveBeenCalled();
  });
  it("labels a bounded sample honestly rather than presenting it as a complete count", async () => {
    const listProposals = vi.fn(async filters => filters.state === "pending_review"
      ? Array.from({ length: 201 }, (_, n) => row(`request_${n}`, "pending_review")) : []);
    const impact = await inspectActionRevisionImpact({ store: { listProposals }, previousDigest });
    expect(impact).toMatchObject({ complete: false, pending: 200 });
    expect(impact.examples).toHaveLength(12);
    expect(actionRevisionImpactLines(impact)[0]).toContain("at least 200");
    expect(actionRevisionImpactLines(impact).join("\n")).toContain("remaining entries");
  });
  it("does not label a missing inspection API as an empty queue", async () => {
    await expect(inspectActionRevisionImpact({ store: {}, previousDigest })).rejects.toThrow("UNAVAILABLE");
    expect(actionRevisionImpactLines()[0]).toContain("not checked");
  });
  it("does not double count a request that advances while the pages are being inspected", async () => {
    const listProposals = vi.fn(async filters => ["pending_review", "approved"].includes(filters.state)
      ? [row("moving", filters.state)] : []);
    const impact = await inspectActionRevisionImpact({ store: { listProposals }, previousDigest });
    expect(impact).toMatchObject({ pending: 1, awaiting_review: 0, approved_or_running: 1, examples: ["moving"] });
    expect(actionRevisionImpactLines(impact).join("\n")).toContain("queue can change");
  });
  it("never creates a missing ledger while inspecting a replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "action-impact-"));
    try {
      const active = { authority: { action_boundary: { digest: previousDigest } } } as ActionRuleAuthorityActivationV1;
      const draft = { authority: { action_boundary: { digest: `sha256:${"b".repeat(64)}` } } } as ActionRuleAuthorityDraftV1;
      expect((await reviewActionRevisionImpact({ projectRoot: root, active, draft }))[0]).toContain("not checked");
      expect(await fs.readdir(root)).toEqual([]);
      expect(await reviewActionRevisionImpact({ projectRoot: root, draft })).toEqual([]);
      expect(await reviewActionRevisionImpact({ projectRoot: root, active, draft: active as unknown as ActionRuleAuthorityDraftV1 })).toEqual([]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
