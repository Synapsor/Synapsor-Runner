import { describe, expect, it } from "vitest";
import { ACTION_SUGGESTION_VERSION, assessActionSuggestion } from "./action-design.js";
import type { GuidedActionOptions, GuidedActionResourceOption } from "./guided-action.js";
import {
  applySuggestedDeterministicApproval,
  prepareQuickProposalAction,
  rankActionIntent,
} from "./guided-action-quick.js";

const students: GuidedActionResourceOption = {
  id: "institutional_research.students",
  schema: "institutional_research",
  table: "students",
  label: "Students",
  description: "Student registration records.",
  primary_key: "student_id",
  tenant_key: "tenant_id",
  writable_fields: [
    { name: "student_id", data_type: "varchar(32)", enum_values: [], nullable: false, required_for_insert: true },
    { name: "residency", data_type: "text", enum_values: ["in_state", "out_of_state"], nullable: false, required_for_insert: true },
    { name: "entry_cohort", data_type: "integer", enum_values: [], nullable: false, required_for_insert: true, suggested_numeric_minimum: 2020, suggested_numeric_maximum: 2030 },
  ],
  structurally_eligible_fields: [
    { name: "student_id", data_type: "varchar(32)", enum_values: [], nullable: false, required_for_insert: true },
    { name: "residency", data_type: "text", enum_values: ["in_state", "out_of_state"], nullable: false, required_for_insert: true },
    { name: "entry_cohort", data_type: "integer", enum_values: [], nullable: false, required_for_insert: true, suggested_numeric_minimum: 2020, suggested_numeric_maximum: 2030 },
  ],
  conflict_candidates: ["student_id"],
  insert_dedup_candidates: ["student_id"],
  kept_out_fields: ["tenant_id"],
  operation_availability: {
    insert: { available: true, reason: "A unique student_id proves retry identity." },
    update: { available: true, reason: "student_id identifies one row." },
    delete: { available: true, reason: "student_id identifies one row." },
  },
};

const options: GuidedActionOptions = {
  boundary_name: "reviewed_staging",
  boundary_state: "active",
  boundary_digest: `sha256:${"a".repeat(64)}`,
  source: "local_postgres",
  deployment_profile: "staging",
  resources: [students],
  blocked_resources: [],
  safe_defaults: {},
};

describe("quick proposal action preparation", () => {
  it("prepares a complete proposal-only action from unique reviewed structure", () => {
    const result = prepareQuickProposalAction({
      options,
      intent: "Register one student with a reviewed residency and entry cohort.",
      decisions: { resource: students.id, operation: "insert", fields: ["entry_cohort", "residency"] },
    });
    expect(result).toMatchObject({
      state: "ready",
      authority_granted: false,
      source_database_changed: false,
      action: {
        resource: "institutional_research.students",
        operation: "insert",
        dedup_proposal_column: "student_id",
        authority_posture: "proposal_only",
        writeback: { mode: "none" },
        patches: [
          { column: "entry_cohort", minimum: 2020, maximum: 2030 },
          { column: "residency" },
        ],
      },
    });
    if (result.state !== "ready") throw new Error("expected ready action");
    expect(result).not.toHaveProperty("deterministic_approval_template");
    expect(result.summary.trusted_context).toEqual(["tenant_id from trusted Runner context"]);
    expect(result.summary.arguments.map((item) => item.field)).toEqual(["entry_cohort", "residency"]);
  });

  it("keeps multi-field proposal combinations on human review unless an exact policy is separately reviewed", () => {
    const subscriptions: GuidedActionResourceOption = {
      ...students,
      id: "telecom.subscriptions",
      schema: "telecom",
      table: "subscriptions",
      label: "Subscriptions",
      writable_fields: [
        { name: "plan_code", data_type: "text", enum_values: ["starter", "unlimited", "unlimited_plus", "family_premium"], nullable: false, required_for_insert: false },
        { name: "base_monthly_cents", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
      ],
      structurally_eligible_fields: [
        { name: "plan_code", data_type: "text", enum_values: ["starter", "unlimited", "unlimited_plus", "family_premium"], nullable: false, required_for_insert: false },
        { name: "base_monthly_cents", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
      ],
      conflict_candidates: ["version"],
    };
    const result = prepareQuickProposalAction({
      options: { ...options, resources: [subscriptions] },
      intent: "Propose a reviewed subscription plan change.",
      decisions: {
        resource: subscriptions.id,
        operation: "update",
        guard_column: "version",
        fields: ["plan_code", "base_monthly_cents"],
        numeric_bounds: { base_monthly_cents: { minimum: 4500, maximum: 16500 } },
      },
    });

    expect(result).toMatchObject({ state: "ready", action: { patches: expect.any(Array) } });
    expect(result).not.toHaveProperty("deterministic_approval_template");
  });

  it("still offers a conservative structural starting policy for one bounded field", () => {
    const cohortOnly: GuidedActionResourceOption = {
      ...students,
      writable_fields: [students.writable_fields.find((field) => field.name === "entry_cohort")!],
      structurally_eligible_fields: [students.structurally_eligible_fields.find((field) => field.name === "entry_cohort")!],
    };
    const result = prepareQuickProposalAction({
      options: { ...options, resources: [cohortOnly] },
      intent: "Update the reviewed entry cohort.",
      decisions: {
        resource: cohortOnly.id,
        operation: "update",
        guard_column: "student_id",
        fields: ["entry_cohort"],
      },
    });

    expect(result).toMatchObject({
      state: "ready",
      deterministic_approval_template: {
        source: "reviewed_structure",
        auto_approval: {
          conditions: [{ field: "entry_cohort", operator: "lte", value: 2030 }],
        },
      },
    });
  });

  it("binds deterministic approval limits to tenant plus principal for reviewed RLS scope", () => {
    const rlsScoped: GuidedActionResourceOption = {
      ...students,
      principal_rls_setting: "app.viewer_context",
      writable_fields: [students.writable_fields.find((field) => field.name === "entry_cohort")!],
      structurally_eligible_fields: [students.structurally_eligible_fields.find((field) => field.name === "entry_cohort")!],
    };
    const result = prepareQuickProposalAction({
      options: { ...options, resources: [rlsScoped] },
      intent: "Update the reviewed entry cohort for this authenticated user.",
      decisions: {
        resource: rlsScoped.id,
        operation: "update",
        guard_column: "student_id",
        fields: ["entry_cohort"],
      },
    });

    expect(result).toMatchObject({
      state: "ready",
      deterministic_approval_template: {
        shared_limits: [expect.objectContaining({ scope: "tenant_principal" })],
      },
      summary: {
        trusted_context: expect.arrayContaining([
          "PostgreSQL RLS setting app.viewer_context from trusted Runner context",
        ]),
      },
    });
  });

  it("keeps fractional bounds available for a decimal source column", () => {
    const decimalResource: GuidedActionResourceOption = {
      ...students,
      writable_fields: [{ name: "requested_hours", data_type: "numeric(6,2)", enum_values: [], nullable: false, required_for_insert: false }],
      structurally_eligible_fields: [{ name: "requested_hours", data_type: "numeric(6,2)", enum_values: [], nullable: false, required_for_insert: false }],
    };
    const result = prepareQuickProposalAction({
      options: { ...options, resources: [decimalResource] },
      intent: "Update requested hours.",
      decisions: {
        resource: decimalResource.id,
        operation: "update",
        guard_column: "student_id",
        fields: ["requested_hours"],
        numeric_bounds: { requested_hours: { minimum: 0.5, maximum: 16.25 } },
      },
    });

    expect(result).toMatchObject({
      state: "ready",
      action: { patches: [{ column: "requested_hours", minimum: 0.5, maximum: 16.25 }] },
    });
  });

  it("replaces the structural template with one validated model policy proposal without granting authority", () => {
    const prepared = prepareQuickProposalAction({
      options,
      intent: "Register one student with a reviewed residency and entry cohort.",
      decisions: { resource: students.id, operation: "insert", fields: ["entry_cohort", "residency"] },
    });
    const assessment = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Register one student with bounded values.",
      resource: "institutional_research.students",
      operation: "insert",
      fields: ["entry_cohort", "residency"],
      approval_policy_proposal: {
        mode: "deterministic",
        conditions: [
          { field: "entry_cohort", operator: "lte", value: 2028 },
          { field: "residency", operator: "in", values: ["in_state"] },
        ],
        max_per_day: 4,
        shared_limits: [{ kind: "count", scope: "tenant", maximum: 8, window_seconds: 3600 }],
      },
      suggested_by: { kind: "model", provider: "openai", model: "gpt-test" },
    }, options.resources);

    const result = applySuggestedDeterministicApproval(prepared, assessment);

    expect(result).toMatchObject({
      state: "ready",
      authority_granted: false,
      deterministic_approval_template: {
        source: "model_suggestion",
        auto_approval: {
          conditions: [
            { field: "entry_cohort", operator: "lte", value: 2028 },
            { field: "residency", operator: "in", values: ["in_state"] },
          ],
          max_per_day: 4,
        },
        shared_limits: [{
          id: expect.stringContaining("student_propose_insert_students"),
          scope: "tenant",
          maximum: 8,
          window_seconds: 3600,
        }],
      },
    });
    if (result.state !== "ready") throw new Error("expected ready action");
    expect(result.action).not.toHaveProperty("auto_approval");
  });

  it("intersects model policy thresholds with the operator-reviewed proposal range", () => {
    const prepared = prepareQuickProposalAction({
      options,
      intent: "Register one student with a reviewed residency and entry cohort.",
      decisions: { resource: students.id, operation: "insert", fields: ["entry_cohort", "residency"], numeric_bounds: { entry_cohort: { minimum: 2022, maximum: 2028 } } },
    });
    const assessment = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Register one student with bounded values.",
      resource: "institutional_research.students",
      operation: "insert",
      fields: ["entry_cohort", "residency"],
      approval_policy_proposal: {
        mode: "deterministic",
        conditions: [
          { field: "entry_cohort", operator: "gte", value: 1900 },
          { field: "entry_cohort", operator: "lte", value: 2100 },
          { field: "residency", operator: "in", values: ["in_state"] },
        ],
        max_per_day: 4,
      },
      suggested_by: { kind: "model", provider: "openai", model: "gpt-test" },
    }, options.resources);

    const result = applySuggestedDeterministicApproval(prepared, assessment);

    expect(result).toMatchObject({
      state: "ready",
      deterministic_approval_template: {
        source: "model_suggestion",
        auto_approval: {
          conditions: [
            { field: "entry_cohort", operator: "gte", value: 2022 },
            { field: "entry_cohort", operator: "lte", value: 2028 },
            { field: "residency", operator: "in", values: ["in_state"] },
          ],
        },
        normalizations: [
          expect.stringContaining("minimum narrowed from 1900"),
          expect.stringContaining("maximum narrowed from 2100"),
        ],
      },
    });
  });

  it("refuses a deterministic policy whose numeric intersection is empty", () => {
    const prepared = prepareQuickProposalAction({
      options,
      intent: "Register one student with a reviewed residency and entry cohort.",
      decisions: { resource: students.id, operation: "insert", fields: ["entry_cohort", "residency"], numeric_bounds: { entry_cohort: { minimum: 2022, maximum: 2028 } } },
    });
    const assessment = assessActionSuggestion({
      schema_version: ACTION_SUGGESTION_VERSION,
      intent: "Register one student with bounded values.",
      resource: "institutional_research.students",
      operation: "insert",
      fields: ["entry_cohort", "residency"],
      approval_policy_proposal: {
        mode: "deterministic",
        conditions: [
          { field: "entry_cohort", operator: "lte", value: 2000 },
          { field: "residency", operator: "in", values: ["in_state"] },
        ],
        max_per_day: 4,
      },
      suggested_by: { kind: "model", provider: "openai", model: "gpt-test" },
    }, options.resources);

    expect(() => applySuggestedDeterministicApproval(prepared, assessment))
      .toThrow(/leaves no value inside the reviewed proposal range 2022 through 2028/);
  });

  it("asks for an exact resource when a typed target is absent", () => {
    const result = prepareQuickProposalAction({
      options: {
        ...options,
        resources: [students, { ...students, id: "institutional_research.archived_students", table: "archived_students", label: "Archived students" }],
      },
      intent: "Update a student record.",
    });
    expect(result).toMatchObject({
      state: "needs_input",
      decision: { kind: "resource" },
      authority_granted: false,
    });
  });

  it("preserves exact typed field selections despite repeated table words", () => {
    const serviceRequests: GuidedActionResourceOption = {
      ...students,
      id: "operations.service_requests",
      schema: "operations",
      table: "service_requests",
      label: "Service requests",
      description: "Requests for scheduled service work.",
      writable_fields: [
        { name: "request_type", data_type: "text", enum_values: ["inspection", "repair"], nullable: false, required_for_insert: true },
      ],
      structurally_eligible_fields: [
        { name: "request_type", data_type: "text", enum_values: ["inspection", "repair"], nullable: false, required_for_insert: true },
      ],
      conflict_candidates: ["version"],
      insert_dedup_candidates: ["request_id"],
    };
    const dispatchSettings: GuidedActionResourceOption = {
      ...students,
      id: "operations.dispatch_settings",
      schema: "operations",
      table: "dispatch_settings",
      label: undefined,
      description: undefined,
      writable_fields: [
        { name: "alert_level", data_type: "text", enum_values: ["standard", "elevated"], nullable: false, required_for_insert: false },
        { name: "max_open_requests", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false, suggested_numeric_minimum: 1, suggested_numeric_maximum: 40 },
      ],
      structurally_eligible_fields: [
        { name: "alert_level", data_type: "text", enum_values: ["standard", "elevated"], nullable: false, required_for_insert: false },
        { name: "max_open_requests", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false, suggested_numeric_minimum: 1, suggested_numeric_maximum: 40 },
      ],
      conflict_candidates: ["version"],
      insert_dedup_candidates: [],
      operation_availability: {
        insert: { available: false, reason: "No unique retry identity was found." },
        update: { available: true, reason: "version detects a stale update." },
        delete: { available: false, reason: "Delete is not reviewed." },
      },
    };

    const result = prepareQuickProposalAction({
      options: { ...options, resources: [serviceRequests, dispatchSettings] },
      intent: "Update dispatcher alert level and maximum open requests with version conflict protection.",
      decisions: { resource: dispatchSettings.id, operation: "update", fields: ["alert_level", "max_open_requests"] },
    });

    expect(result).toMatchObject({
      state: "ready",
      recommendations: {
        resource: "operations.dispatch_settings",
        operation: "update",
        fields: ["alert_level", "max_open_requests"],
      },
      action: {
        resource: "operations.dispatch_settings",
        operation: "update",
        conflict_column: "version",
        patches: [
          { column: "alert_level" },
          { column: "max_open_requests", minimum: 1, maximum: 40 },
        ],
      },
    });
  });

  it("asks only for a missing numeric business bound", () => {
    const withoutSuggestedBounds: GuidedActionResourceOption = {
      ...students,
      writable_fields: students.writable_fields.map((field) => field.name === "entry_cohort"
        ? { ...field, suggested_numeric_minimum: undefined, suggested_numeric_maximum: undefined }
        : field),
      structurally_eligible_fields: students.structurally_eligible_fields.map((field) => field.name === "entry_cohort"
        ? { ...field, suggested_numeric_minimum: undefined, suggested_numeric_maximum: undefined }
        : field),
    };
    const unresolved = prepareQuickProposalAction({
      options: { ...options, resources: [withoutSuggestedBounds] },
      intent: "Register one student with residency and entry cohort.",
      decisions: { resource: withoutSuggestedBounds.id, operation: "insert", fields: ["entry_cohort", "residency"] },
    });
    expect(unresolved).toMatchObject({
      state: "needs_input",
      decision: { kind: "numeric_bounds", field: "entry_cohort" },
    });
    const resolved = prepareQuickProposalAction({
      options: { ...options, resources: [withoutSuggestedBounds] },
      intent: "Register one student with residency and entry cohort.",
      decisions: { resource: students.id, operation: "insert", fields: ["entry_cohort", "residency"], numeric_bounds: { entry_cohort: { minimum: 2022, maximum: 2028 } } },
    });
    expect(resolved).toMatchObject({
      state: "ready",
      action: { patches: [{ column: "entry_cohort", minimum: 2022, maximum: 2028 }, { column: "residency" }] },
    });
  });

  it("keeps hard-delete proposals behind an exact phrase", () => {
    const unresolved = prepareQuickProposalAction({
      options,
      intent: "Delete one student.",
      decisions: { resource: students.id, operation: "delete" },
    });
    expect(unresolved).toMatchObject({
      state: "needs_input",
      decision: { kind: "delete_confirmation", expected: "DELETE institutional_research.students" },
    });
    const ready = prepareQuickProposalAction({
      options,
      intent: "Delete one student.",
      decisions: { resource: students.id, operation: "delete", delete_confirmation: "DELETE institutional_research.students" },
    });
    expect(ready).toMatchObject({
      state: "ready",
      action: {
        operation: "delete",
        patches: [],
        conflict_column: "student_id",
        authority_posture: "proposal_only",
        writeback: { mode: "none" },
      },
    });
    if (ready.state !== "ready") throw new Error("expected ready delete action");
    expect(ready.deterministic_approval_template).toBeUndefined();
  });

  it("preserves explicit typed exclusions while retaining create/delete narration", () => {
    const preferences: GuidedActionResourceOption = {
      ...students,
      id: "fleet_ops.operator_preferences",
      schema: "fleet_ops",
      table: "operator_preferences",
      label: "Operator preferences",
      description: "One dispatcher's alert and notification preferences.",
      writable_fields: [
        {
          name: "alert_threshold_minutes",
          data_type: "integer",
          enum_values: [],
          nullable: false,
          required_for_insert: false,
          suggested_numeric_minimum: 0,
          suggested_numeric_maximum: 240,
        },
        {
          name: "notification_level",
          data_type: "text",
          enum_values: ["standard", "elevated", "urgent"],
          nullable: false,
          required_for_insert: false,
        },
      ],
      structurally_eligible_fields: [
        {
          name: "alert_threshold_minutes",
          data_type: "integer",
          enum_values: [],
          nullable: false,
          required_for_insert: false,
          suggested_numeric_minimum: 0,
          suggested_numeric_maximum: 240,
        },
        {
          name: "notification_level",
          data_type: "text",
          enum_values: ["standard", "elevated", "urgent"],
          nullable: false,
          required_for_insert: false,
        },
      ],
      conflict_candidates: ["version"],
      operation_availability: {
        insert: { available: true, reason: "A unique retry identity exists." },
        update: { available: true, reason: "A reviewed version guard exists." },
        delete: { available: true, reason: "A reviewed identity exists." },
      },
    };
    const workOrders: GuidedActionResourceOption = {
      ...preferences,
      id: "fleet_ops.work_orders",
      table: "work_orders",
      label: "Work orders",
      description: "Fleet work orders.",
      writable_fields: [{
        name: "priority",
        data_type: "text",
        enum_values: ["routine", "urgent"],
        nullable: false,
        required_for_insert: false,
      }],
      structurally_eligible_fields: [{
        name: "priority",
        data_type: "text",
        enum_values: ["routine", "urgent"],
        nullable: false,
        required_for_insert: false,
      }],
    };
    const intent = "Let the dispatcher propose changing their own alert threshold and notification level. Do not create or delete work orders.";

    expect(rankActionIntent([workOrders, preferences], intent, { resource: preferences.id, operation: "update", fields: ["alert_threshold_minutes", "notification_level"], excluded_operations: ["delete", "insert"] })).toMatchObject({
      resource: "fleet_ops.operator_preferences",
      operation: "update",
      excluded_operations: ["delete", "insert"],
      fields: ["alert_threshold_minutes", "notification_level"],
    });
    expect(prepareQuickProposalAction({
      options: { ...options, resources: [workOrders, preferences] },
      intent,
      decisions: { resource: preferences.id, operation: "update", fields: ["alert_threshold_minutes", "notification_level"], excluded_operations: ["delete", "insert"] },
    })).toMatchObject({
      state: "ready",
      action: {
        resource: "fleet_ops.operator_preferences",
        operation: "update",
        conflict_column: "version",
      },
    });
    expect(() => prepareQuickProposalAction({
      options: { ...options, resources: [workOrders, preferences] },
      intent,
      decisions: { resource: preferences.id, operation: "delete", excluded_operations: ["delete", "insert"] },
    })).toThrow(/DELETE contradicts the stated job/);
  });

  it("uses explicit typed Action choices in a mixed warehouse narration", () => {
    const shipments: GuidedActionResourceOption = {
      ...students,
      id: "warehouse_qual.shipments",
      schema: "warehouse_qual",
      table: "shipments",
      label: "Shipments",
      description: "Tenant-owned shipment records.",
      writable_fields: [
        { name: "carrier_mode", data_type: "enum", enum_values: ["ground", "air"], nullable: false, required_for_insert: false },
        { name: "warehouse_zone", data_type: "enum", enum_values: ["north", "central"], nullable: false, required_for_insert: false },
        { name: "status", data_type: "enum", enum_values: ["pending", "in_transit"], nullable: false, required_for_insert: false },
      ],
      structurally_eligible_fields: [
        { name: "carrier_mode", data_type: "enum", enum_values: ["ground", "air"], nullable: false, required_for_insert: false },
        { name: "warehouse_zone", data_type: "enum", enum_values: ["north", "central"], nullable: false, required_for_insert: false },
        { name: "status", data_type: "enum", enum_values: ["pending", "in_transit"], nullable: false, required_for_insert: false },
      ],
      conflict_candidates: ["version"],
    };
    const routingPreferences: GuidedActionResourceOption = {
      ...students,
      id: "warehouse_qual.routing_preferences",
      schema: "warehouse_qual",
      table: "routing_preferences",
      label: "Routing preferences",
      description: "One coordinator's carrier and delay preferences.",
      writable_fields: [
        { name: "carrier_mode", data_type: "enum", enum_values: ["ground", "air"], nullable: false, required_for_insert: false },
        { name: "delay_threshold_minutes", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
      ],
      structurally_eligible_fields: [
        { name: "carrier_mode", data_type: "enum", enum_values: ["ground", "air"], nullable: false, required_for_insert: false },
        { name: "delay_threshold_minutes", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
      ],
      conflict_candidates: ["version"],
    };
    const intent = "Help an authenticated warehouse coordinator understand only their own shipments, carrier modes, zones, statuses, and shipment event history, and let them propose changing only their own carrier mode and delay threshold. Do not create or delete shipments, approve proposals, or apply source changes.";

    expect(rankActionIntent([shipments, routingPreferences], intent, { resource: routingPreferences.id, operation: "update", fields: ["carrier_mode", "delay_threshold_minutes"], excluded_operations: ["delete", "insert"] })).toMatchObject({
      resource: "warehouse_qual.routing_preferences",
      operation: "update",
      excluded_operations: ["delete", "insert"],
      fields: ["carrier_mode", "delay_threshold_minutes"],
    });
    expect(prepareQuickProposalAction({
      options: { ...options, resources: [shipments, routingPreferences] },
      intent,
      decisions: {
        resource: routingPreferences.id, operation: "update", fields: ["carrier_mode", "delay_threshold_minutes"], excluded_operations: ["delete", "insert"],
        numeric_bounds: { delay_threshold_minutes: { minimum: 5, maximum: 180 } },
      },
    })).toMatchObject({
      state: "ready",
      action: {
        resource: "warehouse_qual.routing_preferences",
        operation: "update",
        conflict_column: "version",
        patches: [
          { column: "carrier_mode" },
          { column: "delay_threshold_minutes", minimum: 5, maximum: 180 },
        ],
      },
    });
  });

  it("preserves typed exclusions independent of contracted negative wording", () => {
    const hints = rankActionIntent([students], "Change residency, but don't create or delete students.", { resource: students.id, operation: "update", fields: ["residency"], excluded_operations: ["delete", "insert"] });
    expect(hints).toMatchObject({
      operation: "update",
      excluded_operations: ["delete", "insert"],
      fields: ["residency"],
    });
  });

  it("preserves a typed UPDATE with no-source-write narration", () => {
    const subscriptions: GuidedActionResourceOption = {
      ...students,
      id: "telecom.subscriptions",
      schema: "telecom",
      table: "subscriptions",
      label: "Subscriptions",
      description: "Reviewed subscription plan records.",
      writable_fields: [
        { name: "plan_code", data_type: "text", enum_values: ["starter", "unlimited"], nullable: false, required_for_insert: false },
        { name: "base_monthly_cents", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
      ],
      structurally_eligible_fields: [
        { name: "plan_code", data_type: "text", enum_values: ["starter", "unlimited"], nullable: false, required_for_insert: false },
        { name: "base_monthly_cents", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false },
      ],
      conflict_candidates: ["updated_at", "version"],
    };
    const invoices: GuidedActionResourceOption = {
      ...students,
      id: "telecom.invoices",
      schema: "telecom",
      table: "invoices",
      label: "Invoices",
      writable_fields: [{ name: "amount_due_cents", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false }],
      structurally_eligible_fields: [{ name: "amount_due_cents", data_type: "integer", enum_values: [], nullable: false, required_for_insert: false }],
    };
    const intent = "Help the authenticated telecom customer understand their account, subscription, service line, recent usage, invoices, and payments, and let them propose changing their plan code and monthly base price. Do not apply or write any source change.";

    const hints = rankActionIntent([invoices, subscriptions], intent, { resource: subscriptions.id, operation: "update", fields: ["base_monthly_cents", "plan_code"] });
    expect(hints).toMatchObject({
      resource: "telecom.subscriptions",
      operation: "update",
      fields: ["base_monthly_cents", "plan_code"],
    });
    expect(hints.excluded_operations ?? []).not.toContain("update");
  });

  it("keeps an unselected field pending despite an ambiguous suffix", () => {
    const preferences: GuidedActionResourceOption = {
      ...students,
      id: "logistics.preferences",
      schema: "logistics",
      table: "preferences",
      writable_fields: [
        { name: "carrier_mode", data_type: "text", enum_values: [], nullable: false, required_for_insert: false },
        { name: "delivery_mode", data_type: "text", enum_values: [], nullable: false, required_for_insert: false },
      ],
      structurally_eligible_fields: [
        { name: "carrier_mode", data_type: "text", enum_values: [], nullable: false, required_for_insert: false },
        { name: "delivery_mode", data_type: "text", enum_values: [], nullable: false, required_for_insert: false },
      ],
      conflict_candidates: ["version"],
    };

    const hints = rankActionIntent([preferences], "Update the mode preference.", { resource: preferences.id, operation: "update" });
    expect(hints).toMatchObject({ resource: "logistics.preferences", operation: "update", fields: [] });
    expect(prepareQuickProposalAction({
      options: { ...options, resources: [preferences] },
      intent: "Update the mode preference.",
      decisions: { resource: preferences.id, operation: "update" },
    })).toMatchObject({
      state: "needs_input",
      decision: {
        kind: "fields",
        choices: [
          { value: "carrier_mode" },
          { value: "delivery_mode" },
        ],
      },
    });
  });

  it("preserves an exact typed target independent of shared schema words", () => {
    const named = {
      ...students,
      id: "fleet_ops.work_orders",
      schema: "fleet_ops",
      table: "work_orders",
      label: "Work orders",
    };
    const opaque = {
      ...students,
      id: "fleet_ops.x7",
      schema: "fleet_ops",
      table: "x7",
      label: undefined,
      description: undefined,
    };
    expect(rankActionIntent([opaque, named], "Update one fleet work order", { resource: named.id }).resource)
      .toBe("fleet_ops.work_orders");
  });

  it("refuses an exact target with no source-proven proposal operation instead of silently returning", () => {
    const unavailable: GuidedActionResourceOption = {
      ...students,
      operation_availability: {
        insert: { available: false, reason: "No unique retry identity was found." },
        update: { available: false, reason: "No conflict/version field was found." },
        delete: { available: false, reason: "Delete has no reviewed conflict guard." },
      },
    };
    expect(() => prepareQuickProposalAction({
      options: { ...options, resources: [unavailable] },
      intent: "Create a new student.",
      decisions: { resource: unavailable.id },
    })).toThrow(/No proposal operation is structurally ready.*Open Readiness/s);
  });

  it("never substitutes DELETE when the typed UPDATE effect is unavailable", () => {
    const deleteOnly: GuidedActionResourceOption = {
      ...students,
      operation_availability: {
        insert: { available: false, reason: "No unique retry identity was found." },
        update: { available: false, reason: "The reviewed row identity is unavailable." },
        delete: { available: true, reason: "A reviewed administrative delete guard exists." },
      },
    };
    expect(() => prepareQuickProposalAction({
      options: { ...options, resources: [deleteOnly] },
      intent: "Update one student residency.",
      decisions: { resource: deleteOnly.id, operation: "update", fields: ["residency"] },
    })).toThrow(/UPDATE.*unavailable.*did not substitute a different write effect/s);
  });
});
