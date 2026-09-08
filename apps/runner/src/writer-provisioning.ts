import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { SupervisedWriterPostureAssessment } from "./worker-policy.js";

export type WriterProvisioningPlan = {
  version: 1;
  outcome: string;
  action_digest: string;
  writer_env: string;
  suggested_role: string;
  engine: string;
  relations: Array<NonNullable<SupervisedWriterPostureAssessment["required_relations"]>[number] & {
    schema: string; table: string;
    policies: NonNullable<SchemaInspection["tables"][number]["row_level_security_policies"]>;
    triggers: NonNullable<SchemaInspection["tables"][number]["write_triggers"]>;
  }>;
};

/** Administrator evidence, never an authority artifact or a model tool. */
export function writerProvisioningPlan(input: {
  assessment: SupervisedWriterPostureAssessment; inspection: SchemaInspection;
  outcome: string; actionDigest: string; writerEnv: string;
}): WriterProvisioningPlan | undefined {
  if (input.inspection.engine !== "postgres" || !input.assessment.required_relations?.length) return undefined;
  const relations: WriterProvisioningPlan["relations"] = [];
  for (const required of input.assessment.required_relations) {
    const table = input.inspection.tables.find((entry) => `${entry.schema}.${entry.name}` === required.relation);
    if (!table || table.type !== "table" || !required.privileges.every((value) => ["select", "insert", "update"].includes(value))) return undefined;
    const columns = new Set(table.columns.map((column) => column.name));
    if ([...required.update_columns, ...(required.lock_column ? [required.lock_column] : [])].some((column) => !columns.has(column))) return undefined;
    relations.push({ ...required, schema: table.schema, table: table.name,
      policies: structuredClone(table.row_level_security_policies ?? []), triggers: structuredClone(table.write_triggers ?? []) });
  }
  return { version: 1, outcome: input.outcome, action_digest: input.actionDigest, writer_env: input.writerEnv,
    suggested_role: `runner_writer_${createHash("sha256").update(input.actionDigest + input.outcome).digest("hex").slice(0, 12)}`,
    engine: input.inspection.engine, relations };
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export function writerProvisioningSql(plan: WriterProvisioningPlan): string {
  if (plan.engine !== "postgres" || !/^runner_writer_[a-f0-9]{12}$/u.test(plan.suggested_role)) throw new Error("Invalid dedicated writer plan.");
  if (plan.relations.some((relation) => !relation.privileges.every((value) => ["select", "insert", "update"].includes(value)))) {
    throw new Error("Unsupported writer privilege; export the exact reviewed requirements again.");
  }
  const role = identifier(plan.suggested_role);
  return [
    "-- ADMINISTRATOR REVIEW REQUIRED. Runner never executes this file.",
    "-- Creates a NEW, initially NOLOGIN role. Does not alter shared roles, RLS, or source rows.",
    "-- Inspect requirements.json and README.md before running against the intended database.",
    "\\set ON_ERROR_STOP on", "BEGIN;", "SET LOCAL lock_timeout = '5s';", "SET LOCAL statement_timeout = '30s';",
    `CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    `DO $runner_connect$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${plan.suggested_role}'); END $runner_connect$;`,
    ...[...new Set(plan.relations.map((relation) => relation.schema))].map((schema) => `GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${role};`),
    ...plan.relations.flatMap((relation) => {
      const table = `${identifier(relation.schema)}.${identifier(relation.table)}`;
      const updates = relation.update_columns.length ? relation.update_columns : relation.lock_column ? [relation.lock_column] : [];
      return [
        ...relation.privileges.filter((privilege) => privilege !== "update").map((privilege) => `GRANT ${privilege.toUpperCase()} ON TABLE ${table} TO ${role};`),
        ...(updates.length ? [`GRANT UPDATE (${updates.map(identifier).join(", ")}) ON TABLE ${table} TO ${role};`]
          : relation.privileges.includes("update") ? [`GRANT UPDATE ON TABLE ${table} TO ${role};`] : []),
      ];
    }),
    `ALTER ROLE ${role} SET statement_timeout = '5s';`,
    `ALTER ROLE ${role} SET lock_timeout = '2s';`,
    "COMMIT;", "",
    "-- STILL REQUIRED: review scoped policies, helper-function access, defaults/sequences and triggers.",
    "-- Do not copy an unrestricted policy or grant membership in the shared writer role.",
    "-- After review, configure authentication and LOGIN separately. Never put credentials in this file.",
    "-- Recheck this connection in Runner. Execution consent and a running worker are still required.", "",
  ].join("\n");
}

export async function exportWriterProvisioning(projectRoot: string, plan: WriterProvisioningPlan): Promise<string> {
  // A unique local directory avoids overwriting an administrator's edited repair.
  const parent = path.join(projectRoot, ".synapsor", "writer-handoffs");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(parent, "review-"));
  const write = (name: string, value: string) => fs.writeFile(path.join(directory, name), value, { mode: 0o600, flag: "wx" });
  await write("requirements.json", JSON.stringify(plan, null, 2) + "\n");
  await write("grants.sql", writerProvisioningSql(plan));
  await write("README.md", [
    "# Dedicated Writer Review", "", `Outcome: ${plan.outcome}`, `Action revision: ${plan.action_digest}`, "",
    "This export is a deployment plan, not execution permission. No database command has run.",
    "1. An authorized database administrator reviews requirements.json: exact effect columns, private locking columns, current RLS policies and triggers.",
    "2. Review grants.sql. It creates only a new NOLOGIN role with the exact relation privileges. Existing role names cause a transaction rollback; never replace a shared role.",
    "3. Provision scoped policies and required helper-function access for the new role. Policy predicates cannot be inferred safely for an arbitrary database. Do not disable RLS, inherit the shared writer, or grant source receipt tables not listed in requirements.json.",
    "4. Review defaults/sequences for INSERT and trigger side effects. Authentication and LOGIN are separate administrator steps; use a secret manager or psql's password prompt, not a saved plaintext password.",
    `5. Configure the new connection in ${plan.writer_env}. If RLS/schema changed, resume the same start command with --rescan and choose Revalidate the saved job against changed database before execution review. Otherwise reopen the same project and recheck the writer. No fingerprint check is bypassed.`,
    "6. Confirm execution only after live verification succeeds. Start the worker in the guided handoff. Approval is not completion; only a successful execution receipt proves a change completed.", "",
    "The lock-column UPDATE privilege permits PostgreSQL row locking. It does not authorize an agent to change that identity; Runner still enforces its reviewed effect and conflict guards.",
    "For the shipped telecom fixture, use the separately reviewed dedicated-writer fixture repair with this requirements.json. The broad shared writer is intentionally not reused.", "",
  ].join("\n"));
  return directory;
}
