import { describe, expect, it } from "vitest";
import { ProposalStore } from "./index.js";

describe("Explore audit query filters", () => {
  it("filters keyed scopes, boundary, outcome, resource, and time without result values", () => {
    const store = new ProposalStore(":memory:");
    try {
      store.recordQueryAudit({
        tenant_id: "keyed:tenant",
        principal: "keyed:principal",
        capability: "app.explore_data",
        source_id: "library_mysql",
        query_fingerprint: "sha256:query",
        table_name: "librarydb.members",
        row_count: 0,
        created_at: "2026-08-15T10:00:00.000Z",
        payload: {
          scoped_explore_version: "1.7.0",
          boundary_digest: `sha256:${"b".repeat(64)}`,
          status: "refused_before_source_execution",
          result_values_persisted: false,
        },
      });
      expect(store.listQueryAudit({
        tenants: ["keyed:other", "keyed:tenant"],
        principals: ["keyed:principal"],
        table: "librarydb.members",
        boundary: `sha256:${"b".repeat(64)}`,
        outcome: "refused",
        from: "2026-08-15T09:00:00.000Z",
        to: "2026-08-15T11:00:00.000Z",
      })).toHaveLength(1);
      expect(store.listQueryAudit({ outcome: "ok" })).toHaveLength(0);
      expect(JSON.stringify(store.listQueryAudit())).not.toContain("result_rows");
    } finally {
      store.close();
    }
  });

  it("searches redacted plan metadata and pages without loading the full ledger", () => {
    const store = new ProposalStore(":memory:");
    try {
      for (const [index, field] of ["membership_tier", "loan_status", "genre_code"].entries()) {
        store.recordQueryAudit({
          tenant_id: "keyed:tenant",
          capability: "app.explore_data",
          source_id: "library_mysql",
          query_fingerprint: `sha256:query-${index}`,
          table_name: "librarydb.members",
          row_count: index + 1,
          created_at: `2026-08-15T10:00:0${index}.000Z`,
          payload: {
            scoped_explore_version: "1.7.0",
            status: "ok",
            normalized_plan: {
              kind: "aggregate",
              resource: "librarydb.members",
              measures: [{ function: "count" }],
              dimensions: [{ field }],
            },
            result_values_persisted: false,
          },
        });
        store.recordEvidenceBundle({
          evidence_bundle_id: `ev_search_${index}`,
          tenant_id: "keyed:tenant",
          created_at: `2026-08-15T10:00:0${index}.000Z`,
          payload: {
            schema_version: "synapsor.analytics-evidence.v1",
            capability: "app.explore_data",
            source_id: "library_mysql",
            source_table: "librarydb.members",
            query_fingerprint: `sha256:evidence-${index}`,
            normalized_plan: {
              kind: "aggregate",
              resource: "librarydb.members",
              measures: [{ function: "count" }],
              dimensions: [{ field }],
            },
            result_values_persisted: false,
          },
          query_audit: [],
        });
      }

      expect(store.listQueryAudit({ search: "membership_tier" })).toEqual([
        expect.objectContaining({ query_fingerprint: "sha256:query-0" }),
      ]);
      expect(store.listQueryAudit({ search: "MEMBERS", limit: 1, offset: 1 })).toEqual([
        expect.objectContaining({ query_fingerprint: "sha256:query-1" }),
      ]);
      expect(store.listQueryAudit({ search: "%" })).toHaveLength(0);
      expect(store.listQueryAudit({ search: "query-0" })).toEqual([
        expect.objectContaining({ query_fingerprint: "sha256:query-0" }),
      ]);
      expect(store.listEvidenceBundles({ search: "loan_status" })).toEqual([
        expect.objectContaining({ evidence_bundle_id: "ev_search_1" }),
      ]);
      expect(store.listEvidenceBundles({ search: "evidence-2" })).toEqual([
        expect.objectContaining({ evidence_bundle_id: "ev_search_2" }),
      ]);
      expect(store.listEvidenceBundles({ search: "librarydb.members", limit: 1, offset: 2 })).toEqual([
        expect.objectContaining({ evidence_bundle_id: "ev_search_0" }),
      ]);
    } finally {
      store.close();
    }
  });
});
