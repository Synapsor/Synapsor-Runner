import { describe, expect, it } from "vitest";
import { blockedTenantScopeGuidance } from "./boundary-scope-guidance.js";

describe("blocked tenant-scope guidance", () => {
  it("explains a nullable path into tenant data and the exact database-side remedies", () => {
    const guidance = blockedTenantScopeGuidance({
      id: "public.abandoned_carts",
      tenant_key: {
        candidates: [],
        evidence: [],
        alternatives_considered: [],
        confidence: "low",
        confirmation_required: true,
        safety_consequence: "Rows cannot be tenant scoped.",
        blocked_reason: "no reviewed tenant column is available",
      },
      derived_tenant_scope: {
        candidates: [],
        confirmation_required: true,
        safety_consequence: "No proven path is available.",
      },
      shared_reference_scope: {
        eligible: false,
        confirmation_required: true,
        safety_consequence: "Shared rows require review.",
        blockers: [
          "relationship abandoned_carts_order_id_fkey reaches tenant-scoped resource public.orders",
        ],
      },
      relationships: [{
        name: "abandoned_carts_order_id_fkey",
        columns: ["order_id"],
        referenced_resource: "public.orders",
        referenced_columns: ["id"],
        nullable: true,
        cardinality_proven: true,
      }],
    });

    expect(guidance).toBeDefined();
    expect(guidance?.why).toEqual(expect.arrayContaining([
      "Direct tenant scope unavailable: no trusted tenant column was found.",
      expect.stringContaining("order_id -> public.orders.id is nullable"),
      expect.stringContaining("reaches tenant-scoped resource public.orders"),
    ]));
    expect(guidance?.remediation).toEqual(expect.arrayContaining([
      expect.stringContaining("trusted tenant column"),
      expect.stringContaining("public.abandoned_carts.order_id NOT NULL"),
      expect.stringContaining("Shared reference is not a valid workaround"),
      "Runner will not change the database schema for you.",
    ]));
  });

  it("does not alter guidance or eligibility for an addable table", () => {
    expect(blockedTenantScopeGuidance({
      id: "public.product_catalog",
      tenant_key: {
        candidates: [],
        evidence: [],
        alternatives_considered: [],
        confidence: "low",
        confirmation_required: true,
        safety_consequence: "Rows cannot be tenant scoped.",
      },
      derived_tenant_scope: {
        candidates: [],
        confirmation_required: true,
        safety_consequence: "No proven path is available.",
      },
      shared_reference_scope: {
        eligible: true,
        confirmation_required: true,
        safety_consequence: "Shared rows require review.",
        blockers: [],
      },
      relationships: [],
    })).toBeUndefined();
  });

  it("does not request tenant structure for a reviewed single-organization boundary", () => {
    const input = {
      id: "librarydb.loan_events",
      organization_scope: {
        mode: "single_organization" as const,
        organization_id: "university-ir-dev",
        acknowledgement: "all_rows_belong_to_one_organization" as const,
      },
      tenant_key: {
        candidates: [],
        evidence: [],
        alternatives_considered: [],
        confidence: "low" as const,
        confirmation_required: true,
        safety_consequence: "No per-row tenant predicate is needed.",
        blocked_reason: "no reviewed tenant column is available",
      },
      derived_tenant_scope: {
        candidates: [],
        confirmation_required: true as const,
        safety_consequence: "No per-row tenant predicate is needed.",
      },
      relationships: [],
    };

    expect(blockedTenantScopeGuidance(input)).toBeUndefined();
  });
});
