import { describe, expect, it } from "vitest";
import { ACTION_SUGGESTION_VERSION, assessActionSuggestion } from "./action-design.js";
import type { GuidedActionOptions, GuidedActionResourceOption } from "./guided-action.js";
import {
  applySuggestedDeterministicApproval,
  prepareQuickProposalAction,
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
      decisions: { numeric_bounds: { entry_cohort: { minimum: 2022, maximum: 2028 } } },
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
      decisions: { numeric_bounds: { entry_cohort: { minimum: 2022, maximum: 2028 } } },
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

  it("asks for an exact resource when intent ranking is ambiguous", () => {
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

  it("lets multiple reviewed field matches outrank a repeated loose table-token overlap", () => {
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
    });
    expect(unresolved).toMatchObject({
      state: "needs_input",
      decision: { kind: "numeric_bounds", field: "entry_cohort" },
    });
    const resolved = prepareQuickProposalAction({
      options: { ...options, resources: [withoutSuggestedBounds] },
      intent: "Register one student with residency and entry cohort.",
      decisions: { numeric_bounds: { entry_cohort: { minimum: 2022, maximum: 2028 } } },
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
    });
    expect(unresolved).toMatchObject({
      state: "needs_input",
      decision: { kind: "delete_confirmation", expected: "DELETE institutional_research.students" },
    });
    const ready = prepareQuickProposalAction({
      options,
      intent: "Delete one student.",
      decisions: { delete_confirmation: "DELETE institutional_research.students" },
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
    })).toThrow(/No proposal operation is structurally ready.*Open Readiness/s);
  });

  it("never substitutes DELETE when the stated UPDATE effect is unavailable", () => {
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
    })).toThrow(/UPDATE.*unavailable.*did not substitute a different write effect/s);
  });
});
