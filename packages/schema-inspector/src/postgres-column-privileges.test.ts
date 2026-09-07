import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectDatabaseWithConnection, rolePostureFingerprint } from "./index.js";

const url = process.env.SYNAPSOR_TEST_POSTGRES_URL;
describe.skipIf(!url)("PostgreSQL effective column privileges", () => {
  const name = `synapsor_columns_${crypto.randomBytes(5).toString("hex")}`;
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    await pool.query(`CREATE ROLE "${name}" NOLOGIN; CREATE ROLE "${name}_policy" NOLOGIN;
      CREATE SCHEMA "${name}";
      CREATE TABLE "${name}".records (id int PRIMARY KEY, setting int, private_flag boolean);
      CREATE TABLE "${name}".other_records (id int PRIMARY KEY);
      GRANT USAGE ON SCHEMA "${name}" TO "${name}";
      GRANT SELECT ON "${name}".records TO "${name}";
      GRANT UPDATE (setting) ON "${name}".records TO "${name}";`);
  });
  afterAll(async () => {
    await pool.query(`DROP SCHEMA "${name}" CASCADE; DROP ROLE "${name}"; DROP ROLE "${name}_policy";`);
    await pool.end();
  });
  const inspect = async () => {
    const connection = await pool.connect();
    try {
      await connection.query(`SET ROLE "${name}"`);
      return await inspectDatabaseWithConnection({ engine: "postgres", databaseUrlEnv: "TEST_DB", schema: name, env: { TEST_DB: url! } }, { engine: "postgres", connection });
    } finally { await connection.query("RESET ROLE"); connection.release(); }
  };
  it("does not label a column-only writer read-only and binds its exact fields into role posture", async () => {
    const before = await inspect();
    expect(before.role_posture).toMatchObject({ read_only: false, writable_relations: [`${name}.records`] });
    expect(before.tables.find((table) => table.name === "records")?.role_posture).toMatchObject({
      privileges: { select: true, update: false }, column_privileges: { update: ["setting"] },
    });
    await pool.query(`GRANT UPDATE (private_flag) ON "${name}".records TO "${name}"`);
    const after = await inspect();
    expect(after.tables.find((table) => table.name === "records")?.role_posture?.column_privileges?.update).toEqual(["private_flag", "setting"]);
    expect(rolePostureFingerprint(after)).not.toBe(rolePostureFingerprint(before));
  });
  it("proves PostgreSQL needs a narrow UPDATE grant even for a private verification lock", async () => {
    await pool.query(`GRANT SELECT ON "${name}".other_records TO "${name}"`);
    const lock = async () => {
      const connection = await pool.connect();
      try {
        await connection.query(`SET ROLE "${name}"`);
        return await connection.query(`SELECT id FROM "${name}".other_records FOR UPDATE`);
      } finally { await connection.query("RESET ROLE"); connection.release(); }
    };
    await expect(lock()).rejects.toMatchObject({ code: "42501" });
    await pool.query(`GRANT UPDATE (id) ON "${name}".other_records TO "${name}"`);
    await expect(lock()).resolves.toMatchObject({ rows: [] });
    const inspection = await inspect();
    expect(inspection.tables.find((table) => table.name === "other_records")?.role_posture).toMatchObject({
      privileges: { update: false }, column_privileges: { update: ["id"] },
    });
  });
  it("detects SELECT-visible rows denied to locking SELECT until an inherited UPDATE RLS policy applies", async () => {
    await pool.query(`GRANT SELECT, UPDATE (id) ON "${name}".other_records TO "${name}";
      INSERT INTO "${name}".other_records VALUES (1);
      ALTER TABLE "${name}".other_records ENABLE ROW LEVEL SECURITY;
      CREATE POLICY read_rows ON "${name}".other_records FOR SELECT USING (id = 1);
      CREATE POLICY lock_rows ON "${name}".other_records FOR UPDATE TO "${name}_policy" USING (id = 1) WITH CHECK (id = 1);`);
    const counts = async () => {
      const connection = await pool.connect();
      try {
        await connection.query(`SET ROLE "${name}"`);
        const read = await connection.query(`SELECT id FROM "${name}".other_records`);
        const locked = await connection.query(`SELECT id FROM "${name}".other_records FOR UPDATE`);
        return { read: read.rowCount, locked: locked.rowCount };
      } finally { await connection.query("RESET ROLE"); connection.release(); }
    };
    expect(await counts()).toEqual({ read: 1, locked: 0 });
    const before = await inspect();
    expect(before.tables.find((table) => table.name === "other_records")?.role_posture?.row_security_update_permitted).toBe(false);
    await pool.query(`GRANT "${name}_policy" TO "${name}"`);
    expect(await counts()).toEqual({ read: 1, locked: 1 });
    const after = await inspect();
    expect(after.tables.find((table) => table.name === "other_records")?.role_posture?.row_security_update_permitted).toBe(true);
    expect(rolePostureFingerprint(after)).not.toBe(rolePostureFingerprint(before));
  });
});
