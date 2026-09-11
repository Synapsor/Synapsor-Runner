import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDelegationDraft,
  listDelegationDrafts,
  readDelegationDraft,
  summarizeDelegation,
  writeDelegationDraft,
} from "./delegation-setup.js";
import type { GuidedActionDraft } from "./guided-action.js";
import type { ReadWorkloadReview, ReadWorkloadView } from "./read-workloads.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("delegation setup artifacts", () => {
  it("records one immutable, authority-neutral job across read and action drafts", async () => {
    const root = await temporaryRoot();
    const draft = buildDelegationDraft({
      jobIntent: "Answer support workload questions and propose bounded ticket status changes.",
      boundaryName: "reviewed_support",
      workload: workload(),
      review: review(),
      actionIntents: ["Propose a bounded ticket status change."],
      actionDrafts: [{ intent: "Propose a bounded ticket status change.", draft: actionDraft(true) }],
      modelAssist: {
        provider: "openai",
        model: "gpt-test",
        structural_metadata_egress_acknowledged: true,
      },
      now: "2026-08-28T12:00:00.000Z",
    });

    expect(draft).toMatchObject({
      state: "disabled",
      job_name: "answer_support_workload_questions_and_propose_bounded_ticket_sta",
      read: {
        boundary_name: "reviewed_support",
        state: "disabled_review",
      },
      actions: [{
        capability: "support.propose_update_tickets",
        rehearsal: "passed",
        state: "disabled",
      }],
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      source_database_changed: false,
    });
    const written = await writeDelegationDraft(root, draft);
    expect(written.latest_path).toBe(
      "./.synapsor/delegations/answer_support_workload_questions_and_propose_bounded_ticket_sta/draft.json",
    );
    expect(written.revision_path).toContain(draft.revision_digest.slice("sha256:".length));
    await expect(readDelegationDraft(root, draft.job_name)).resolves.toEqual(draft);
  });

  it("retains detailed bounded job and Action intent text", () => {
    const jobIntent = "j".repeat(2_000);
    const actionIntent = "a".repeat(2_000);
    const draft = buildDelegationDraft({
      jobName: "detailed_job",
      jobIntent,
      boundaryName: "reviewed_support",
      workload: workload(),
      review: review(),
      actionIntents: [actionIntent],
    });
    expect(draft.job_intent).toBe(jobIntent);
    expect(draft.actions[0]?.intent).toBe(actionIntent);
    expect(() => buildDelegationDraft({
      jobName: "too_long_job",
      jobIntent: "j".repeat(2_001),
      boundaryName: "reviewed_support",
      workload: workload(),
      review: review(),
    })).toThrow("job intent must be 1 through 2000 safe characters");
  });

  it.each([
    ["Preserve the saved rules.", "Preserve the saved rules."],
    ["Preserve the saved rules.", "  PRESERVE   the saved rules.  "],
  ])("preserves distinct outcome bindings with equivalent descriptions (%s, %s)", (first, second) => {
    const input = delegationInput({
      actionIntents: [second, first],
      semanticActions: [
        semanticAction(first, "university.accept_seat", "1"),
        semanticAction(second, "university.restore_registration", "2"),
      ],
    });
    const before = structuredClone(input);
    const draft = buildDelegationDraft(input);
    expect(draft.actions).toEqual(input.semanticActions!.map((entry) => ({
      ...entry,
      intent: entry.intent.trim().replace(/\s+/g, " "),
      kind: "rule_derived",
      rehearsal: "passed",
      state: "disabled",
    })));
    expect(new Set(draft.actions.map((action) => action.outcome)).size).toBe(2);
    expect(buildDelegationDraft(input)).toEqual(draft);
    expect(input).toEqual(before);
  });

  it("retains outcome-bound entries without a parallel legacy intent list", () => {
    const semanticActions = [semanticAction("Preserve both rules.", "university.accept_seat"),
      semanticAction("Preserve both rules.", "university.restore_registration")];
    expect(buildDelegationDraft(delegationInput({ semanticActions })).actions.map((action) => action.outcome))
      .toEqual(["university.accept_seat", "university.restore_registration"]);
  });

  it.each(["same entry", "different authority", "different description"])("rejects an outcome identity collision (%s)", (collision) => {
    const first = semanticAction("Accept the seat.", "university.accept_seat");
    const second = { ...first,
      outcome: " university.accept_seat ",
      ...(collision === "different authority" ? { authority_digest: digest("2") } : {}),
      ...(collision === "different description" ? { intent: "Restore the registration." } : {}),
    };
    const input = delegationInput({ actionIntents: [first.intent, second.intent], semanticActions: [first, second] });
    const before = structuredClone(input);
    expect(() => buildDelegationDraft(input)).toThrow("DELEGATION_ACTION_OUTCOME_COLLISION");
    expect(input).toEqual(before);
  });

  it("preserves unambiguous legacy drafts and pending work alongside outcome-bound entries", () => {
    const input = delegationInput({
      actionIntents: ["Propose a bounded ticket status change.", "Accept the seat.", "Release the advising hold."],
      actionDrafts: [{ intent: "  PROPOSE a bounded ticket status change. ", draft: actionDraft(false) }],
      semanticActions: [semanticAction("Accept the seat.", "university.accept_seat")],
    });
    const before = structuredClone(input);
    const draft = buildDelegationDraft(input);
    expect(draft.actions).toMatchObject([
      { intent: "Accept the seat.", outcome: "university.accept_seat", kind: "rule_derived", rehearsal: "passed" },
      { intent: "Propose a bounded ticket status change.", capability: "support.propose_update_tickets", kind: "discretionary", rehearsal: "required" },
      { intent: "Release the advising hold.", rehearsal: "not_started" },
    ]);
    expect(draft.authority_granted).toBe(false);
    expect(draft.source_database_changed).toBe(false);
    expect(input).toEqual(before);
  });

  it.each([
    "duplicate legacy drafts", "duplicate legacy requests", "semantic and legacy overlap",
    "unmatched legacy draft", "unmatched semantic entry", "fewer requests than outcomes", "more requests than outcomes",
  ])("rejects ambiguous unbound intent pairings (%s)", (ambiguity) => {
    const intent = "Preserve the saved rule.";
    const legacy = { intent, draft: actionDraft(false) };
    const semantic = semanticAction(intent, "university.accept_seat");
    const variants: Record<string, Partial<Parameters<typeof buildDelegationDraft>[0]>> = {
      "duplicate legacy drafts": { actionIntents: [intent, intent], actionDrafts: [legacy,
        { intent: intent.toUpperCase(), draft: { ...actionDraft(true), capability: "support.propose_other_change" } }] },
      "duplicate legacy requests": { actionIntents: [intent, intent], actionDrafts: [legacy] },
      "semantic and legacy overlap": { actionIntents: [intent, intent], actionDrafts: [legacy], semanticActions: [semantic] },
      "unmatched legacy draft": { actionIntents: ["Another request."], actionDrafts: [legacy] },
      "unmatched semantic entry": { actionIntents: ["Another request."], semanticActions: [semantic] },
      "fewer requests than outcomes": { actionIntents: [intent], semanticActions: [semantic,
        semanticAction(intent, "university.restore_registration")] },
      "more requests than outcomes": { actionIntents: [intent, intent], semanticActions: [semantic] },
    };
    const input = delegationInput(variants[ambiguity]);
    const before = structuredClone(input);
    expect(() => buildDelegationDraft(input)).toThrow("DELEGATION_ACTION_BINDING_AMBIGUOUS");
    expect(input).toEqual(before);
  });

  it("reports EXPLORE, PROPOSE, DELEGATE, and APPLY as separate authority stages", () => {
    const draft = buildDelegationDraft({
      jobName: "support_agent",
      jobIntent: "Answer support questions and propose status changes.",
      boundaryName: "reviewed_support",
      workload: workload(),
      review: review(),
      actionIntents: ["Propose a bounded ticket status change."],
      actionDrafts: [{ intent: "Propose a bounded ticket status change.", draft: actionDraft(false) }],
    });
    expect(summarizeDelegation(draft, {
      read_active: true,
      proposal_active: true,
      delegated_approval_active: false,
      execution_active: false,
    })).toMatchObject({
      learn: { state: "active" },
      propose: { state: "active" },
      stages: {
        explore: "active",
        propose: "active",
        delegate: "off",
        apply: "off",
      },
      human_required: [
        expect.stringContaining("Approve proposals manually"),
        expect.stringContaining("trusted executor"),
      ],
    });
  });

  it("refuses a tampered latest pointer while retaining the immutable revision", async () => {
    const root = await temporaryRoot();
    const draft = buildDelegationDraft({
      jobName: "support_agent",
      jobIntent: "Answer support questions.",
      boundaryName: "reviewed_support",
      workload: workload(),
      review: review(),
    });
    const written = await writeDelegationDraft(root, draft);
    const latestPath = path.join(root, written.latest_path);
    const tampered = JSON.parse(await fs.readFile(latestPath, "utf8"));
    tampered.job_intent = "Widen access";
    await fs.writeFile(latestPath, JSON.stringify(tampered));

    await expect(readDelegationDraft(root, "support_agent"))
      .rejects.toThrow(/DELEGATION_DRAFT_CHANGED/);
    await expect(fs.readFile(path.join(root, written.revision_path), "utf8"))
      .resolves.toContain("Answer support questions.");
  });

  it("lists the latest immutable job drafts newest first", async () => {
    const root = await temporaryRoot();
    const older = buildDelegationDraft({
      jobName: "older_job",
      jobIntent: "Answer older support questions.",
      boundaryName: "reviewed_support",
      workload: workload(),
      review: review(),
      now: "2026-08-28T01:00:00.000Z",
    });
    const newer = buildDelegationDraft({
      jobName: "newer_job",
      jobIntent: "Answer newer support questions.",
      boundaryName: "reviewed_support",
      workload: workload(),
      review: review(),
      now: "2026-08-28T02:00:00.000Z",
    });
    await writeDelegationDraft(root, older);
    await writeDelegationDraft(root, newer);
    await expect(listDelegationDrafts(root)).resolves.toEqual([newer, older]);
  });
});

function delegationInput(overrides: Partial<Parameters<typeof buildDelegationDraft>[0]> = {}): Parameters<typeof buildDelegationDraft>[0] {
  return {
    jobIntent: "Preserve the original student registration policy and pending work.",
    boundaryName: "reviewed_support",
    workload: workload(),
    review: review(),
    now: "2026-08-28T12:00:00.000Z",
    ...overrides,
  };
}

function semanticAction(intent: string, outcome: string, fingerprint = "1") {
  return { intent, outcome, action_boundary_name: "reviewed_rules", authority_digest: digest(fingerprint) };
}

function workload(): ReadWorkloadView {
  return {
    schema_version: "synapsor.read-workload-record.v1",
    analysis_id: "rw_0123456789abcdef0123456789abcdef",
    analysis_digest: digest("a"),
    generated_boundary_digest: digest("b"),
    imported_at: "2026-08-28T11:59:00.000Z",
    source: { kind: "operator_exact_plan" },
    analysis: {
      schema_version: "synapsor.read-workload-analysis.v1",
      workload_digest: digest("c"),
      workload_name: "support_reads",
      status: "ready",
      allowed: [{
        id: "tickets_by_status",
        description: "Count tickets by status",
        status: "supported",
        authority_atoms: [],
      }],
      forbidden: [],
      authority_atoms: [],
      coverage: {
        allowed_supported: 1,
        allowed_total: 1,
        forbidden_denied: 0,
        forbidden_total: 0,
      },
      exposure: {
        generated_resources: 1,
        candidate_resources: 1,
        generated_fields: 4,
        candidate_return_fields: 1,
        candidate_operation_fields: 1,
        candidate_relationships: 0,
      },
      blockers: [],
      authority_granted: false,
      source_query_executed: false,
      explore_budget_consumed: false,
      source_database_changed: false,
    },
    authority_granted: false,
    source_query_executed: false,
    explore_budget_consumed: false,
    source_database_changed: false,
    state: "reviewed",
    review: review(),
  };
}

function review(): ReadWorkloadReview {
  return {
    schema_version: "synapsor.read-workload-review.v1",
    analysis_id: "rw_0123456789abcdef0123456789abcdef",
    analysis_digest: digest("a"),
    analyzed_candidate_digest: digest("d"),
    candidate_digest: digest("e"),
    review_revision: 3,
    reviewed_at: "2026-08-28T12:00:00.000Z",
    authority_activated: false,
    source_database_changed: false,
  };
}

function actionDraft(rehearsed: boolean): GuidedActionDraft {
  return {
    schema_version: "synapsor.guided-action.v1",
    state: "disabled",
    capability: "support.propose_update_tickets",
    source: "local_postgres",
    resource: "public.tickets",
    operation: "update",
    boundary_name: "reviewed_support",
    boundary_digest: digest("f"),
    generation_lock_fingerprint: digest("1"),
    contract_digest: digest("2"),
    action_boundary_name: "default_action_boundary",
    action_boundary_digest: digest("4"),
    dsl_path: "./synapsor/actions/ticket.dsl",
    contract_path: "./synapsor/actions/ticket.json",
    tests_path: "./synapsor/actions/ticket.tests.json",
    review_path: "./synapsor/actions/ticket.review.json",
    design_path: "./synapsor/actions/ticket.design.json",
    runtime_config_path: "./synapsor.actions.runner.json",
    write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
    receipt_mode: "runner_ledger",
    authority_posture: "proposal_only",
    writeback_mode: "none",
    supervised_worker_execution: false,
    created_at: "2026-08-28T12:00:00.000Z",
    ...(rehearsed ? {
      effect_preview: {
        contract_digest: digest("2"),
        action_boundary_digest: digest("4"),
        proposal_id: "prv_test",
        proposal_hash: digest("3"),
        previewed_at: "2026-08-28T12:00:01.000Z",
        source_database_changed: false,
      },
    } : {}),
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-delegation-"));
  roots.push(root);
  return root;
}
