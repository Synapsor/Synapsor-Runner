import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { describe, expect, it } from "vitest";
import {
  compileReadPrerequisitePredicate,
  type ReadCurrentStatePrerequisite,
} from "./read-prerequisite.js";
import {
  createScopedExploreDatabaseExecutor,
  type CompiledExploreQuery,
} from "./scoped-explore.js";

const authorizedUrl = process.env.SYNAPSOR_TEST_MYSQL_URL;

describe.skipIf(!authorizedUrl)("connected Read current-state prerequisite (owned disposable MySQL only)", () => {
  it("permits only current evidence and rechecks a coverage query after withdrawal", async () => {
    const admin = mysql.createPool({ uri: authorizedUrl!, connectionLimit: 2, connectTimeout: 3_000 });
    const suffix = randomBytes(8).toString("hex");
    const database = `read_prereq_${suffix}`;
    const role = `read_prereq_${suffix}`;
    const password = randomBytes(24).toString("base64url");
    let executor: ReturnType<typeof createScopedExploreDatabaseExecutor> | undefined;
    try {
      await admin.query(`CREATE DATABASE \`${database}\``);
      await admin.query(`CREATE USER '${role}'@'%' IDENTIFIED BY '${password}'`);
      await admin.query(`CREATE TABLE \`${database}\`.student_admissions (
        tenant_id varchar(128) NOT NULL,
        principal_id varchar(128) NOT NULL,
        status enum('admitted', 'not_admitted', 'withdrawn') NOT NULL,
        effective_from timestamp(6) NOT NULL,
        effective_until timestamp(6) NOT NULL,
        UNIQUE KEY student_admissions_tenant_id_principal_id_key (tenant_id, principal_id))`);
      await admin.query(`CREATE TABLE \`${database}\`.private_rows (payload varchar(128) NOT NULL)`);
      await admin.query(`INSERT INTO \`${database}\`.student_admissions VALUES ('tenant-a', 'student-a', 'admitted', UTC_TIMESTAMP(6) - interval 1 minute, UTC_TIMESTAMP(6) + interval 1 minute)`);
      await admin.query(`INSERT INTO \`${database}\`.private_rows VALUES ('visible-only-after-gate')`);
      await admin.query(`GRANT SELECT ON \`${database}\`.* TO '${role}'@'%'`);
      const readerUrl = new URL(authorizedUrl!);
      readerUrl.pathname = `/${database}`;
      readerUrl.username = role;
      readerUrl.password = password;
      executor = createScopedExploreDatabaseExecutor({ engine: "mysql", databaseUrl: readerUrl.toString() });
      const prerequisite: ReadCurrentStatePrerequisite = {
        schema_version: "synapsor.read-current-state-prerequisite.v1",
        source: { schema: database, table: "student_admissions" },
        subject: { tenant_column: "tenant_id", principal_column: "principal_id", unique_constraint: "student_admissions_tenant_id_principal_id_key" },
        current_state: {
          state_column: "status", positive_state: "admitted", effective_from_column: "effective_from", effective_until_column: "effective_until",
          interval: "[effective_from,effective_until)", clock: "database_utc",
        },
        semantic_consent: { source_description: "Disposable test current-state source.", positive_state_description: "Only admitted is positive.", confirmed: true },
      };
      const query = compiledQuery(prerequisite, database);
      const coverage = compiledCoverageQuery(prerequisite, database);
      await expect(executor.executeBatch({ queries: [query], context: { tenant: "tenant-a", principal: "student-a" }, timeoutMs: 3_000 }))
        .resolves.toEqual([[{ payload: "visible-only-after-gate" }]]);

      const refuse = async (compiled: CompiledExploreQuery) => expect(executor!.executeBatch({
        queries: [compiled], context: { tenant: "tenant-a", principal: "student-a" }, timeoutMs: 3_000,
      })).rejects.toMatchObject({ code: "EXPLORE_READ_PREREQUISITE_NOT_SATISFIED" });
      const evidence = async (status: "admitted" | "withdrawn", from: string, until: string) => {
        await admin.query(`DELETE FROM \`${database}\`.student_admissions`);
        await admin.query(`INSERT INTO \`${database}\`.student_admissions VALUES ('tenant-a', 'student-a', ?, ${from}, ${until})`, [status]);
      };
      await admin.query(`DELETE FROM \`${database}\`.student_admissions`);
      await refuse(query);
      await evidence("admitted", "UTC_TIMESTAMP(6) + interval 1 hour", "UTC_TIMESTAMP(6) + interval 2 hour");
      await refuse(query);
      await evidence("admitted", "UTC_TIMESTAMP(6) - interval 2 hour", "UTC_TIMESTAMP(6) - interval 1 hour");
      await refuse(query);
      await evidence("withdrawn", "UTC_TIMESTAMP(6) - interval 1 minute", "UTC_TIMESTAMP(6) + interval 1 minute");
      await refuse(query);
      await evidence("admitted", "UTC_TIMESTAMP(6) - interval 1 minute", "UTC_TIMESTAMP(6) + interval 1 minute");
      await expect(executor.executeBatch({ queries: [coverage], context: { tenant: "tenant-a", principal: "student-a" }, timeoutMs: 3_000 }))
        .resolves.toEqual([[{ __coverage_cohort: 1 }]]);
      await admin.query(`UPDATE \`${database}\`.student_admissions SET status = 'withdrawn'`);
      await refuse(coverage);
    } finally {
      await executor?.close();
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(() => undefined);
      await admin.query(`DROP USER IF EXISTS '${role}'@'%'`).catch(() => undefined);
      await admin.end();
    }
  }, 30_000);
});

function compiledQuery(prerequisite: ReadCurrentStatePrerequisite, database: string): CompiledExploreQuery {
  const params: Array<string | number | boolean | null> = [];
  const quote = (identifier: string) => `\`${identifier.replaceAll("`", "``")}\``;
  const predicate = compileReadPrerequisitePredicate({
    prerequisite, context: { tenant: "tenant-a", principal: "student-a" }, params, engine: "mysql",
    quote: (identifier) => quote(identifier), placeholder: () => "?",
  });
  return {
    sql: `SELECT payload FROM ${quote(database)}.${quote("private_rows")} t0 WHERE ${predicate.predicate}`,
    params, resources: [], read_prerequisite: predicate.compiled,
  };
}

function compiledCoverageQuery(prerequisite: ReadCurrentStatePrerequisite, database: string): CompiledExploreQuery {
  const query = compiledQuery(prerequisite, database);
  const where = query.sql.slice(query.sql.indexOf(" WHERE ") + " WHERE ".length);
  return { ...query, sql: `SELECT COUNT(*) AS \`__coverage_cohort\` FROM \`${database}\`.\`private_rows\` t0 WHERE ${where}` };
}
