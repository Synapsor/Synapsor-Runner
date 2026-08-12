import { describe, expect, it } from "vitest";
import { ProposalStore, type ProductionExploreAuditEventInput } from "@synapsor-runner/proposal-store";
import { importProductionExploreAuditEvents } from "./store-shared.js";

describe("shared PostgreSQL production Explore audit hydration", () => {
  it("hydrates evidence and its linked query audit with original timestamps", () => {
    const store = new ProposalStore(":memory:");
    const createdAt = "2026-08-11T10:20:30.000Z";
    const event: ProductionExploreAuditEventInput = {
      event_id: "ev_explore_fixture",
      event_kind: "evidence_bundle",
      created_at: createdAt,
      payload: {
        evidence_bundle: {
          evidence_bundle_id: "ev_explore_fixture",
          tenant_id: "keyed:tenant-fixture",
          payload: {
            schema_version: "synapsor.analytics-evidence.v1",
            capability: "app.explore_data",
            source_id: "app_postgres",
            source_table: "public.orders",
            query_fingerprint: "sha256:query-fixture",
            result_values_persisted: false,
          },
          items: [],
          query_audit: [{
            source_id: "app_postgres",
            query_fingerprint: "sha256:query-fixture",
            table_name: "public.orders",
            row_count: 3,
            payload: {
              scoped_explore_version: "1.7.0",
              capability: "app.explore_data",
              status: "ok",
              normalized_plan: { kind: "aggregate", resource: "public.orders" },
              result_values_persisted: false,
            },
          }],
        },
      },
    };

    try {
      expect(importProductionExploreAuditEvents(store, [event])).toEqual({ imported: 1, skipped: 0 });
      const evidence = store.getEvidenceBundle("ev_explore_fixture");
      expect(evidence).toMatchObject({
        tenant_id: "keyed:tenant-fixture",
        source_id: "app_postgres",
        source_table: "public.orders",
        created_at: createdAt,
      });
      expect(evidence?.query_audit).toHaveLength(1);
      expect(evidence?.query_audit[0]).toMatchObject({
        table_name: "public.orders",
        row_count: 3,
        created_at: createdAt,
        evidence_bundle_id: "ev_explore_fixture",
      });
      expect(store.listEvidenceBundles({ tenant: "keyed:tenant-fixture" })).toHaveLength(1);
      expect(store.listQueryAudit({ table: "public.orders" })).toHaveLength(1);
      expect(JSON.stringify(evidence)).not.toContain("result_rows");
    } finally {
      store.close();
    }
  });

  it("hydrates refusal-only query audits and rejects malformed event envelopes", () => {
    const store = new ProposalStore(":memory:");
    const refusal: ProductionExploreAuditEventInput = {
      event_id: "audit_explore_fixture",
      event_kind: "query_audit",
      created_at: "2026-08-11T10:21:30.000Z",
      payload: {
        query_audit: {
          source_id: "app_mysql",
          query_fingerprint: "sha256:refusal-fixture",
          table_name: "public.orders",
          row_count: 0,
          payload: {
            scoped_explore_version: "1.7.0",
            status: "refused_before_source_execution",
            error_code: "EXPLORE_PLAN_INVALID",
            source_query_executed: false,
            result_values_persisted: false,
          },
        },
      },
    };

    try {
      importProductionExploreAuditEvents(store, [refusal]);
      expect(store.listQueryAudit({ source: "app_mysql" })).toEqual([
        expect.objectContaining({
          table_name: "public.orders",
          row_count: 0,
          created_at: refusal.created_at,
          payload: expect.objectContaining({ error_code: "EXPLORE_PLAN_INVALID" }),
        }),
      ]);
      expect(() => importProductionExploreAuditEvents(store, [{
        ...refusal,
        event_id: "audit_explore_bad",
        payload: { query_audit: { row_count: 0 } },
      }])).toThrow("audit_explore_bad is malformed");
    } finally {
      store.close();
    }
  });
});
