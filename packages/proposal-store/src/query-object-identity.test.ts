import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildEvidenceQuery, buildProposalCountQuery, buildProposalQuery, buildQueryAuditQuery, buildReceiptQuery, type SqlQuery } from "./query-builders.js";

// Exercise production SQL against distinct stored identities. This is a local
// ledger search filter; matching a token does not grant Source authority.
function fixture() {
  const db = new DatabaseSync(":memory:");
  const columns = "proposal_id TEXT, tenant_id TEXT, principal TEXT, source_id TEXT, business_object TEXT, source_table TEXT, table_name TEXT, object_id TEXT, created_at TEXT, action TEXT";
  for (const table of ["proposals", "evidence_bundles", "query_audit"]) db.exec(`CREATE TABLE ${table} (${columns})`);
  db.exec("CREATE TABLE writeback_receipts (proposal_id TEXT, created_at TEXT)");
  const add = (id: string, object: string, table: string, tenant = "team-a", principal = "person-a", source = "source-a", objectId = "row-a") => {
    for (const destination of ["proposals", "evidence_bundles", "query_audit"]) {
      db.prepare(`INSERT INTO ${destination} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenant, principal, source, object, table, table, objectId, "2026-10-08T00:00:00Z", "change");
    }
    db.prepare("INSERT INTO writeback_receipts VALUES (?, ?)").run(id, "2026-10-08T00:00:00Z");
  };
  add("singular", "invoice", "private.a");
  add("plural", "invoices", "private.b");
  add("schema-alias", "other", "public.invoice");
  add("exact-table", "other", "invoice");
  add("foreign-tenant", "invoice", "invoice", "team-b");
  add("foreign-principal", "invoice", "invoice", "team-a", "person-b");
  add("foreign-source", "invoice", "invoice", "team-a", "person-a", "source-b");
  add("foreign-object-id", "invoice", "invoice", "team-a", "person-a", "source-a", "row-b");
  add("literal", "x' OR 1=1 --", "private.literal");
  return { db, select: (query: SqlQuery) => db.prepare(query.sql).all(...query.params).map((row) => row.proposal_id).sort() };
}

const scopes = { tenant: "team-a", principal: "person-a", source: "source-a", objectId: "row-a" };
for (const [name, build] of Object.entries({ proposal: buildProposalQuery, evidence: buildEvidenceQuery, audit: buildQueryAuditQuery, receipt: buildReceiptQuery })) {
  describe(`${name}: exact object identity`, () => {
    it("matches only the exact business object or table, retaining every conjunctive scope", () => {
      const { db, select } = fixture();
      try { expect(select(build({ ...scopes, objectType: "invoice" }))).toEqual(["exact-table", "singular"]); }
      finally { db.close(); }
    });
    it("does not stem a plural, guess a schema, or broaden a missing identifier", () => {
      const { db, select } = fixture();
      try {
        expect(select(build({ ...scopes, objectType: "invoices" }))).toEqual(["plural"]);
        expect(select(build({ ...scopes, objectType: "public.invoice" }))).toEqual(["schema-alias"]);
        expect(select(build({ ...scopes, objectType: "Invoice" }))).toEqual([]);
      } finally { db.close(); }
    });
    it("keeps literal punctuation parameterized and leaves the separate table filter unchanged", () => {
      const { db, select } = fixture();
      try {
        expect(select(build({ ...scopes, objectType: "x' OR 1=1 --" }))).toEqual(["literal"]);
        expect(select(build({ ...scopes, table: "invoice" }))).toEqual(["exact-table", "schema-alias"]);
      } finally { db.close(); }
    });
  });
}

it("proposal count and selected rows use the same exact identity contract", () => {
  const { db, select } = fixture();
  try {
    const filters = { ...scopes, objectType: "invoice" };
    const query = buildProposalCountQuery(filters);
    expect(db.prepare(query.sql).get(...query.params)?.count).toBe(2);
    expect(select(buildProposalQuery(filters))).toEqual(["exact-table", "singular"]);
  } finally { db.close(); }
});
