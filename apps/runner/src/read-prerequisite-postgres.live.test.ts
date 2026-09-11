import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  compileReadPrerequisitePredicate,
  type ReadCurrentStatePrerequisite,
} from "./read-prerequisite.js";
import {
  createScopedExploreDatabaseExecutor,
  type CompiledExploreQuery,
} from "./scoped-explore.js";

const authorizedUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;

describe.skipIf(!authorizedUrl)("connected Read current-state prerequisite (owned disposable PostgreSQL only)", () => {
  it("permits only current evidence and rechecks a coverage query after withdrawal", async () => {
    const admin = new Pool({ connectionString: authorizedUrl!, max: 2, connectionTimeoutMillis: 3_000 });
    const suffix = randomBytes(8).toString("hex");
    const schema = `read_prereq_${suffix}`;
    const role = `read_prereq_${suffix}`;
    const password = randomBytes(24).toString("base64url");
    let executor: ReturnType<typeof createScopedExploreDatabaseExecutor> | undefined;
    try {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS PASSWORD '${password}'`);
      await admin.query(`CREATE TYPE "${schema}".admission_status AS ENUM ('admitted', 'not_admitted', 'withdrawn')`);
      await admin.query(`CREATE TABLE "${schema}".student_admissions (
        tenant_id text NOT NULL,
        principal_id text NOT NULL,
        status "${schema}".admission_status NOT NULL,
        effective_from timestamptz NOT NULL,
        effective_until timestamptz NOT NULL,
        UNIQUE (tenant_id, principal_id))`);
      await admin.query(`CREATE TABLE "${schema}".private_rows (payload text NOT NULL)`);
      await admin.query(`INSERT INTO "${schema}".student_admissions VALUES ('tenant-a', 'student-a', 'admitted', CURRENT_TIMESTAMP - interval '1 minute', CURRENT_TIMESTAMP + interval '1 minute')`);
      await admin.query(`INSERT INTO "${schema}".private_rows VALUES ('visible-only-after-gate')`);
      await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
      await admin.query(`GRANT SELECT ON "${schema}".student_admissions, "${schema}".private_rows TO "${role}"`);
      const readerUrl = new URL(authorizedUrl!);
      readerUrl.username = role;
      readerUrl.password = password;
      executor = createScopedExploreDatabaseExecutor({ engine: "postgres", databaseUrl: readerUrl.toString() });
      const prerequisite: ReadCurrentStatePrerequisite = {
        schema_version: "synapsor.read-current-state-prerequisite.v1",
        source: { schema, table: "student_admissions" },
        subject: { tenant_column: "tenant_id", principal_column: "principal_id", unique_constraint: "student_admissions_tenant_id_principal_id_key" },
        current_state: {
          state_column: "status",
          positive_state: "admitted",
          effective_from_column: "effective_from",
          effective_until_column: "effective_until",
          interval: "[effective_from,effective_until)",
          clock: "database_utc",
        },
        semantic_consent: {
          source_description: "Disposable test current-state source.",
          positive_state_description: "Only the admitted enum value is positive.",
          confirmed: true,
        },
      };
      const query = compiledQuery(prerequisite, schema);
      const coverage = compiledCoverageQuery(prerequisite, schema);
      await expect(executor.executeBatch({
        queries: [query], context: { tenant: "tenant-a", principal: "student-a" }, timeoutMs: 3_000,
      })).resolves.toEqual([[{ payload: "visible-only-after-gate" }]]);

      const refuse = async (compiled: CompiledExploreQuery) => expect(executor!.executeBatch({
        queries: [compiled], context: { tenant: "tenant-a", principal: "student-a" }, timeoutMs: 3_000,
      })).rejects.toMatchObject({
        code: "EXPLORE_READ_PREREQUISITE_NOT_SATISFIED",
        message: "Current authorization requirements for this data are not satisfied.",
      });
      const evidence = async (status: "admitted" | "not_admitted" | "withdrawn", from: string, until: string) => {
        await admin.query(`DELETE FROM "${schema}".student_admissions`);
        await admin.query(`INSERT INTO "${schema}".student_admissions VALUES ('tenant-a', 'student-a', $1, ${from}, ${until})`, [status]);
      };

      await admin.query(`DELETE FROM "${schema}".student_admissions`);
      await refuse(query);
      await evidence("admitted", "CURRENT_TIMESTAMP + interval '1 hour'", "CURRENT_TIMESTAMP + interval '2 hours'");
      await refuse(query);
      await evidence("admitted", "CURRENT_TIMESTAMP - interval '2 hours'", "CURRENT_TIMESTAMP - interval '1 hour'");
      await refuse(query);
      await evidence("withdrawn", "CURRENT_TIMESTAMP - interval '1 minute'", "CURRENT_TIMESTAMP + interval '1 minute'");
      await refuse(query);

      await evidence("admitted", "CURRENT_TIMESTAMP - interval '1 minute'", "CURRENT_TIMESTAMP + interval '1 minute'");
      await expect(executor.executeBatch({
        queries: [coverage], context: { tenant: "tenant-a", principal: "student-a" }, timeoutMs: 3_000,
      })).resolves.toEqual([[{ __coverage_cohort: "1" }]]);
      await admin.query(`UPDATE "${schema}".student_admissions SET status = 'withdrawn'`);
      await refuse(coverage);
    } finally {
      await executor?.close();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => undefined);
      await admin.end();
    }
  }, 20_000);
});

function compiledQuery(
  prerequisite: ReadCurrentStatePrerequisite,
  schema: string,
): CompiledExploreQuery {
  const params: Array<string | number | boolean | null> = [];
  const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
  const predicate = compileReadPrerequisitePredicate({
    prerequisite,
    context: { tenant: "tenant-a", principal: "student-a" },
    params,
    engine: "postgres",
    quote: (identifier) => quote(identifier),
    placeholder: (index) => `$${index}`,
  });
  return {
    sql: `SELECT payload FROM ${quote(schema)}.${quote("private_rows")} t0 WHERE ${predicate.predicate}`,
    params,
    resources: [],
    read_prerequisite: predicate.compiled,
  };
}

function compiledCoverageQuery(
  prerequisite: ReadCurrentStatePrerequisite,
  schema: string,
): CompiledExploreQuery {
  const query = compiledQuery(prerequisite, schema);
  const where = query.sql.slice(query.sql.indexOf(" WHERE ") + " WHERE ".length);
  return {
    ...query,
    sql: `SELECT COUNT(*) AS "__coverage_cohort" FROM "${schema}"."private_rows" t0 WHERE ${where}`,
  };
}
