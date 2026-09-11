import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { describe, expect, it, vi } from "vitest";
import {
  actionAuthorityRevisionNeedsVersionAdvance,
  actionHomeChoices,
  actionInspectionDatabaseUrlEnv,
  actionBoundaryActivationStatusLine,
  actionBoundaryApprovalStatusLine,
  actionBoundaryLimitSummary,
  actionSuggestionMenuLabel,
  actionActivationReviewLines,
  conciseConversationalActionActivationReviewLines,
  conversationalActionActivationReviewLines,
  actionDraftUsesQuickResume,
  actionReviewLines,
  collectGuidedActionInput,
  collectGuidedRehearsalArgs,
  collectQuickGuidedRehearsalArgs,
  collectQuickProposalActionInput,
  conventionalModelAuthoringSession,
  createTerminalActionPrompter,
  generatedGuidedRehearsalArgs,
  mergeActionProjectInspections,
  rankActionIntent,
  renderActionControlPlaneTable,
  reviewActionDraft,
  reviewActionProposalInbox,
  suggestedActionBoundaryLimits,
  type ActionBoundaryInterviewContext,
  type ActionControlPrompter,
} from "./action-tui.js";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import type { ActionOperatorService, ActionProposalDetail } from "./action-operator.js";
import type { GuidedActionResourceOption } from "./guided-action.js";
import { ACTION_SUGGESTION_VERSION, assessActionSuggestion } from "./action-design.js";
import type { QuickDeterministicApprovalTemplate } from "./guided-action-quick.js";

const orders: GuidedActionResourceOption = {
  id: "public.orders",
  schema: "public",
  table: "orders",
  primary_key: "id",
  tenant_key: "tenant_id",
  tenant_label: "customer account",
  principal_key: "rep_id",
  principal_label: "support representative",
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
  it("offers the typed manual semantic editor without hiding existing control-plane paths", () => {
    const choices = actionHomeChoices({ activations: [], drafts: [], action_boundary: {} } as never, [], options as never);
    expect(choices).toContainEqual(expect.objectContaining({
      value: "manual_semantic",
      label: "Edit business rules manually",
      detail: "Create or edit one supported proposal-only rule. Changes stay disabled until separate review; unsupported rules remain unchanged.",
    }));
    expect(choices.map(choice => choice.label).join("\n")).not.toContain("Manual semantic ActionRule");
    expect(choices).toContainEqual(expect.objectContaining({ value: "boundary" }));
  });

  const inspectedTable = (
    name: string,
    privileges: { select?: boolean; insert?: boolean; update?: boolean } = {},
    dataType = "integer",
  ): TableInfo => ({
    schema: "public",
    name,
    type: "table",
    writable: true,
    columns: [{
      name: "id",
      data_type: dataType,
      nullable: false,
      generated: false,
      ordinal_position: 1,
      enum_values: [],
      suggestions: {
        tenant: false,
        sensitive: false,
        immutable: true,
        conflict: false,
        large_or_binary: false,
      },
    }],
    primary_key: ["id"],
    unique_constraints: [],
    foreign_keys: [],
    indexes: [],
    suggestions: {
      tenant_columns: [],
      conflict_columns: [],
      sensitive_columns: [],
      default_visible_columns: ["id"],
    },
    role_posture: {
      owner: "owner",
      current_role_is_owner: false,
      current_role_can_assume_owner: false,
      privileges: {
        select: privileges.select === true,
        insert: privileges.insert === true,
        update: privileges.update === true,
        delete: false,
        truncate: false,
        references: false,
        trigger: false,
      },
      row_security_forced: false,
      row_security_effective_for_current_role: false,
    },
  });
  const inspection = (
    user: string,
    tables: TableInfo[],
    writableRelations: string[],
  ): SchemaInspection => ({
    engine: "postgres",
    server_version: "16.4",
    current_user: user,
    inspected_at: "2026-09-04T00:00:00.000Z",
    schemas: ["public"],
    tables,
    warnings: ["metadata only"],
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: writableRelations.length === 0,
      writable_relations: writableRelations,
      owned_relations: [],
      reasons: [],
    },
  });

  it("proves Action operations with the configured writer credential instead of the read-only source", () => {
    expect(actionInspectionDatabaseUrlEnv({
      engine: "postgres",
      sourceEnv: "DATABASE_URL",
      configuredSources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          write_url_env: "CUSTOM_WRITER_URL",
        },
      },
      env: {},
    })).toBe("CUSTOM_WRITER_URL");
  });

  it("uses the conventional separate writer when a fresh read-only config has not recorded one yet", () => {
    expect(actionInspectionDatabaseUrlEnv({
      engine: "postgres",
      sourceEnv: "DATABASE_URL",
      configuredSources: {
        local_postgres: { engine: "postgres", read_url_env: "DATABASE_URL" },
      },
      env: { SYNAPSOR_DATABASE_WRITE_URL: "postgresql://writer.example/db" },
    })).toBe("SYNAPSOR_DATABASE_WRITE_URL");
  });

  it("retains single-credential authoring when no separate writer is configured", () => {
    expect(actionInspectionDatabaseUrlEnv({
      engine: "mysql",
      sourceEnv: "DATABASE_URL",
      configuredSources: {
        local_mysql: { engine: "mysql", read_url_env: "DATABASE_URL" },
      },
      env: {},
    })).toBe("DATABASE_URL");
  });

  it("combines reader-only verification resources with separately proven writer posture", () => {
    const read = inspection("reader", [
      inspectedTable("accounts", { select: true }),
      inspectedTable("subscriptions", { select: true }),
    ], []);
    const write = inspection("writer", [
      inspectedTable("subscriptions", { select: true, update: true }),
      inspectedTable("audit_events", { insert: true }),
    ], ["public.subscriptions", "public.audit_events"]);

    const merged = mergeActionProjectInspections(read, write);

    expect(merged.current_user).toBe("writer");
    expect(merged.tables.map((table) => `${table.schema}.${table.name}`)).toEqual([
      "public.accounts",
      "public.audit_events",
      "public.subscriptions",
    ]);
    expect(merged.tables.find((table) => table.name === "accounts")?.role_posture?.privileges.select).toBe(true);
    expect(merged.tables.find((table) => table.name === "subscriptions")?.role_posture?.privileges.update).toBe(true);
    expect(merged.role_posture?.writable_relations).toEqual(["public.subscriptions", "public.audit_events"]);
    expect(merged.warnings.at(-1)).toContain("combines reader-visible verification metadata");
  });

  it("refuses incompatible overlapping read and writer schema shapes", () => {
    const read = inspection("reader", [inspectedTable("subscriptions", { select: true })], []);
    const write = inspection("writer", [inspectedTable("subscriptions", { update: true }, "text")], [
      "public.subscriptions",
    ]);

    expect(() => mergeActionProjectInspections(read, write)).toThrow(
      /ACTION_INSPECTION_SCHEMA_MISMATCH: public\.subscriptions differs/u,
    );
  });

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

  it("labels model suggestions by reviewed effect rather than an opaque record id", () => {
    const assessment = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Propose one bounded order credit update.",
      operation: "update",
      resource: "public.orders",
      fields: ["credit_cents"],
      suggested_by: { kind: "model", provider: "openai", model: "gpt-test" },
    }, options.resources);

    expect(actionSuggestionMenuLabel({ state: "reviewed", assessment }))
      .toBe("UPDATE public.orders [REVIEWED]");
    expect(actionSuggestionMenuLabel({ state: "reviewed", assessment }))
      .not.toContain("as_");
  });

  it("auto-selects one conventional external model without reading or persisting its key", () => {
    expect(conventionalModelAuthoringSession({ OPENAI_API_KEY: "openai-secret" })).toEqual({
      provider: "openai",
      model: "gpt-5.6-terra",
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

    await emitKey(terminal.input, { name: "pageup", sequence: "\u001b[5~" });
    await emitKey(terminal.input, { name: "escape", sequence: "\u001b" });
    await expect(choice).resolves.toBeUndefined();
    const rendered = stripAnsi(terminal.output.read()?.toString() ?? "");
    expect(rendered).toContain("Target: UPDATE public.orders");
    expect(rendered).toContain("trusted customer account (tenant_id tenant scope)");
    expect(rendered).toContain("support representative (rep_id principal scope)");
    expect(rendered).toContain("Auto-approve proposal credit_cents | <= 500");
    expect(rendered).toContain("State | proposal_only | writeback none");
    expect(rendered).toContain("PgUp/PgDn Scroll hidden details");
  });

  it("keeps conversational Action activation compact while preserving exact policy authority", () => {
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
    const lines = conversationalActionActivationReviewLines(action, orders, [{
      id: "credit-per-principal",
      kind: "count",
      scope: "tenant_principal",
      maximum: 3,
      window_seconds: 86_400,
      capability: action.capability_name,
    }]);
    const rendered = lines.join("\n");

    expect(rendered).toContain("Target: UPDATE public.orders");
    expect(rendered).toContain("| Field or scope");
    expect(rendered).toContain("| Proposal allowed");
    expect(rendered).toContain("| Auto-approved when");
    expect(rendered).toContain("credit_cents");
    expect(rendered).toContain("0 through 2500");
    expect(rendered).toContain("<= 500");
    expect(rendered).toContain("credit-per-principal");
    expect(rendered).toContain("customer account");
    expect(rendered).toContain("support representative");
    expect(rendered).toContain("Approval OFF | apply OFF | writeback OFF");
    expect(rendered).not.toContain("Auto-approve proposal credit_cents |");
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(76);
  });

  it("summarizes the Action activation gate while retaining exact trusted-scope limits", () => {
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
      },
      authority_posture: "proposal_only" as const,
      writeback: { mode: "none" as const },
      confirmed_trusted_scope: true,
    };
    const lines = conciseConversationalActionActivationReviewLines(action, orders, [{
      id: "credit-per-principal",
      kind: "count",
      scope: "tenant_principal",
      maximum: 3,
      window_seconds: 86_400,
      capability: action.capability_name,
    }]);
    const rendered = lines.join("\n");

    expect(rendered).toContain("UPDATE public.orders · proposal only");
    expect(rendered).toContain("credit_cents: 0 through 2500");
    expect(rendered).toContain("proposal status | one of \"open\"");
    expect(rendered).toContain("identity id; conflict version");
    expect(rendered).toContain("Limit: 3 approvals per customer account + approval policy / UTC day.");
    expect(rendered).toContain("At most 3 deterministic approvals");
    expect(rendered).not.toContain("credit-per-principal");
    expect(rendered).toContain("trusted customer account + support representative");
    expect(rendered).toContain("rolling 24 hours");
    expect(rendered).toContain("Apply and source writeback remain off");
    expect(rendered).not.toContain("+----------------");
  });

  it("renders every shared Action Boundary limit even when this action uses human approval", () => {
    const action = {
      capability_name: "orders.propose_credit",
      description: "Propose one bounded order credit.",
      business_object: "order",
      resource: "public.orders",
      operation: "update" as const,
      conflict_column: "version",
      patches: [{
        column: "credit_cents",
        value_source: "argument" as const,
        argument_name: "credit_cents",
        minimum: 0,
        maximum: 2500,
      }],
      approval_role: "action_reviewer",
      required_approvals: 1,
      authority_posture: "proposal_only" as const,
      writeback: { mode: "none" as const },
      confirmed_trusted_scope: true,
    };
    const lines = actionActivationReviewLines(action, orders, [
      {
        id: "all-actions-hourly",
        kind: "count",
        scope: "boundary",
        maximum: 20,
        window_seconds: 3600,
      },
      {
        id: "credit-action-daily",
        kind: "count",
        scope: "capability",
        capability: action.capability_name,
        maximum: 10,
        window_seconds: 86_400,
      },
    ]).join("\n");

    expect(lines).toContain("Shared rolling limit all-actions-hourly");
    expect(lines).toContain("whole action boundary");
    expect(lines).toContain("Shared rolling limit credit-action-daily");
    expect(lines).toContain("this exact action (orders.propose_credit)");
    expect(lines).toContain("rolling 24 hours");
    expect(lines).toContain("outside it, Runner refuses before proposal creation");
    expect(lines).toContain("Approval | 1 x action_reviewer; human review");
  });

  it("prepares one consolidated proposal-only action from unique reviewed intent", async () => {
    const textPrompts: Array<{
      label: string;
      options: Parameters<ActionControlPrompter["text"]>[1];
    }> = [];
    const prompter = scriptedPrompter({
      choices: ["create"],
      texts: ["0,2500"],
      confirms: [],
      onText: (label, options) => textPrompts.push({ label, options }),
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
    expect(textPrompts[0]).toMatchObject({
      label: "Allowed credit_cents range (minimum,maximum)",
      options: {
        title: "SET THE REVIEWED RANGE FOR CREDIT_CENTS",
        context: expect.arrayContaining([
          "Target: UPDATE public.orders",
          "Agent-supplied field: credit_cents",
          "Enter two numbers separated by a comma, for example 5,120.",
        ]),
      },
    });
  });

  it("skips hard-delete drafting once without repeating an exact phrase prompt", async () => {
    const chosen: string[] = [];
    const prompter = scriptedPrompter({
      choices: ["skip"],
      texts: [],
      confirms: [],
      onChoose: (title) => chosen.push(title),
    });

    await expect(collectQuickProposalActionInput(
      options,
      prompter,
      "Delete one public order.",
    )).resolves.toBeUndefined();
    expect(chosen).toEqual(["CONFIRM HARD-DELETE PROPOSAL AUTHORITY"]);
  });

  it("keeps quick hard-delete drafting behind the exact destructive phrase", async () => {
    const prompter = scriptedPrompter({
      choices: ["confirm", "create"],
      texts: ["DELETE public.orders"],
      confirms: [],
    });

    await expect(collectQuickProposalActionInput(
      options,
      prompter,
      "Delete one public order.",
    )).resolves.toMatchObject({
      resource: "public.orders",
      operation: "delete",
      delete_confirmation: "DELETE public.orders",
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
    });
  });

  it("asks for unresolved Action bounds in natural language and confirms the exact interpretation", async () => {
    const textLabels: string[] = [];
    const textContexts: string[][] = [];
    const confirmationContexts: string[][] = [];
    const decisionInterpreter = vi.fn(async () => ({
      state: "resolved" as const,
      decisions: { numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } } },
      summary: "credit_cents: 0 through 2500",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const prompter = scriptedPrompter({
      choices: [],
      texts: ["From zero through twenty-five dollars.", "yes", "human review"],
      confirms: [],
      onText: (label, options) => {
        textLabels.push(label);
        textContexts.push(options?.context ?? []);
        if (options?.title === "CONFIRM PROPOSAL RANGE") {
          confirmationContexts.push(options.context ?? []);
        }
      },
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
      [],
      {
        modelInterview: {
          session: { provider: "openai", model: "gpt-5.6-luna" },
          egressAcknowledged: true,
          decisionInterpreter,
        },
      },
    );

    expect(textLabels).toEqual([
      "What is the smallest and largest credit cents the agent may propose?",
      "Press Enter to accept, or describe what should change",
      "Press Enter to accept, or describe what should change",
    ]);
    expect(textContexts[0]).toEqual(expect.arrayContaining([
      "Where used: every UPDATE public.orders proposal may supply credit_cents only inside the confirmed range.",
      "Outside this range: Runner refuses the proposal before approval. Auto-approval may use a narrower range later.",
    ]));
    expect(confirmationContexts[0]).toEqual(expect.arrayContaining([
      "Operator answer: From zero through twenty-five dollars.",
      "Runner-validated interpretation: credit_cents: 0 through 2500",
      "Where enforced: every UPDATE public.orders proposal; values outside this range are refused before approval.",
      "Authority granted: no | source database changed: no",
    ]));
    expect(decisionInterpreter).toHaveBeenCalledWith(expect.objectContaining({
      answer: "From zero through twenty-five dollars.",
      decision: expect.objectContaining({ kind: "numeric_bounds", field: "credit_cents" }),
      egressAcknowledged: true,
    }));
    expect(action).toMatchObject({
      resource: "public.orders",
      operation: "update",
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
    });
  });

  it("reuses an exact bound from the original job instead of asking the operator to repeat it", async () => {
    const textLabels: string[] = [];
    const decisionInterpreter = vi.fn(async (input: { answer: string }) => ({
      state: "resolved" as const,
      decisions: { numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } } },
      summary: "credit_cents: 0 through 2500",
      model_message: "The disabled proposal will allow credit_cents from 0 through 2500. Should I use that exact range?",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const prompter = scriptedPrompter({
      choices: [],
      texts: ["yes", "human review"],
      confirms: [],
      onText: (label) => textLabels.push(label),
    });
    const job = "Let support propose credit_cents from 0 through 2500. Keep human approval.";

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      job,
      [],
      {
        modelInterview: {
          session: {
            provider: "openai",
            model: "gpt-5.6-terra",
            openingOperatorMessage: job,
            openingValidatedFacts: ["The model selected UPDATE public.orders."],
          },
          egressAcknowledged: true,
          decisionInterpreter,
        },
      },
    );

    expect(decisionInterpreter).toHaveBeenCalledWith(expect.objectContaining({
      answer: job,
      decision: expect.objectContaining({ kind: "numeric_bounds", field: "credit_cents" }),
    }));
    expect(textLabels).not.toContain("What is the smallest and largest credit cents the agent may propose?");
    expect(textLabels[0]).toBe("Press Enter to accept, or describe what should change");
    expect(action).toMatchObject({
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
    });
  });

  it("turns an ambiguous original-job bound into one focused clarification", async () => {
    const textLabels: string[] = [];
    const decisionInterpreter = vi.fn()
      .mockResolvedValueOnce({
        state: "clarification" as const,
        question: "What is the largest credit cents the agent may propose?",
        model_message: "I still need the exact maximum credit amount.",
        authority_granted: false as const,
        source_database_changed: false as const,
      })
      .mockResolvedValueOnce({
        state: "resolved" as const,
        decisions: { numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } } },
        summary: "credit_cents: 0 through 2500",
        model_message: "The disabled proposal will allow credit_cents from 0 through 2500. Should I use that exact range?",
        correction_used: false,
        authority_granted: false as const,
        source_database_changed: false as const,
      });
    const job = "Let support propose a bounded order credit. Keep human approval.";
    const prompter = scriptedPrompter({
      choices: [],
      texts: ["From zero through 2500 cents.", "yes", "human review"],
      confirms: [],
      onText: (label) => textLabels.push(label),
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      job,
      [],
      {
        modelInterview: {
          session: {
            provider: "openai",
            model: "gpt-5.6-terra",
            openingOperatorMessage: job,
          },
          egressAcknowledged: true,
          decisionInterpreter,
        },
      },
    );

    expect(decisionInterpreter).toHaveBeenCalledTimes(2);
    expect(textLabels[0]).toBe("What is the largest credit cents the agent may propose?");
    expect(textLabels.filter((label) => label.includes("smallest and largest"))).toHaveLength(0);
    expect(action).toMatchObject({
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
    });
  });

  it("falls back to the normal focused question when interpreting the original job fails", async () => {
    const choiceTitles: string[] = [];
    const textLabels: string[] = [];
    const decisionInterpreter = vi.fn()
      .mockRejectedValueOnce(new Error("ACTION_BOUNDARY_INTERVIEW_INVALID: malformed model output."))
      .mockResolvedValueOnce({
        state: "resolved" as const,
        decisions: { numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } } },
        summary: "credit_cents: 0 through 2500",
        model_message: "The disabled proposal will allow credit_cents from 0 through 2500. Should I use that exact range?",
        correction_used: false,
        authority_granted: false as const,
        source_database_changed: false as const,
      });
    const job = "Let support propose a bounded order credit. Keep human approval.";
    const prompter = scriptedPrompter({
      choices: [],
      texts: ["From zero through 2500 cents.", "yes", "human review"],
      confirms: [],
      onChoose: (title) => choiceTitles.push(title),
      onText: (label) => textLabels.push(label),
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      job,
      [],
      {
        modelInterview: {
          session: {
            provider: "openai",
            model: "gpt-5.6-terra",
            openingOperatorMessage: job,
          },
          egressAcknowledged: true,
          decisionInterpreter,
        },
      },
    );

    expect(decisionInterpreter).toHaveBeenCalledTimes(2);
    expect(choiceTitles).not.toContain("MODEL INTERPRETATION NOT USED");
    expect(textLabels[0]).toBe("What is the smallest and largest credit cents the agent may propose?");
    expect(action).toMatchObject({
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
    });
  });

  it("continues with exact controls after a refused model interpretation instead of retrying later decisions", async () => {
    const recoveryChoices: string[] = [];
    const recoveryContext: string[] = [];
    const decisionInterpreter = vi.fn(async () => {
      throw new Error("ACTION_BOUNDARY_INTERVIEW_INVALID: malformed local-model tool output.");
    });
    const prompter = scriptedPrompter({
      choices: ["manual", "create"],
      texts: ["From zero through twenty-five dollars.", "0,2500"],
      confirms: [],
      onChoose(title, choices, context) {
        if (title === "MODEL INTERPRETATION NOT USED") {
          recoveryChoices.push(...choices.map((choice) => `${choice.value}:${choice.label}`));
          recoveryContext.push(...(context ?? []));
        }
      },
    });

    const result = await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
      [],
      {
        modelInterview: {
          session: { provider: "openai_compatible", model: "qwen2.5:7b", baseUrl: "http://127.0.0.1:11434/v1" },
          egressAcknowledged: true,
          decisionInterpreter,
        },
      },
    );

    expect(decisionInterpreter).toHaveBeenCalledOnce();
    expect(recoveryChoices).toEqual(expect.arrayContaining([
      expect.stringContaining("manual:Continue this Action setup with exact controls"),
      expect.stringContaining("retry:Try one more natural-language answer"),
    ]));
    expect(recoveryContext).toContain(
      "The selected model returned invalid structured output: malformed local-model tool output.",
    );
    expect(recoveryContext.join("\n")).not.toContain("ACTION_BOUNDARY_INTERVIEW_INVALID");
    expect(result).toMatchObject({
      resource: "public.orders",
      operation: "update",
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
    });
  });

  it("preserves a validated model decision when the operator switches the remaining setup to exact controls", async () => {
    const multiGuardOptions = {
      ...options,
      resources: [{ ...orders, conflict_candidates: ["updated_at", "version"] }],
    };
    const choiceTitles: string[] = [];
    const decisionInterpreter = vi.fn(async () => ({
      state: "resolved" as const,
      decisions: { guard_column: "version" },
      summary: "conflict guard: version",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const prompter = scriptedPrompter({
      choices: ["create"],
      texts: ["Use version.", "exact controls"],
      confirms: [],
      onChoose: (title) => choiceTitles.push(title),
    });

    const action = await collectQuickProposalActionInput(
      multiGuardOptions,
      prompter,
      "Let support update an order credit within a reviewed limit.",
      [],
      {
        initialDecisions: {
          resource: "public.orders",
          operation: "update",
          fields: ["credit_cents"],
          numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } },
        },
        modelInterview: {
          session: { provider: "openai", model: "gpt-5.6-luna" },
          egressAcknowledged: true,
          decisionInterpreter,
        },
      },
    );

    expect(action).toMatchObject({ conflict_column: "version" });
    expect(choiceTitles).not.toContain("WHICH COLUMN DETECTS STALE PROPOSALS?");
    expect(decisionInterpreter).toHaveBeenCalledOnce();
  });

  it("removes a selected stale-row guard from model-writable fields", async () => {
    const guardedOrders: GuidedActionResourceOption = {
      ...orders,
      structurally_eligible_fields: [
        ...orders.structurally_eligible_fields,
        { name: "version", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
      ],
      conflict_candidates: ["updated_at", "version"],
    };
    const action = await collectQuickProposalActionInput(
      { ...options, resources: [guardedOrders] },
      scriptedPrompter({ choices: ["create"], texts: [], confirms: [] }),
      "Propose a reviewed order update.",
      [],
      {
        initialDecisions: {
          resource: "public.orders",
          operation: "update",
          guard_column: "version",
          fields: ["credit_cents", "version"],
          numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } },
        },
      },
    );

    expect(action).toMatchObject({
      conflict_column: "version",
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
    });
    expect(action).not.toMatchObject({
      patches: expect.arrayContaining([expect.objectContaining({ column: "version" })]),
    });
  });

  it("removes the only auto-selected stale-row guard from model-writable fields", async () => {
    const guardedOrders: GuidedActionResourceOption = {
      ...orders,
      structurally_eligible_fields: [
        ...orders.structurally_eligible_fields,
        { name: "version", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
      ],
      conflict_candidates: ["version"],
    };
    const action = await collectQuickProposalActionInput(
      { ...options, resources: [guardedOrders] },
      scriptedPrompter({ choices: ["create"], texts: [], confirms: [] }),
      "Propose a reviewed order update.",
      [],
      {
        initialDecisions: {
          resource: "public.orders",
          operation: "update",
          fields: ["credit_cents", "version"],
          numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } },
        },
      },
    );

    expect(action).toMatchObject({
      conflict_column: "version",
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
    });
    expect(action).not.toMatchObject({
      patches: expect.arrayContaining([expect.objectContaining({ column: "version" })]),
    });
  });

  it("lets exact controls select more than one reviewed proposal field", async () => {
    const prompter = scriptedPrompter({
      choices: ["status", "credit_cents", "__done__", "create"],
      texts: ["0,2500"],
      confirms: [],
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Update one reviewed order.",
      [],
      {
        initialDecisions: {
          resource: "public.orders",
          operation: "update",
          guard_column: "version",
        },
      },
    );

    expect(action).toMatchObject({
      patches: expect.arrayContaining([
        expect.objectContaining({ column: "status" }),
        expect.objectContaining({ column: "credit_cents", minimum: 0, maximum: 2500 }),
      ]),
    });
  });

  it("reprompts malformed and fractional integer bounds instead of abandoning Action drafting", async () => {
    const prompts: Array<Parameters<ActionControlPrompter["text"]>[1]> = [];
    const prompter = scriptedPrompter({
      choices: ["create"],
      texts: ["4500 16500", "4500.5,16500", "4500,16500"],
      confirms: [],
      onText: (_label, promptOptions) => prompts.push(promptOptions),
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Update the reviewed order credit.",
      [],
      {
        initialDecisions: {
          resource: "public.orders",
          operation: "update",
          guard_column: "version",
          fields: ["credit_cents"],
        },
      },
    );

    expect(action).toMatchObject({
      patches: [{ column: "credit_cents", minimum: 4500, maximum: 16500 }],
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[1]?.context).toEqual(expect.arrayContaining([
      expect.stringContaining("exactly two finite numbers separated by a comma"),
    ]));
    expect(prompts[2]?.context).toEqual(expect.arrayContaining([
      expect.stringContaining("integer source column requires whole-number bounds"),
    ]));
  });

  it("requires a separate exact confirmation before operator-supplied value context reaches the model", async () => {
    let attempt = 0;
    const decisionInterpreter = vi.fn(async (input: Parameters<NonNullable<ActionBoundaryInterviewContext["decisionInterpreter"]>>[0]) => {
      attempt += 1;
      return attempt === 1
        ? {
            state: "value_request" as const,
            field: "credit_cents",
            reason: "The operator named a local business class that is not schema-declared.",
            question: "Which exact credit values are in that class?",
            correction_used: false,
            authority_granted: false as const,
            source_database_changed: false as const,
          }
        : {
            state: "resolved" as const,
            decisions: { numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } } },
            summary: "credit_cents: 0 through 2500",
            correction_used: false,
            authority_granted: false as const,
            source_database_changed: false as const,
          };
    });
    const prompter = scriptedPrompter({
      choices: ["provide", "send"],
      texts: ["Use our ordinary low-credit class.", "0, 2500", "yes", "human review"],
      confirms: [],
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
      [],
      {
        modelInterview: {
          session: { provider: "openai", model: "gpt-5.6-luna" },
          egressAcknowledged: true,
          decisionInterpreter,
        },
      },
    );

    expect(decisionInterpreter).toHaveBeenCalledTimes(2);
    expect(decisionInterpreter.mock.calls[1]?.[0]).toMatchObject({
      answer: "Use our ordinary low-credit class.",
      operatorApprovedValues: {
        field: "credit_cents",
        values: ["0", "2500"],
        egressAcknowledged: true,
      },
    });
    expect(action).toMatchObject({
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
      authority_posture: "proposal_only",
    });
  });

  it("answers an unrelated scope follow-up without reinterpreting the pending stale-row guard", async () => {
    const multiGuardOrders: GuidedActionResourceOption = {
      ...orders,
      conflict_candidates: ["updated_at", "version"],
    };
    const multiGuardOptions = {
      ...options,
      resources: [multiGuardOrders],
    };
    const decisionInterpreter = vi.fn(async () => ({
      state: "resolved" as const,
      decisions: { guard_column: "version" },
      summary: "conflict guard: version",
      model_message: "Use version to reject a stale proposal. Should I keep that exact guard?",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const modelSession: ActionBoundaryInterviewContext["session"] = {
      provider: "openai",
      model: "gpt-5.6-luna",
      openingValidatedFacts: [
        "The combined Read and Action draft passed Runner validation.",
      ],
    };
    const textRecords: Array<{
      label: string;
      options: Parameters<ActionControlPrompter["text"]>[1];
    }> = [];
    const prompter = scriptedPrompter({
      choices: ["create"],
      texts: [
        "Use version.",
        "Why is version needed, and is trusted account scope already resolved?",
        "yes",
        "human review",
      ],
      confirms: [],
      onText: (label, promptOptions) => textRecords.push({ label, options: promptOptions }),
    });

    const action = await collectQuickProposalActionInput(
      multiGuardOptions,
      prompter,
      "Let an authenticated customer propose a reviewed plan change.",
      [],
      {
        initialDecisions: {
          resource: "public.orders",
          operation: "update",
          fields: ["credit_cents"],
          numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } },
        },
        modelInterview: {
          session: modelSession,
          egressAcknowledged: true,
          decisionInterpreter,
        },
      },
    );

    expect(decisionInterpreter).toHaveBeenCalledOnce();
    expect(action).toMatchObject({
      resource: "public.orders",
      operation: "update",
      conflict_column: "version",
    });
    const confirmations = textRecords.filter((record) =>
      record.options?.title === "CONFIRM CONFLICT AND RETRY GUARD");
    expect(confirmations).toHaveLength(2);
    expect(confirmations[1]?.options?.conversation?.modelLines).toEqual([]);
    expect(confirmations[1]?.options?.conversation?.checkpoint).toMatchObject({
      title: "Model explanation not used",
      lines: expect.arrayContaining([
        expect.stringContaining("Trusted scope and target identity are already resolved separately"),
      ]),
      tone: "warning",
    });
    expect(modelSession.openingValidatedFactsConsumed).toBe(true);
  });

  it("lets the operator replace a prepared approval policy in natural language before one exact confirmation", async () => {
    const policyInterpreter = vi.fn(async () => ({
      state: "resolved" as const,
      auto_approval: {
        conditions: [{ field: "credit_cents", operator: "lte" as const, value: 500 }],
        max_per_day: 3,
        max_total_per_day: 1000,
        total_field: "credit_cents",
      },
      shared_limits: [{
        kind: "count" as const,
        scope: "tenant_principal" as const,
        maximum: 3,
        window_seconds: 86400,
      }],
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    let acceptedTemplate: QuickDeterministicApprovalTemplate | undefined;
    const textPrompts: Array<{
      label: string;
      options: Parameters<ActionControlPrompter["text"]>[1];
    }> = [];
    const choiceTitles: string[] = [];
    const prompter = scriptedPrompter({
      choices: [],
      texts: [
        "From zero through twenty-five dollars.",
        "yes",
        "Credits up to five dollars, at most three per support agent each day and ten dollars total.",
        "yes",
      ],
      confirms: [],
      onText: (label, options) => textPrompts.push({ label, options }),
      onChoose: (title) => choiceTitles.push(title),
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
      [],
      {
        modelInterview: {
          session: { provider: "openai", model: "gpt-5.6-luna" },
          egressAcknowledged: true,
          decisionInterpreter: async () => ({
            state: "resolved",
            decisions: { numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } } },
            summary: "credit_cents: 0 through 2500",
            correction_used: false,
            authority_granted: false,
            source_database_changed: false,
          }),
          policyInterpreter,
        },
        onDeterministicApprovalAccepted(template) {
          acceptedTemplate = template;
        },
      },
    );

    expect(policyInterpreter).toHaveBeenCalledWith(expect.objectContaining({
      answer: expect.stringContaining("three per support agent"),
      action: expect.objectContaining({ resource: "public.orders" }),
      egressAcknowledged: true,
    }));
    expect(action).toMatchObject({
      auto_approval: {
        conditions: [{ field: "credit_cents", operator: "lte", value: 500 }],
        max_per_day: 3,
        max_total_per_day: 1000,
        total_field: "credit_cents",
      },
    });
    expect(acceptedTemplate).toMatchObject({
      source: "model_interview",
      shared_limits: [{ scope: "tenant_principal", maximum: 3, window_seconds: 86400 }],
    });
    const policyPrompt = textPrompts.find((prompt) =>
      prompt.options?.title === "CONFIRM AUTO-APPROVAL POLICY"
      && prompt.label === "Press Enter to accept, or describe what should change"
      && prompt.options.context?.some((line) => line.includes("| Field or scope")));
    expect(policyPrompt).toMatchObject({
        options: {
          title: "CONFIRM AUTO-APPROVAL POLICY",
          context: expect.arrayContaining([
            expect.stringContaining("| Field or scope"),
            expect.stringContaining("| credit_cents"),
            expect.stringContaining("describe the change in ordinary language"),
          ]),
        },
      });
    expect(policyPrompt?.options?.context?.join("\n")).not.toContain("Proposal envelope");
    expect(policyPrompt?.options?.context
      ?.filter((line) => /^[+|]/u.test(line))
      .every((line) => line.length <= 72)).toBe(true);
    expect(policyPrompt?.options?.conversation).toBeUndefined();
    expect(textPrompts.every((candidate) => candidate.options?.conversation === undefined)).toBe(true);
    expect(choiceTitles).not.toContain("REVIEW EXACT AUTO-APPROVAL POLICY");
    expect(choiceTitles).not.toContain("REVIEW PROPOSAL ACTION");
  });

  it("stops an incompatible policy after three bounded clarifications and offers recovery", async () => {
    const policyInterpreter = vi.fn(async () => ({
      state: "clarification" as const,
      question: "Which reviewed ticket field represents the refund amount?",
      model_message: "This refund rule does not fit the current ticket action because it has no amount or payment-method field.",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const choiceRecords: Array<{ title: string; labels: string[] }> = [];
    const prompter = scriptedPrompter({
      choices: ["human"],
      texts: [
        "From zero through twenty-five dollars.",
        "yes",
        "Auto-approve refunds up to twenty-five dollars.",
        "Use an account credit.",
        "The action still has no reviewed amount field.",
      ],
      confirms: [],
      onChoose: (title, choices) => choiceRecords.push({
        title,
        labels: choices.map((choice) => choice.label),
      }),
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
      [],
      {
        modelInterview: {
          session: { provider: "openai", model: "gpt-5.6-luna" },
          egressAcknowledged: true,
          decisionInterpreter: async () => ({
            state: "resolved",
            decisions: { numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } } },
            summary: "credit_cents: 0 through 2500",
            correction_used: false,
            authority_granted: false,
            source_database_changed: false,
          }),
          policyInterpreter,
        },
      },
    );

    expect(policyInterpreter).toHaveBeenCalledTimes(3);
    expect(choiceRecords).toContainEqual(expect.objectContaining({
      title: "POLICY DOES NOT FIT THIS ACTION",
      labels: expect.arrayContaining([
        "Describe a policy for this exact action",
        "Keep human approval [recommended]",
        "Use exact policy controls",
        "Skip this action and continue",
      ]),
    }));
    expect(action).not.toHaveProperty("auto_approval");
  });

  it("does not treat blank Enter during a model policy clarification as acceptance or navigation", async () => {
    let attempt = 0;
    const policyInterpreter = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          state: "clarification" as const,
          question: "What exact reviewed credit ceiling should apply?",
          model_message: "What exact reviewed credit ceiling should apply?",
          correction_used: false,
          authority_granted: false as const,
          source_database_changed: false as const,
        };
      }
      return {
        state: "resolved" as const,
        auto_approval: {
          conditions: [{ field: "credit_cents", operator: "lte" as const, value: 500 }],
          max_per_day: 3,
        },
        shared_limits: [],
        correction_used: false,
        authority_granted: false as const,
        source_database_changed: false as const,
      };
    });
    const promptRecords: Array<{ label: string; title?: string; context?: string[] }> = [];
    const choiceTitles: string[] = [];
    const prompter = scriptedPrompter({
      choices: [],
      texts: [
        "From zero through twenty-five dollars.",
        "yes",
        "Use a bounded policy.",
        "",
        "Five dollars.",
        "yes",
      ],
      confirms: [],
      onText: (label, options) => promptRecords.push({
        label,
        ...(options?.title ? { title: options.title } : {}),
        ...(options?.context ? { context: options.context } : {}),
      }),
      onChoose: (title) => choiceTitles.push(title),
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
      [],
      {
        modelInterview: {
          session: { provider: "openai", model: "gpt-5.6-luna" },
          egressAcknowledged: true,
          decisionInterpreter: async () => ({
            state: "resolved",
            decisions: { numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } } },
            summary: "credit_cents: 0 through 2500",
            correction_used: false,
            authority_granted: false,
            source_database_changed: false,
          }),
          policyInterpreter,
        },
      },
    );

    expect(policyInterpreter).toHaveBeenCalledTimes(2);
    expect(choiceTitles).not.toContain("POLICY DOES NOT FIT THIS ACTION");
    expect(promptRecords.filter((record) => record.title === "REFINE AUTO-APPROVAL POLICY")).toHaveLength(2);
    expect(promptRecords.some((record) => record.context?.some((line) =>
      line.includes("Blank Enter did not accept, skip, or change")))).toBe(true);
    expect(action).toMatchObject({
      auto_approval: {
        conditions: [{ field: "credit_cents", operator: "lte", value: 500 }],
      },
    });
  });

  it("resets the bounded clarification count after a policy revision resolves", async () => {
    let attempt = 0;
    const policyInterpreter = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1 || attempt === 3) {
        return {
          state: "clarification" as const,
          question: attempt === 1
            ? "What exact credit ceiling should apply?"
            : "What lower revised credit ceiling should apply?",
          correction_used: false,
          authority_granted: false as const,
          source_database_changed: false as const,
        };
      }
      const maximum = attempt === 2 ? 500 : 400;
      return {
        state: "resolved" as const,
        auto_approval: {
          conditions: [{ field: "credit_cents", operator: "lte" as const, value: maximum }],
          max_per_day: 3,
        },
        shared_limits: [],
        correction_used: false,
        authority_granted: false as const,
        source_database_changed: false as const,
      };
    });
    const choiceTitles: string[] = [];
    const prompter = scriptedPrompter({
      choices: [],
      texts: [
        "From zero through twenty-five dollars.",
        "yes",
        "Use a bounded policy.",
        "Five dollars.",
        "change",
        "Use a lower bounded policy.",
        "Four dollars.",
        "yes",
      ],
      confirms: [],
      onChoose: (title) => choiceTitles.push(title),
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
      [],
      {
        modelInterview: {
          session: { provider: "openai", model: "gpt-5.6-luna" },
          egressAcknowledged: true,
          decisionInterpreter: async () => ({
            state: "resolved",
            decisions: { numeric_bounds: { credit_cents: { minimum: 0, maximum: 2500 } } },
            summary: "credit_cents: 0 through 2500",
            correction_used: false,
            authority_granted: false,
            source_database_changed: false,
          }),
          policyInterpreter,
        },
      },
    );

    expect(policyInterpreter).toHaveBeenCalledTimes(4);
    expect(choiceTitles).not.toContain("POLICY DOES NOT FIT THIS ACTION");
    expect(action).toMatchObject({
      auto_approval: {
        conditions: [{ field: "credit_cents", operator: "lte", value: 400 }],
      },
    });
  });

  it("reviews a validated model Action draft without reselecting its target, operation, or fields", async () => {
    const suggestion = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Let support propose a bounded order credit.",
      operation: "update",
      resource: "public.orders",
      fields: ["credit_cents"],
      approval_policy_proposal: {
        mode: "deterministic",
        conditions: [{ field: "credit_cents", operator: "lte", value: 500 }],
        max_per_day: 3,
        max_total_per_day: 1_000,
        total_field: "credit_cents",
      },
      suggested_by: { kind: "model", provider: "openai", model: "gpt-5.6-luna" },
    }, options.resources);
    expect(suggestion.status, suggestion.blockers.join("; ")).toBe("suggested");
    const choiceTitles: string[] = [];
    const firstChoiceLabels: string[] = [];
    const choiceContexts = new Map<string, string[]>();
    const prompter = scriptedPrompter({
      choices: ["delegate", "confirm"],
      texts: ["0,2500"],
      confirms: [],
      onChoose: (title, choices, context = []) => {
        choiceTitles.push(title);
        firstChoiceLabels.push(choices[0]?.label ?? "");
        choiceContexts.set(title, context);
      },
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      suggestion.suggestion.intent,
      ["MODEL-SUGGESTED ACTION DRAFT"],
      {
        initialDecisions: {
          resource: suggestion.suggestion.resource,
          operation: suggestion.suggestion.operation,
          fields: suggestion.suggestion.fields,
        },
        suggestion,
      },
    );

    expect(choiceTitles).toEqual(["REVIEW PROPOSAL ACTION", "REVIEW EXACT AUTO-APPROVAL POLICY"]);
    expect(firstChoiceLabels[0]).toContain("model-proposed deterministic approval rules");
    expect(firstChoiceLabels[1]).toContain("exact disabled policy");
    const exactPolicyReview = choiceContexts.get("REVIEW EXACT AUTO-APPROVAL POLICY") ?? [];
    const exactPolicyText = exactPolicyReview.join("\n");
    expect(exactPolicyText).toContain("| Control");
    expect(exactPolicyText).toContain("Proposal envelope");
    expect(exactPolicyText).toContain("credit_cents");
    expect(exactPolicyText).toContain("Auto-approve");
    expect(exactPolicyText).toContain("proposal credit_cents");
    expect(exactPolicyText).toContain("Policy fallback");
    expect(exactPolicyText).toContain("3 approvals / UTC");
    expect(exactPolicyText).toContain("1000 total / UTC");
    expect(exactPolicyText).toContain("Approval authority: DISABLED | apply authority: NONE | source database changed: no");
    expect(exactPolicyReview).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^Why:/u),
    ]));
    expect(exactPolicyReview
      .filter((line) => /^[+|]/u.test(line))
      .every((line) => line.length <= 72)).toBe(true);
    expect(action).toMatchObject({
      resource: "public.orders",
      operation: "update",
      patches: [{ column: "credit_cents", minimum: 0, maximum: 2500 }],
      auto_approval: {
        conditions: [{ field: "credit_cents", operator: "lte", value: 500 }],
        max_per_day: 3,
        max_total_per_day: 1_000,
        total_field: "credit_cents",
      },
      authority_posture: "proposal_only",
      writeback: { mode: "none" },
    });
  });

  it("keeps deterministic approval fields and circuit breakers tied to the reviewed action", async () => {
    const textPrompts: Array<{
      label: string;
      options: Parameters<ActionControlPrompter["text"]>[1];
    }> = [];
    const choiceContexts = new Map<string, string[]>();
    const firstChoiceLabels = new Map<string, string>();
    let acceptedTemplate: QuickDeterministicApprovalTemplate | undefined;
    const prompter = scriptedPrompter({
      choices: ["delegate", "manual", "custom", "at_most"],
      texts: ["0,2500", "500", "3", "1000"],
      confirms: [],
      onText: (label, options) => textPrompts.push({ label, options }),
      onChoose: (title, choices, context = []) => {
        choiceContexts.set(title, context);
        firstChoiceLabels.set(title, choices[0]?.label ?? "");
      },
    });

    const action = await collectQuickProposalActionInput(
      options,
      prompter,
      "Let support update an order credit_cents within a reviewed limit.",
      [],
      {
        onDeterministicApprovalAccepted(template) {
          acceptedTemplate = template;
        },
      },
    );

    expect(action).toMatchObject({
      auto_approval: {
        conditions: [{ field: "credit_cents", operator: "lte", value: 500 }],
        max_per_day: 3,
        max_total_per_day: 1000,
        total_field: "credit_cents",
      },
    });
    expect(firstChoiceLabels.get("REVIEW PROPOSAL ACTION"))
      .toContain("Runner-proposed deterministic approval rules");
    expect(acceptedTemplate).toMatchObject({
      source: "reviewed_structure",
      shared_limits: [{
        kind: "count",
        scope: "tenant_principal",
        maximum: 10,
        window_seconds: 86_400,
      }],
    });
    expect(choiceContexts.get("AUTO-APPROVAL CONDITIONS")).toEqual(expect.arrayContaining([
      "Target: UPDATE public.orders",
      expect.stringContaining("returns to human review"),
    ]));
    expect(textPrompts.find((prompt) => prompt.label === "Auto-approve credit_cents at or below"))
      .toMatchObject({
        options: {
          title: "SET NUMERIC AUTO-APPROVAL CEILING",
          context: expect.arrayContaining(["Target: UPDATE public.orders"]),
        },
      });
    expect(textPrompts.find((prompt) => prompt.label === "Maximum auto-approved proposals per day"))
      .toMatchObject({
        options: {
          title: "SET POLICY CALENDAR-DAY FALLBACK",
          context: expect.arrayContaining([
            expect.stringContaining("UTC calendar day"),
            expect.stringContaining("not a rolling or action-wide limit"),
            expect.stringContaining("require human review"),
          ]),
        },
      });
    expect(textPrompts.find((prompt) =>
      prompt.label === "Maximum aggregate credit_cents auto-approved per day"))
      .toMatchObject({
        options: {
          title: "SET AGGREGATE CIRCUIT BREAKER",
          context: expect.arrayContaining([
            expect.stringContaining("maximum combined credit_cents"),
          ]),
        },
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
      "At most 3 deterministic approvals for orders.propose_small_credit for each trusted tenant + principal in a rolling 1 hour window.",
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

  it("keeps model-assisted rehearsal in one natural-language exchange", async () => {
    const prompts: string[] = [];
    const prompter = scriptedPrompter({
      choices: [],
      texts: ["Use closed, 750 credits, notifications on, with note reviewed.", ""],
      confirms: [],
      onText: (label) => prompts.push(label),
    });
    const details = {
      draft: {
        capability: "orders.propose_typed_rehearsal",
        operation: "insert",
      },
      preview_args: { status: "open", credit_cents: 100, notify: false, note: "preview" },
      contract: {
        capabilities: [{
          name: "orders.propose_typed_rehearsal",
          subject: { schema: "public", table: "orders" },
          args: {
            status: { type: "string", enum: ["open", "closed"] },
            credit_cents: { type: "number", minimum: 0, maximum: 1000 },
            notify: { type: "boolean" },
            note: { type: "string", max_length: 32 },
          },
        }],
      },
    } as unknown as Parameters<typeof collectGuidedRehearsalArgs>[0];
    const rehearsalInterpreter = vi.fn(async (_input: unknown) => ({
      state: "resolved" as const,
      args: { status: "closed", credit_cents: 750, notify: true, note: "reviewed" },
      summary: [
        'status: "closed"',
        "credit_cents: 750",
        "notify: true",
        'note: "reviewed"',
      ],
      model_message: "I mapped that to closed status, 750 credits, notifications on, and note `reviewed`. Should I run this exact disposable rehearsal?",
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const modelInterview: ActionBoundaryInterviewContext = {
      session: { provider: "openai", model: "gpt-test" },
      egressAcknowledged: true,
      rehearsalInterpreter,
    };

    await expect(collectGuidedRehearsalArgs(details, prompter, modelInterview, {})).resolves.toEqual({
      status: "closed",
      credit_cents: 750,
      notify: true,
      note: "reviewed",
    });
    expect(prompts).toEqual([
      "What example values should I use for the disposable rehearsal?",
      "Press Enter to run this exact disposable rehearsal, or restate the complete example",
    ]);
    expect(rehearsalInterpreter).toHaveBeenCalledWith(expect.objectContaining({
      capability: "orders.propose_typed_rehearsal",
      target: "INSERT public.orders",
      answer: "Use closed, 750 credits, notifications on, with note reviewed.",
      egressAcknowledged: true,
    }));
  });

  it("requires and immediately validates a complete replacement rehearsal example", async () => {
    const prompts: string[] = [];
    const replacement = "Use open, 500 credits, notifications off, with note revised.";
    const prompter = scriptedPrompter({
      choices: [],
      texts: [
        "Use closed, 750 credits, notifications on, with note reviewed.",
        replacement,
        "",
      ],
      confirms: [],
      onText: (label) => prompts.push(label),
    });
    const details = {
      draft: { capability: "orders.propose_typed_rehearsal", operation: "insert" },
      preview_args: { status: "open", credit_cents: 100, notify: false, note: "preview" },
      contract: {
        capabilities: [{
          name: "orders.propose_typed_rehearsal",
          subject: { schema: "public", table: "orders" },
          args: {
            status: { type: "string", enum: ["open", "closed"] },
            credit_cents: { type: "number", minimum: 0, maximum: 1000 },
            notify: { type: "boolean" },
            note: { type: "string", max_length: 32 },
          },
        }],
      },
    } as unknown as Parameters<typeof collectGuidedRehearsalArgs>[0];
    const rehearsalInterpreter = vi.fn(async (input: { answer: string }) => {
      const revised = input.answer === replacement;
      return {
        state: "resolved" as const,
        args: revised
          ? { status: "open", credit_cents: 500, notify: false, note: "revised" }
          : { status: "closed", credit_cents: 750, notify: true, note: "reviewed" },
        summary: revised
          ? ["status: open", "credit_cents: 500", "notify: false", "note: revised"]
          : ["status: closed", "credit_cents: 750", "notify: true", "note: reviewed"],
        correction_used: false,
        authority_granted: false as const,
        source_database_changed: false as const,
      };
    });

    await expect(collectGuidedRehearsalArgs(details, prompter, {
      session: { provider: "openai", model: "gpt-test" },
      egressAcknowledged: true,
      rehearsalInterpreter: rehearsalInterpreter as ActionBoundaryInterviewContext["rehearsalInterpreter"],
    }, {})).resolves.toEqual({
      status: "open",
      credit_cents: 500,
      notify: false,
      note: "revised",
    });
    expect(rehearsalInterpreter).toHaveBeenCalledTimes(2);
    expect(rehearsalInterpreter.mock.calls[1]?.[0]).toMatchObject({ answer: replacement });
    expect(prompts).toEqual([
      "What example values should I use for the disposable rehearsal?",
      "Press Enter to run this exact disposable rehearsal, or restate the complete example",
      "Press Enter to run this exact disposable rehearsal, or restate the complete example",
    ]);
  });

  it("keeps an UPDATE rehearsal identity local while the model interprets other values", async () => {
    const prompter = scriptedPrompter({
      choices: [],
      texts: ["order-1042", "Set the credit to 500.", ""],
      confirms: [],
    });
    const details = {
      draft: { capability: "orders.propose_update_credit", operation: "update" },
      preview_args: { order_id: "replace-with-order-id", credit_cents: 100 },
      contract: {
        capabilities: [{
          name: "orders.propose_update_credit",
          subject: { schema: "public", table: "orders" },
          lookup: { id_from_arg: "order_id" },
          args: {
            order_id: { type: "string", max_length: 128 },
            credit_cents: { type: "number", minimum: 0, maximum: 1000 },
          },
        }],
      },
    } as unknown as Parameters<typeof collectGuidedRehearsalArgs>[0];
    const rehearsalInterpreter = vi.fn(async (_input: unknown) => ({
      state: "resolved" as const,
      args: { credit_cents: 500 },
      summary: ["credit_cents: 500"],
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));

    await expect(collectGuidedRehearsalArgs(details, prompter, {
      session: { provider: "openai", model: "gpt-test" },
      egressAcknowledged: true,
      rehearsalInterpreter,
    }, {})).resolves.toEqual({
      order_id: "order-1042",
      credit_cents: 500,
    });
    expect(rehearsalInterpreter).toHaveBeenCalledWith(expect.objectContaining({
      args: { credit_cents: expect.objectContaining({ type: "number" }) },
      answer: "Set the credit to 500.",
    }));
    const interpreted = rehearsalInterpreter.mock.calls[0]?.[0] as { args?: Record<string, unknown> } | undefined;
    expect(interpreted?.args).not.toHaveProperty("order_id");
  });

  it("resolves a trusted-scope unique UPDATE row without asking for its identity", async () => {
    const prompts: string[] = [];
    const prompter = scriptedPrompter({
      choices: [],
      texts: ["Set the credit to 500.", ""],
      confirms: [],
      onText: (label) => prompts.push(label),
    });
    const details = {
      draft: { capability: "orders.propose_update_credit", operation: "update" },
      preview_args: { order_id: "replace-with-order-id", credit_cents: 100 },
      contract: {
        capabilities: [{
          name: "orders.propose_update_credit",
          subject: { schema: "public", table: "orders" },
          lookup: { id_from_arg: "order_id" },
          args: {
            order_id: { type: "string", max_length: 128 },
            credit_cents: { type: "number", minimum: 0, maximum: 1000 },
          },
        }],
      },
    } as unknown as Parameters<typeof collectGuidedRehearsalArgs>[0];
    const rehearsalInterpreter = vi.fn(async (_input: unknown) => ({
      state: "resolved" as const,
      args: { credit_cents: 500 },
      summary: ["credit_cents: 500"],
      correction_used: false,
      authority_granted: false as const,
      source_database_changed: false as const,
    }));
    const resolver = vi.fn(async () => ({
      state: "resolved" as const,
      mode: "trusted_scope_unique" as const,
      lookup_argument: "order_id",
      value: "order-1042",
      proof: "unique constraint orders_tenant_key (tenant_id)",
    }));

    await expect(collectGuidedRehearsalArgs(details, prompter, {
      session: { provider: "openai", model: "gpt-test" },
      egressAcknowledged: true,
      rehearsalInterpreter,
    }, {}, {
      projectRoot: "/tmp/project",
      inspection: {} as never,
      resolver,
    })).resolves.toEqual({ order_id: "order-1042", credit_cents: 500 });
    expect(prompts).toEqual([
      "What example values should I use for the disposable rehearsal?",
      "Press Enter to run this exact disposable rehearsal, or restate the complete example",
    ]);
    expect(rehearsalInterpreter.mock.calls[0]?.[0]).toMatchObject({
      args: { credit_cents: expect.any(Object) },
    });
    expect(rehearsalInterpreter.mock.calls[0]?.[0]).not.toMatchObject({
      args: { order_id: expect.anything() },
    });
  });

  it("uses reviewed labels for a local non-unique rehearsal picker", async () => {
    const prompter = scriptedPrompter({
      choices: ["candidate:1"],
      texts: [],
      confirms: [],
    });
    const details = {
      draft: { capability: "orders.propose_quick_update", operation: "update" },
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
    const resolver = vi.fn(async () => ({
      state: "selection_required" as const,
      mode: "local_safe_picker" as const,
      lookup_argument: "order_id",
      candidates: [
        { label: "status: open", value: "ord-secret-1" },
        { label: "status: pending", value: "ord-secret-2" },
      ],
      truncated: false,
    }));

    await expect(collectQuickGuidedRehearsalArgs(details, prompter, {
      projectRoot: "/tmp/project",
      inspection: {} as never,
      resolver,
    })).resolves.toEqual({ order_id: "ord-secret-2", credit_cents: 50 });
  });

  it("normalizes a hidden PostgreSQL bigint rehearsal identity to the generated argument type", async () => {
    const prompter = scriptedPrompter({ choices: [], texts: [], confirms: [] });
    const details = {
      draft: { capability: "preferences.propose_quick_update", operation: "update" },
      preview_args: { preference_id: 0, threshold: 15 },
      contract: {
        capabilities: [{
          name: "preferences.propose_quick_update",
          subject: { schema: "public", table: "preferences" },
          lookup: { id_from_arg: "preference_id" },
          args: {
            preference_id: { type: "number" },
            threshold: { type: "number", minimum: 15, maximum: 180 },
          },
        }],
      },
    } as unknown as Parameters<typeof collectQuickGuidedRehearsalArgs>[0];
    const resolver = vi.fn(async () => ({
      state: "resolved" as const,
      mode: "trusted_scope_unique" as const,
      lookup_argument: "preference_id",
      value: "42",
      proof: "unique constraint preferences_scope_key (tenant_id, principal_id)",
    }));

    await expect(collectQuickGuidedRehearsalArgs(details, prompter, {
      projectRoot: "/tmp/project",
      inspection: {} as never,
      resolver,
    })).resolves.toEqual({ preference_id: 42, threshold: 15 });
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
      draft: { capability: "orders.propose_quick_update", operation: "update" },
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
    const textPrompts: Array<{
      label: string;
      options: Parameters<ActionControlPrompter["text"]>[1];
    }> = [];
    const prompter = scriptedPrompter({
      choices: [],
      texts: ["ord-1"],
      confirms: [],
      onText: (label, promptOptions) => textPrompts.push({ label, options: promptOptions }),
    });
    await expect(collectQuickGuidedRehearsalArgs(details, prompter)).resolves.toEqual({
      order_id: "ord-1",
      credit_cents: 50,
    });
    expect(textPrompts).toEqual([{
      label: "Existing order_id value (advanced)",
      options: {
        title: "ENTER LOCAL ROW ID",
        context: expect.arrayContaining([
          "Target: UPDATE public.orders",
          "Local-only argument: order_id",
          expect.stringContaining("trusted tenant/principal scope"),
        ]),
      },
    }]);
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

  it("labels unread proposal values without conflating them with null or unset", async () => {
    const pending = proposalDetail("pending_review");
    const changeSet = pending.proposal.change_set as unknown as {
      patch: Record<string, unknown>;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    changeSet.patch = { base_monthly_cents: 4500, nullable_note: "ignored patch fallback" };
    changeSet.before = { version: 4, nullable_note: null };
    changeSet.after = { base_monthly_cents: 4500, nullable_note: null };
    const operatorService: ActionOperatorService = {
      async identityPosture() { return { provider: "dev_env", apply_roles: [] }; },
      async list() { return [{
        proposal_id: pending.proposal.proposal_id, proposal_hash: pending.proposal.proposal_hash,
        capability: pending.proposal.action, state: pending.proposal.state,
        business_object: pending.proposal.business_object, object_id: pending.proposal.object_id,
        writeback_mode: "read_only", source_database_mutated: false,
        created_at: pending.proposal.created_at, updated_at: pending.proposal.updated_at,
      }]; },
      async count() { return 1; },
      async page() { return { total: 1, items: await this.list() }; },
      async detail() { return pending; },
      async approve() { throw new Error("not expected"); },
      async reject() { throw new Error("not expected"); },
      async apply() { throw new Error("not expected"); },
      async replay() { throw new Error("not expected"); },
    };
    const prompter = scriptedPrompter({
      choices: [`proposal:${pending.proposal.proposal_id}`, "back", "back"], texts: [], confirms: [],
      onChoose(title, _choices, context) {
        if (title !== "PROPOSAL REVIEW") return;
        expect(context).toContain("  base_monthly_cents: not observed (not read) -> 4500");
        expect(context).toContain("  nullable_note: null -> null");
        expect(context?.join("\n")).not.toContain("not set -> 4500");
      },
    });

    await reviewActionProposalInbox({ operatorService, prompter, env: {} });
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

  it("renders every sequential manual review summary before accepting its typed input", async () => {
    const terminal = fakeTerminal(72, 12);
    const prompter = createTerminalActionPrompter(terminal.input, terminal.output);
    const summaries = [
      ["Eligibility summary", "The appointment is confirmed."],
      ["Proposal summary", "Propose updating reminder hours."],
      ["Refusal summary", "Refuse values outside the reviewed range."],
      ["Human review summary", "Requests above the automatic threshold require human review."],
    ] as const;

    for (const [label, answer] of summaries) {
      const pending = prompter.text(label, {
        title: "MANUAL SEMANTIC ACTIONRULE",
        context: ["State the reviewed business result."],
      });
      await nextTurn();
      const frame = stripAnsi(terminal.output.read()?.toString() ?? "");
      expect(frame).toContain("MANUAL SEMANTIC ACTIONRULE");
      expect(frame).toContain(label);
      expect(frame).toContain("State the reviewed business result.");

      terminal.input.write(`${answer}\n`);
      await expect(pending).resolves.toBe(answer);
      expect(terminal.input.isRaw).toBe(false);
    }
  });

  it("lets Q select a visible Quit action without walking the menu", async () => {
    const terminal = fakeTerminal(72, 12);
    const prompter = createTerminalActionPrompter(terminal.input, terminal.output);
    const selection = prompter.choose("ACTION BOUNDARY", [
      { value: "review", label: "Review Action Boundary" },
      { value: "quit", label: "Quit" },
    ]);

    await nextTurn();
    const frame = stripAnsi(terminal.output.read()?.toString() ?? "");
    expect(frame).toContain("Q Quit");
    await emitKey(terminal.input, { name: "q", sequence: "q" });
    await expect(selection).resolves.toBe("quit");
    expect(terminal.input.isRaw).toBe(false);
  });

  it("keeps a colored action and policy explanation above line input", async () => {
    vi.stubEnv("NO_COLOR", "");
    const terminal = fakeTerminal(80, 14);
    const prompter = createTerminalActionPrompter(terminal.input, terminal.output);
    const text = prompter.text("Maximum approvals in the rolling window", {
      defaultValue: "3",
      title: "SET TRUSTED-SCOPE APPROVAL LIMIT",
      context: [
        "Action: INSERT renewable_ops.maintenance_requests",
        "Selected scope: each trusted tenant + principal.",
        "Enter the count ceiling now; choose the rolling time window next.",
      ],
    });

    await nextTurn();
    const rendered = terminal.output.read()?.toString() ?? "";
    expect(rendered).toContain("\u001b[1;36m  SET TRUSTED-SCOPE APPROVAL LIMIT\u001b[0m");
    expect(stripAnsi(rendered)).toContain("Action: INSERT renewable_ops.maintenance_requests");
    expect(stripAnsi(rendered)).toContain("Maximum approvals in the rolling window [3] [Esc Back]:");

    terminal.input.write("5\n");
    await expect(text).resolves.toBe("5");
    expect(terminal.input.isRaw).toBe(false);

    const confirmation = prompter.choose("CONFIRM INTERPRETED DECISION", [
      { value: "confirm", label: "Confirm this exact reviewed value" },
    ], [
      "You said: Between five minutes and two hours.",
      "Runner-validated interpretation: estimated_minutes: 5 through 120",
      "Authority granted: no | source database changed: no",
    ], "confirm");
    await nextTurn();
    const confirmationFrame = terminal.output.read()?.toString() ?? "";
    expect(confirmationFrame).toContain("\u001b[1;32mestimated_minutes: 5 through 120\u001b[0m");
    await emitKey(terminal.input, { name: "escape", sequence: "\u001b" });
    await expect(confirmation).resolves.toBeUndefined();
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
  onText?: (
    label: string,
    options?: Parameters<ActionControlPrompter["text"]>[1],
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
    async text(label, options) {
      input.onText?.(label, options);
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
