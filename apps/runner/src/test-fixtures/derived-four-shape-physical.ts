import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";

const execute = promisify(execFile);
const image = "sha256:1edc8e87e53194e0cc8006c4e9df9b626c6c72cb43ad3385f0f34af7922065b1";

/** Fresh DERIVED physical fixture only. No schema-inspection, authority, Source
 * coverage, runtime provenance or readiness object is supplied by this factory.
 * Original025/paid schemas and data are never opened or modified here. */
export function derivedFourShapeSql(schema: "derived_ops" | "derived_small", categories: 1 | 13): string {
  const rows: string[] = [];
  for (let category = 0; category < categories; category++) {
    for (const variant of ["healthy", "blocked", "denied", "missing", "low_count", "low_capacity", "foreign_tenant", "foreign_principal"]) {
      const id = `fixture_${category}_${variant}`;
      const tenant = variant === "foreign_tenant" ? "foreign_tenant" : "fixture_tenant";
      const principal = variant === "foreign_principal" ? "foreign_principal" : "fixture_principal";
      rows.push(`INSERT INTO ${schema}.units(id,tenant_id,principal_id,category,status,reason,allocated_count,blocked) VALUES ('${id}','${tenant}','${principal}',${category},'open','',${variant === "low_count" ? 0 : 25},${variant === "blocked"});`);
      if (variant !== "missing") rows.push(`INSERT INTO ${schema}.eligibility(id,tenant_id,principal_id,allowed,capacity) VALUES ('${id}','${tenant}','${principal}',${variant !== "denied"},${variant === "low_capacity" ? 25 : 50});`);
    }
  }
  return `CREATE ROLE derived_reader WITH LOGIN NOSUPERUSER NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA ${schema};
CREATE TYPE ${schema}.unit_status AS ENUM ('open','ready','held','closed');
CREATE TABLE ${schema}.units (
 id text PRIMARY KEY, tenant_id text NOT NULL, principal_id text NOT NULL,
 category integer NOT NULL CHECK(category BETWEEN 0 AND 12),
 status ${schema}.unit_status NOT NULL DEFAULT 'open', reason text NOT NULL DEFAULT '' CHECK(char_length(reason)<=64),
 allocated_count integer NOT NULL DEFAULT 0 CHECK(allocated_count>=0), blocked boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>=1), UNIQUE(tenant_id,principal_id,id)
);
CREATE TABLE ${schema}.eligibility (
 id text PRIMARY KEY, tenant_id text NOT NULL, principal_id text NOT NULL,
 allowed boolean NOT NULL, capacity integer NOT NULL CHECK(capacity>=0), version integer NOT NULL DEFAULT 1 CHECK(version>=1),
 CONSTRAINT eligibility_unit_scope_fk FOREIGN KEY(tenant_id,principal_id,id) REFERENCES ${schema}.units(tenant_id,principal_id,id) NOT DEFERRABLE
);
CREATE FUNCTION ${schema}.keep_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.version := OLD.version+1; RETURN NEW; END $$;
CREATE TRIGGER keep_unit_version BEFORE UPDATE ON ${schema}.units FOR EACH ROW EXECUTE FUNCTION ${schema}.keep_version();
CREATE TRIGGER keep_eligibility_version BEFORE UPDATE ON ${schema}.eligibility FOR EACH ROW EXECUTE FUNCTION ${schema}.keep_version();
ALTER TABLE ${schema}.units ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${schema}.units FORCE ROW LEVEL SECURITY;
ALTER TABLE ${schema}.eligibility ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${schema}.eligibility FORCE ROW LEVEL SECURITY;
CREATE POLICY reader_scope ON ${schema}.units FOR SELECT TO derived_reader USING (tenant_id = nullif(current_setting('derived.tenant',true),'') AND principal_id = nullif(current_setting('derived.principal',true),''));
CREATE POLICY reader_scope ON ${schema}.eligibility FOR SELECT TO derived_reader USING (tenant_id = nullif(current_setting('derived.tenant',true),'') AND principal_id = nullif(current_setting('derived.principal',true),''));
GRANT USAGE ON SCHEMA ${schema} TO derived_reader;
GRANT SELECT ON ${schema}.units TO derived_reader;
GRANT SELECT(id,tenant_id,principal_id,allowed,capacity,version) ON ${schema}.eligibility TO derived_reader;
ALTER ROLE derived_reader SET derived.tenant = 'fixture_tenant';
ALTER ROLE derived_reader SET derived.principal = 'fixture_principal';
${rows.join("\n")}\n`;
}

export async function createDerivedFourShapePhysicalFixture(input: {
  evidenceRoot: string; schema: "derived_ops" | "derived_small"; categories: 1 | 13;
}) {
  const id = randomUUID().slice(0, 8), container = `synapsor-derived-four-${id}`;
  const socket = `/var/tmp/synapsor-derived-${id}-sock`;
  await fs.mkdir(input.evidenceRoot, { recursive: false, mode: 0o700 });
  await fs.mkdir(socket, { mode: 0o777 }); await fs.chmod(socket, 0o777);
  const run = async (args: string[], output?: string) => {
    const result = await execute("docker", args, { maxBuffer: 4 * 1024 * 1024 });
    if (output) await fs.writeFile(path.join(input.evidenceRoot, output), result.stdout + result.stderr);
    return result.stdout;
  };
  const sql = derivedFourShapeSql(input.schema, input.categories);
  await fs.writeFile(path.join(input.evidenceRoot, "fixture.sql"), sql);
  await run(["run", "--detach", "--name", container, "--network", "none", "--memory", "256m", "--cpus", "1", "--pids-limit", "100",
    "--mount", `type=bind,src=${socket},dst=/var/run/postgresql`, "--mount", `type=bind,src=${input.evidenceRoot},dst=/evidence,readonly`,
    "-e", "POSTGRES_USER=derived_admin", "-e", "POSTGRES_DB=derived_authoring", "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    image, "-c", "listen_addresses=", "-c", "shared_buffers=32MB", "-c", "max_connections=20"], "container-create.txt");
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { await run(["exec", container, "psql", "-U", "derived_admin", "-d", "derived_authoring", "-Atc", "SELECT 1"]); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!ready) throw new Error("DERIVED fixture setup did not become ready; no product operation ran.");
  await run(["exec", container, "psql", "-U", "derived_admin", "-d", "derived_authoring", "-v", "ON_ERROR_STOP=1", "-f", "/evidence/fixture.sql"], "fixture-setup.txt");
  const env = { ...process.env, OWNED_DERIVED_READ_URL: `postgresql://derived_reader@localhost/derived_authoring?host=${encodeURIComponent(socket)}`,
    SYNAPSOR_TENANT_ID: "fixture_tenant", SYNAPSOR_PRINCIPAL: "fixture_principal" };
  const inspection = await inspectDatabase({ databaseUrlEnv: "OWNED_DERIVED_READ_URL", schema: input.schema, env });
  await fs.writeFile(path.join(input.evidenceRoot, "initial-actual-inspection.json"), JSON.stringify(inspection, null, 2) + "\n");
  await run(["exec", container, "pg_dump", "-U", "derived_admin", "-d", "derived_authoring", "--schema-only", `--schema=${input.schema}`], "initial-schema.sql");
  await run(["exec", container, "pg_dump", "-U", "derived_admin", "-d", "derived_authoring", "--data-only", `--schema=${input.schema}`], "initial-data.sql");
  await run(["inspect", container], "initial-container.json");
  const archive = async (prefix: string) => {
    const binary = await execute("docker", ["exec", container, "pg_dump", "-U", "derived_admin", "-d", "derived_authoring", "--format=custom"],
      { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 });
    await fs.writeFile(path.join(input.evidenceRoot, `${prefix}-source.dump`), binary.stdout);
    await run(["exec", container, "pg_dumpall", "-U", "derived_admin", "--roles-only", "--no-role-passwords"], `${prefix}-roles.sql`);
  };
  await archive("initial");
  return { container, socket, env, sql, inspection,
    inspect: () => inspectDatabase({ databaseUrlEnv: "OWNED_DERIVED_READ_URL", schema: input.schema, env }),
    snapshot: async () => {
      await run(["exec", container, "pg_dump", "-U", "derived_admin", "-d", "derived_authoring", "--schema-only", `--schema=${input.schema}`], "final-schema.sql");
      await run(["exec", container, "pg_dump", "-U", "derived_admin", "-d", "derived_authoring", "--data-only", `--schema=${input.schema}`], "final-data.sql");
      await archive("final");
      await run(["logs", container], "final-container-log.txt");
    },
    cleanup: async () => {
      await run(["rm", "--force", "--volumes", container], "owned-container-cleanup.txt");
      await run(["run", "--rm", "--network", "none", "--memory", "64m", "--pids-limit", "20", "--mount", `type=bind,src=${socket},dst=/owned`,
        "--user", "0:0", "--entrypoint", "chown", image, `${os.userInfo().uid}:${os.userInfo().gid}`, "/owned"], "owned-socket-ownership.txt");
      for (const name of await fs.readdir(socket)) {
        if (![".s.PGSQL.5432", ".s.PGSQL.5432.lock"].includes(name)) throw new Error("Unexpected owned socket artifact; preserve it.");
        await fs.unlink(path.join(socket, name));
      }
      await fs.rmdir(socket);
    },
  };
}
