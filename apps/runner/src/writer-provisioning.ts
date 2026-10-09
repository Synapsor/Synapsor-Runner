import fs from "node:fs/promises";
import { formatMysqlReceiptMigration, formatPostgresReceiptMigration } from "./onboarding.js";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { SupervisedWriterPostureAssessment } from "./worker-policy.js";
import { writerPolicyRepair } from "./writer-rls-repair.js";
import type { WriterProvisioningPlan } from "./writer-provisioning-types.js";
export type { WriterProvisioningPlan } from "./writer-provisioning-types.js";

/** Administrator evidence, never an authority artifact or a model tool. */
export function writerProvisioningPlan(input: {
  assessment: SupervisedWriterPostureAssessment; inspection: SchemaInspection;
  outcome: string; outcomes?: string[]; actionDigest: string; writerEnv: string; readEnv?: string;
  receiptSetup?: WriterProvisioningPlan["receipt_setup"];
  hardLimitNamespace?: boolean;
}): WriterProvisioningPlan | undefined {
  if (!["postgres", "mysql"].includes(input.inspection.engine) || !input.assessment.required_relations?.length) return undefined;
  if (input.inspection.engine === "mysql" && input.assessment.required_relations.some(relation => relation.rls_required)) return undefined;
  if (input.hardLimitNamespace && input.inspection.engine !== "postgres") return undefined;
  const relations: WriterProvisioningPlan["relations"] = [];
  for (const required of input.assessment.required_relations) {
    const table = input.inspection.tables.find((entry) => `${entry.schema}.${entry.name}` === required.relation);
    if (!table && input.receiptSetup && required.relation === `${input.receiptSetup.schema}.${input.receiptSetup.table}`
      && !required.rls_required && !required.row_scope?.length && !required.update_columns.length && !required.lock_column
      && required.privileges.every(privilege => ["select", "insert", "update"].includes(privilege))) {
      relations.push({ ...required, ...input.receiptSetup, policies: [], triggers: [] });
      continue;
    }
    if (!table || table.type !== "table" || !required.privileges.every((value) => ["select", "insert", "update"].includes(value))) return undefined;
    const columns = new Set(table.columns.map((column) => column.name));
    if ([...required.update_columns, ...(required.lock_column ? [required.lock_column] : [])].some((column) => !columns.has(column))) return undefined;
    if (required.row_scope?.some(item => !columns.has(item.field))) return undefined;
    relations.push({ ...required, schema: table.schema, table: table.name,
      native_uuid_scope_columns: (required.row_scope ?? []).filter(item => table.columns.some(column => column.name === item.field
        && column.data_type === "uuid")).map(item => item.field),
      ...(required.rls_required ? { row_security: { enabled: table.row_level_security ?? "unknown",
        forced: typeof table.role_posture?.row_security_forced === "boolean" ? table.role_posture.row_security_forced : "unknown" } } : {}),
      policies: structuredClone(table.row_level_security_policies ?? []), triggers: structuredClone(table.write_triggers ?? []) });
  }
  const readEnv = input.readEnv ?? "DATABASE_URL";
  // The inspected connection may be the reader that failed a writer check.
  // A provisioning plan must never instruct replacing that reader credential.
  const writerEnv = input.writerEnv !== readEnv ? input.writerEnv
    : readEnv !== "SYNAPSOR_DATABASE_WRITE_URL" ? "SYNAPSOR_DATABASE_WRITE_URL" : "SYNAPSOR_EXECUTION_DATABASE_URL";
  return { version: 1, outcome: input.outcome, ...(input.outcomes ? { outcomes: [...input.outcomes].sort() } : {}), action_digest: input.actionDigest, writer_env: writerEnv, read_env: readEnv,
    suggested_role: `runner_writer_${createHash("sha256").update(input.actionDigest + input.outcome).digest("hex").slice(0, 12)}`,
    engine: input.inspection.engine, relations, ...(input.hardLimitNamespace ? { hard_limit_namespace: { relation: "pg_catalog.pg_namespace" as const, privilege: "MAINTAIN" as const } } : {}), ...(input.receiptSetup ? { receipt_setup: input.receiptSetup } : {}) };
}

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

export function writerProvisioningSql(plan: WriterProvisioningPlan): string {
  if (!["postgres", "mysql"].includes(plan.engine) || !/^runner_writer_[a-f0-9]{12}$/u.test(plan.suggested_role)) throw new Error("Invalid dedicated writer plan.");
  if (plan.relations.some((relation) => !relation.privileges.every((value) => ["select", "insert", "update"].includes(value)))) {
    throw new Error("Unsupported writer privilege; export the exact reviewed requirements again.");
  }
  if (plan.hard_limit_namespace && (plan.engine !== "postgres" || plan.hard_limit_namespace.relation !== "pg_catalog.pg_namespace" || plan.hard_limit_namespace.privilege !== "MAINTAIN")) throw new Error("Unsupported hard-limit namespace requirement.");
  if (plan.engine === "mysql") return mysqlWriterProvisioningSql(plan);
  const role = identifier(plan.suggested_role);
  return [
    "-- ADMINISTRATOR REVIEW REQUIRED. Runner never executes this file.",
    "-- Creates a NEW, initially NOLOGIN role. Does not alter shared roles, RLS, or source rows.",
    "-- Inspect requirements.json and README.md before running against the intended database.",
    "\\set ON_ERROR_STOP on", "BEGIN;", "SET LOCAL lock_timeout = '5s';", "SET LOCAL statement_timeout = '30s';",
    `CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
    `DO $runner_connect$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${plan.suggested_role}'); END $runner_connect$;`,
    ...(plan.receipt_setup ? [
      "-- Reviewed source receipt infrastructure only; receipt storage is not a public Read permission.",
      formatPostgresReceiptMigration(plan.receipt_setup.schema, plan.receipt_setup.table),
    ] : []),
    ...[...new Set(plan.relations.map((relation) => relation.schema))].map((schema) => `GRANT USAGE ON SCHEMA ${identifier(schema)} TO ${role};`),
    ...(plan.hard_limit_namespace ? [
      "-- Hard-limit namespace replacement protection. MAINTAIN also permits maintenance and all lock modes on this catalog relation, subject to PostgreSQL restrictions.",
      `GRANT MAINTAIN ON TABLE pg_catalog.pg_namespace TO ${role};`,
      "-- No pg_maintain membership, catalog DML or grant option. Live PostgreSQL 17 validation and Source inspection remain mandatory.",
    ] : []),
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
    "-- A column UPDATE grant used for row locking is real database mutation authority on that column; it is not a lock-only PostgreSQL permission.",
    "-- STILL REQUIRED: review scoped policies, helper-function access, defaults/sequences and triggers.",
    "-- RLS-backed targets require ENABLE and FORCE ROW LEVEL SECURITY. See requirements.json; this file does not change RLS.",
    "-- Do not copy an unrestricted policy or grant membership in the shared writer role.",
    "-- After review, configure authentication and LOGIN separately. Never put credentials in this file.",
    "-- Recheck this connection in Runner. Execution consent and a running worker are still required.", "",
  ].join("\n");
}

function mysqlWriterProvisioningSql(plan: WriterProvisioningPlan): string {
  if (plan.relations.some(relation => relation.rls_required)) throw new Error("MySQL cannot provision PostgreSQL RLS requirements.");
  // The precreated source-receipt contract explicitly requires SELECT/INSERT/
  // UPDATE on its exact selected relation. Never infer this from missing effect
  // columns, a relation name, or a private lock identity.
  const receiptRelation = (relation: WriterProvisioningPlan["relations"][number]) => Boolean(plan.receipt_setup
    && relation.schema === plan.receipt_setup.schema && relation.table === plan.receipt_setup.table
    && relation.relation === `${plan.receipt_setup.schema}.${plan.receipt_setup.table}`
    && !relation.lock_column && !relation.row_scope?.length && !relation.update_columns.length
    && relation.privileges.length === 3 && ["select", "insert", "update"].every(p => relation.privileges.includes(p)));
  if (plan.relations.some(relation => relation.privileges.includes("update") && !relation.update_columns.length && !receiptRelation(relation))) {
    throw new Error("Missing exact reviewed UPDATE columns; refresh the writer requirements instead of broadening grants.");
  }
  const quote = (value: string) => `\`${value.replaceAll("`", "``")}\``;
  const account = `'${plan.suggested_role}'@'localhost'`;
  return [
    "-- ADMINISTRATOR REVIEW REQUIRED. Runner never executes this file.",
    "-- Creates a NEW locked account. Configure authentication separately before unlocking.",
    "-- Replace localhost consistently with the exact approved application host if needed; do not use a wildcard host.",
    "-- MySQL account/grant DDL auto-commits. Stop on the first error; do not use mysql --force or reuse an existing account.",
    `CREATE USER ${account} ACCOUNT LOCK;`,
    ...(plan.receipt_setup ? [formatMysqlReceiptMigration(plan.receipt_setup.schema, plan.receipt_setup.table)] : []),
    ...plan.relations.flatMap(relation => {
      const table = `${quote(relation.schema)}.${quote(relation.table)}`;
      // Any reviewed effect-column UPDATE already satisfies row locking. Add
      // the reviewed identity only when there are no effect UPDATE columns.
      const updates = relation.update_columns.length ? relation.update_columns : relation.lock_column ? [relation.lock_column] : [];
      return [
        ...relation.privileges.filter(privilege => privilege !== "update").map(privilege => `GRANT ${privilege.toUpperCase()} ON ${table} TO ${account};`),
        ...(updates.length ? [`GRANT UPDATE (${updates.map(quote).join(", ")}) ON ${table} TO ${account};`]
          : relation.privileges.includes("update") ? [`GRANT UPDATE ON ${table} TO ${account};`] : []),
      ];
    }),
    "-- A lock-column UPDATE grant is real database mutation authority on that column, not a lock-only permission.",
    "-- Review triggers, defaults and account custody. Recheck the configured writer in Runner before execution review.", "",
  ].join("\n");
}

export function writerPolicyRepairSummary(plan: WriterProvisioningPlan): string[] {
  if (plan.engine === "mysql") return [
    "Review grants.sql for the exact dedicated MySQL account and column grants. Live writer verification is still required.",
    ...writerProvisioningSql(plan).split("\n").filter(line => line.startsWith("GRANT ")),
  ];
  const repair = writerPolicyRepair(plan);
  return repair.sql ? [
    "Scoped filter repair: review scoped-policies.sql after grants.sql. It adds only missing policies for the dedicated writer, using the exact reviewed identity filters.",
    "Existing policies stay unchanged. An administrator must apply the repair; then rescan and revalidate this saved job before rechecking execution.",
  ] : repair.blockers.length ? [
    "A filter repair was not generated. README.md names each policy prerequisite needing administrator input; grants alone will not complete setup.",
  ] : ["The inspected simple policies need no additional policy file; live writer verification is still required."];
}

export async function exportWriterProvisioning(projectRoot: string, plan: WriterProvisioningPlan): Promise<string> {
  // A unique local directory avoids overwriting an administrator's edited repair.
  const parent = path.join(projectRoot, ".synapsor", "writer-handoffs");
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(parent, "review-"));
  const write = (name: string, value: string) => fs.writeFile(path.join(directory, name), value, { mode: 0o600, flag: "wx" });
  await write("requirements.json", JSON.stringify(plan, null, 2) + "\n");
  await write("grants.sql", writerProvisioningSql(plan));
  const policyRepair = plan.engine === "mysql" ? { blockers: [], changes: [], sql: undefined } : writerPolicyRepair(plan);
  if (policyRepair.sql) await write("scoped-policies.sql", policyRepair.sql);
  if (plan.engine === "mysql") {
    await write("README.md", [
      "# Dedicated MySQL Writer Review", "", `Outcomes: ${(plan.outcomes ?? [plan.outcome]).join(", ")}`,
      `Action revision: ${plan.action_digest}`, "",
      "This export is a deployment plan, not execution permission. No database command has run.",
      "1. Review requirements.json: exact effect columns, private row-lock columns and inspected triggers.",
      "2. Review grants.sql. It creates a NEW locked account at localhost. Replace localhost consistently with the exact approved application host if needed. Do not use a wildcard host, shared writer or role membership.",
      "3. Run only after administrator review, stopping at the first error. MySQL account and grant DDL auto-commits; there is no rollback of earlier grants. Never continue after CREATE USER fails or reuse an existing account.",
      ...(plan.receipt_setup ? [`Selected source receipt: ${plan.receipt_setup.schema}.${plan.receipt_setup.table}. The script includes the existing receipt migration. Re-inspection and a rollback receipt probe remain required; no public Read access to receipt content is granted.`] : []),
      "4. Review defaults and trigger effects. Configure authentication securely and unlock the account separately. Never save credentials in this export.",
      `5. Keep ${plan.read_env ?? "the saved read connection"} unchanged. Configure the dedicated connection ONLY in ${plan.writer_env}. Resume the saved Action execution setup and recheck the writer.`,
      "6. Execution consent and worker startup remain separate. Only a successful execution receipt proves a completed change.", "",
      "A key-column UPDATE grant for row locking is real database mutation authority on that column for the credential holder. It adds no model-facing update operation; Runner still enforces its reviewed effects and conflict guards.", "",
    ].join("\n"));
    return directory;
  }
  await write("README.md", [
    "# Dedicated Writer Review", "", `Outcomes: ${(plan.outcomes ?? [plan.outcome]).join(", ")}`, `Action revision: ${plan.action_digest}`, "",
    "This export is a deployment plan, not execution permission. No database command has run.",
    ...(plan.receipt_setup ? [`Selected source receipt: ${plan.receipt_setup.schema}.${plan.receipt_setup.table}. grants.sql includes the existing receipt migration before narrow writer grants. This is a preview, not proof that the objects or writer work. No Read access to receipt content is granted. Re-inspection and a rollback receipt probe remain required before execution review.`, ""] : []),
    ...(plan.hard_limit_namespace ? ["Hard-limit prerequisite: exact MAINTAIN on pg_catalog.pg_namespace for the selected dedicated writer. This also permits maintenance and all table lock modes on that relation, subject to PostgreSQL object restrictions. Review this extra catalog capability; no catalog row mutation or global pg_maintain membership is requested. Setup must inspect the actual writer before Action activation and recheck on publication and each Source transaction.", ""] : []),
    "1. An authorized database administrator reviews requirements.json: exact effect columns, private locking columns, current RLS policies and triggers.",
    "2. Review grants.sql. It creates only a new NOLOGIN role with the exact relation privileges. Existing role names cause a transaction rollback; never replace a shared role.",
    "3. Provision scoped policies and required helper-function access for the new role. Policy predicates cannot be inferred safely for an arbitrary database. Do not disable RLS, inherit the shared writer, or grant source receipt tables not listed in requirements.json.",
    "   Every relation marked rls_required needs ENABLE and FORCE ROW LEVEL SECURITY, applicable SELECT and write/locking policies using the reviewed identity settings, and non-owner/non-bypass reader and writer roles. requirements.json records the inspected enabled/forced state; unknown is not verified. Review the effect on other application roles before an administrator changes RLS. grants.sql deliberately does not make that change.",
    "4. Review defaults/sequences for INSERT and trigger side effects. Authentication and LOGIN are separate administrator steps; use a secret manager or psql's password prompt, not a saved plaintext password.",
    `5. Keep ${plan.read_env ?? "the saved read connection"} unchanged. Configure the new connection ONLY in ${plan.writer_env}; never replace the reader with this restricted writer. If RLS/schema changed, resume the same start command through the READER with --rescan and choose Revalidate the saved job against changed database before execution review. Otherwise run synapsor-runner action review --project-root . in this project, select Verified Action Boundary and its execution setup, and recheck ${plan.writer_env}. No job re-entry is needed and no fingerprint check is bypassed.`,
    "6. Confirm execution only after live verification succeeds. Start the worker in the guided handoff. Approval is not completion; only a successful execution receipt proves a change completed.", "",
    "The lock-column UPDATE privilege permits PostgreSQL row locking and is also real database mutation authority on that column for the credential holder. PostgreSQL has no lock-only UPDATE grant. Review its exact scoped policies and credential custody. It does not add a model-facing update operation; Runner still enforces its reviewed effect and conflict guards.",
    ...(policyRepair.sql ? ["", "## Reviewed Simple Row Filters", "",
      "The inspected policies match the exact reviewed identity columns. After grants.sql, an administrator can review and apply scoped-policies.sql to add only the missing policies for this dedicated role. Existing application policies are not altered. The script checks the entire prior policy snapshot and forced-RLS state before any change; drift, unsafe role attributes or role memberships roll back the repair.",
      "If this exact dedicated role was already provisioned from these grants, do not rerun grants.sql or replace it. Verify its existing grants against requirements.json before applying only scoped-policies.sql. Do not use this repair for an unrelated shared application role.",
      ...policyRepair.changes.map(change => `- ${change}`),
      "After this policy change, rescan through the reader, revalidate the SAME saved job and recheck execution. This is administrator-assisted provisioning, not automatic Runner authority."]
      : policyRepair.blockers.length ? ["", "## Row-Filter Repair Needs Administrator Input", "",
        "No scoped-policies.sql was generated; additional grants alone do not resolve these prerequisites.",
        ...policyRepair.blockers.map(blocker => `- ${blocker}`)] : []),
    "",
  ].join("\n"));
  return directory;
}
