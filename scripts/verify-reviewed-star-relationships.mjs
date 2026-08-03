import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import mysql from "../packages/mysql/node_modules/mysql2/promise.js";
import { Pool } from "pg";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  activateExplorationBoundary,
  buildAutoBoundary,
  reviewExplorationBoundaryCandidate,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import { createScopedExploreRuntime } from "../apps/runner/dist/scoped-explore.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(root, "examples/runner-fleet/docker-compose.yml");
const postgresAdminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet";
const postgresReadUrl = "postgresql://synapsor_reader:synapsor_reader_password@127.0.0.1:55439/synapsor_fleet";
const mysqlAdminUrl = "mysql://root:root_password@127.0.0.1:53309";
const mysqlReadUrl = "mysql://synapsor_star_reader:synapsor_star_reader_password@127.0.0.1:53309/synapsor_star";
const temporaryRoots = [];

function assert(condition, message, details) {
  if (!condition) {
    throw new Error(`${message}${details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

function fixtureRows() {
  const rows = [];
  const groups = [
    ["store-a", "product-energy", 100],
    ["store-a", "product-hardware", 200],
    ["store-b", "product-energy", 300],
    ["store-b", "product-hardware", 400],
    ["store-a", null, 500],
    ["store-other", "product-energy", 999],
  ];
  let id = 1;
  for (const [store, product, amount] of groups) {
    for (let index = 0; index < 5; index += 1) {
      rows.push({
        id: `sale-${id++}`,
        tenant: "acme",
        store,
        product,
        amount,
        scenario: "star",
        segment: null,
        occurredAt: "2026-06-15 00:00:00",
      });
    }
  }
  for (let index = 0; index < 5; index += 1) {
    rows.push({
      id: `sale-${id++}`,
      tenant: "globex",
      store: "store-other",
      product: "product-other",
      amount: 700,
      scenario: "star",
      segment: null,
      occurredAt: "2026-06-15 00:00:00",
    });
  }
  for (let segment = 0; segment < 60; segment += 1) {
    const label = `segment-${String(segment).padStart(3, "0")}`;
    for (let index = 0; index < 5; index += 1) {
      rows.push({
        id: `rank-before-${segment}-${index}`,
        tenant: "acme",
        store: "store-a",
        product: "product-energy",
        amount: 100 + segment,
        scenario: "rank",
        segment: label,
        occurredAt: "2026-06-15 00:00:00",
      });
      rows.push({
        id: `rank-after-${segment}-${index}`,
        tenant: "acme",
        store: "store-a",
        product: "product-energy",
        amount: 100 + segment + (3 * (segment + 1)),
        scenario: "rank",
        segment: label,
        occurredAt: "2026-07-15 00:00:00",
      });
    }
  }
  for (let index = 0; index < 2; index += 1) {
    rows.push({
      id: `rank-private-before-${index}`,
      tenant: "acme",
      store: "store-a",
      product: "product-energy",
      amount: 100_000,
      scenario: "rank",
      segment: "private-winner",
      occurredAt: "2026-06-15 00:00:00",
    });
    rows.push({
      id: `rank-private-after-${index}`,
      tenant: "acme",
      store: "store-a",
      product: "product-energy",
      amount: 200_000,
      scenario: "rank",
      segment: "private-winner",
      occurredAt: "2026-07-15 00:00:00",
    });
  }
  return rows;
}

function sqlValues(rows) {
  const value = (input) => input === null ? "NULL" : `'${String(input).replaceAll("'", "''")}'`;
  return rows.map((row) =>
    `(${value(row.id)}, ${value(row.tenant)}, ${value(row.store)}, ${value(row.product)}, ${row.amount}, ${value(row.scenario)}, ${value(row.segment)}, ${value(row.occurredAt)})`)
    .join(",\n");
}

async function seedPostgres() {
  const pool = new Pool({ connectionString: postgresAdminUrl, max: 1 });
  const values = sqlValues(fixtureRows());
  try {
    await pool.query(`
      DROP SCHEMA IF EXISTS star_live CASCADE;
      CREATE SCHEMA star_live;
      CREATE TABLE star_live.stores (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        name text NOT NULL
      );
      CREATE TABLE star_live.categories (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        name text NOT NULL
      );
      CREATE TABLE star_live.products (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        category_id text,
        name text NOT NULL,
        CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id)
          REFERENCES star_live.categories(id)
      );
      CREATE TABLE star_live.sales_facts (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        store_id text NOT NULL,
        product_id text,
        amount_cents integer NOT NULL,
        scenario text NOT NULL,
        segment text,
        occurred_at timestamptz NOT NULL,
        CONSTRAINT sales_facts_store_id_fkey FOREIGN KEY (store_id)
          REFERENCES star_live.stores(id),
        CONSTRAINT sales_facts_product_id_fkey FOREIGN KEY (product_id)
          REFERENCES star_live.products(id)
      );
      CREATE TABLE star_live.line_items (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        sales_fact_id text NOT NULL,
        quantity integer NOT NULL,
        CONSTRAINT line_items_sales_fact_id_fkey FOREIGN KEY (sales_fact_id)
          REFERENCES star_live.sales_facts(id)
      );
      INSERT INTO star_live.stores VALUES
        ('store-a', 'acme', 'Downtown'),
        ('store-b', 'acme', 'Airport'),
        ('store-other', 'globex', 'Other tenant');
      INSERT INTO star_live.categories VALUES
        ('category-energy', 'acme', 'Energy'),
        ('category-hardware', 'acme', 'Hardware'),
        ('category-other', 'globex', 'Other tenant');
      INSERT INTO star_live.products VALUES
        ('product-energy', 'acme', 'category-energy', 'Battery'),
        ('product-hardware', 'acme', 'category-hardware', 'Cable'),
        ('product-other', 'globex', 'category-other', 'Other tenant');
      INSERT INTO star_live.sales_facts
        (id, tenant_id, store_id, product_id, amount_cents, scenario, segment, occurred_at)
      VALUES ${values};
      INSERT INTO star_live.line_items (id, tenant_id, sales_fact_id, quantity)
      SELECT 'line-' || id || '-' || n, tenant_id, id, n
      FROM star_live.sales_facts CROSS JOIN generate_series(1, 3) AS n;
      GRANT USAGE ON SCHEMA star_live TO synapsor_reader;
      GRANT SELECT ON ALL TABLES IN SCHEMA star_live TO synapsor_reader;
      ALTER TABLE star_live.stores ENABLE ROW LEVEL SECURITY;
      ALTER TABLE star_live.stores FORCE ROW LEVEL SECURITY;
      ALTER TABLE star_live.categories ENABLE ROW LEVEL SECURITY;
      ALTER TABLE star_live.categories FORCE ROW LEVEL SECURITY;
      ALTER TABLE star_live.products ENABLE ROW LEVEL SECURITY;
      ALTER TABLE star_live.products FORCE ROW LEVEL SECURITY;
      ALTER TABLE star_live.sales_facts ENABLE ROW LEVEL SECURITY;
      ALTER TABLE star_live.sales_facts FORCE ROW LEVEL SECURITY;
      ALTER TABLE star_live.line_items ENABLE ROW LEVEL SECURITY;
      ALTER TABLE star_live.line_items FORCE ROW LEVEL SECURITY;
      CREATE POLICY stores_tenant_read ON star_live.stores FOR SELECT TO synapsor_reader
        USING (tenant_id = current_setting('app.tenant_id', true));
      CREATE POLICY categories_tenant_read ON star_live.categories FOR SELECT TO synapsor_reader
        USING (tenant_id = current_setting('app.tenant_id', true));
      CREATE POLICY products_tenant_read ON star_live.products FOR SELECT TO synapsor_reader
        USING (tenant_id = current_setting('app.tenant_id', true));
      CREATE POLICY sales_facts_tenant_read ON star_live.sales_facts FOR SELECT TO synapsor_reader
        USING (tenant_id = current_setting('app.tenant_id', true));
      CREATE POLICY line_items_tenant_read ON star_live.line_items FOR SELECT TO synapsor_reader
        USING (tenant_id = current_setting('app.tenant_id', true));
    `);
  } finally {
    await pool.end();
  }
}

async function seedMysql() {
  const connection = await mysql.createConnection({
    uri: mysqlAdminUrl,
    multipleStatements: true,
  });
  const values = sqlValues(fixtureRows());
  try {
    await connection.query(`
      DROP DATABASE IF EXISTS synapsor_star;
      CREATE DATABASE synapsor_star;
      CREATE TABLE synapsor_star.stores (
        id varchar(64) PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        name varchar(128) NOT NULL
      );
      CREATE TABLE synapsor_star.categories (
        id varchar(64) PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        name varchar(128) NOT NULL
      );
      CREATE TABLE synapsor_star.products (
        id varchar(64) PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        category_id varchar(64),
        name varchar(128) NOT NULL,
        CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id)
          REFERENCES synapsor_star.categories(id)
      );
      CREATE TABLE synapsor_star.sales_facts (
        id varchar(64) PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        store_id varchar(64) NOT NULL,
        product_id varchar(64),
        amount_cents integer NOT NULL,
        scenario varchar(32) NOT NULL,
        segment varchar(64),
        occurred_at timestamp NOT NULL,
        CONSTRAINT sales_facts_store_id_fkey FOREIGN KEY (store_id)
          REFERENCES synapsor_star.stores(id),
        CONSTRAINT sales_facts_product_id_fkey FOREIGN KEY (product_id)
          REFERENCES synapsor_star.products(id)
      );
      CREATE TABLE synapsor_star.line_items (
        id varchar(128) PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        sales_fact_id varchar(64) NOT NULL,
        quantity integer NOT NULL,
        CONSTRAINT line_items_sales_fact_id_fkey FOREIGN KEY (sales_fact_id)
          REFERENCES synapsor_star.sales_facts(id)
      );
      INSERT INTO synapsor_star.stores VALUES
        ('store-a', 'acme', 'Downtown'),
        ('store-b', 'acme', 'Airport'),
        ('store-other', 'globex', 'Other tenant');
      INSERT INTO synapsor_star.categories VALUES
        ('category-energy', 'acme', 'Energy'),
        ('category-hardware', 'acme', 'Hardware'),
        ('category-other', 'globex', 'Other tenant');
      INSERT INTO synapsor_star.products VALUES
        ('product-energy', 'acme', 'category-energy', 'Battery'),
        ('product-hardware', 'acme', 'category-hardware', 'Cable'),
        ('product-other', 'globex', 'category-other', 'Other tenant');
      INSERT INTO synapsor_star.sales_facts
        (id, tenant_id, store_id, product_id, amount_cents, scenario, segment, occurred_at)
      VALUES ${values};
      INSERT INTO synapsor_star.line_items
        SELECT CONCAT('line-', id, '-1'), tenant_id, id, 1 FROM synapsor_star.sales_facts;
      INSERT INTO synapsor_star.line_items
        SELECT CONCAT('line-', id, '-2'), tenant_id, id, 2 FROM synapsor_star.sales_facts;
      INSERT INTO synapsor_star.line_items
        SELECT CONCAT('line-', id, '-3'), tenant_id, id, 3 FROM synapsor_star.sales_facts;
      CREATE USER IF NOT EXISTS 'synapsor_star_reader'@'%' IDENTIFIED BY 'synapsor_star_reader_password';
      GRANT SELECT ON synapsor_star.* TO 'synapsor_star_reader'@'%';
      FLUSH PRIVILEGES;
    `);
  } finally {
    await connection.end();
  }
}

function projectSummary(projectRoot) {
  return {
    root: projectRoot,
    package_manager: "pnpm",
    frameworks: [],
    schema_inputs: [],
    database_env_names: ["STAR_DATABASE_URL"],
  };
}

function expectedGroups(includeNull) {
  return [
    { stores_name: "Airport", categories_name: "Energy", sum_amount_cents: 1500 },
    { stores_name: "Airport", categories_name: "Hardware", sum_amount_cents: 2000 },
    { stores_name: "Downtown", categories_name: "Energy", sum_amount_cents: 500 },
    { stores_name: "Downtown", categories_name: "Hardware", sum_amount_cents: 1000 },
    ...(includeNull
      ? [{ stores_name: "Downtown", categories_name: null, sum_amount_cents: 2500 }]
      : []),
  ].sort(groupOrder);
}

function groupOrder(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

async function sourceSnapshot(engine, admin) {
  if (engine === "postgres") {
    const result = await admin.query("SELECT COUNT(*)::int AS count, SUM(amount_cents)::int AS total FROM star_live.sales_facts");
    return result.rows[0];
  }
  const [rows] = await admin.query("SELECT COUNT(*) AS count, SUM(amount_cents) AS total FROM synapsor_star.sales_facts");
  return { count: Number(rows[0].count), total: Number(rows[0].total) };
}

async function verifyEngine(engine, readUrl, inspectedSchema, admin) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `synapsor-star-${engine}-`));
  temporaryRoots.push(projectRoot);
  const env = {
    STAR_DATABASE_URL: readUrl,
    SYNAPSOR_TENANT_ID: "acme",
    SYNAPSOR_PRINCIPAL: "analyst-1",
  };
  const before = await sourceSnapshot(engine, admin);
  const inspection = await inspectDatabase({
    engine,
    databaseUrlEnv: "STAR_DATABASE_URL",
    schema: inspectedSchema,
    env,
  });
  assert(inspection.role_posture?.verified && inspection.role_posture.read_only,
    `${engine} reader role was not demonstrably read-only`, inspection.role_posture);
  const buildInput = {
    inspection,
    project: projectSummary(projectRoot),
    sourceEnv: "STAR_DATABASE_URL",
    inspectedSchema,
  };
  let build = buildAutoBoundary(buildInput);
  if (engine === "mysql") {
    const decidedAt = "2026-07-25T00:00:00.000Z";
    build = buildAutoBoundary({
      ...buildInput,
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: Object.fromEntries(inspection.tables.map((table) => [
          `${table.schema}.${table.name}`,
          {
            tenant_key: {
              value: "tenant_id",
              actor: "star-verifier",
              reason: "The fixture owner confirms tenant_id is the authorization boundary for this reviewed resource.",
              decided_at: decidedAt,
            },
          },
        ])),
      },
    });
  }
  await writeAutoBoundaryArtifacts({ projectRoot, build });
  const factId = `${inspectedSchema}.sales_facts`;
  const fact = build.exploration_boundary.pack.resources.find((resource) => resource.id === factId);
  assert(fact, `${engine} did not generate the sales fact resource`);
  assert(
    inspection.tables.find((table) => table.name === "sales_facts")
      ?.columns.find((column) => column.name === "product_id")?.nullable === true,
    `${engine} did not preserve nullable foreign-key metadata`,
  );
  assert(fact.aggregate_measures.includes("amount_cents"),
    `${engine} did not classify the inspected integer measure as aggregate-safe`, fact.aggregate_measures);
  assert(fact.relationships.some((relationship) =>
    relationship.id === "sales_facts_store_id_fkey"
    && relationship.path_depth === 1
    && relationship.nullable === false),
  `${engine} did not prove the store dimension`, {
    generated_relationships: fact.relationships,
    inspected_foreign_keys: inspection.tables.find((table) => table.name === "sales_facts")?.foreign_keys,
    store_primary_key: inspection.tables.find((table) => table.name === "stores")?.primary_key,
    store_unique_constraints: inspection.tables.find((table) => table.name === "stores")?.unique_constraints,
    store_indexes: inspection.tables.find((table) => table.name === "stores")?.indexes,
    graph_relationships: build.graph.resources.find((resource) => resource.id === factId)?.relationships,
    graph_fields: build.graph.resources.find((resource) => resource.id === factId)?.fields
      .filter((field) => ["store_id", "product_id"].includes(field.name)),
    graph_targets: build.graph.resources
      .filter((resource) => ["stores", "products"].includes(resource.table))
      .map((resource) => ({
        id: resource.id,
        status: resource.status,
        tenant: resource.tenant_key,
        principal: resource.principal_key,
        id_field: resource.fields.find((field) => field.name === "id"),
      })),
  });
  assert(fact.relationships.some((relationship) =>
    relationship.id === "sales_facts_product_id_fkey__products_category_id_fkey"
    && relationship.path_depth === 2
    && relationship.nullable === true
    && relationship.unmatched_rows === "review_required"),
  `${engine} did not prove the depth-two category dimension`, fact.relationships);
  assert(!fact.relationships.some((relationship) =>
    relationship.target_resource === `${inspectedSchema}.line_items`),
  `${engine} generated a one-to-many fan-out path`, fact.relationships);

  const plan = {
    kind: "aggregate",
    resource: factId,
    measures: [{ function: "sum", field: "amount_cents" }],
    dimensions: [
      { field: "name", relationship: "sales_facts_store_id_fkey" },
      { field: "name", relationship: "sales_facts_product_id_fkey__products_category_id_fkey" },
    ],
    where: [{ field: "scenario", op: "eq", value: "star" }],
    top_n: 10,
  };

  for (const [choice, includeNull] of [["keep_null", true], ["exclude", false]]) {
    const candidate = structuredClone(build.exploration_boundary);
    for (const resource of candidate.pack.resources) {
      for (const relationship of resource.relationships) {
        if (relationship.unmatched_rows === "review_required") {
          relationship.unmatched_rows = choice;
        }
      }
    }
    const reviewed = reviewExplorationBoundaryCandidate(build.exploration_boundary, candidate);
    await activateExplorationBoundary({
      projectRoot,
      candidate: reviewed.candidate,
      expectedDigest: reviewed.digest,
      actor: "star-verifier",
      confirmation: `ACTIVATE ${reviewed.digest}`,
      confirmedDecisions: reviewed.candidate.unresolved_decisions,
      currentInspection: inspection,
    });
    const runtime = await createScopedExploreRuntime({
      projectRoot,
      transport: "stdio",
      env,
    });
    try {
      const result = await runtime.explore(plan);
      assert(result.source_database_changed === false, `${engine} star aggregate reported a mutation`, result);
      assert(result.counted_entity?.resource === factId
        && result.counted_entity?.primary_key === "id",
      `${engine} star aggregate did not name its counted entity`, result.counted_entity);
      assert(JSON.stringify([...result.data].sort(groupOrder)) === JSON.stringify(expectedGroups(includeNull)),
        `${engine} ${choice} star aggregate returned incorrect values`, result.data);

      const wrong = {
        ...plan,
        dimensions: [{
          field: "quantity",
          relationship: "line_items_sales_fact_id_fkey",
        }],
      };
      await runtime.explore(wrong).then(
        () => assert(false, `${engine} accepted a reverse one-to-many path`),
        (error) => assert(error?.code === "EXPLORE_RELATIONSHIP_FORBIDDEN",
          `${engine} refused the wrong join with an unexpected error`, { code: error?.code, message: error?.message }),
      );
    } finally {
      await runtime.close();
    }
  }

  assert(fact.groupable_fields.includes("segment"),
    `${engine} did not review the ranked fixture dimension`, fact.groupable_fields);
  assert(fact.filterable_fields.scenario?.includes("eq"),
    `${engine} did not review the ranked fixture filter`, fact.filterable_fields);
  assert(fact.time_bucket_fields.occurred_at?.includes("week"),
    `${engine} did not review the ranked fixture time field`, fact.time_bucket_fields);
  assert((build.exploration_boundary.budgets.max_ranked_groups ?? 0) > build.exploration_boundary.budgets.max_groups,
    `${engine} did not generate a separate ranked candidate ceiling`, build.exploration_boundary.budgets);

  const rankedCandidate = structuredClone(build.exploration_boundary);
  for (const resource of rankedCandidate.pack.resources) {
    for (const relationship of resource.relationships) {
      if (relationship.unmatched_rows === "review_required") relationship.unmatched_rows = "exclude";
    }
  }
  const rankedReviewed = reviewExplorationBoundaryCandidate(build.exploration_boundary, rankedCandidate);
  await activateExplorationBoundary({
    projectRoot,
    candidate: rankedReviewed.candidate,
    expectedDigest: rankedReviewed.digest,
    actor: "ranked-analytics-verifier",
    confirmation: `ACTIVATE ${rankedReviewed.digest}`,
    confirmedDecisions: rankedReviewed.candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  const rankedRuntime = await createScopedExploreRuntime({ projectRoot, transport: "stdio", env });
  const rankedPlan = {
    kind: "aggregate",
    resource: factId,
    measures: [{ function: "sum", field: "amount_cents" }],
    dimensions: [{ field: "segment" }],
    where: [{ field: "scenario", op: "eq", value: "rank" }],
    order_by: { kind: "measure", index: 0, direction: "desc" },
    top_n: 3,
  };
  try {
    const ranked = await rankedRuntime.explore(rankedPlan);
    assert(
      JSON.stringify(ranked.data.map((row) => row.segment))
        === JSON.stringify(["segment-059", "segment-058", "segment-057"]),
      `${engine} did not rank the complete high-cardinality candidate set`, ranked,
    );
    assert(ranked.privacy?.suppressed_groups === 1,
      `${engine} did not suppress the high-valued small cohort before ranking`, ranked.privacy);
    assert(!JSON.stringify(ranked).includes("private-winner"),
      `${engine} leaked the suppressed ranked group`, ranked);

    await rankedRuntime.explore({
      ...rankedPlan,
      order_by: undefined,
    }).then(
      () => assert(false, `${engine} ordinary aggregate bypassed max_groups`),
      (error) => assert(error?.code === "EXPLORE_RESPONSE_TOO_LARGE",
        `${engine} ordinary aggregate overflow failed with an unexpected error`, {
          code: error?.code,
          message: error?.message,
        }),
    );

    const movers = await rankedRuntime.explore({
      ...rankedPlan,
      time_bucket: { field: "occurred_at", bucket: "week" },
      comparison: {
        field: "occurred_at",
        ranges: [
          { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
          { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
        ],
      },
      order_by: { kind: "comparison_change", index: 0, change: "percentage", direction: "desc" },
    });
    assert(
      JSON.stringify(movers.data.map((row) => row.segment))
        === JSON.stringify(["segment-059", "segment-058", "segment-057"]),
      `${engine} did not rank two-period percentage movers`, movers,
    );
    assert(movers.privacy?.suppressed_groups === 2,
      `${engine} did not suppress the small cohort in both comparison periods`, movers.privacy);
    assert(!JSON.stringify(movers).includes("private-winner"),
      `${engine} leaked the suppressed period mover`, movers);
    assert(
      Math.abs(Number(movers.data[0]?.sum_amount_cents_percentage_change) - (900 / 795 * 100)) < 1e-9,
      `${engine} returned incorrect two-period mover math`, movers.data[0],
    );
  } finally {
    await rankedRuntime.close();
  }
  const after = await sourceSnapshot(engine, admin);
  assert(JSON.stringify(after) === JSON.stringify(before), `${engine} live read verification changed source rows`, { before, after });
  console.log(`${engine} reviewed relationship/ranking verification passed with exact totals, nullable semantics, high-cardinality top-N, period movers, suppression, scope, and fan-out refusal.`);
}

run("docker", ["compose", "-f", compose, "up", "-d", "--wait", "postgres", "mysql"], { inherit: true });
const postgresAdmin = new Pool({ connectionString: postgresAdminUrl, max: 1 });
let mysqlAdmin;
try {
  await seedPostgres();
  await seedMysql();
  mysqlAdmin = await mysql.createConnection({ uri: mysqlAdminUrl });
  await verifyEngine("postgres", postgresReadUrl, "star_live", postgresAdmin);
  await verifyEngine("mysql", mysqlReadUrl, "synapsor_star", mysqlAdmin);
  console.log("Reviewed star-schema relationship verification passed on live PostgreSQL and MySQL.");
} finally {
  await postgresAdmin.end().catch(() => undefined);
  await mysqlAdmin?.end().catch(() => undefined);
  run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
  for (const directory of temporaryRoots) fs.rmSync(directory, { recursive: true, force: true });
}
