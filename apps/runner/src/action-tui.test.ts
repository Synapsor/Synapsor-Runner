import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import {
  actionAuthorityRevisionNeedsVersionAdvance,
  actionBoundaryActivationStatusLine,
  actionBoundaryApprovalStatusLine,
  actionBoundaryLimitSummary,
  actionActivationReviewLines,
  actionDraftUsesQuickResume,
  actionReviewLines,
  collectGuidedActionInput,
  collectGuidedRehearsalArgs,
  collectQuickGuidedRehearsalArgs,
  collectQuickProposalActionInput,
  conventionalModelAuthoringSession,
  createTerminalActionPrompter,
  generatedGuidedRehearsalArgs,
  rankActionIntent,
  renderActionControlPlaneTable,
  reviewActionDraft,
  reviewActionProposalInbox,
  suggestedActionBoundaryLimits,
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
  boundary_name: "reviewed_staging",
  boundary_state: "active" as const,
  boundary_digest: `sha256:${"a".repeat(64)}` as const,
  source: "local_postgres",
  deployment_profile: "staging" as const,
  resources: [orders],
  blocked_resources: [],
  safe_defaults: {},
};

describe("Safe Action terminal control plane", () => {
  it("requires a reviewed version transition before promoting a proposal-only UPDATE", () => {
    const executable = {
      authority_posture: "executable" as const,
      writeback: { mode: "direct_sql" as const },
      receipt_mode: "runner_ledger" as const,
    };
    expect(actionAuthorityRevisionNeedsVersionAdvance({
      operation: "update",
      receipt_mode: "runner_ledger",
    }, executable)).toBe(true);
    expect(actionAuthorityRevisionNeedsVersionAdvance({
      operation: "update",
      receipt_mode: "runner_ledger",
      version_advance: "integer_increment",
    }, executable)).toBe(false);
    expect(actionAuthorityRevisionNeedsVersionAdvance({
      operation: "insert",
      receipt_mode: "runner_ledger",
    }, executable)).toBe(false);
  });

  it("names the active first-class Action Boundary in setup completion", () => {
    const boundary = {
      name: "default_action_boundary",
      authority: {
        capabilities: [{}, {}],
        approval_policies: [{ capability: "support.propose_refund", mode: "policy" }],
      },
    } as Parameters<typeof actionBoundaryActivationStatusLine>[0];
    expect(actionBoundaryActivationStatusLine(boundary))
      .toBe("Action Boundary: ACTIVE (default_action_boundary; 2 actions)");
    expect(actionBoundaryApprovalStatusLine(boundary, "support.propose_refund"))
      .toBe("Approval: DETERMINISTIC POLICY WITH HUMAN FALLBACK");
    expect(actionBoundaryApprovalStatusLine(boundary, "support.propose_note"))
      .toBe("Approval: HUMAN REVIEW");
    expect(actionBoundaryActivationStatusLine(undefined))
      .toBe("Action Boundary: status unavailable");
  });

  it("auto-selects one conventional external model without reading or persisting its key", () => {
    expect(conventionalModelAuthoringSession({ OPENAI_API_KEY: "openai-secret" })).toEqual({
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(conventionalModelAuthoringSession({ ANTHROPIC_API_KEY: "anthropic-secret" })).toEqual({
      provider: "anthropic",
      model: expect.any(String),
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect(conventionalModelAuthoringSession({
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
    })).toBeUndefined();
    expect(conventionalModelAuthoringSession({})).toBeUndefined();
  });

  it("resumes proposal-only drafts through the minimal rehearsal path", () => {
    expect(actionDraftUsesQuickResume({ authority_posture: "proposal_only" })).toBe(true);
    expect(actionDraftUsesQuickResume({ authority_posture: "executable" })).toBe(false);
  });

  it("keeps a prepared job action disabled even after its exact rehearsal passed", async () => {
    const messages: Array<{ title: string; lines: string[] }> = [];
    const prompter: ActionControlPrompter = {
      async choose() { throw new Error("prepare-only must not offer activation"); },
      async text() { throw new Error("a completed rehearsal needs no input"); },
      async confirm() { throw new Error("prepare-only must not ask for authority"); },
      async message(title, lines) { messages.push({ title, lines }); },
    };
    const draft = {
      schema_version: "synapsor.guided-action.v1",
      state: "disabled",
      capability: "orders.propose_credit",
      source: "local_postgres",
      resource: "public.orders",
      operation: "update",
      boundary_name: "reviewed_staging",
      boundary_digest: `sha256:${"a".repeat(64)}`,
      generation_lock_fingerprint: `sha256:${"b".repeat(64)}`,
      contract_digest: `sha256:${"c".repeat(64)}`,
      dsl_path: "./capability.synapsor.sql",
      contract_path: "./synapsor.contract.json",
      tests_path: "./contract-tests.json",
      review_path: "./REVIEW.md",
      design_path: "./action-design.json",
      runtime_config_path: "./synapsor.actions.runner.json",
      receipt_mode: "runner_ledger",
      authority_posture: "proposal_only",
      writeback_mode: "none",
      supervised_worker_execution: false,
      created_at: "2026-08-28T12:00:00.000Z",
      effect_preview: {
        contract_digest: `sha256:${"c".repeat(64)}`,
        proposal_id: "prv_credit",
        proposal_hash: `sha256:${"d".repeat(64)}`,
        source_database_changed: false,
        previewed_at: "2026-08-28T12:01:00.000Z",
      },
    } as Parameters<typeof reviewActionDraft>[0]["draft"];

    await expect(reviewActionDraft({
      projectRoot: "/tmp/not-read-in-prepare-only",
      inspection: {} as Parameters<typeof reviewActionDraft>[0]["inspection"],
      draft,
      prompter,
      env: {},
      prepareOnly: true,
    })).resolves.toBeUndefined();
    expect(messages).toEqual([expect.objectContaining({
      title: "PROPOSAL ACTION DRAFT SAVED",
      lines: expect.arrayContaining([
        "Proposal action: DISABLED",
        "Approval: HUMAN",
        "Writeback: OFF",
        "Source database changed: no",
      ]),
    })]);
  });

  it("keeps exact proposal activation authority visible at 80x24", async () => {
    const action = {
      capability_name: "orders.propose_credit",
      description: "Propose one bounded order credit.",
      business_object: "order",
      resource: "public.orders",
      operation: "update" as const,
      conflict_column: "version",
      patches: [
        { column: "status", value_source: "argument" as const, argument_name: "status" },
        { column: "credit_cents", value_source: "argument" as const, argument_name: "credit_cents", minimum: 0, maximum: 2500 },
      ],
      approval_role: "action_reviewer",
      required_approvals: 1,
      auto_approval: {
        conditions: [
          { field: "status", operator: "in" as const, values: ["open"] },
          { field: "credit_cents", operator: "lte" as const, value: 500 },
        ],
        max_per_day: 3,
        max_total_per_day: 1000,
        total_field: "credit_cents",
      },
      authority_posture: "proposal_only" as const,
      writeback: { mode: "none" as const },
      confirmed_trusted_scope: true,
    };
    const terminal = fakeTerminal(80, 24);
    const prompter = createTerminalActionPrompter(terminal.input, terminal.output);
    const choice = prompter.choose("ACTIVATE PROPOSAL ACTION", [
      { value: "activate", label: "Activate this exact proposal-only action", detail: "Creates proposals only; approval and apply remain outside the agent." },
      { value: "advanced", label: "Open draft details", detail: "Inspect DSL, policy, rehearsal, or edit the design." },
      { value: "back", label: "Leave disabled" },
    ], [
      ...actionActivationReviewLines(action, orders),
      "Rehearsal: passed for this exact disabled revision; source database changed: no.",
    ]);

    await emitKey(terminal.input, { name: "escape", sequence: "\u001b" });
    await expect(choice).resolves.toBeUndefined();
    const rendered = stripAnsi(terminal.output.read()?.toString() ?? "");
    expect(rendered).toContain("Target: UPDATE public.orders");
    expect(rendered).toContain("tenant tenant_id + principal rep_id");
    expect(rendered).toContain("Conditions:");
    expect(rendered).toContain("writeback none");
    expect(rendered).not.toContain("rows hidden");
  });

  it("prepares one consolidated proposal-only action from unique reviewed intent", async () => {
    const prompter = scriptedPrompter({
      choices: ["create"],
      texts: ["0,2500"],
      confirms: [],
    });
    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
    );
    expect(action).toMatchObject({
      capability_name: "order.propose_update_orders",
      description: "Let support update an order credit_cents within a reviewed limit.",
      resource: "public.orders",
      operation: "update",
      conflict_column: "version",
      approval_role: "action_reviewer",
      required_approvals: 1,
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
      confirmed_trusted_scope: true,
      patches: [{
        column: "credit_cents",
        value_source: "argument",
        minimum: 0,
        maximum: 2500,
      }],
    });
  });

  it("keeps the reviewed-but-disabled Read handoff visible in the first Action choice", async () => {
    const prompts: Array<{ title: string; context: string[] }> = [];
    const prompter = scriptedPrompter({
      choices: ["create"],
      texts: ["0,2500"],
      confirms: [],
      onChoose: (title, _choices, context = []) => prompts.push({ title, context }),
    });

    await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
      [
        "READ REVIEW COMPLETE - NOT ACTIVE",
        "Read Boundary: reviewed_staging is fully reviewed and remains disabled.",
        "Agent read authority: unchanged | source database changed: no",
      ],
    );

    expect(prompts[0]).toMatchObject({ title: "REVIEW PROPOSAL ACTION" });
    expect(prompts[0]?.context.slice(0, 3)).toEqual([
      "READ REVIEW COMPLETE - NOT ACTIVE",
      "Read Boundary: reviewed_staging is fully reviewed and remains disabled.",
      "Agent read authority: unchanged | source database changed: no",
    ]);
  });

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

  it("defaults to reviewing every remaining model-suggested field before optional extras", async () => {
    const suggestion = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Let support propose an order status and credit change.",
      operation: "update",
      resource: "public.orders",
      fields: ["status", "credit_cents"],
      suggested_by: { kind: "model", provider: "openai", model: "gpt-5.6-luna" },
    }, options.resources);
    const continuationDefaults: Array<{ label: string; defaultValue: boolean | undefined }> = [];
    const prompter = scriptedPrompter({
      choices: [
        "public.orders",
        "update",
        "status",
        "argument",
        "credit_cents",
        "argument",
        "safe",
        "create",
      ],
      texts: [
        "0",
        "5000",
        "orders.propose_status_and_credit",
        "Propose one reviewed order status and credit change.",
      ],
      confirms: [true, false, true],
      onConfirm(label, defaultValue) {
        if (label.includes("write field")) continuationDefaults.push({ label, defaultValue });
      },
    });

    const action = await collectGuidedActionInput(options, prompter, suggestion, {
      intent: suggestion.suggestion.intent,
      mode: "guided",
    });

    expect(action?.patches?.map((patch) => patch.column)).toEqual(["status", "credit_cents"]);
    expect(continuationDefaults).toEqual([
      expect.objectContaining({ defaultValue: true }),
      expect.objectContaining({ defaultValue: false }),
    ]);
  });

  it("cancels an incomplete INSERT instead of skipping a required field", async () => {
    const continuationDefaults: Array<{ label: string; defaultValue: boolean | undefined }> = [];
    const prompter = scriptedPrompter({
      choices: ["public.orders", "insert", "status", "argument"],
      texts: [],
      confirms: [false],
      onConfirm(label, defaultValue) {
        continuationDefaults.push({ label, defaultValue });
      },
    });

    await expect(collectGuidedActionInput(options, prompter, undefined, {
      intent: "Create one order.",
      mode: "guided",
    })).resolves.toBeUndefined();
    expect(continuationDefaults).toEqual([
      expect.objectContaining({ label: expect.stringContaining("Still required: credit_cents"), defaultValue: true }),
    ]);
  });

  it("rebuilds an imported approval policy when the operator narrows the exact write fields", async () => {
    const suggestion = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Let support propose a bounded order status or credit change.",
      operation: "update",
      resource: "public.orders",
      fields: ["status", "credit_cents"],
      approval_policy_proposal: {
        mode: "deterministic",
        conditions: [
          { field: "status", operator: "in", values: ["open"] },
          { field: "credit_cents", operator: "lte", value: 1000 },
        ],
        max_per_day: 5,
      },
      suggested_by: { kind: "model", provider: "openai", model: "gpt-5.6-luna" },
    }, options.resources);
    let proposedPolicyWasOffered = false;
    const prompter = scriptedPrompter({
      choices: [
        "public.orders",
        "update",
        "status",
        "argument",
        "delegate",
        "recommended",
        "create",
      ],
      texts: [
        "orders.propose_status_only",
        "Propose one reviewed order status change.",
        "5",
      ],
      confirms: [false, true],
      onChoose(title, choices) {
        if (title === "AUTO-APPROVAL CONDITIONS") {
          proposedPolicyWasOffered = choices.some((choice) => choice.value === "proposed");
        }
      },
    });

    const action = await collectGuidedActionInput(options, prompter, suggestion, {
      intent: suggestion.suggestion.intent,
      mode: "guided",
    });

    expect(proposedPolicyWasOffered).toBe(false);
    expect(action?.patches?.map((patch) => patch.column)).toEqual(["status"]);
    expect(action?.auto_approval).toEqual({
      conditions: [{ field: "status", operator: "in", values: ["open", "closed"] }],
      max_per_day: 5,
    });
  });

  it("reviews a model-proposed deterministic policy and trusted principal limit without granting authority", async () => {
    const suggestion = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Let support propose small order credits without waiting for routine human approval.",
      operation: "update",
      resource: "public.orders",
      fields: ["credit_cents"],
      approval_policy_proposal: {
        mode: "deterministic",
        conditions: [{ field: "credit_cents", operator: "lte", value: 1000 }],
        max_per_day: 5,
        max_total_per_day: 2500,
        total_field: "credit_cents",
        shared_limits: [{
          kind: "count",
          scope: "tenant_principal",
          maximum: 3,
          window_seconds: 3600,
        }],
      },
      suggested_by: { kind: "model", provider: "openai", model: "gpt-5.6-luna" },
    }, options.resources);
    const prompter = scriptedPrompter({
      choices: [
        "public.orders",
        "update",
        "credit_cents",
        "argument",
        "delegate",
        "proposed",
        "create",
      ],
      texts: [
        "0",
        "5000",
        "orders.propose_small_credit",
        "Propose one small reviewed order credit.",
      ],
      confirms: [false, true, true],
    });

    const action = await collectGuidedActionInput(options, prompter, suggestion, {
      intent: suggestion.suggestion.intent,
      mode: "guided",
    });
    expect(action).toMatchObject({
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
      required_approvals: 1,
      auto_approval: {
        conditions: [{ field: "credit_cents", operator: "lte", value: 1000 }],
        max_per_day: 5,
        max_total_per_day: 2500,
        total_field: "credit_cents",
      },
    });
    const limits = suggestedActionBoundaryLimits(action!.capability_name, suggestion);
    expect(limits).toEqual([{
      id: "suggested_orders_propose_small_credit_tenant_principal_count_1",
      kind: "count",
      scope: "tenant_principal",
      maximum: 3,
      window_seconds: 3600,
      capability: "orders.propose_small_credit",
    }]);
    expect(actionBoundaryLimitSummary(limits[0]!)).toBe(
      "At most 3 deterministic approvals for orders.propose_small_credit per trusted tenant + principal in 1 hour.",
    );
  });

  it("turns business intent into a proposal-only disabled design without asking execution questions", async () => {
    const prompter = scriptedPrompter({
      choices: ["public.orders", "update", "credit_cents", "argument", "safe", "create"],
      texts: [
        "0",
        "2500",
        "orders.propose_bounded_credit",
        "Let support propose one bounded order credit.",
      ],
      confirms: [false, true],
    });
    const action = await collectGuidedActionInput(options, prompter, undefined, {
      intent: "Let support change an order credit up to a reviewed limit.",
      mode: "guided",
    });
    expect(action).toMatchObject({
      capability_name: "orders.propose_bounded_credit",
      resource: "public.orders",
      operation: "update",
      conflict_column: "version",
      approval_role: "action_reviewer",
      required_approvals: 1,
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
      confirmed_trusted_scope: true,
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
    });
    expect(action?.auto_approval).toBeUndefined();
    expect(action?.write_url_env).toBeUndefined();
    expect(actionReviewLines(action!, orders).join("\n")).toContain("AGENT MAY NOT");
    expect(actionReviewLines(action!, orders).join("\n")).toContain("Source mutation is impossible");
  });

  it("ranks only unique reviewed metadata matches and leaves ambiguous intent unselected", () => {
    const shipments: GuidedActionResourceOption = {
      ...orders,
      id: "logistics.shipments",
      schema: "logistics",
      table: "shipments",
      label: "Outbound shipments",
      description: "One shipment with a reviewed carrier mode.",
      writable_fields: [{ name: "carrier_mode", label: "Carrier mode", data_type: "text", enum_values: ["air", "ground"], nullable: false, required_for_insert: true }],
      structurally_eligible_fields: [{ name: "carrier_mode", label: "Carrier mode", data_type: "text", enum_values: ["air", "ground"], nullable: false, required_for_insert: true }],
    };
    expect(rankActionIntent([orders, shipments], "Change the carrier mode for one outbound shipment")).toMatchObject({
      resource: "logistics.shipments",
      operation: "update",
      fields: ["carrier_mode"],
    });
    expect(rankActionIntent([
      shipments,
      { ...shipments, id: "logistics.return_shipments", table: "return_shipments", label: "Return shipments" },
    ], "Update a shipment").resource).toBeUndefined();
  });

  it("collects generated enum, numeric, boolean, and text rehearsal values without raw JSON", async () => {
    const prompter = scriptedPrompter({
      choices: ["guided", "1", "true", "run"],
      texts: ["750", "reviewed note"],
      confirms: [],
    });
    const details = {
      draft: { capability: "orders.propose_typed_rehearsal" },
      preview_args: { status: "open", credit_cents: 100, notify: false, note: "preview" },
      contract: {
        capabilities: [{
          name: "orders.propose_typed_rehearsal",
          args: {
            status: { type: "string", enum: ["open", "closed"] },
            credit_cents: { type: "number", minimum: 0, maximum: 1000 },
            notify: { type: "boolean" },
            note: { type: "string", max_length: 32 },
          },
        }],
      },
    } as unknown as Parameters<typeof collectGuidedRehearsalArgs>[0];
    await expect(collectGuidedRehearsalArgs(details, prompter)).resolves.toEqual({
      status: "closed",
      credit_cents: 750,
      notify: true,
      note: "reviewed note",
    });
  });

  it("generates bounded rehearsal values from the compiled contract", () => {
    const details = {
      draft: { capability: "orders.propose_generated_rehearsal" },
      preview_args: { status: "open", credit_cents: 100, notify: false, note: "replace-with-note" },
      contract: {
        capabilities: [{
          name: "orders.propose_generated_rehearsal",
          args: {
            status: { type: "string", enum: ["open", "closed"] },
            credit_cents: { type: "number", minimum: 50, maximum: 1000 },
            notify: { type: "boolean" },
            note: { type: "string", max_length: 8 },
          },
        }],
      },
    } as unknown as Parameters<typeof generatedGuidedRehearsalArgs>[0];
    expect(generatedGuidedRehearsalArgs(details)).toEqual({
      status: "open",
      credit_cents: 50,
      notify: false,
      note: "replace-",
    });
  });

  it("asks only for the existing row identity that UPDATE rehearsal cannot invent", async () => {
    const details = {
      draft: { capability: "orders.propose_quick_update" },
      preview_args: { order_id: "replace-with-order-id", credit_cents: 50 },
      contract: {
        capabilities: [{
          name: "orders.propose_quick_update",
          subject: { schema: "public", table: "orders" },
          lookup: { id_from_arg: "order_id" },
          args: {
            order_id: { type: "string", max_length: 128 },
            credit_cents: { type: "number", minimum: 50, maximum: 1000 },
          },
        }],
      },
    } as unknown as Parameters<typeof collectQuickGuidedRehearsalArgs>[0];
    const prompter = scriptedPrompter({ choices: [], texts: ["ord-1"], confirms: [] });
    await expect(collectQuickGuidedRehearsalArgs(details, prompter)).resolves.toEqual({
      order_id: "ord-1",
      credit_cents: 50,
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
      action_boundary: {
        synthesized_from_legacy_actions: false,
      },
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
      async count() { return 1; },
      async page() {
        return {
          total: 1,
          items: await this.list(),
        };
      },
      async detail() { return pending; },
      approve,
      async reject() { throw new Error("not expected"); },
      async apply() { throw new Error("WRITEBACK NONE must never reach apply"); },
      async replay() { throw new Error("not expected"); },
    };
    let reviewedApproved = false;
    const choices = [`proposal:${pending.proposal.proposal_id}`, "approve", "back", "back"];
    const texts = ["Reviewed bounded credit request.", "reviewer"];
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
      async confirm(message) {
        expect(message).toContain(pending.proposal.proposal_id);
        expect(message).toContain(pending.proposal.proposal_hash.slice(0, 20));
        return true;
      },
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

  it("highlights the declared safe default for confirmations and recommended choices", async () => {
    const terminal = fakeTerminal(72, 14);
    const prompter = createTerminalActionPrompter(terminal.input, terminal.output);

    const declined = prompter.confirm("Enable deterministic approval?", false);
    await nextTurn();
    expect(stripAnsi(terminal.output.read()?.toString() ?? "")).toContain("> No");
    await emitKey(terminal.input, { name: "enter", sequence: "\r" });
    await expect(declined).resolves.toBe(false);

    const window = prompter.choose("ROLLING APPROVAL WINDOW", [
      { value: "3600", label: "1 hour" },
      { value: "86400", label: "24 hours (recommended)" },
    ], [], "86400");
    await nextTurn();
    expect(stripAnsi(terminal.output.read()?.toString() ?? "")).toContain("> 24 hours (recommended)");
    await emitKey(terminal.input, { name: "enter", sequence: "\r" });
    await expect(window).resolves.toBe("86400");
  });

  it("labels a readiness report as returning to the Safe Action menu instead of continuing forward", async () => {
    const terminal = fakeTerminal(72, 12);
    const prompter = createTerminalActionPrompter(terminal.input, terminal.output);
    const report = prompter.message(
      "SAFE ACTION READINESS",
      ["Every action still requires review."],
      "Back to Safe Action menu",
    );

    await nextTurn();
    const frame = stripAnsi(terminal.output.read()?.toString() ?? "");
    expect(frame).toContain("> Back to Safe Action menu");
    expect(frame).toContain("Enter Select");
    expect(frame).not.toContain("Continue");

    await emitKey(terminal.input, { name: "enter", sequence: "\r" });
    await expect(report).resolves.toBeUndefined();
    expect(terminal.input.isRaw).toBe(false);
  });

  it("pages the proposal inbox through count and offset queries instead of truncating at 200", async () => {
    const page = vi.fn(async (filters: { offset?: number } = {}) => ({
      total: 25,
      items: Array.from({ length: Math.min(12, 25 - Number(filters.offset ?? 0)) }, (_, index) => ({
      proposal_id: `proposal-${Number(filters.offset ?? 0) + index + 1}`,
      proposal_hash: `sha256:${"a".repeat(64)}`,
      capability: "orders.propose_credit",
      state: "pending_review" as const,
      business_object: "order",
      object_id: `order-${index + 1}`,
      writeback_mode: "read_only",
      source_database_mutated: false,
      created_at: "2026-08-23T12:00:00.000Z",
      updated_at: "2026-08-23T12:00:00.000Z",
      })),
    }));
    const operatorService: ActionOperatorService = {
      async identityPosture() { return { provider: "dev_env", apply_roles: [] }; },
      async list() { return []; },
      async count() { return 25; },
      page,
      async detail() { throw new Error("not expected"); },
      async approve() { throw new Error("not expected"); },
      async reject() { throw new Error("not expected"); },
      async apply() { throw new Error("not expected"); },
      async replay() { throw new Error("not expected"); },
    };
    const prompter = scriptedPrompter({ choices: ["next", "back"], texts: [], confirms: [] });
    await reviewActionProposalInbox({ operatorService, prompter, env: {} });
    expect(page).toHaveBeenNthCalledWith(1, expect.objectContaining({ limit: 12, offset: 0 }));
    expect(page).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 12, offset: 12 }));
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
  onChoose?: (
    title: string,
    choices: Parameters<ActionControlPrompter["choose"]>[1],
    context?: string[],
  ) => void;
  onConfirm?: (label: string, defaultValue: boolean | undefined) => void;
}): ActionControlPrompter {
  return {
    async choose(title, choices, context) {
      input.onChoose?.(title, choices, context);
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
    async confirm(label, defaultValue) {
      input.onConfirm?.(label, defaultValue);
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
