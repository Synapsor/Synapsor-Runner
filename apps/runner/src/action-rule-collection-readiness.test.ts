import { describe, expect, it } from "vitest";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { compileActionRule } from "@synapsor-runner/action-rules";
import { completeCollectionFixture } from "../../../packages/action-rules/src/testing/complete-collection-fixture.js";
import { actionRuleCollectionReadiness } from "./action-rule-collection-readiness.js";

const predicate = "tenant_id::text = nullif(current_setting('synapsor.tenant_id', true), '') AND principal_id::text = nullif(current_setting('synapsor.principal', true), '')";
function fixture() {
  const compiled = compileActionRule(completeCollectionFixture());
  const table: TableInfo = { schema: "collections", name: "holds", type: "table", writable: true,
    columns: [], primary_key: ["hold_id"], unique_constraints: [], indexes: [],
    foreign_keys: [{ name: "holds_customer_fk", columns: ["tenant_id", "principal_id", "customer_id"], referenced_schema: "collections",
      referenced_table: "customers", referenced_columns: ["tenant_id", "principal_id", "customer_id"], delete_rule: "NO ACTION" }],
    row_level_security: true,
    row_level_security_policies: ["SELECT", "UPDATE"].map(command => ({ name: command, command, permissive: true, roles: ["reader"], using_expression: predicate })),
    role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      privileges: { select: true, update: false, insert: false, delete: false, truncate: false, references: false, trigger: false },
      row_security_forced: true, row_security_effective_for_current_role: true, row_security_applicable_policies: ["SELECT", "UPDATE"] },
    suggestions: { tenant_columns: [], conflict_columns: [], sensitive_columns: [], default_visible_columns: [] } };
  const inspection = { engine: "postgres", tables: [table] } as SchemaInspection;
  const source = { engine: "postgres" as const, read_url_env: "DATABASE_URL",
    database_scope: { mode: "postgres_rls" as const, tenant_setting: "synapsor.tenant_id", principal_setting: "synapsor.principal" } };
  return { compiled, inspection, source, connection: "reader" as const, table };
}
describe("complete collection readiness without runtime customer values", () => {
  it("checks native UUID filters consistently with runtime without accepting unproven casts", () => {
    const f = fixture();
    for (const policy of f.table.row_level_security_policies!) policy.using_expression = "tenant_id = nullif(current_setting('synapsor.tenant_id',true),'')::uuid AND principal_id = nullif(current_setting('synapsor.principal',true),'')::uuid";
    expect(actionRuleCollectionReadiness(f)).toHaveLength(1);
    f.table.columns = ["tenant_id", "principal_id"].map((name, index) => ({ name, data_type: "uuid", nullable: false,
      generated: false, ordinal_position: index + 1,
      suggestions: { tenant: false, conflict: false, sensitive: false, immutable: true, large_or_binary: false } }));
    expect(actionRuleCollectionReadiness(f)).toEqual([]);
    expect(actionRuleCollectionReadiness({ ...f, connection: "writer" })).toEqual([]);
    f.table.columns[0]!.data_type = "text";
    expect(actionRuleCollectionReadiness(f)).toHaveLength(1);
  });
  it("checks a read connection without pretending writer policies or privileges were checked", () => {
    const f = fixture();
    f.table.role_posture!.row_security_applicable_policies = ["SELECT"];
    expect(actionRuleCollectionReadiness(f)).toEqual([]);
    expect(actionRuleCollectionReadiness({ ...f, connection: "writer" })).toMatchObject([{ reason: expect.stringContaining("write/locking") }]);
  });
  it.each(["deferred", "unvalidated", "hidden", "unknown", "missing_fk", "wrong_setting"])("surfaces %s before execution activation", issue => {
    const f = fixture();
    if (issue === "deferred") f.table.foreign_keys[0]!.deferrable = true;
    if (issue === "unvalidated") f.table.foreign_keys[0]!.action_rule_issue = "unvalidated_foreign_key";
    if (issue === "missing_fk") f.table.foreign_keys = [];
    if (issue === "hidden") f.table.row_level_security_policies![0]!.using_expression += " AND state='released'";
    if (issue === "unknown") delete f.table.role_posture!.row_security_applicable_policies;
    if (issue === "wrong_setting") f.source.database_scope.principal_setting = "other.principal";
    const before = structuredClone(f);
    expect(actionRuleCollectionReadiness(f).length).toBeGreaterThan(0);
    expect(f).toEqual(before);
  });
  it("ignores policies which do not apply, but not restrictive policies which do", () => {
    const f = fixture();
    f.table.row_level_security_policies!.push({ name: "hidden", command: "SELECT", roles: ["another_role"], permissive: false, using_expression: "false" });
    expect(actionRuleCollectionReadiness(f)).toEqual([]);
    f.table.role_posture!.row_security_applicable_policies!.push("hidden");
    expect(actionRuleCollectionReadiness(f)).toHaveLength(1);
  });
});
