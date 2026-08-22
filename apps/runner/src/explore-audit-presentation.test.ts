import { describe, expect, it } from "vitest";
import { describeExploreAuditPlan, reconstructExploreAuditQuery } from "./explore-audit-presentation.js";
import { formatEvidenceBrowserFacts, formatEvidenceBrowserPlan, formatEvidenceBrowserQuery, formatEvidenceBrowserRow, formatEvidenceBrowserSummary, formatEvidenceDetail, formatEvidenceMarkdown, formatEvidenceSummary, formatQueryAuditBrowserFacts, formatQueryAuditBrowserPlan, formatQueryAuditBrowserQuery, formatQueryAuditBrowserRow, formatQueryAuditBrowserSummary, formatQueryAuditDetail } from "./proposal-formatting.js";

describe("Explore audit presentation", () => {
  it("reconstructs a privacy-safe aggregate and makes Runner scope predicates explicit", () => {
    const result = reconstructExploreAuditQuery({
      normalizedPlan: {
        kind: "aggregate",
        resource: "librarydb.members",
        measures: [{ function: "count" }],
        dimensions: [{ field: "membership_tier" }],
        where: [{ field: "join_year", op: "lt", value: { keyed_hash: "a".repeat(64) } }],
        top_n: 25,
      },
      scopeApplication: {
        tenant: { kind: "direct", predicate_applied: true, column: "tenant_id" },
        principal: { kind: "derived", predicate_applied: true, path_id: "members_owner_fk" },
      },
    });

    expect(result?.statement).toContain("SELECT\n  membership_tier,\n  COUNT(*) AS count");
    expect(result?.statement).toContain("FROM librarydb.members");
    expect(result?.statement).toContain("join_year < :value_1 /* redacted */");
    expect(result?.statement).toContain("tenant_id = :trusted_tenant /* Runner tenant scope */");
    expect(result?.statement).toContain("1 = 0 /* REQUIRED Runner principal scope; see notes for members_owner_fk */");
    expect(result?.statement).not.toContain("RUNNER_TENANT_PREDICATE");
    expect(result?.statement).not.toContain("RUNNER_PRINCIPAL_PREDICATE");
    expect(result?.caveats).toContain("Tenant scope: predicate applied by Runner through direct column tenant_id.");
    expect(result?.caveats).toContain("Principal scope: predicate applied by Runner through derived path members_owner_fk.");
    expect(result?.statement).toContain("GROUP BY\n  membership_tier");
    expect(result?.statement).toContain("LIMIT 25");
    expect(JSON.stringify(result)).not.toContain("private-year");
  });

  it("describes stored reviewed plans in plain English without claiming to store the request", () => {
    expect(describeExploreAuditPlan({
      kind: "aggregate",
      resource: "librarydb.members",
      measures: [{ function: "count" }],
      dimensions: [{ field: "membership_tier" }],
      where: [{ field: "join_year", op: "lt", value: { keyed_hash: "a".repeat(64) } }],
    })).toBe("Members grouped by membership tier with 1 reviewed filter.");
    expect(describeExploreAuditPlan({
      kind: "rows",
      resource: "librarydb.genre_catalog",
      select: ["code", "display_name"],
    })).toBe("Rows from genre catalog returning code and display name.");
  });

  it("renders rows, reviewed relationships, and no-predicate shared-reference posture without literals", () => {
    const result = reconstructExploreAuditQuery({
      normalizedPlan: {
        kind: "rows",
        resource: "librarydb.genre_catalog",
        select: ["code", "label"],
        where: [{
          field: "category",
          relationship: "genre_parent_fk",
          op: "in",
          value: { keyed_hash: "b".repeat(64) },
        }],
        order_by: [{ field: "label", direction: "asc" }],
        limit: 10,
      },
      scopeApplication: {
        tenant: { kind: "shared_reference", predicate_applied: false },
        principal: { kind: "not_configured", predicate_applied: false },
      },
    });

    expect(result?.statement).toContain("SELECT code, label");
    expect(result?.statement).toContain("NULL /* REQUIRED relationship JOIN; see notes */ IN (:value_1 /* redacted */)");
    expect(result?.statement).toContain("1 = 0 /* REQUIRED SQL reconstruction; see notes */");
    expect(result?.caveats).toContain("Relationship field category uses reviewed path genre_parent_fk; exact JOIN SQL was not persisted.");
    expect(result?.caveats).toContain("This template contains a required 1 = 0 guard and returns no source rows until every missing SQL expression is restored.");
    expect(result?.statement).toContain("tenant predicate not applied: shared reference");
    expect(result?.statement).toContain("principal predicate not applied: not configured");
    expect(result?.statement).toContain("ORDER BY label ASC");
  });

  it("labels legacy scope metadata as incomplete instead of claiming a predicate was applied", () => {
    const result = reconstructExploreAuditQuery({
      normalizedPlan: {
        kind: "aggregate",
        resource: "public.orders",
        measures: [{ function: "sum", field: "amount_cents" }],
        top_n: 5,
      },
      trustedScope: { tenant_bound: true, principal_bound: true },
      tenantRecorded: true,
      principalRecorded: true,
    });

    expect(result?.statement).toContain("1 = 0 /* REQUIRED Runner tenant scope; see notes */");
    expect(result?.statement).toContain("1 = 0 /* REQUIRED Runner principal scope; see notes */");
    expect(result?.statement).not.toContain("predicate applied by Runner");
    expect(result?.caveats).toContain("Exact tenant-predicate metadata was not recorded for this legacy event.");
  });

  it("groups the important audit facts, colors only interactive output, and leads with the readable query", () => {
    const evidence = {
      evidence_bundle_id: "ev_explore_display",
      tenant_id: `keyed:${"1".repeat(64)}`,
      principal: `keyed:${"2".repeat(64)}`,
      capability: "app.explore_data",
      source_id: "library_mysql",
      source_table: "librarydb.members",
      query_fingerprint: `sha256:${"3".repeat(64)}`,
      payload: {
        schema_version: "synapsor.analytics-evidence.v1",
        boundary_digest: `sha256:${"4".repeat(64)}`,
        generation_lock_fingerprint: `sha256:${"5".repeat(64)}`,
        role_posture_fingerprint: `sha256:${"6".repeat(64)}`,
        result_fingerprint: `hmac-sha256:${"7".repeat(64)}`,
        outcome: "ok",
        normalized_plan: {
          kind: "aggregate",
          resource: "librarydb.members",
          measures: [{ function: "count" }],
          dimensions: [{ field: "membership_tier" }],
          top_n: 25,
        },
        scope_application: {
          tenant: { kind: "direct", predicate_applied: true, column: "tenant_id" },
          principal: { kind: "not_configured", predicate_applied: false },
        },
        returned_rows_or_groups: 3,
        returned_cells: 6,
        suppressed_groups: 1,
        source_query_executed: true,
        source_database_changed: false,
        result_values_persisted: false,
        trusted_scope_values_persisted: false,
        execution_duration_ms: 42,
      },
      items: [],
      query_audit: [],
      created_at: "2026-08-16T01:02:03.000Z",
    };

    const plain = formatEvidenceDetail(evidence, false);
    expect(plain).toMatch(/IDENTITY AND RESOURCE[\s\S]*AUTHORITY[\s\S]*OUTCOME AND PRIVACY[\s\S]*EXECUTION/);
    expect(plain).toContain("Reconstructed reviewed query");
    expect(plain).toContain("tenant_id = :trusted_tenant");
    expect(plain).toContain("Tenant scope: predicate applied by Runner through direct column tenant_id.");
    expect(plain).not.toContain("\u001b[");

    const colored = formatEvidenceDetail(evidence, true);
    expect(colored).toContain("\u001b[");
    expect(colored).toMatch(/\u001b\[[0-9;]*32m/);

    const list = formatEvidenceSummary(evidence, false);
    const localTimestamp = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
      timeZoneName: "short",
    }).format(new Date(evidence.created_at));
    expect(list).toContain("Members grouped by membership tier.");
    expect(list).toContain("3 rows/groups / 6 cells / 1 suppressed");
    expect(list).toContain(localTimestamp);
    expect(list).not.toContain(evidence.created_at);
    expect(formatEvidenceMarkdown(evidence)).toContain(`Created at: ${evidence.created_at}`);
    expect(list).not.toContain("1".repeat(64));
    expect(formatEvidenceSummary(evidence, true)).toMatch(/\u001b\[[0-9;]*32m/);
    const evidenceBrowserRow = formatEvidenceBrowserRow(evidence, 1, false);
    expect(evidenceBrowserRow).toContain("Members grouped by membership tier.");
    expect(evidenceBrowserRow).toContain(localTimestamp);
    const evidenceBrowserSummary = formatEvidenceBrowserSummary(evidence, false);
    expect(evidenceBrowserSummary).not.toContain("Normalized reviewed plan");
    expect(evidenceBrowserSummary).toContain(`When: ${localTimestamp}`);
    const evidenceBrowserFacts = formatEvidenceBrowserFacts(evidence, false);
    expect(evidenceBrowserFacts).toContain("Generation lock");
    expect(evidenceBrowserFacts).toContain(`Created at: ${localTimestamp}`);
    expect(formatEvidenceBrowserQuery(evidence, false)).toContain("tenant_id = :trusted_tenant");
    expect(formatEvidenceBrowserPlan(evidence, false)).toContain('"membership_tier"');

    const refused = formatQueryAuditDetail({
      audit_id: 8,
      created_at: evidence.created_at,
      tenant_id: evidence.tenant_id,
      principal: evidence.principal,
      capability: evidence.capability,
      source_id: evidence.source_id,
      table_name: evidence.source_table,
      query_fingerprint: evidence.query_fingerprint,
      row_count: 0,
      payload: {
        status: "refused_before_source_execution",
        error_code: "EXPLORE_FIELD_FORBIDDEN",
        attempted_access: {
          resource: "librarydb.members",
          field: "membership_tier",
          operation: "group",
        },
        boundary_digest: evidence.payload.boundary_digest,
        normalized_plan: evidence.payload.normalized_plan,
        scope_application: evidence.payload.scope_application,
        source_query_executed: false,
        result_values_persisted: false,
        source_database_changed: false,
      },
    }, true);
    expect(refused).toContain("EXPLORE_FIELD_FORBIDDEN");
    expect(refused).toContain("librarydb.members.membership_tier (group)");
    expect(refused).toMatch(/\u001b\[[0-9;]*31m/);
    expect(refused).toContain("Reconstructed reviewed query");

    const refusedRecord = {
      audit_id: 8,
      created_at: evidence.created_at,
      tenant_id: evidence.tenant_id,
      principal: evidence.principal,
      capability: evidence.capability,
      source_id: evidence.source_id,
      table_name: evidence.source_table,
      query_fingerprint: evidence.query_fingerprint,
      row_count: 0,
      payload: {
        status: "refused_before_source_execution",
        error_code: "EXPLORE_FIELD_FORBIDDEN",
        attempted_access: {
          resource: "librarydb.members",
          field: "membership_tier",
          operation: "group",
        },
        boundary_digest: evidence.payload.boundary_digest,
        scope_application: evidence.payload.scope_application,
        source_query_executed: false,
        result_values_persisted: false,
        source_database_changed: false,
      },
    };
    const queryAuditBrowserRow = formatQueryAuditBrowserRow(refusedRecord, 1, false);
    expect(queryAuditBrowserRow).toContain("Refused group on membership tier in members.");
    expect(queryAuditBrowserRow).toContain(localTimestamp);
    const queryAuditBrowserSummary = formatQueryAuditBrowserSummary(refusedRecord, false);
    expect(queryAuditBrowserSummary).toContain("EXPLORE_FIELD_FORBIDDEN");
    expect(queryAuditBrowserSummary).toContain("librarydb.members.membership_tier (group)");
    expect(queryAuditBrowserSummary).toContain(`When: ${localTimestamp}`);
    expect(formatQueryAuditBrowserFacts(refusedRecord, false)).toContain("Source query executed: no");
    expect(formatQueryAuditBrowserQuery(refusedRecord, false)).toContain("not recorded");
    expect(formatQueryAuditBrowserPlan(refusedRecord, false)).toContain("not recorded");

    const legacyWithoutTopLevelResource = {
      ...evidence,
      source_table: undefined,
    };
    expect(formatEvidenceSummary(legacyWithoutTopLevelResource, false)).toContain("Resource librarydb.members");
  });
});
