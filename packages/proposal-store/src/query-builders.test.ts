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
});
