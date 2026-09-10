import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { SupervisedWriterPostureAssessment } from "./worker-policy.js";
import { exportWriterProvisioning, writerProvisioningPlan, writerProvisioningSql,
  type WriterProvisioningPlan } from "./writer-provisioning.js";

const roots: string[] = [];
const actionDigest = `sha256:${"a".repeat(64)}`;

function inspection(): SchemaInspection {
  return {
    engine: "postgres",
    tables: [
      {
        schema: "telecom", name: "subscriptions", type: "table",
        columns: ["subscription_id", "plan_code", "base_monthly_cents", "version", "updated_at"].map((name) => ({ name })),
        row_level_security_policies: [{ name: "subscriptions_select", command: "SELECT", permissive: true, roles: ["public"] }],
        write_triggers: [],
      },
      {
        schema: "telecom", name: "plan_change_offers", type: "table",
        columns: ["plan_offer_id", "status", "version"].map((name) => ({ name })),
        row_level_security_policies: [{ name: "offers_select", command: "SELECT", permissive: true, roles: ["public"] }],
        write_triggers: [],
      },
      {
        schema: "telecom", name: "unrelated_secrets", type: "table",
        columns: [{ name: "secret" }], row_level_security_policies: [], write_triggers: [],
      },
    ],
  } as unknown as SchemaInspection;
}

function assessment(): SupervisedWriterPostureAssessment {
  return {
    ok: false, fingerprint: `sha256:${"b".repeat(64)}`, expected_fingerprint: null,
    reasons: ["writer_row_lock_privilege_missing"], allowed_relations: [], writable_relations: [],
    required_relations: [
      { relation: "telecom.subscriptions", privileges: ["select", "update"], update_columns: ["base_monthly_cents", "plan_code", "version"], lock_column: "subscription_id", rls_required: true },
      { relation: "telecom.plan_change_offers", privileges: ["select"], update_columns: [], lock_column: "plan_offer_id", rls_required: true },
    ],
  };
}

function plan(): WriterProvisioningPlan {
  const result = writerProvisioningPlan({ assessment: assessment(), inspection: inspection(),
    outcome: "telecom.plan_change_offer_switch", actionDigest, writerEnv: "SYNAPSOR_DATABASE_WRITE_URL" });
  if (!result) throw new Error("expected a PostgreSQL writer plan");
  return result;
}

afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("dedicated writer provisioning handoff", () => {
  it.each([false, true])("exports a separately reviewed telecom writer without broadening the old one (consume=%s)", async (consume) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-telecom-writer-"));
    roots.push(root);
    const reviewed = plan();
    reviewed.relations[0]!.update_columns = ["base_monthly_cents", "data_policy", "effective_from", "included_lines",
      "international_day_pass", "plan_code", "plan_display_name", "version"];
    if (consume) {
      reviewed.relations[1]!.privileges = ["select", "update"];
      reviewed.relations[1]!.update_columns = ["status", "version"];
    }
    const handoff = await exportWriterProvisioning(root, reviewed), output = path.join(root, "new-writer.sql");
    const recipe = path.resolve("examples/telecom-writer-repair/prepare.mjs");
    const inputBefore = await fs.readFile(path.join(handoff, "requirements.json"), "utf8");
    await promisify(execFile)(process.execPath, [recipe, handoff, output]);
    const sql = await fs.readFile(output, "utf8");
    expect(sql).toContain(consume ? 'GRANT UPDATE ("status", "version") ON TABLE "telecom"."plan_change_offers"'
      : 'GRANT UPDATE ("plan_offer_id") ON TABLE "telecom"."plan_change_offers"');
    expect(sql).not.toMatch(/ALTER ROLE "synapsor_plan_writer"|GRANT.*TO "synapsor_plan_writer"/);
    expect(sql).toContain("Fixture policies changed after export");
    expect(sql).toContain("No password, shared-role mutation, source row change, or execution activation");
    expect(await fs.readFile(path.join(handoff, "requirements.json"), "utf8")).toBe(inputBefore);
    await expect(promisify(execFile)(process.execPath, [recipe, handoff, output])).rejects.toThrow();
    expect(await fs.readFile(output, "utf8")).toBe(sql);
    reviewed.relations[1]!.update_columns = ["status", "version", "plan_code"];
    const unrelated = await exportWriterProvisioning(root, reviewed), refusedOutput = path.join(root, "refused.sql");
    await expect(promisify(execFile)(process.execPath, [recipe, unrelated, refusedOutput])).rejects.toThrow(/not the supported two-relation/);
    await expect(fs.access(refusedOutput)).rejects.toThrow();
  });
  it("derives only the reviewed effect columns and private-lock identity from the posture assessment", () => {
    const output = writerProvisioningSql(plan());

    expect(output).toContain('GRANT UPDATE ("base_monthly_cents", "plan_code", "version") ON TABLE "telecom"."subscriptions"');
    expect(output).not.toContain('"updated_at"');
    expect(output).toContain('GRANT SELECT ON TABLE "telecom"."plan_change_offers"');
    expect(output).toContain('GRANT UPDATE ("plan_offer_id") ON TABLE "telecom"."plan_change_offers"');
    expect(output).not.toContain('GRANT UPDATE ("status", "version") ON TABLE "telecom"."plan_change_offers"');
    expect(output).not.toContain('"telecom"."unrelated_secrets"');
  });

  it("quotes forged relation and column identifiers rather than interpolating executable SQL", () => {
    const forged: WriterProvisioningPlan = {
      ...plan(),
      relations: [{ ...plan().relations[0]!, schema: 'telecom"; REVOKE ALL; --', table: 'subscriptions"; DROP TABLE x; --',
        update_columns: ['plan_code"; GRANT pg_read_all_data TO public; --'], lock_column: undefined }],
    };
    const output = writerProvisioningSql(forged);

    expect(output).toContain('"telecom""; REVOKE ALL; --"."subscriptions""; DROP TABLE x; --"');
    expect(output).toContain('"plan_code""; GRANT pg_read_all_data TO public; --"');
    expect(output.split("\n")).not.toContain("GRANT pg_read_all_data TO public;");
  });

  it("creates a new NOLOGIN role without granting membership in or changing the shared writer", () => {
    const output = writerProvisioningSql(plan());
    const role = plan().suggested_role;

    expect(output).toContain(`CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER`);
    expect(output).not.toMatch(/GRANT\s+"?synapsor_writer"?\s+TO/);
    expect(output).not.toMatch(/ALTER ROLE\s+"?synapsor_writer"?/);
    expect(output).not.toMatch(/REVOKE\s+.*synapsor_writer/);
  });

  it("exports private unique handoffs without credentials or model content and preserves administrator edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-writer-provisioning-"));
    roots.push(root);
    const first = await exportWriterProvisioning(root, plan());
    const edited = path.join(first, "grants.sql");
    await fs.appendFile(edited, "\n-- administrator edit\n");
    const second = await exportWriterProvisioning(root, plan());

    expect(second).not.toBe(first);
    expect(await fs.readFile(edited, "utf8")).toContain("administrator edit");
    for (const directory of [first, second]) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of ["requirements.json", "grants.sql", "README.md"]) {
        const text = await fs.readFile(path.join(directory, file), "utf8");
        expect((await fs.stat(path.join(directory, file))).mode & 0o777).toBe(0o600);
        expect(text).not.toMatch(/postgres(?:ql)?:\/\/|password\s*=|api[_-]?key|model prompt/i);
      }
    }
  });
});
