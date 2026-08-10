import crypto from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveSchemaDeclaredEnumValues,
  inspectDatabase,
  inspectDatabaseWithConnection,
} from "./index.js";


const databaseUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
const describePostgres = databaseUrl ? describe : describe.skip;


describePostgres("PostgreSQL native enum inspection", () => {
  const schema = `synapsor_enum_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    await pool.query(`
      CREATE SCHEMA "${schema}";
      CREATE TYPE "${schema}".fulfillment_status AS ENUM ('pending', 'fulfilled', 'cancelled');
      CREATE TABLE "${schema}".order_items (
        id text PRIMARY KEY,
        fulfillment "${schema}".fulfillment_status NOT NULL,
        review_state text NOT NULL CHECK (review_state IN ('queued', 'approved', 'rejected'))
      );
    `);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("returns ordered native ENUM and CHECK vocabularies without aborting inspection", async () => {
    const inspection = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "SYNAPSOR_TEST_POSTGRES_URL",
      schema,
      env: { SYNAPSOR_TEST_POSTGRES_URL: databaseUrl! },
    });
    const orderItems = inspection.tables.find((table) => table.name === "order_items");
    const fulfillment = orderItems?.columns.find((column) => column.name === "fulfillment");
    const reviewState = orderItems?.columns.find((column) => column.name === "review_state");

    expect(fulfillment?.enum_values).toEqual(["pending", "fulfilled", "cancelled"]);
    expect(reviewState?.enum_values).toEqual(["queued", "approved", "rejected"]);
    expect(deriveSchemaDeclaredEnumValues({
      engine: "postgres",
      column_name: "fulfillment",
      native_values: fulfillment?.enum_values,
    })).toEqual(["pending", "fulfilled", "cancelled"]);
  });

  it("can inspect through a caller-owned bounded PostgreSQL pool", async () => {
    const client = await pool.connect();
    try {
      const inspection = await inspectDatabaseWithConnection({
        engine: "postgres",
        databaseUrlEnv: "SYNAPSOR_TEST_POSTGRES_URL",
        schema,
        env: { SYNAPSOR_TEST_POSTGRES_URL: databaseUrl! },
      }, {
        engine: "postgres",
        connection: client,
      });
      expect(inspection.tables.map((table) => table.name)).toEqual(["order_items"]);
    } finally {
      client.release();
    }
  });
});
