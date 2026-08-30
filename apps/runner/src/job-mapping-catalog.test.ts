import { describe, expect, it } from "vitest";
import type { BoundaryResourceReviewView } from "./boundary-review-mutation.js";
import { buildJobMappingCatalog } from "./job-mapping-catalog.js";

describe("job mapping catalog", () => {
  it("prepares direct, uniquely proven derived, shared, and manual resources without granting authority", () => {
    const direct = reviewView({
      id: "ops.accounts",
      generated: true,
      relationships: [{ target: "ops.regions" }],
    });
    const directOutsideDraft = reviewView({
      id: "ops.dispatch_settings",
      generated: true,
      included: false,
    });
    const oneHop = reviewView({
      id: "ops.orders",
      tenantPaths: [path("orders_account_fk", [
        ["ops.orders", "ops.accounts", "account_id"],
      ])],
      relationships: [{ target: "ops.accounts" }],
    });
    const twoHop = reviewView({
      id: "ops.events",
      tenantPaths: [path("events_order_fk__orders_account_fk", [
        ["ops.events", "ops.orders", "order_id"],
        ["ops.orders", "ops.accounts", "account_id"],
      ])],
      relationships: [{ target: "ops.orders" }],
    });
    const threeHop = reviewView({
      id: "ops.event_flags",
      tenantPaths: [path("flags_event_fk__events_order_fk__orders_account_fk", [
        ["ops.event_flags", "ops.events", "event_id"],
        ["ops.events", "ops.orders", "order_id"],
        ["ops.orders", "ops.accounts", "account_id"],
      ])],
      relationships: [{ target: "ops.events" }],
    });
    const shared = reviewView({ id: "ops.regions", shared: true });
    const ambiguous = reviewView({
      id: "ops.transfers",
      tenantPaths: [
        path("transfer_from_fk", [["ops.transfers", "ops.accounts", "from_account_id"]]),
        path("transfer_to_fk", [["ops.transfers", "ops.accounts", "to_account_id"]]),
      ],
    });

    const views = [ambiguous, shared, threeHop, directOutsideDraft, direct, oneHop, twoHop];
    const result = buildJobMappingCatalog(views);

    expect(result).toMatchObject({
      schema_version: "synapsor.job-mapping-catalog.v1",
      direct_resources: ["ops.accounts", "ops.dispatch_settings"],
      direct_resources_to_include: ["ops.dispatch_settings"],
      derived_resources: [
        { resource_id: "ops.orders", tenant_scope: { path_id: "orders_account_fk", depth: 1 } },
        { resource_id: "ops.events", tenant_scope: { depth: 2 } },
        { resource_id: "ops.event_flags", tenant_scope: { depth: 3 } },
      ],
      shared_reference_resources: [{ resource_id: "ops.regions", row_identity: "id" }],
      manual_resources: [{ resource_id: "ops.transfers", reason: expect.stringContaining("multiple proven paths") }],
      current_limits: { max_derived_scope_hops: 2, max_analysis_relationship_hops: 2 },
      proposed_limits: { max_derived_scope_hops: 3, max_analysis_relationship_hops: 3 },
      plan_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(buildJobMappingCatalog(views).plan_digest)
      .toBe(result.plan_digest);
  });

  it("keeps ambiguous principal paths and missing row identity in manual review", () => {
    const principalAmbiguous = reviewView({
      id: "ops.tasks",
      tenantPaths: [path("tasks_account_fk", [["ops.tasks", "ops.accounts", "account_id"]])],
      principalPaths: [
        path("tasks_owner_fk", [["ops.tasks", "ops.users", "owner_id"]]),
        path("tasks_assignee_fk", [["ops.tasks", "ops.users", "assignee_id"]]),
      ],
    });
    const noIdentity = reviewView({ id: "ops.logs", rowIdentity: [] });

    const result = buildJobMappingCatalog([principalAmbiguous, noIdentity]);

    expect(result.derived_resources).toEqual([]);
    expect(result.manual_resources).toEqual([
      { resource_id: "ops.logs", reason: "Row identity is ambiguous." },
      { resource_id: "ops.tasks", reason: expect.stringContaining("Principal scope") },
    ]);
  });
});

function reviewView(input: {
  id: string;
  generated?: boolean;
  included?: boolean;
  shared?: boolean;
  rowIdentity?: string[];
  tenantPaths?: Array<ReturnType<typeof path>>;
  principalPaths?: Array<ReturnType<typeof path>>;
  relationships?: Array<{ target: string }>;
}): BoundaryResourceReviewView {
  return {
    ok: true,
    resource_id: input.id,
    status: "reviewable",
    included: input.included ?? Boolean(input.generated),
    blockers: [],
    row_identity: { candidates: input.rowIdentity ?? ["id"], confidence: "high", evidence: [] },
    tenant_key: { candidates: [], confidence: "none", evidence: [] },
    ...(input.tenantPaths ? { derived_tenant_scope: { candidates: input.tenantPaths } } : {}),
    ...(input.shared ? { shared_reference_scope: { eligible: true, blockers: [] } } : {}),
    principal_key: { candidates: [], confidence: "none", evidence: [] },
    ...(input.principalPaths ? { derived_principal_scope: { candidates: input.principalPaths } } : {}),
    fields: [],
    relationships: (input.relationships ?? []).map(({ target }, index) => ({
      name: `relationship_${index}`,
      columns: ["id"],
      referenced_resource: target,
      referenced_columns: ["id"],
      reviewed_cardinality: "many_to_one_candidate" as const,
      review_required: true as const,
      nullable: false,
      cardinality_proven: true,
    })),
    candidate: input.generated ? {} as BoundaryResourceReviewView["candidate"] : null,
    generated_candidate: input.generated ? {} as BoundaryResourceReviewView["generated_candidate"] : null,
    bindings: {} as BoundaryResourceReviewView["bindings"],
    reviewed_budgets: {
      max_relationship_hops: 2,
      max_derived_scope_hops: 2,
      max_analysis_relationship_hops: 2,
    } as BoundaryResourceReviewView["reviewed_budgets"],
    source_database_changed: false,
  } as unknown as BoundaryResourceReviewView;
}

function path(
  id: string,
  links: Array<[string, string, string]>,
) {
  return {
    path_id: id,
    ancestor_resource: links.at(-1)![1],
    proof: {
      links: links.map(([source, target, column], index) => ({
        constraint: `${id}_${index}`,
        source_resource: source,
        source_columns: [column],
        target_resource: target,
        target_columns: ["id"],
        nullable: false,
        cardinality: "many_to_one" as const,
        target_uniqueness: { kind: "primary_key" as const, columns: ["id"] },
      })),
      digest: `sha256:${"a".repeat(64)}` as const,
    },
  };
}
