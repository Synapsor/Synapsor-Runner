import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { describe, expect, it } from "vitest";
import {
  createBoundaryReviewInteractiveSession,
  formatBoundaryOverviewMap,
  formatBoundaryResourceMap,
  packTerminalActions,
  terminalTheme,
  type BoundaryFieldTier,
} from "./boundary-cli-picker.js";
import type {
  BoundaryResourceReviewSummary,
  BoundaryResourceReviewView,
} from "./boundary-review-mutation.js";

describe("boundary review terminal picker", () => {
  it("uses Escape as immediate back for text and confirmation prompts", async () => {
    const textTerminal = fakeTerminal();
    const textSession = createBoundaryReviewInteractiveSession(
      textTerminal.input,
      textTerminal.output,
    );
    const text = textSession.promptText("New boundary name: ");
    await emitKey(textTerminal.input, { name: "escape", sequence: "\u001b" });
    await expect(text).resolves.toBeUndefined();
    const textOutput = textTerminal.output.read()?.toString() ?? "";
    expect(textOutput).toContain("  New boundary name");
    expect(textOutput).toContain("[Esc Back]");

    const confirmTerminal = fakeTerminal();
    const confirmSession = createBoundaryReviewInteractiveSession(
      confirmTerminal.input,
      confirmTerminal.output,
    );
    const confirmed = confirmSession.confirm("Activate this boundary?", {
      defaultValue: true,
    });
    await emitKey(confirmTerminal.input, { name: "escape", sequence: "\u001b" });
    await expect(confirmed).resolves.toBeUndefined();
    const confirmationOutput = confirmTerminal.output.read()?.toString() ?? "";
    expect(confirmationOutput).toContain("[Y/n]");
    expect(confirmationOutput).toContain("[Esc Back]");
  });

  it("treats terminal EOF as a safe cancellation for text and raw-key prompts", async () => {
    const textTerminal = fakeTerminal();
    const textSession = createBoundaryReviewInteractiveSession(
      textTerminal.input,
      textTerminal.output,
    );
    const text = textSession.promptText("New boundary name: ");
    (textTerminal.input as unknown as PassThrough).end();
    await expect(text).resolves.toBeUndefined();

    const pickerTerminal = fakeTerminal();
    const pickerSession = createBoundaryReviewInteractiveSession(
      pickerTerminal.input,
      pickerTerminal.output,
    );
    const selection = pickerSession.chooseResource(
      [summary("public.orders", 0)],
      {
        confirmed_decisions: 1,
        outstanding_decisions: 0,
        outstanding_resource_decisions: 0,
        outstanding_boundary_decisions: 0,
        resources_requiring_signoff: 0,
      },
    );
    (pickerTerminal.input as unknown as PassThrough).end();
    await expect(selection).resolves.toBeUndefined();
    expect(pickerTerminal.input.isRaw).toBe(false);
  });

  it("keeps ordinary text and Enter defaults distinct from Escape", async () => {
    const textTerminal = fakeTerminal();
    const textSession = createBoundaryReviewInteractiveSession(
      textTerminal.input,
      textTerminal.output,
    );
    const text = textSession.promptText("New boundary name: ");
    await send(textTerminal.input, "billing_analytics\n");
    await expect(text).resolves.toBe("billing_analytics");

    const confirmTerminal = fakeTerminal();
    const confirmSession = createBoundaryReviewInteractiveSession(
      confirmTerminal.input,
      confirmTerminal.output,
    );
    const confirmed = confirmSession.confirm("Activate this boundary?", {
      defaultValue: true,
    });
    await send(confirmTerminal.input, "\n");
    await expect(confirmed).resolves.toBe(true);
  });

  it("keeps a multiline review explanation above a short visible text-entry line", async () => {
    const terminal = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(terminal.input, terminal.output);
    const answer = session.promptText([
      "SHARED REFERENCE REVIEW",
      "Table: public.lab_catalog",
      "Explain why this table contains the same rows for every tenant.",
      "A concrete reason is required; Enter alone does not save.",
      "Required reason",
    ].join("\n"));

    await send(terminal.input, "Centrally managed reference data.\n");
    await expect(answer).resolves.toBe("Centrally managed reference data.");

    const rendered = stripAnsi(terminal.output.read()?.toString() ?? "");
    expect(rendered).toContain("  SHARED REFERENCE REVIEW\n");
    expect(rendered).toContain("  Table: public.lab_catalog\n");
    expect(rendered).toContain("  Required reason [Esc Back]: ");
    expect(terminal.input.isRaw).toBe(false);
  });

  it("requires an explicit activation key and restores terminal state", async () => {
    const acceptedTerminal = fakeTerminal();
    const acceptedSession = createBoundaryReviewInteractiveSession(
      acceptedTerminal.input,
      acceptedTerminal.output,
    );
    const accepted = acceptedSession.confirmActivation!("Activate reviewed access?");
    await send(acceptedTerminal.input, "\r");
    expect(stripAnsi(acceptedTerminal.output.read()?.toString() ?? ""))
      .toContain("Enter alone does not activate");
    await send(acceptedTerminal.input, "y");
    await expect(accepted).resolves.toBe(true);
    expect(acceptedTerminal.input.isRaw).toBe(false);

    const declinedTerminal = fakeTerminal();
    const declinedSession = createBoundaryReviewInteractiveSession(
      declinedTerminal.input,
      declinedTerminal.output,
    );
    const declined = declinedSession.confirmActivation!("Activate reviewed access?");
    await send(declinedTerminal.input, "n");
    await expect(declined).resolves.toBe(false);
    expect(declinedTerminal.input.isRaw).toBe(false);

    const cancelledTerminal = fakeTerminal();
    const cancelledSession = createBoundaryReviewInteractiveSession(
      cancelledTerminal.input,
      cancelledTerminal.output,
    );
    const cancelled = cancelledSession.confirmActivation!("Activate reviewed access?");
    await emitKey(cancelledTerminal.input, { name: "d", sequence: "\u0004", ctrl: true });
    await expect(cancelled).resolves.toBeUndefined();
    expect(cancelledTerminal.input.isRaw).toBe(false);
  });

  it("explains why a nullable tenant relationship cannot make a blocked table addable", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const view = reviewView();
    view.resource_id = "public.abandoned_carts";
    view.status = "blocked";
    view.tenant_key = {
      candidates: [],
      evidence: [],
      alternatives_considered: [],
      confidence: "low",
      confirmation_required: true,
      safety_consequence: "Rows cannot be tenant scoped.",
      blocked_reason: "no reviewed tenant column is available",
    };
    view.derived_tenant_scope = {
      candidates: [],
      confirmation_required: true,
      safety_consequence: "No proven path is available.",
    };
    view.shared_reference_scope = {
      eligible: false,
      confirmation_required: true,
      safety_consequence: "Shared rows require review.",
      blockers: [
        "relationship abandoned_carts_order_id_fkey reaches tenant-scoped resource public.orders",
      ],
    };
    view.relationships = [{
      name: "abandoned_carts_order_id_fkey",
      columns: ["order_id"],
      referenced_resource: "public.orders",
      referenced_columns: ["id"],
      reviewed_cardinality: "many_to_one_candidate",
      review_required: true,
      nullable: true,
      cardinality_proven: true,
    }];

    const result = session.resolveBlockedResource!(view);
    const rendered = stripAnsi(output.read()?.toString() ?? "");
    expect(rendered).toContain("Why tenant isolation is unavailable");
    expect(rendered).toContain("order_id -> public.orders.id is nullable");
    expect(rendered).toContain("relationship abandoned_carts_order_id_fkey reaches");
    expect(rendered).toContain("tenant-scoped resource public.orders");
    expect(rendered).toContain("What makes this table addable");
    expect(rendered).toContain("public.abandoned_carts.order_id NOT NULL");
    expect(rendered).toContain("Runner will not change the database schema for you.");
    await send(input, "b");
    await expect(result).resolves.toBe("back");
  });

  it("labels a fully reviewed candidate as reviewed but not active", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const selected = session.chooseResource(
      [summary("public.ready", 0)],
      {
        confirmed_decisions: 6,
        outstanding_decisions: 0,
        outstanding_resource_decisions: 0,
        outstanding_boundary_decisions: 0,
        resources_requiring_signoff: 0,
      },
    );
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("REVIEWED - NOT ACTIVE");
    expect(rendered).toContain("Complete");
    expect(rendered).not.toContain("DRAFT - NO ACCESS");
    await send(input, "q");
    await expect(selected).resolves.toBeUndefined();
  });

  it("opens Start and Ask access editing directly at tables and columns", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const included = summary("public.check_ins", 1);
    included.relationships = [{
      relationship_id: "check_ins_member_id_fkey",
      target_resource: "public.members",
      path_depth: 1,
      state: "available",
    }];
    const available = summary("public.members", 0);
    available.included = false;
    const selected = session.chooseResource(
      [included, available],
      undefined,
      { initialView: "access" },
    );
    const firstView = output.read()?.toString() ?? "";
    const firstViewPlain = stripAnsi(firstView);
    expect(firstViewPlain).toContain("EDIT ACCESS - reviewed_staging");
    expect(firstViewPlain).toContain("TABLES IN THIS BOUNDARY");
    expect(firstViewPlain).toContain(
      "Enter edits columns. A shows tables with proven paths into this boundary.",
    );
    expect(firstViewPlain).toContain("FINAL REVIEW PENDING");
    expect(firstViewPlain).toContain("[draft changed - activate to use]");
    expect(firstViewPlain).toContain("No separate table sign-off.");
    expect(firstViewPlain).toContain("B/Esc Boundary overview");
    expect(firstViewPlain).toContain("A Add related tables");
    expect(firstViewPlain).toContain("SELECTED TABLE");
    expect(firstViewPlain).toContain("BOUNDARY");
    expect(firstViewPlain).toContain("C Review + activate");
    expect(firstViewPlain).toContain("L Ranked limits");
    expect(firstViewPlain).not.toContain("BOUNDARIES");
    expect(firstViewPlain).not.toContain("One S sign-off records");
    expect(firstViewPlain).not.toContain("[table sign-off needed]");

    await send(input, "a");
    await send(input, "\u001b[B");
    await send(input, "\r");
    await expect(selected).resolves.toEqual({
      resource_id: "public.members",
      action: "add",
    });
    const rendered = output.read()?.toString() ?? "";
    const renderedPlain = stripAnsi(rendered);
    expect(renderedPlain).toContain("ADD RELATED TABLES (1)");
    expect(renderedPlain).toContain("[linked to public.check_ins]");
    expect(renderedPlain).toContain("check_ins_member_id_fkey");
    expect(renderedPlain).toContain("B/Esc Boundary tables");
    expect(renderedPlain).toContain("Tab All inspected tables");
  });

  it("opens shell access management at the boundary list and exposes selected-table privacy", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const resource = summary("public.equipment", 0);
    resource.minimum_cohort_size = 5;
    const selected = session.chooseResource(
      [resource],
      undefined,
      { initialView: "access", startAtBoundaryList: true },
    );
    const firstView = output.read()?.toString() ?? "";
    expect(firstView).toContain("YOUR DATA BOUNDARY");
    expect(firstView).not.toContain("TABLES IN THIS BOUNDARY");

    await send(input, "e");
    await send(input, "p");
    await expect(selected).resolves.toEqual({
      resource_id: "public.equipment",
      action: "privacy",
    });
    const tableView = output.read()?.toString() ?? "";
    expect(tableView).toContain("P");
    expect(tableView).toContain("Privacy (minimum group 5)");
    expect(tableView).toContain("minimum group 5");
  });

  it("makes fixed reviewed analytics available for the selected included table", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const selected = session.chooseResource(
      [summary("public.orders", 0)],
      undefined,
      { initialView: "access" },
    );
    const rendered = stripAnsi(output.read()?.toString() ?? "");
    expect(rendered).toContain("G Reviewed metrics and numeric bands");
    await send(input, "g");
    await expect(selected).resolves.toEqual({
      resource_id: "public.orders",
      action: "analytics",
    });
  });

  it("makes reviewed table metadata a first-class focused-access action", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const selected = session.chooseResource(
      [summary("public.orders", 0)],
      undefined,
      { initialView: "access" },
    );
    expect(stripAnsi(output.read()?.toString() ?? ""))
      .toContain("I Table label and description");
    await send(input, "i");
    await expect(selected).resolves.toEqual({
      resource_id: "public.orders",
      action: "metadata",
    });
  });

  it("keeps focused access tables alphabetical and restores the highlighted table", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const invoices = summary("public.invoices", 1);
    invoices.active = true;
    const accounts = summary("public.accounts", 0);
    accounts.active = true;
    const subscriptions = summary("public.subscriptions", 0);
    subscriptions.active = true;
    const selected = session.chooseResource(
      [invoices, accounts, subscriptions],
      undefined,
      {
        initialView: "access",
        initialResourceId: "public.invoices",
      },
    );
    const rendered = stripAnsi(output.read()?.toString() ?? "");
    expect(rendered.indexOf("public.accounts")).toBeLessThan(rendered.indexOf("public.invoices"));
    expect(rendered.indexOf("public.invoices")).toBeLessThan(rendered.indexOf("public.subscriptions"));
    expect(rendered).toContain("> public.invoices");

    await send(input, "p");
    await expect(selected).resolves.toEqual({
      resource_id: "public.invoices",
      action: "privacy",
    });
  });

  it("keeps table and boundary actions readable in a narrow terminal", async () => {
    const { input, output } = fakeTerminal();
    Object.assign(output, { columns: 58 });
    const session = createBoundaryReviewInteractiveSession(input, output);
    const resource = summary("public.equipment", 0);
    resource.minimum_cohort_size = 5;
    const selected = session.chooseResource(
      [resource],
      undefined,
      { initialView: "access" },
    );
    const rendered = stripAnsi(output.read()?.toString() ?? "");
    expect(rendered).toContain("SELECTED TABLE");
    expect(rendered).toContain("Enter Edit columns");
    expect(rendered).toContain("P Privacy (minimum group 5)");
    expect(rendered).toContain("BOUNDARY");
    expect(rendered).toContain("B/Esc Boundary overview");
    expect(rendered).toContain("L Ranked limits");
    expect(rendered).toContain("C Review + activate");

    await send(input, "q");
    await expect(selected).resolves.toBeUndefined();
  });

  it("returns from focused access to the boundary overview instead of quitting", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const selected = session.chooseResource(
      [summary("public.check_ins", 1)],
      undefined,
      { initialView: "access" },
    );
    output.read();

    await emitKey(input, { sequence: "\u001b" });
    await send(input, "c");

    await expect(selected).resolves.toEqual({ action: "confirm" });
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("YOUR DATA BOUNDARY");
    expect(rendered).toContain("NAME");
    expect(rendered).toContain("AI ACCESS");
    expect(rendered).toContain("reviewed_staging");
    expect(rendered).toContain("NOT ACTIVE");
    expect(rendered).not.toContain("Active   -");
    expect(rendered).not.toContain("> Next");
    expect(rendered).toContain("Enter");
    expect(rendered).toContain("Enter/C Review + activate");
    expect(rendered).toContain("Activation returns here so you can keep editing");
    expect(rendered).toContain("Press Q when finished to choose how to ask");
  });

  it("uses arrow-key resource selection without changing risk-first order", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const resources: BoundaryResourceReviewSummary[] = [
      summary("public.high_risk", 3),
      summary("public.medium_risk", 1),
      summary("public.ready", 0),
      ...Array.from({ length: 9 }, (_, index) =>
        summary(`public.extra_${String(index + 1).padStart(2, "0")}`, 0)),
    ];
    const selected = session.chooseResource(resources);
    const firstView = output.read()?.toString() ?? "";
    const firstViewPlain = stripAnsi(firstView);
    expect(firstViewPlain).toContain("BOUNDARIES");
    expect(firstViewPlain).toContain("NAME");
    expect(firstViewPlain).toContain("STATUS");
    expect(firstViewPlain).toContain("TABLES");
    expect(firstViewPlain).toContain("AUTHORITY");
    expect(firstViewPlain).toContain("reviewed_staging");
    expect(firstViewPlain).toContain("DRAFT - NO ACCESS");
    expect(firstViewPlain).toContain("A New boundary");
    expect(firstViewPlain).toContain("P Privacy for all tables");
    expect(firstViewPlain).toContain("C Complete review");
    expect(firstViewPlain).not.toContain("public.high_risk");

    await send(input, "\r");
    await send(input, "\u001b[B");
    await send(input, "\r");
    await expect(selected).resolves.toEqual({
      resource_id: "public.medium_risk",
      action: "review",
    });
    const rendered = output.read()?.toString() ?? "";
    const renderedPlain = stripAnsi(rendered);
    expect(renderedPlain).toContain("reviewed_staging");
    expect(renderedPlain).toContain("DRAFT - NO ACCESS");
    expect(renderedPlain).toContain("TABLES");
    expect(renderedPlain).toContain("P Explain what this table sign-off covers");
    expect(renderedPlain).toContain("[table sign-off needed]");
    expect(renderedPlain).toContain("One S sign-off records 3 exact decisions together.");
    expect(renderedPlain).toContain("Esc");
    expect(renderedPlain).toContain("Boundaries");
    expect(renderedPlain.indexOf("public.high_risk")).toBeLessThan(
      renderedPlain.indexOf("public.medium_risk"),
    );
    expect(renderedPlain).toContain("shows 2 more tables below");
  });

  it("makes the reviewed ranked-aggregate ceiling discoverable at boundary level", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const selected = session.chooseResource([summary("public.orders", 0)]);
    const firstView = output.read()?.toString() ?? "";
    expect(stripAnsi(firstView)).toContain("L Ranked limit");
    await send(input, "l");
    await expect(selected).resolves.toEqual({ action: "limits" });
  });

  it("opens one boundary-wide privacy action from the boundary list", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const selected = session.chooseResource(
      [summary("public.orders", 0)],
      undefined,
      { initialView: "access", startAtBoundaryList: true },
    );
    expect(stripAnsi(output.read()?.toString() ?? "")).toContain("P Privacy for all tables");
    await send(input, "p");
    await expect(selected).resolves.toEqual({ action: "privacy_all" });
  });

  it("keeps an active boundary's disabled edits visibly pending", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const resource = summary("public.orders", 0);
    resource.active = true;
    resource.active_boundary_name = "reviewed_staging";
    const selected = session.chooseResource(
      [resource],
      {
        confirmed_decisions: 6,
        outstanding_decisions: 0,
        outstanding_resource_decisions: 0,
        outstanding_boundary_decisions: 0,
        resources_requiring_signoff: 0,
        boundaries: [{
          name: "reviewed_staging",
          selected: true,
          active: true,
          matches_active_digest: false,
          table_count: 1,
          outstanding_decisions: 0,
        }],
      },
      { initialView: "access", startAtBoundaryList: true },
    );
    const first = stripAnsi(output.read()?.toString() ?? "");
    expect(first).toContain("ACTIVE + DRAFT EDITS");
    expect(first).toContain("1 PENDING BOUNDARY CHANGE IS NOT ACTIVE");
    expect(first).toContain("C reviews and activates the exact disabled update");
    await send(input, "q");
    await expect(selected).resolves.toBeUndefined();
  });

  it("explains an isolated legacy policy review without assigning global settings", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const resource = summary("public.orders", 0);
    resource.active = true;
    resource.active_boundary_name = "reviewed_staging";
    const selected = session.chooseResource(
      [resource],
      {
        confirmed_decisions: 6,
        outstanding_decisions: 0,
        outstanding_resource_decisions: 0,
        outstanding_boundary_decisions: 0,
        resources_requiring_signoff: 0,
        boundaries: [{
          name: "reviewed_staging",
          selected: true,
          active: true,
          matches_active_digest: true,
          table_count: 1,
          outstanding_decisions: 1,
          policy_review_required: true,
        }],
      },
      { initialView: "access", startAtBoundaryList: true },
    );
    const first = stripAnsi(output.read()?.toString() ?? "");
    expect(first).toContain("LEGACY BOUNDARY POLICY NEEDS REVIEW");
    expect(first).toContain("preserved this boundary's exact revision");
    expect(first).toContain("did not assign the old project-wide");
    expect(first).toContain("settings to it");
    await send(input, "q");
    await expect(selected).resolves.toBeUndefined();
  });

  it("starts with boundary tables and opens proven relationship candidates in place", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const candidate = summary("public.check_ins", 6);
    candidate.pending_decisions = [
      "public.check_ins: confirm filter/sort/group/aggregate-only field permissions",
      "public.check_ins: confirm minimum cohort and extraction/differencing budgets",
      "public.check_ins: confirm principal scope assigned_agent_id",
      "public.check_ins: confirm tenant key organization_id",
      "public.check_ins: confirm visible and kept-out fields",
      "public.check_ins: review relationship check_ins_location_id_fkey cardinality and scope on public.locations",
    ];
    candidate.relationships = [{
      relationship_id: "check_ins_member_id_fkey",
      target_resource: "public.members",
      path_depth: 1,
      state: "available",
    }];
    const available = summary("public.members", 0);
    available.included = false;
    const selected = session.chooseResource([candidate, available]);

    await send(input, "\r");
    await send(input, "p");
    await send(input, "p");
    await send(input, "a");
    await send(input, "\u001b[B");
    await send(input, "\r");

    await expect(selected).resolves.toEqual({
      resource_id: "public.members",
      action: "add",
    });
    const rendered = output.read()?.toString() ?? "";
    const renderedPlain = stripAnsi(rendered);
    expect(renderedPlain).toContain("TABLES");
    expect(renderedPlain).toContain("A");
    expect(renderedPlain).toContain("Add related tables");
    expect(renderedPlain).toContain("ADD RELATED TABLES (1)");
    expect(renderedPlain).toContain("Proven path: public.check_ins -> public.members");
    expect(renderedPlain).toContain("TABLE SIGN-OFF DETAILS - public.check_ins");
    expect(renderedPlain).toContain(
      "not separate prompts.",
    );
    expect(renderedPlain).toContain("1. Allowed operations");
    expect(renderedPlain).toContain("2. Privacy limits");
    expect(renderedPlain).toContain("3. User row scope: assigned_agent_id");
    expect(renderedPlain).toContain("4. Customer row scope: organization_id");
    expect(renderedPlain).toContain("5. Column access");
    expect(renderedPlain).toContain("6. Related-table path: public.locations");
    expect(renderedPlain).toContain(
      "One S sign-off records all 6 exact decisions above.",
    );
  });

  it("keeps unrelated tables out of Add until the operator explicitly opens all inspected tables", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const included = summary("public.check_ins", 1);
    included.relationships = [{
      relationship_id: "check_ins_location_id_fkey",
      target_resource: "public.locations",
      path_depth: 1,
      state: "available",
    }];
    const related = summary("public.locations", 0);
    related.included = false;
    const unrelated = summary("public.invoices", 0);
    unrelated.included = false;
    const selected = session.chooseResource(
      [included, related, unrelated],
      undefined,
      { initialView: "access" },
    );
    output.read();

    await send(input, "a");
    const relatedView = output.read()?.toString() ?? "";
    const relatedViewPlain = stripAnsi(relatedView);
    expect(relatedViewPlain).toContain("ADD RELATED TABLES (1)");
    expect(relatedViewPlain).toContain("public.locations");
    expect(relatedViewPlain).not.toContain("public.invoices");

    await send(input, "\t");
    const allView = output.read()?.toString() ?? "";
    const allViewPlain = stripAnsi(allView);
    expect(allViewPlain).toContain("ALL INSPECTED TABLES (2 available to add)");
    expect(allViewPlain).toContain("public.locations");
    expect(allViewPlain).toContain("public.invoices");
    expect(allViewPlain).toContain("Tab Related tables only");

    await send(input, "b");
    await send(input, "q");
    await expect(selected).resolves.toBeUndefined();
  });

  it("shows only continuous derived-scope children in Add related tables", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const orders = summary("public.orders", 0);
    const invoices = summary("public.invoices", 0);
    invoices.included = false;
    invoices.relationships = [{
      relationship_id: "invoices_order_id_fkey",
      target_resource: "public.orders",
      path_depth: 1,
      state: "available",
    }];
    const orderItems = summary("public.order_items", 0);
    orderItems.included = false;
    orderItems.relationships = [{
      relationship_id: "order_items_order_id_fkey",
      target_resource: "public.orders",
      path_depth: 1,
      state: "available",
    }];
    orderItems.derived_tenant_scope = derivedScopeInference(
      oneHopDerivedScope("public.order_items", "public.orders", "order_items_order_id_fkey"),
    );
    const orderItemEvents = summary("public.order_item_events", 0);
    orderItemEvents.included = false;
    orderItemEvents.derived_tenant_scope = derivedScopeInference(twoHopDerivedScope());
    const abandonedCarts = summary("public.abandoned_carts", 0);
    abandonedCarts.included = false;
    abandonedCarts.derived_tenant_scope = derivedScopeInference(
      oneHopDerivedScope(
        "public.abandoned_carts",
        "public.orders",
        "abandoned_carts_order_id_fkey",
        true,
      ),
    );
    const unrelated = summary("public.product_catalog", 0);
    unrelated.included = false;
    const selected = session.chooseResource([
      orders,
      invoices,
      orderItems,
      orderItemEvents,
      abandonedCarts,
      unrelated,
    ], undefined, { initialView: "access" });
    output.read();

    await send(input, "a");
    const related = stripAnsi(output.read()?.toString() ?? "");
    expect(related).toContain("ADD RELATED TABLES (2)");
    expect(related).toContain("public.invoices");
    expect(related).toContain("public.order_items");
    expect(related).not.toContain("public.order_item_events");
    expect(related).not.toContain("public.abandoned_carts");
    expect(related).not.toContain("public.product_catalog");

    await send(input, "\u001b[B");
    const derived = stripAnsi(output.read()?.toString() ?? "");
    expect(derived).toContain("[linked to public.orders]");
    expect(derived).toContain("Derived tenant scope: order_items -> orders.tenant_id");
    expect(derived).toContain("Exact path ID: order_items_order_id_fkey");
    expect(derived).not.toContain("Proven path: public.order_items -> public.orders");
    await send(input, "\r");
    await expect(selected).resolves.toEqual({
      resource_id: "public.order_items",
      action: "add",
    });
  });

  it("shows a two-hop derived child only after its intermediate table is in the boundary", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const orders = summary("public.orders", 0);
    const orderItems = summary("public.order_items", 0);
    orderItems.derived_tenant_scope = derivedScopeInference(
      oneHopDerivedScope("public.order_items", "public.orders", "order_items_order_id_fkey"),
    );
    const orderItemEvents = summary("public.order_item_events", 0);
    orderItemEvents.included = false;
    orderItemEvents.derived_tenant_scope = derivedScopeInference(twoHopDerivedScope());
    const selected = session.chooseResource(
      [orders, orderItems, orderItemEvents],
      undefined,
      { initialView: "access" },
    );
    output.read();

    await send(input, "a");
    const related = stripAnsi(output.read()?.toString() ?? "");
    expect(related).toContain("ADD RELATED TABLES (1)");
    expect(related).toContain("public.order_item_events");
    expect(related).toContain("[linked to public.orders]");
    expect(related).toContain(
      "Derived tenant scope: order_item_events -> order_items -> orders.tenant_id",
    );
    await send(input, "\r");
    await expect(selected).resolves.toEqual({
      resource_id: "public.order_item_events",
      action: "add",
    });
  });

  it("exposes boundary naming as a first-class action", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const selected = session.chooseResource([summary("public.check_ins", 1)]);
    await send(input, "n");
    await expect(selected).resolves.toEqual({ action: "rename" });
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("reviewed_staging");
    expect(rendered).toContain("DRAFT - NO ACCESS");
    expect(rendered).toContain("N");
    expect(rendered).toContain("Rename");
  });

  it("chooses a new boundary's first table without inheriting an existing table", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const first = summary("public.check_ins", 0);
    const second = summary("public.organizations", 0);
    first.included = false;
    second.included = false;
    const selected = session.chooseResource(
      [first, second],
      undefined,
      { initialView: "access", startingBoundaryName: "organization_analytics" },
    );
    const firstView = output.read()?.toString() ?? "";
    expect(firstView).toContain("CHOOSE FIRST TABLE - organization_analytics");
    expect(firstView).toContain("Nothing is copied from another boundary.");
    expect(firstView).toContain("public.check_ins");
    expect(firstView).toContain("public.organizations");

    await send(input, "\u001b[B");
    await send(input, "\r");
    await expect(selected).resolves.toEqual({
      resource_id: "public.organizations",
      action: "add",
    });
  });

  it("accounts for every inspected table and explains unavailable starting tables", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const eligible = summary("public.orders", 0);
    const unavailable = summary("public.audit_log", 0);
    eligible.included = false;
    unavailable.included = false;
    unavailable.status = "blocked_identifier";
    unavailable.blockers = ["No proven single-column record identity."];
    const selected = session.chooseResource(
      [eligible, unavailable],
      undefined,
      { initialView: "access", startingBoundaryName: "sales" },
    );

    await send(input, "\u001b[B");
    await send(input, "\r");
    await send(input, "\u001b[A");
    await send(input, "\r");

    await expect(selected).resolves.toEqual({
      resource_id: "public.orders",
      action: "add",
    });
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("public.audit_log");
    expect(rendered).toContain("UNAVAILABLE");
    expect(rendered).toContain("Inspected tables: 2 total · 1 can start · 0 add after ancestor · 1 unavailable.");
    expect(rendered).toContain("public.audit_log cannot start a boundary");
  });

  it("blocks a derived-only table before first-table structural review", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const derived = summary("public.order_items", 0);
    derived.included = false;
    derived.first_table_startable = false;
    derived.first_table_guidance = "start with public.orders, then add this table";
    derived.first_table_scope_label = "order_items -> orders.tenant_id";
    const ancestor = summary("public.orders", 0);
    ancestor.included = false;
    ancestor.first_table_startable = true;
    const selected = session.chooseResource(
      [derived, ancestor],
      undefined,
      { initialView: "access", startingBoundaryName: "sales" },
    );

    await send(input, "\r");
    await send(input, "\u001b[B");
    await send(input, "\r");
    await expect(selected).resolves.toEqual({ resource_id: "public.orders", action: "add" });
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("START FROM ANCESTOR");
    expect(rendered).toContain("1 can start · 1 add after ancestor · 0 unavailable");
    expect(rendered).toContain("public.order_items cannot be the first table");
    expect(rendered).toContain("order_items -> orders.tenant_id");
  });

  it("uses colored selected text instead of inverse-video highlighting", () => {
    const selected = terminalTheme(true).focus("> public.check_ins");
    expect(selected).toContain("\u001b[1;96m");
    expect(selected).not.toContain("\u001b[7m");
    expect(terminalTheme(false).focus("> public.check_ins")).toBe("> public.check_ins");
  });

  it("makes Enter save a disabled-draft decision when the caller selects default yes", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const confirmed = session.confirm(
      "Save this disabled review decision now?",
      { defaultValue: true },
    );
    await send(input, "\r");
    await expect(confirmed).resolves.toBe(true);
    expect(output.read()?.toString() ?? "").toContain("[Y/n]");
  });

  it("exposes active Explore disable from the same boundary lifecycle menu", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const active = summary("public.check_ins", 1);
    active.active = true;
    active.active_boundary_name = active.candidate_boundary_name;
    const selected = session.chooseResource([active]);
    await send(input, "d");
    await expect(selected).resolves.toEqual({
      action: "disable",
      boundary_name: "reviewed_staging",
    });
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("D");
    expect(rendered).toContain("Deactivate");
  });

  it("keeps hidden deactivate keys inert in the table editor and distinguishes draft removal", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const active = summary("public.check_ins", 0);
    active.active = true;
    active.active_boundary_name = active.candidate_boundary_name;
    const selected = session.chooseResource([active], undefined, {
      initialView: "access",
      startAtBoundaryList: false,
    });
    await send(input, "d");
    await send(input, "q");
    await expect(selected).resolves.toBeUndefined();
    const rendered = stripAnsi(output.read()?.toString() ?? "");
    expect(rendered).toContain("R Remove from draft");
    expect(rendered).not.toContain("Deactivate active boundary");
  });

  it("explains the multi-table boundary concisely and keeps the exhaustive map available", async () => {
    const first = summary("public.check_ins", 0);
    first.active = true;
    first.relationships = [{
      relationship_id: "check_ins_location",
      target_resource: "public.locations",
      path_depth: 1,
      state: "included",
    }];
    const second = summary("public.locations", 0);
    second.included = false;
    const resources = [first, second];
    const overview = formatBoundaryOverviewMap(resources);
    expect(overview).toContain("BOUNDARY OVERVIEW");
    expect(overview).toContain(
      'Boundary "reviewed_staging" is one boundary containing 1 table.',
    );
    expect(overview).toContain(
      "The schema.table entries below are tables inside it, not separate boundaries.",
    );
    expect(overview).toContain('NEXT BOUNDARY "reviewed_staging" (DISABLED DRAFT)');
    expect(overview).toContain("public.check_ins [ACTIVE + IN DRAFT; table sign-off complete]");
    expect(overview).toContain("-> public.locations (many-to-one, depth 1)");
    expect(overview).toContain("Show the complete catalog: synapsor-runner boundary review --map --all");

    const exhaustive = formatBoundaryOverviewMap(resources, { exhaustive: true });
    expect(exhaustive).toContain("WHOLE BOUNDARY MAP (ALL TABLES)");
    expect(exhaustive).toContain(
      "path check_ins_location [IN NEXT BOUNDARY]",
    );
    expect(exhaustive).toContain(
      "-> public.locations (many-to-one, depth 1)",
    );

    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const selected = session.chooseResource(resources);
    await send(input, "m");
    await emitKey(input, { name: "escape", sequence: "\u001b" });
    await send(input, "\r");
    await send(input, "r");
    await expect(selected).resolves.toEqual({
      resource_id: "public.check_ins",
      action: "remove",
    });
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("WHOLE BOUNDARY MAP");
    expect(rendered).toContain("R");
    expect(rendered).toContain("Remove");
  });

  it("bounds the default overview for a large schema and exposes the full catalog explicitly", () => {
    const resources = Array.from({ length: 15 }, (_, index) =>
      summary(`public.table_${String(index + 1).padStart(2, "0")}`, index < 3 ? 1 : 0));
    resources.forEach((resource, index) => {
      resource.included = index < 3;
    });
    resources[9]!.relationships = [{
      relationship_id: "table_10_table_01_fkey",
      target_resource: "public.table_01",
      path_depth: 1,
      state: "available",
    }];

    const overview = formatBoundaryOverviewMap(resources, { commandName: "synapsor-runner" });
    expect(overview).toContain("Runner inspected 15 tables.");
    expect(overview).toContain("Auto Boundary selected 3 starting tables.");
    expect(overview).toContain("12 reviewable tables are outside this boundary; 0 are blocked.");
    expect(overview).toContain("  +6 more");
    expect(overview).toContain("public.table_10 -> public.table_01");
    expect(overview).not.toContain("public.table_15");

    const exhaustive = formatBoundaryOverviewMap(resources, { exhaustive: true });
    expect(exhaustive).toContain("public.table_15");
  });

  it("offers every trusted-scope output tier while scope stays fixed", async () => {
    const first = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(first.input, first.output);
    const view = reviewView();
    const edited = session.editFieldTiers(view);
    await send(first.input, " ");
    await send(first.input, "\r");
    await expect(edited).resolves.toMatchObject({
      outcome: "withheld_from_model",
      tenant_id: "kept_out",
    });

    const second = fakeTerminal();
    const trustedSession = createBoundaryReviewInteractiveSession(second.input, second.output);
    const trustedEdit = trustedSession.editFieldTiers(view);
    await send(second.input, "\u001b[B");
    await send(second.input, "w");
    await send(second.input, "\r");
    await expect(trustedEdit).resolves.toMatchObject({
      outcome: "visible",
      tenant_id: "withheld_from_model",
    });
    const trustedOutput = second.output.read()?.toString() ?? "";
    expect(trustedOutput).toContain("Fixed trusted scope");
    expect(trustedOutput).toContain("response-local token");
    expect(trustedOutput).toContain("[trusted scope]");
    expect(trustedOutput).not.toContain("output tier\n");

    const third = fakeTerminal();
    const visibleSession = createBoundaryReviewInteractiveSession(third.input, third.output);
    const visibleEdit = visibleSession.editFieldTiers(view);
    await send(third.input, "\u001b[B");
    await send(third.input, "v");
    await send(third.input, "\r");
    await expect(visibleEdit).resolves.toMatchObject({
      outcome: "visible",
      tenant_id: "visible",
    });
    const visibleOutput = third.output.read()?.toString() ?? "";
    expect(visibleOutput).toContain("outside model arguments");
    expect(visibleOutput).toContain("reviewed value may be sent");
  });

  it("makes access tiers visually explicit and returns from the map to the table list", async () => {
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const { input, output } = fakeTerminal();
      const session = createBoundaryReviewInteractiveSession(input, output);
      const edited = session.editFieldTiers(reviewView());
      await send(input, "w");
      await send(input, "m");
      await send(input, "b");
      await expect(edited).resolves.toBe("back");

      const rendered = output.read()?.toString() ?? "";
      expect(rendered).toContain("\u001b[1;36m");
      expect(rendered).toContain("\u001b[1;96m");
      expect(rendered).not.toContain("\u001b[7m");
      expect(rendered).toContain("V");
      expect(rendered).toContain("MODEL + RUNNER");
      expect(rendered).toContain("Raw values: Runner only");
      expect(rendered).toContain("KEPT OUT");
      expect(rendered).toContain("Space");
      expect(rendered).toContain("Change access");
      expect(rendered).toContain("Enter");
      expect(rendered).toContain("Continue to table sign-off");
      expect(rendered).toContain("COLUMN");
      expect(rendered).toContain("TYPE");
      expect(rendered).toContain("ACCESS");
      expect(rendered).toContain("REVIEW NOTE");
      expect(rendered).toContain("Esc");
      expect(rendered).toContain("Back");
      expect(rendered).not.toContain("Backspace Back to tables");
      expect(rendered).toContain("Space cycles: MODEL + RUNNER -> RUNNER ONLY -> KEPT OUT");
      expect(rendered).toContain("TABLE ACCESS MAP - public.check_ins");
      expect(rendered).toContain("Preview includes unsaved access choices.");
      expect(rendered).toContain("outcome: return, filter(eq), sort, count distinct");
      expect(rendered).toContain("Trusted tenant scope: tenant_id (direct; bound outside model arguments)");
      expect(rendered).not.toContain("tenant-secret");
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });

  it("uses a compact aligned column table on narrow terminals", async () => {
    const { input, output } = fakeTerminal();
    output.columns = 68;
    const session = createBoundaryReviewInteractiveSession(input, output);
    const edited = session.editFieldTiers(reviewView(), { focusedAccess: true });
    const rendered = output.read()?.toString() ?? "";
    const plain = stripAnsi(rendered);

    expect(rendered).toContain("COLUMN");
    expect(rendered).toContain("ACCESS");
    expect(rendered).toContain("Selected column: outcome · text");
    expect(plain).toMatch(/Back to boundary\s+tables/);
    await send(input, "b");
    await expect(edited).resolves.toBe("back");
  });

  it("edits only database-declared categorical values and explains the empty-set consequence", async () => {
    const view = reviewView();
    view.fields[0]!.enum_values = ["scheduled", "completed"];
    view.candidate!.field_enums = { outcome: ["scheduled", "completed"] };
    view.generated_candidate!.field_enums = { outcome: ["scheduled", "completed"] };

    const first = fakeTerminal();
    const firstSession = createBoundaryReviewInteractiveSession(first.input, first.output);
    const action = firstSession.editFieldTiers(view, { focusedAccess: true });
    await send(first.input, "w");
    await send(first.input, "e");
    const enumAction = await action;
    expect(enumAction).toMatchObject({
      action: "enum",
      field: "outcome",
      tiers: { outcome: "withheld_from_model" },
    });
    expect(stripAnsi(first.output.read()?.toString() ?? "")).toContain(
      "E Edit allowed values for selected column: 2 of 2",
    );

    const resumed = fakeTerminal();
    const resumedSession = createBoundaryReviewInteractiveSession(resumed.input, resumed.output);
    const stagedTiers = typeof enumAction === "object" && "tiers" in enumAction
      ? enumAction.tiers as Record<string, BoundaryFieldTier>
      : undefined;
    const resumedEdit = resumedSession.editFieldTiers(view, {
      focusedAccess: true,
      initialTiers: stagedTiers,
    });
    await send(resumed.input, "\r");
    await expect(resumedEdit).resolves.toMatchObject({ outcome: "withheld_from_model" });

    const second = fakeTerminal();
    const secondSession = createBoundaryReviewInteractiveSession(second.input, second.output);
    const edited = secondSession.editFieldEnumValues!(view, "outcome");
    await send(second.input, " ");
    await send(second.input, "\r");
    await expect(edited).resolves.toEqual(["completed"]);
    const rendered = stripAnsi(second.output.read()?.toString() ?? "");
    expect(rendered).toContain("No source rows were sampled");
    expect(rendered).toContain("Removed values are refused even if guessed");
    expect(rendered).toContain("Selecting none disables filtering and grouping");
    expect(rendered).toContain("Save allowed values and return to columns");
  });

  it("opens selected-column metadata without losing staged access choices", async () => {
    const terminal = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(terminal.input, terminal.output);
    const action = session.editFieldTiers(reviewView(), { focusedAccess: true });
    await send(terminal.input, "w");
    await send(terminal.input, "i");

    await expect(action).resolves.toMatchObject({
      action: "metadata",
      field: "outcome",
      tiers: { outcome: "withheld_from_model" },
    });
    expect(stripAnsi(terminal.output.read()?.toString() ?? ""))
      .toContain("I Edit the selected column's reviewed label and description");
  });

  it("opens user-owner scope review without losing staged column choices", async () => {
    const terminal = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(terminal.input, terminal.output);
    const action = session.editFieldTiers(reviewView(), { focusedAccess: true });
    await send(terminal.input, "w");
    await send(terminal.input, "o");

    await expect(action).resolves.toMatchObject({
      action: "principal",
      tiers: { outcome: "withheld_from_model" },
    });
    const rendered = stripAnsi(terminal.output.read()?.toString() ?? "");
    expect(rendered).toContain("O User/owner row limit: not configured");
  });

  it("resolves blocked identity and tenant choices without leaving the terminal editor", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const view = reviewView();
    view.status = "blocked_scope";
    view.candidate = null;
    view.generated_candidate = null;
    view.blockers = ["trusted tenant scope is unresolved"];
    view.row_identity = {
      ...view.row_identity,
      selected: "outcome",
      candidates: ["outcome"],
      alternatives_considered: [{
        value: "outcome",
        confidence: "high",
        evidence: ["database primary key"],
        selected: true,
      }],
    };
    view.tenant_key = {
      ...view.tenant_key,
      selected: undefined,
      candidates: ["tenant_id", "workspace_id"],
      alternatives_considered: [
        {
          value: "tenant_id",
          confidence: "low",
          evidence: ["column name matches a tenant convention"],
          selected: false,
        },
        {
          value: "workspace_id",
          confidence: "low",
          evidence: ["column name matches a tenant convention"],
          selected: false,
        },
      ],
    };

    const resolution = session.resolveBlockedResource!(view);
    const first = stripAnsi(output.read()?.toString() ?? "");
    expect(first).toContain("RESOLVE TABLE ACCESS - public.check_ins");
    expect(first).toContain("Record ID");
    expect(first).toContain("Tenant isolation");
    expect(first).toContain("These choices stay outside model arguments");
    await send(input, "\u001b[C");
    await send(input, "\r");
    await expect(resolution).resolves.toEqual({
      row_identity: "outcome",
      tenant_key: "workspace_id",
    });
  });

  it("renders a derived tenant path as a table chain while returning its canonical id", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const view = reviewView();
    const scope = twoHopDerivedScope();
    view.status = "blocked_scope";
    view.candidate = null;
    view.generated_candidate = null;
    view.tenant_key = {
      ...view.tenant_key,
      selected: undefined,
      candidates: [],
      alternatives_considered: [],
    };
    view.derived_tenant_scope = {
      candidates: [scope],
      selected: scope,
      confirmation_required: true,
      safety_consequence: "This mandatory path scopes every row.",
    };

    const resolution = session.resolveBlockedResource!(view);
    const rendered = stripAnsi(output.read()?.toString() ?? "");
    expect(rendered).toContain("order_item_events -> order_items -> orders.tenant_id (mandatory");
    expect(rendered).toContain("relationship path)");
    expect(rendered).not.toContain("events_item_fkey__items_order_fkey");
    await send(input, "\r");
    await expect(resolution).resolves.toEqual({
      row_identity: "outcome",
      tenant_scope_path: "events_item_fkey__items_order_fkey",
    });
  });

  it("offers an eligible shared reference as an explicit reviewed row-scope choice", async () => {
    const { input, output } = fakeTerminal();
    const session = createBoundaryReviewInteractiveSession(input, output);
    const view = reviewView();
    view.status = "blocked_scope";
    view.candidate = null;
    view.generated_candidate = null;
    view.tenant_key = {
      ...view.tenant_key,
      selected: undefined,
      candidates: [],
      alternatives_considered: [],
    };
    view.derived_tenant_scope = undefined;
    view.shared_reference_scope = {
      eligible: true,
      confirmation_required: true,
      safety_consequence: "No tenant predicate is applied.",
      blockers: [],
    };

    const resolution = session.resolveBlockedResource!(view);
    const rendered = stripAnsi(output.read()?.toString() ?? "");
    expect(rendered).toContain("Shared reference - same reviewed rows for every tenant");
    expect(rendered).toContain("Shared reference means every tenant receives the same reviewed rows");
    await send(input, "\r");
    await expect(resolution).resolves.toEqual({
      row_identity: "outcome",
      shared_reference_scope: "table_has_no_per_tenant_rows",
    });
  });

  it("sanitizes inspected names before rendering the structural map", () => {
    const view = reviewView();
    view.resource_id = "public.check_ins\u001b[2J";
    view.fields[0]!.name = "outcome\u001b]0;spoof\u0007";
    const rendered = formatBoundaryResourceMap(view);
    expect(rendered).not.toContain("\u001b[2J");
    expect(rendered).not.toContain("\u001b]0;spoof");
    expect(rendered).toContain("public.check_ins?[2J");
    expect(rendered).toContain("outcome?]0;spoof?");
  });

  it("packs boundary actions into the fewest lines allowed by terminal width", () => {
    const actions = [
      "Up/Down Select",
      "Enter Edit",
      "C Review + activate",
      "A New boundary",
      "M Map",
      "N Rename",
      "X Delete",
      "D Deactivate",
      "Q Quit",
    ];
    expect(packTerminalActions(actions, 140)).toEqual([actions.join("   ")]);

    const compact = packTerminalActions(actions, 60);
    expect(compact.length).toBeGreaterThan(1);
    expect(compact.every((line) => line.length <= 60)).toBe(true);
    expect(compact.join("\n")).toContain("C Review + activate");
    expect(compact.join("\n")).toContain("D Deactivate");
  });
});

function fakeTerminal(): {
  input: ReadStream;
  output: WriteStream & PassThrough;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    setRawMode(value: boolean): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (value: boolean) => {
    input.isRaw = value;
  };
  const output = new PassThrough() as WriteStream & PassThrough;
  Object.assign(output, { isTTY: true, columns: 100 });
  return {
    input: input as unknown as ReadStream,
    output,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

async function send(input: ReadStream, value: string): Promise<void> {
  (input as unknown as PassThrough).write(value);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function emitKey(
  input: ReadStream,
  key: { name?: string; sequence: string; ctrl?: boolean },
): Promise<void> {
  input.emit("keypress", key.sequence, key);
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function summary(resourceId: string, riskCount: number): BoundaryResourceReviewSummary {
  return {
    candidate_boundary_name: "reviewed_staging",
    resource_id: resourceId,
    resource_type: "table",
    status: "draft_read",
    included: true,
    active: false,
    blockers: [],
    pending_decisions: Array.from({ length: riskCount }, (_, index) => `decision-${index}`),
    risk_count: riskCount,
    model_visible_fields: 3,
    runner_output_only_fields: 0,
    kept_out_fields: 1,
    relationships: [],
  };
}

function reviewView(): BoundaryResourceReviewView {
  const inference = {
    candidates: ["tenant_id"],
    evidence: [],
    alternatives_considered: [],
    confidence: "high" as const,
    confirmation_required: false,
    safety_consequence: "",
  };
  return {
    ok: true,
    resource_id: "public.check_ins",
    status: "draft_read",
    included: true,
    blockers: [],
    row_identity: { ...inference, selected: "outcome", candidates: ["outcome"] },
    tenant_key: { ...inference, selected: "tenant_id" },
    principal_key: { ...inference, candidates: [] },
    fields: [
      {
        name: "outcome",
        data_type: "text",
        nullable: false,
        primary_key: true,
        sensitive_suggestion: false,
        sensitivity: {
          state: "structurally_low_risk",
          reason_codes: ["no_sensitive_structural_signal"],
          reasons: ["No sensitive structural signal."],
          evidence_source: "database",
        },
        raw_visible_suggestion: true,
        aggregate_measure_suggestion: false,
        count_distinct_suggestion: true,
        groupable_suggestion: false,
        time_bucket_suggestion: false,
        evidence: ["database column outcome text"],
      },
      {
        name: "tenant_id",
        data_type: "text",
        nullable: false,
        primary_key: false,
        sensitive_suggestion: false,
        sensitivity: {
          state: "structurally_low_risk",
          reason_codes: ["no_sensitive_structural_signal"],
          reasons: ["No sensitive structural signal."],
          evidence_source: "database",
        },
        raw_visible_suggestion: true,
        aggregate_measure_suggestion: false,
        count_distinct_suggestion: false,
        groupable_suggestion: false,
        time_bucket_suggestion: false,
        evidence: ["database column tenant_id text"],
      },
    ],
    relationships: [],
    candidate: {
      id: "public.check_ins",
      schema: "public",
      table: "check_ins",
      primary_key: "outcome",
      tenant_key: "tenant_id",
      field_types: { outcome: "text", tenant_id: "text" },
      field_enums: {},
      selectable_fields: ["outcome"],
      filterable_fields: { outcome: ["eq"] },
      sortable_fields: ["outcome"],
      groupable_fields: [],
      aggregate_measures: [],
      count_distinct_fields: ["outcome"],
      time_bucket_fields: {},
      kept_out_fields: ["tenant_id"],
      relationships: [],
      minimum_cohort_size: 5,
      suppression_aware_totals: true,
    },
    generated_candidate: {
      id: "public.check_ins",
      schema: "public",
      table: "check_ins",
      primary_key: "outcome",
      tenant_key: "tenant_id",
      field_types: { outcome: "text", tenant_id: "text" },
      field_enums: {},
      selectable_fields: ["outcome"],
      filterable_fields: { outcome: ["eq"] },
      sortable_fields: ["outcome"],
      groupable_fields: [],
      aggregate_measures: [],
      count_distinct_fields: ["outcome"],
      time_bucket_fields: {},
      kept_out_fields: ["tenant_id"],
      relationships: [],
      minimum_cohort_size: 5,
      suppression_aware_totals: true,
    },
    bindings: {
      draft_digest: `sha256:${"1".repeat(64)}`,
      candidate_digest: `sha256:${"2".repeat(64)}`,
      generation_lock_fingerprint: `sha256:${"3".repeat(64)}`,
      schema_fingerprint: `sha256:${"4".repeat(64)}`,
      role_posture_fingerprint: `sha256:${"5".repeat(64)}`,
      review_revision: 0,
    },
    source_database_changed: false,
  };
}

function twoHopDerivedScope() {
  const link = (
    constraint_name: string,
    source_resource: string,
    target_resource: string,
  ) => ({
    constraint_name,
    source_resource,
    target_resource,
    source_columns: ["parent_id"],
    target_columns: ["id"],
    target_uniqueness: {
      kind: "primary_key" as const,
      name: `${target_resource.split(".").at(-1)}_pkey`,
      columns: ["id"],
    },
    nullable: false,
    cardinality: "many_to_one" as const,
    max_fan_out: 1 as const,
  });
  const links = [
    link("events_item_fkey", "public.order_item_events", "public.order_items"),
    link("items_order_fkey", "public.order_items", "public.orders"),
  ];
  return {
    mode: "derived" as const,
    path_id: "events_item_fkey__items_order_fkey",
    ancestor_resource: "public.orders",
    ancestor_column: "tenant_id",
    proof: {
      source: "database_catalog" as const,
      links,
      digest: `sha256:${"7".repeat(64)}` as `sha256:${string}`,
    },
  };
}

function oneHopDerivedScope(
  sourceResource: string,
  ancestorResource: string,
  constraintName: string,
  nullable = false,
) {
  return {
    mode: "derived" as const,
    path_id: constraintName,
    ancestor_resource: ancestorResource,
    ancestor_column: "tenant_id",
    proof: {
      source: "database_catalog" as const,
      links: [{
        constraint_name: constraintName,
        source_resource: sourceResource,
        target_resource: ancestorResource,
        source_columns: ["order_id"],
        target_columns: ["id"],
        target_uniqueness: {
          kind: "primary_key" as const,
          name: `${ancestorResource.split(".").at(-1)}_pkey`,
          columns: ["id"],
        },
        nullable,
        cardinality: "many_to_one" as const,
        max_fan_out: 1 as const,
      }],
      digest: `sha256:${"8".repeat(64)}` as `sha256:${string}`,
    },
  };
}

function derivedScopeInference(scope: ReturnType<typeof oneHopDerivedScope> | ReturnType<typeof twoHopDerivedScope>) {
  return {
    candidates: [scope],
    selected: scope,
    confirmation_required: true as const,
    safety_consequence: "Every row is scoped through this mandatory relationship path.",
  };
}
