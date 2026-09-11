import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exportWriterProvisioning, writerPolicyRepairSummary, type WriterProvisioningPlan } from "./writer-provisioning.js";
import { writerPolicyRepair } from "./writer-rls-repair.js";

function simpleWriterPlan(): WriterProvisioningPlan {
  return { version: 1, engine: "postgres", outcome: "school.enroll", action_digest: `sha256:${"a".repeat(64)}`,
    writer_env: "WRITER_URL", read_env: "DATABASE_URL", suggested_role: "runner_writer_012345abcdef", relations: [
      { relation: "school.students", schema: "school", table: "students", privileges: ["select", "update"], update_columns: ["status", "version"],
        lock_column: "student_id", rls_required: true, row_security: { enabled: true, forced: true }, triggers: [],
        row_scope: [{ field: "institution_id", setting: "app.institution" }, { field: "student_id", setting: "app.student" }],
        policies: [{ name: "student_read", command: "SELECT", permissive: true, roles: ["reader"],
          using_expression: "institution_id::text = nullif(current_setting('app.institution', true), '') AND student_id::text = nullif(current_setting('app.student', true), '')" }] },
    ] };
}

describe("administrator-reviewed simple row-policy repair", () => {
  it("exports a separate, drift-checked repair without mutating the input or executing SQL", async () => {
    const plan = simpleWriterPlan(), before = structuredClone(plan);
    const repair = writerPolicyRepair(plan);
    expect(repair.blockers).toEqual([]); expect(repair.changes).toHaveLength(2);
    expect(repair.sql).toContain("Policies changed after export");
    expect(repair.sql).toContain('FOR UPDATE TO "runner_writer_012345abcdef"');
    expect(repair.sql).not.toMatch(/ALTER TABLE|ALTER POLICY|DROP |GRANT |DISABLE ROW/);
    expect(writerPolicyRepairSummary(plan).join("\n")).toContain("scoped-policies.sql after grants.sql");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-policy-export-"));
    try {
      const exported = await exportWriterProvisioning(root, plan);
      expect(await fs.readFile(path.join(exported, "scoped-policies.sql"), "utf8")).toBe(repair.sql);
      expect(await fs.readFile(path.join(exported, "README.md"), "utf8")).toContain("After grants.sql");
      expect(await fs.readFile(path.join(exported, "grants.sql"), "utf8")).not.toContain("CREATE POLICY");
      expect(plan).toEqual(before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it.each(["missing_scope", "unforced", "custom_predicate", "restrictive", "multiple_reads_custom", "multiple_reads_restrictive", "multiple_reads_narrowed", "missing_read", "extra_setting", "check_predicate", "trigger", "all_policy"])("leaves %s for explicit administrator review", change => {
    const plan = simpleWriterPlan(), relation = plan.relations[0]!;
    if (change === "missing_scope") delete relation.row_scope;
    if (change === "unforced") relation.row_security!.forced = false;
    if (change === "custom_predicate") relation.policies[0]!.using_expression += " AND status='admitted'";
    if (change === "restrictive") relation.policies[0]!.permissive = false;
    if (change === "multiple_reads_custom") relation.policies.push({ ...relation.policies[0]!, name: "other", using_expression: "true" });
    if (change === "multiple_reads_restrictive") relation.policies.push({ ...relation.policies[0]!, name: "other", permissive: false });
    if (change === "multiple_reads_narrowed") relation.policies.push({ ...relation.policies[0]!, name: "other", using_expression: `${relation.policies[0]!.using_expression} AND status='admitted'` });
    if (change === "missing_read") relation.policies = [];
    if (change === "extra_setting") relation.row_scope![0]!.setting = "unreviewed.identity";
    if (change === "check_predicate") relation.policies.push({ name: "write", command: "UPDATE", permissive: true, roles: ["public"], using_expression: relation.policies[0]!.using_expression, check_expression: "true" });
    if (change === "trigger") relation.triggers.push({ name: "custom" } as typeof relation.triggers[number]);
    if (change === "all_policy") relation.policies[0]!.command = "ALL";
    const repair = writerPolicyRepair(plan);
    expect(repair.sql).toBeUndefined(); expect(repair.changes).toEqual([]);
    expect(repair.blockers[0]).toContain("school.students:");
    expect(writerPolicyRepairSummary(plan).join("\n")).toContain("grants alone will not complete setup");
  });
  it.each(["identical", "equivalent", "equivalent_reversed"] as const)("prepares another dedicated writer with %s reviewed SELECT policies", kind => {
    const plan = simpleWriterPlan(), relation = plan.relations[0]!;
    const priorRole = "runner_writer_abcdef012345";
    const predicate = kind === "identical" ? relation.policies[0]!.using_expression! :
      "nullif(current_setting('app.student', true),'') = student_id::text AND institution_id::text = nullif(current_setting('app.institution', true),'')";
    relation.policies.push({ name: "prior_writer_read", command: "SELECT", permissive: true, roles: [priorRole], using_expression: predicate },
      { name: "prior_writer_lock", command: "UPDATE", permissive: true, roles: [priorRole], using_expression: predicate, check_expression: predicate });
    if (kind === "equivalent_reversed") relation.policies.reverse();
    const before = structuredClone(plan), repair = writerPolicyRepair(plan);
    expect(repair.blockers).toEqual([]);
    expect(repair.changes).toHaveLength(2);
    expect(repair.sql).toContain('FOR SELECT TO "runner_writer_012345abcdef"');
    expect(repair.sql).toContain('FOR UPDATE TO "runner_writer_012345abcdef"');
    expect(repair.sql).toContain("prior_writer_read");
    expect(repair.sql).toContain("prior_writer_lock");
    expect(repair.sql).toContain("Policies changed after export");
    expect(repair.sql).toContain(`USING (${relation.policies.find(policy => policy.command === "SELECT")!.using_expression})`);
    expect(repair.sql).not.toMatch(/ALTER POLICY|DROP POLICY|GRANT /);
    expect(plan).toEqual(before);
  });
  it("reuses an applicable public policy rather than duplicating it", () => {
    const plan = simpleWriterPlan(), relation = plan.relations[0]!;
    relation.policies.push({ ...relation.policies[0]!, name: "prior_writer_read", roles: ["runner_writer_abcdef012345"] });
    relation.policies[0]!.roles = ["public"];
    expect(writerPolicyRepair(plan).changes).toHaveLength(1);
    relation.policies.push({ ...relation.policies[0]!, name: "write", command: "UPDATE", check_expression: relation.policies[0]!.using_expression });
    expect(writerPolicyRepair(plan)).toEqual({ blockers: [], changes: [] });
  });
});
