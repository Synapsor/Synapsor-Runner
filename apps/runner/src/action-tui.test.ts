import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import {
  collectGuidedActionInput,
  createTerminalActionPrompter,
  renderActionControlPlaneTable,
  reviewActionProposalInbox,
  type ActionControlPrompter,
} from "./action-tui.js";
import type { ActionOperatorService, ActionProposalDetail } from "./action-operator.js";
import type { GuidedActionResourceOption } from "./guided-action.js";
import { ACTION_SUGGESTION_VERSION, assessActionSuggestion } from "./action-design.js";

const orders: GuidedActionResourceOption = {
  id: "public.orders",
  schema: "public",
  table: "orders",
  primary_key: "id",
  tenant_key: "tenant_id",
  principal_key: "rep_id",
  writable_fields: [
    { name: "status", data_type: "text", enum_values: ["open", "closed"], nullable: false, required_for_insert: true },
    { name: "credit_cents", data_type: "integer", enum_values: [], nullable: false, required_for_insert: true },
  ],
  structurally_eligible_fields: [
    { name: "status", data_type: "text", enum_values: ["open", "closed"], nullable: false, required_for_insert: true },
    { name: "credit_cents", data_type: "integer", enum_values: [], nullable: false, required_for_insert: true },
  ],
  conflict_candidates: ["version"],
  insert_dedup_candidates: ["request_id"],
  kept_out_fields: ["tenant_id", "rep_id"],
  operation_availability: {
    update: { available: true, reason: "Available." },
    insert: { available: true, reason: "Available." },
    delete: { available: true, reason: "Available with exact confirmation." },
  },
};

const options = {
  boundary_digest: `sha256:${"a".repeat(64)}` as const,
  source: "local_postgres",
  deployment_profile: "staging" as const,
  resources: [orders],
  safe_defaults: {},
};

describe("Safe Action terminal control plane", () => {
  it("collects a proposal-only UPDATE without inferring business bounds or execution", async () => {
    const prompter = scriptedPrompter({
      choices: [
        "public.orders",
        "update",
        "credit_cents",
        "argument",
        "version",
        "proposal_only",
        "integer_increment",
      ],
      texts: [
        "0",
        "5000",
        "orders.propose_credit",
        "Propose one bounded order credit.",
        "finance_reviewer",
        "2",
      ],
      confirms: [false, true, true],
    });
    const action = await collectGuidedActionInput(options, prompter);
    expect(action).toMatchObject({
      capability_name: "orders.propose_credit",
      resource: "public.orders",
      operation: "update",
      conflict_column: "version",
      version_advance: "integer_increment",
      required_approvals: 2,
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
      confirmed_trusted_scope: true,
      patches: [{
        column: "credit_cents",
        value_source: "argument",
        minimum: 0,
        maximum: 5000,
      }],
    });
    expect(action?.supervised_worker_execution).toBe(false);
    expect(action?.write_url_env).toBeUndefined();
  });

  it("uses a bounded suggestion only to prioritize candidates and still asks every authority question", async () => {
    const suggestion = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Allow support to propose one bounded order credit.",
      operation: "update",
      resource: "public.orders",
      fields: ["credit_cents"],
      suggested_by: { kind: "model", provider: "anthropic", model: "claude-test" },
    }, options.resources);
    let sawSuggestedFieldFirst = false;
    const prompter = scriptedPrompter({
      choices: [
        "public.orders",
        "update",
        "credit_cents",
        "argument",
        "version",
        "proposal_only",
        "integer_increment",
      ],
      texts: [
        "0",
        "5000",
        "orders.propose_credit_from_suggestion",
        "Propose one bounded order credit.",
        "finance_reviewer",
        "1",
      ],
      confirms: [false, false, true, true],
      onChoose(title, choices) {
        if (title === "CHOOSE EXACT WRITE FIELDS") {
          sawSuggestedFieldFirst = choices[0]?.value === "credit_cents";
        }
      },
    });
    const action = await collectGuidedActionInput(options, prompter, suggestion);
    expect(sawSuggestedFieldFirst).toBe(true);
    expect(action).toMatchObject({
      capability_name: "orders.propose_credit_from_suggestion",
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
      conflict_column: "version",
      approval_role: "finance_reviewer",
      confirmed_trusted_scope: true,
    });
  });

  it("makes hard DELETE human-reviewed, exact, and proposal-only by default", async () => {
    const prompter = scriptedPrompter({
      choices: ["public.orders", "delete", "version", "proposal_only"],
      texts: [
        "orders.propose_delete",
        "Propose deleting one exact order.",
        "senior_reviewer",
        "1",
        "DELETE public.orders",
      ],
      confirms: [true, true],
    });
    const action = await collectGuidedActionInput(options, prompter);
    expect(action).toMatchObject({
      operation: "delete",
      patches: [],
      conflict_column: "version",
      delete_confirmation: "DELETE public.orders",
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
    });
    expect(action?.auto_approval).toBeUndefined();
  });

  it("requires every non-default INSERT field and permits a fixed enum without an UPDATE transition", async () => {
    const prompter = scriptedPrompter({
      choices: [
        "public.orders",
        "insert",
        "request_id",
        "status",
        "fixed",
        "open",
        "credit_cents",
        "argument",
        "proposal_only",
      ],
      texts: [
        "0",
        "1000",
        "orders.propose_create",
        "Propose one bounded order creation.",
        "order_reviewer",
        "1",
      ],
      confirms: [true, false, false, true, true],
    });
    const action = await collectGuidedActionInput(options, prompter);
    expect(action).toMatchObject({
      operation: "insert",
      dedup_proposal_column: "request_id",
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
      patches: [
        { column: "status", value_source: "fixed", fixed_value: "open", allowed_from: [] },
        { column: "credit_cents", value_source: "argument", minimum: 0, maximum: 1000 },
      ],
    });
  });

  it("renders active and draft authority as a readable table", () => {
    const lines = renderActionControlPlaneTable({
      activations: [{
        schema_version: "synapsor.guided-action.v1",
        state: "active",
        capability: "orders.propose_credit",
        resource: "public.orders",
        operation: "update",
        contract_digest: `sha256:${"b".repeat(64)}`,
        contract_path: "./contract.json",
        design_path: "./design.json",
        dsl_path: "./action.sql",
        tests_path: "./tests.json",
        review_path: "./REVIEW.md",
        config_path: "./synapsor.actions.runner.json",
        authority_posture: "proposal_only",
        writeback_mode: "none",
        actor: "reviewer",
        activated_at: "2026-08-20T00:00:00.000Z",
        source_database_changed: false,
      }],
      drafts: [],
    }, 100);
    expect(lines.join("\n")).toMatch(/\+[-+]+\+/);
    expect(lines.join("\n")).toContain("Capability");
    expect(lines.join("\n")).toContain("proposal_only");
    expect(lines.join("\n")).toContain("UPDATE public.orders");
  });

  it("binds TUI approval to the exact hash and never offers apply for WRITEBACK NONE", async () => {
    const pending = proposalDetail("pending_review");
    const approved = proposalDetail("approved");
    const approve = vi.fn(async (_proposalId, decision) => {
      expect(decision).toMatchObject({
        actor: "reviewer",
        reason: "Reviewed bounded credit request.",
        expected_proposal_hash: pending.proposal.proposal_hash,
      });
      return approved;
    });
    const operatorService: ActionOperatorService = {
      async identityPosture() { return { provider: "dev_env", apply_roles: [] }; },
      async list() {
        return [{
          proposal_id: pending.proposal.proposal_id,
          proposal_hash: pending.proposal.proposal_hash,
          capability: pending.proposal.action,
          state: pending.proposal.state,
          business_object: pending.proposal.business_object,
          object_id: pending.proposal.object_id,
          writeback_mode: "read_only",
          source_database_mutated: false,
          created_at: pending.proposal.created_at,
          updated_at: pending.proposal.updated_at,
        }];
      },
      async detail() { return pending; },
      approve,
      async reject() { throw new Error("not expected"); },
      async apply() { throw new Error("WRITEBACK NONE must never reach apply"); },
      async replay() { throw new Error("not expected"); },
    };
    let reviewedApproved = false;
    const choices = [`proposal:${pending.proposal.proposal_id}`, "approve", "back", "back"];
    const texts = [
      `APPROVE ${pending.proposal.proposal_hash}`,
      "Reviewed bounded credit request.",
      "reviewer",
    ];
    const prompter: ActionControlPrompter = {
      async choose(title, available) {
        const value = choices.shift();
        if (!value) throw new Error(`Unexpected choice prompt ${title}`);
        if (title === "PROPOSAL REVIEW" && reviewedApproved) {
          expect(available.find((item) => item.value === "apply")?.disabled).toBe(true);
        }
        if (value === "approve") reviewedApproved = true;
        expect(available.some((item) => item.value === value && !item.disabled)).toBe(true);
        return value;
      },
      async text() {
        const value = texts.shift();
        if (!value) throw new Error("Unexpected text prompt");
        return value;
      },
      async confirm() { throw new Error("not expected"); },
      async message() {},
    };
    await reviewActionProposalInbox({ operatorService, prompter, env: {} });
    expect(approve).toHaveBeenCalledOnce();
  });

  it("keeps Action selection visible and in place in a short wrapped terminal", async () => {
    const terminal = fakeTerminal(48, 10);
    const prompter = createTerminalActionPrompter(terminal.input, terminal.output);
    const selection = prompter.choose("CHOOSE ACTION TARGET", [
      { value: "orders", label: "public.orders", detail: "Reviewed tenant and principal scope with several eligible fields." },
      { value: "members", label: "public.members", detail: "A deliberately long explanation that must wrap without scrolling the viewport." },
      { value: "blocked", label: "public.blocked", detail: "Unavailable structural candidate.", disabled: true },
    ], ["Candidates are not write permissions."]);

    await nextTurn();
    let frame = terminal.output.read()?.toString() ?? "";
    expect(terminalFrameRows(frame)).toBeLessThanOrEqual(10);
    expect(stripAnsi(frame)).toContain("CHOOSE ACTION TARGET");
    expect(stripAnsi(frame)).toContain("> public.orders");
    expect(stripAnsi(frame)).toContain("Up/Down");
    expect(frame.endsWith("\n")).toBe(false);

    await emitKey(terminal.input, { name: "down", sequence: "\u001b[B" });
    frame = terminal.output.read()?.toString() ?? "";
    expect(terminalFrameRows(frame)).toBeLessThanOrEqual(10);
    expect(stripAnsi(frame)).toContain("> public.members");
    expect(frame.endsWith("\n")).toBe(false);

    await emitKey(terminal.input, { name: "enter", sequence: "\r" });
    await expect(selection).resolves.toBe("members");
    expect(terminal.input.isRaw).toBe(false);
  });

  it("accepts typed Action text without retaining raw mode and honors NO_COLOR", async () => {
    vi.stubEnv("NO_COLOR", "1");
    const terminal = fakeTerminal(60, 12);
    const prompter = createTerminalActionPrompter(terminal.input, terminal.output);

    const text = prompter.text("Exact semantic capability name");
    await nextTurn();
    terminal.input.write("orders.propose_credit\n");
    await expect(text).resolves.toBe("orders.propose_credit");
    expect(terminal.input.isRaw).toBe(false);
    const textOutput = terminal.output.read()?.toString() ?? "";
    expect(stripAnsi(textOutput)).toContain("Exact semantic capability name");

    const selection = prompter.choose("EXECUTION AUTHORITY", [
      { value: "proposal_only", label: "Proposal-only", detail: "Source mutation is impossible." },
      { value: "executable", label: "Executable", detail: "Requires a separate trusted apply path." },
    ]);
    await nextTurn();
    const frame = terminal.output.read()?.toString() ?? "";
    expect(frame).not.toMatch(/\u001b\[[0-9;]*m/u);
    await emitKey(terminal.input, { name: "escape", sequence: "\u001b" });
    await expect(selection).resolves.toBeUndefined();
    expect(terminal.input.isRaw).toBe(false);
  });
});

function proposalDetail(state: "pending_review" | "approved"): ActionProposalDetail {
  return {
    proposal: {
      proposal_id: "wrp_orders_credit",
      proposal_version: 1,
      proposal_hash: `sha256:${"c".repeat(64)}`,
      action: "orders.propose_credit",
      state,
      tenant_id: "tenant-a",
      principal: "rep-1",
      capability: "orders.propose_credit",
      business_object: "order",
      object_id: "order-1",
      source_kind: "postgres",
      source_id: "local_postgres",
      source_schema: "public",
      source_table: "orders",
      source_database_mutated: false,
      change_set: {
        schema_version: "synapsor.change-set.v3",
        proposal_id: "wrp_orders_credit",
        action: "propose_credit",
        engine: "postgres",
        source: { source_id: "local_postgres", schema: "public", table: "orders" },
        subject: { business_object: "order", object_id: "order-1" },
        scope: { tenant_id: "tenant-a", principal: "rep-1" },
        patch: { credit_cents: 500 },
        before: { credit_cents: 0 },
        after: { credit_cents: 500 },
        evidence: { bundle_id: "ev_order_credit", query_fingerprint: `sha256:${"d".repeat(64)}` },
        approval: { status: "required", required_role: "finance_reviewer", required_approvals: 1 },
        writeback: { mode: "read_only", status: "not_configured" },
        source_database_mutated: false,
      },
      created_at: "2026-08-20T00:00:00.000Z",
      updated_at: "2026-08-20T00:00:00.000Z",
    } as unknown as ActionProposalDetail["proposal"],
    approval_progress: {
      approved: state === "approved" ? 1 : 0,
      required: 1,
      remaining: state === "approved" ? 0 : 1,
      rejected: false,
      complete: state === "approved",
    },
    freshness_status: "not_required",
    events: [],
    receipts: [],
    evidence_item_count: 1,
  };
}

function scriptedPrompter(input: {
  choices: string[];
  texts: string[];
  confirms: boolean[];
  onChoose?: (title: string, choices: Parameters<ActionControlPrompter["choose"]>[1]) => void;
}): ActionControlPrompter {
  return {
    async choose(title, choices) {
      input.onChoose?.(title, choices);
      const value = input.choices.shift();
      if (value === undefined) throw new Error(`Unexpected choice prompt: ${choices.map((choice) => choice.value).join(", ")}`);
      expect(choices.some((choice) => choice.value === value && !choice.disabled)).toBe(true);
      return value;
    },
    async text() {
      const value = input.texts.shift();
      if (value === undefined) throw new Error("Unexpected text prompt.");
      return value;
    },
    async confirm() {
      const value = input.confirms.shift();
      if (value === undefined) throw new Error("Unexpected confirmation prompt.");
      return value;
    },
    async message() {},
  };
}

function fakeTerminal(columns: number, rows: number): {
  input: ReadStream & PassThrough & { isRaw: boolean };
  output: WriteStream & PassThrough;
} {
  const input = new PassThrough() as PassThrough & ReadStream & {
    isTTY: true;
    isRaw: boolean;
    setRawMode(value: boolean): ReadStream;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value: boolean) => {
    input.isRaw = value;
    return input;
  };
  const output = new PassThrough() as WriteStream & PassThrough;
  Object.assign(output, { isTTY: true, columns, rows });
  return { input, output };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}

function terminalFrameRows(value: string): number {
  return (value.match(/\r\n/gu) ?? []).length + (value ? 1 : 0);
}

async function emitKey(
  input: ReadStream,
  key: { name?: string; sequence: string; ctrl?: boolean },
): Promise<void> {
  input.emit("keypress", key.sequence, key);
  await nextTurn();
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
