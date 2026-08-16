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
  const metricSeries = [
    ["growth", [10, 20, 30]],
    ["retained", [40, 50, 60]],
  ];
  for (const [segment, weeklyAmounts] of metricSeries) {
    for (let week = 0; week < weeklyAmounts.length; week += 1) {
      for (let index = 0; index < 5; index += 1) {
        rows.push({
          id: `metric-${segment}-${week}-${index}`,
          tenant: "acme",
          store: "store-a",
          product: "product-energy",
          amount: weeklyAmounts[week],
          scenario: "metrics",
          segment,
          occurredAt: `2026-07-${String(6 + (week * 7)).padStart(2, "0")} 00:00:00`,
        });
      }
    }
  }
  for (let index = 0; index < 2; index += 1) {
    rows.push({
      id: `metric-private-${index}`,
      tenant: "acme",
      store: "store-a",
      product: "product-energy",
      amount: 999,
      scenario: "metrics",
      segment: "private-small",
      occurredAt: "2026-07-13 00:00:00",
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
        department_id text NOT NULL,
        name text NOT NULL
      );
      CREATE TABLE star_live.departments (
        id text PRIMARY KEY,
        tenant_id text NOT NULL,
        name text NOT NULL
      );
      ALTER TABLE star_live.categories
        ADD CONSTRAINT categories_department_id_fkey FOREIGN KEY (department_id)
        REFERENCES star_live.departments(id);
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
      CREATE INDEX sales_facts_store_id_idx ON star_live.sales_facts(store_id);
      CREATE INDEX sales_facts_product_id_idx ON star_live.sales_facts(product_id);
      CREATE INDEX products_category_id_idx ON star_live.products(category_id);
      CREATE INDEX categories_department_id_idx ON star_live.categories(department_id);
      CREATE INDEX line_items_sales_fact_id_idx ON star_live.line_items(sales_fact_id);
      INSERT INTO star_live.stores VALUES
        ('store-a', 'acme', 'Downtown'),
        ('store-b', 'acme', 'Airport'),
        ('store-other', 'globex', 'Other tenant');
      INSERT INTO star_live.departments VALUES
        ('department-energy', 'acme', 'Energy portfolio'),
        ('department-hardware', 'acme', 'Hardware portfolio'),
        ('department-other', 'globex', 'Other tenant');
      INSERT INTO star_live.categories VALUES
        ('category-energy', 'acme', 'department-energy', 'Energy'),
        ('category-hardware', 'acme', 'department-hardware', 'Hardware'),
        ('category-other', 'globex', 'department-other', 'Other tenant');
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
      ALTER TABLE star_live.departments ENABLE ROW LEVEL SECURITY;
      ALTER TABLE star_live.departments FORCE ROW LEVEL SECURITY;
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
      CREATE POLICY departments_tenant_read ON star_live.departments FOR SELECT TO synapsor_reader
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
        department_id varchar(64) NOT NULL,
        name varchar(128) NOT NULL
      );
      CREATE TABLE synapsor_star.departments (
        id varchar(64) PRIMARY KEY,
        tenant_id varchar(64) NOT NULL,
        name varchar(128) NOT NULL
      );
      ALTER TABLE synapsor_star.categories
        ADD CONSTRAINT categories_department_id_fkey FOREIGN KEY (department_id)
        REFERENCES synapsor_star.departments(id);
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
      INSERT INTO synapsor_star.departments VALUES
        ('department-energy', 'acme', 'Energy portfolio'),
        ('department-hardware', 'acme', 'Hardware portfolio'),
        ('department-other', 'globex', 'Other tenant');
      INSERT INTO synapsor_star.categories VALUES
        ('category-energy', 'acme', 'department-energy', 'Energy'),
        ('category-hardware', 'acme', 'department-hardware', 'Hardware'),
        ('category-other', 'globex', 'department-other', 'Other tenant');
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
  let depthThreeExecutionDurationMs;
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
  const depthThreeRelationship = "sales_facts_product_id_fkey__products_category_id_fkey__categories_department_id_fkey";
  assert(fact.relationships.some((relationship) =>
    relationship.id === depthThreeRelationship
    && relationship.path_depth === 3
    && relationship.proof?.links.length === 3
    && relationship.nullable === true
    && relationship.unmatched_rows === "review_required"),
  `${engine} did not preserve the exact depth-three department candidate`, fact.relationships);
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
    assert(!reviewed.candidate.pack.resources.find((resource) => resource.id === factId)
      ?.relationships.some((relationship) => relationship.id === depthThreeRelationship),
    `${engine} activated depth three without the explicit reviewed opt-in`, reviewed.candidate.budgets);
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

  const defaultDepthRuntime = await createScopedExploreRuntime({
    projectRoot,
    transport: "stdio",
    env,
  });
  try {
    await defaultDepthRuntime.explore({
      kind: "aggregate",
      resource: factId,
      measures: [{ function: "sum", field: "amount_cents" }],
      dimensions: [{ field: "name", relationship: depthThreeRelationship }],
      where: [{ field: "scenario", op: "eq", value: "star" }],
      top_n: 10,
    }).then(
      () => assert(false, `${engine} accepted depth three under the depth-two default`),
      (error) => assert(error?.code === "EXPLORE_RELATIONSHIP_FORBIDDEN",
        `${engine} refused the inactive depth-three path with an unexpected error`, {
          code: error?.code,
          message: error?.message,
        }),
    );
  } finally {
    await defaultDepthRuntime.close();
  }

  const overDepthCandidate = structuredClone(build.exploration_boundary);
  overDepthCandidate.budgets.max_analysis_relationship_hops = 4;
  try {
    reviewExplorationBoundaryCandidate(build.exploration_boundary, overDepthCandidate);
    assert(false, `${engine} accepted an analysis relationship depth above the reviewed hard cap`);
  } catch (error) {
    assert(/hard reviewed ceiling 3|hard-capped at three proven hops/i.test(error?.message ?? ""),
      `${engine} refused analysis relationship depth four with an unexpected error`, {
        message: error?.message,
      });
  }

  const depthThreeCandidate = structuredClone(build.exploration_boundary);
  depthThreeCandidate.budgets.max_analysis_relationship_hops = 3;
  assert(depthThreeCandidate.budgets.max_derived_scope_hops === 2,
    `${engine} raising analysis depth implicitly raised derived-scope depth`, depthThreeCandidate.budgets);
  for (const resource of depthThreeCandidate.pack.resources) {
    for (const relationship of resource.relationships) {
      if (relationship.unmatched_rows === "review_required") relationship.unmatched_rows = "exclude";
    }
  }
  const depthThreeReviewed = reviewExplorationBoundaryCandidate(
    build.exploration_boundary,
    depthThreeCandidate,
  );
  await activateExplorationBoundary({
    projectRoot,
    candidate: depthThreeReviewed.candidate,
    expectedDigest: depthThreeReviewed.digest,
    actor: "depth-three-verifier",
    confirmation: `ACTIVATE ${depthThreeReviewed.digest}`,
    confirmedDecisions: depthThreeReviewed.candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  const depthThreeRuntime = await createScopedExploreRuntime({
    projectRoot,
    transport: "stdio",
    env,
  });
  try {
    const depthThreeStartedAt = performance.now();
    const result = await depthThreeRuntime.explore({
      kind: "aggregate",
      resource: factId,
      measures: [{ function: "sum", field: "amount_cents" }],
      dimensions: [{ field: "name", relationship: depthThreeRelationship }],
      where: [{ field: "scenario", op: "eq", value: "star" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    });
    depthThreeExecutionDurationMs = Math.round((performance.now() - depthThreeStartedAt) * 100) / 100;
    assert(JSON.stringify(result.data) === JSON.stringify([
      { departments_name: "Energy portfolio", sum_amount_cents: 6995 },
      { departments_name: "Hardware portfolio", sum_amount_cents: 3000 },
    ]), `${engine} returned incorrect depth-three department totals`, result.data);
    assert(result.source_database_changed === false,
      `${engine} depth-three aggregate reported a source mutation`, result);
  } finally {
    await depthThreeRuntime.close();
  }

  const metricsCandidate = structuredClone(build.exploration_boundary);
  const metricsFact = metricsCandidate.pack.resources.find((resource) => resource.id === factId);
  assert(metricsFact, `${engine} metrics candidate omitted the sales fact resource`);
  metricsFact.derived_measures = [
    {
      name: "amount_ratio_per_sale",
      label: "Amount ratio per sale",
      shape: "ratio",
      numerator: { function: "sum", field: "amount_cents" },
      denominator: { function: "count" },
      null_policy: "null_on_zero_or_null_denominator",
    },
    {
      name: "amount_per_sale",
      label: "Amount per sale",
      shape: "per_unit_average",
      numerator: { function: "sum", field: "amount_cents" },
      denominator: { function: "count" },
      null_policy: "null_on_zero_or_null_denominator",
    },
    {
      name: "distinct_sale_percentage",
      label: "Distinct sale percentage",
      shape: "percentage",
      numerator: { function: "count_distinct", field: "id" },
      denominator: { function: "count" },
      null_policy: "null_on_zero_or_null_denominator",
    },
    {
      name: "amount_running_total",
      label: "Amount running total",
      shape: "running_total",
      base_measure: { function: "sum", field: "amount_cents" },
    },
    {
      name: "amount_rank",
      label: "Amount rank",
      shape: "rank",
      base_measure: { function: "sum", field: "amount_cents" },
      direction: "desc",
    },
    {
      name: "amount_lag_change",
      label: "Amount change from prior period",
      shape: "lag_absolute_change",
      base_measure: { function: "sum", field: "amount_cents" },
    },
    {
      name: "amount_lag_percentage",
      label: "Amount percentage change from prior period",
      shape: "lag_percentage_change",
      base_measure: { function: "sum", field: "amount_cents" },
    },
    {
      name: "amount_moving_average",
      label: "Two-period amount moving average",
      shape: "moving_average",
      base_measure: { function: "sum", field: "amount_cents" },
      window_size: 2,
    },
    {
      name: "amount_share",
      label: "Share of released amount",
      shape: "share_of_released_total",
      base_measure: { function: "sum", field: "amount_cents" },
    },
  ];
  for (const resource of metricsCandidate.pack.resources) {
    for (const relationship of resource.relationships) {
      if (relationship.unmatched_rows === "review_required") relationship.unmatched_rows = "exclude";
    }
  }
  const metricsReviewed = reviewExplorationBoundaryCandidate(
    build.exploration_boundary,
    metricsCandidate,
  );
  await activateExplorationBoundary({
    projectRoot,
    candidate: metricsReviewed.candidate,
    expectedDigest: metricsReviewed.digest,
    actor: "reviewed-metrics-verifier",
    confirmation: `ACTIVATE ${metricsReviewed.digest}`,
    confirmedDecisions: metricsReviewed.candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  const metricsRuntime = await createScopedExploreRuntime({
    projectRoot,
    transport: "stdio",
    env,
  });
  try {
    const commonPlan = {
      kind: "aggregate",
      resource: factId,
      dimensions: [{ field: "segment" }],
      where: [{ field: "scenario", op: "eq", value: "metrics" }],
      top_n: 10,
    };
    const ratioResult = await metricsRuntime.explore({
      ...commonPlan,
      measures: [
        { derived_measure: "amount_ratio_per_sale" },
        { derived_measure: "amount_per_sale" },
        { derived_measure: "distinct_sale_percentage" },
      ],
    });
    const ratioRows = new Map(ratioResult.data.map((row) => [row.segment, row]));
    assert(ratioResult.privacy?.suppressed_groups === 1
      && !ratioRows.has("private-small")
      && ratioRows.get("growth")?.amount_ratio_per_sale === 20
      && ratioRows.get("growth")?.amount_per_sale === 20
      && ratioRows.get("growth")?.distinct_sale_percentage === 100
      && ratioRows.get("retained")?.amount_ratio_per_sale === 50
      && ratioRows.get("retained")?.amount_per_sale === 50
      && ratioRows.get("retained")?.distinct_sale_percentage === 100,
    `${engine} returned incorrect reviewed ratio/per-unit metrics or included a suppressed input`, ratioResult);

    const rankedResult = await metricsRuntime.explore({
      ...commonPlan,
      measures: [
        { derived_measure: "amount_rank" },
        { derived_measure: "amount_share" },
      ],
    });
    const rankedRows = new Map(rankedResult.data.map((row) => [row.segment, row]));
    const growthShare = Number(rankedRows.get("growth")?.amount_share);
    const retainedShare = Number(rankedRows.get("retained")?.amount_share);
    assert(rankedResult.privacy?.suppressed_groups === 1
      && !rankedRows.has("private-small")
      && rankedRows.get("growth")?.amount_rank === 2
      && rankedRows.get("retained")?.amount_rank === 1
      && Math.abs(growthShare - (100 * 300 / 1050)) < 1e-9
      && Math.abs(retainedShare - (100 * 750 / 1050)) < 1e-9,
    `${engine} ranked or shared against suppressed groups`, rankedResult);

    const sequentialPlan = {
      ...commonPlan,
      time_bucket: { field: "occurred_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
    };
    const sequentialResult = await metricsRuntime.explore({
      ...sequentialPlan,
      measures: [
        { derived_measure: "amount_running_total" },
        { derived_measure: "amount_lag_change" },
        { derived_measure: "amount_lag_percentage" },
      ],
    });
    const series = (segment, field) => sequentialResult.data
      .filter((row) => row.segment === segment)
      .sort((left, right) => String(left.time_bucket).localeCompare(String(right.time_bucket)))
      .map((row) => row[field]);
    assert(sequentialResult.privacy?.suppressed_groups === 1
      && !sequentialResult.data.some((row) => row.segment === "private-small")
      && JSON.stringify(series("growth", "amount_running_total")) === JSON.stringify([50, 150, 300])
      && JSON.stringify(series("retained", "amount_running_total")) === JSON.stringify([200, 450, 750])
      && JSON.stringify(series("growth", "amount_lag_change")) === JSON.stringify([null, 50, 50])
      && JSON.stringify(series("retained", "amount_lag_change")) === JSON.stringify([null, 50, 50])
      && JSON.stringify(series("growth", "amount_lag_percentage")) === JSON.stringify([null, 100, 50])
      && JSON.stringify(series("retained", "amount_lag_percentage")) === JSON.stringify([null, 25, 20]),
    `${engine} returned incorrect post-suppression running or lag metrics`, sequentialResult);

    const movingResult = await metricsRuntime.explore({
      ...sequentialPlan,
      measures: [{ derived_measure: "amount_moving_average" }],
    });
    const movingSeries = (segment) => movingResult.data
      .filter((row) => row.segment === segment)
      .sort((left, right) => String(left.time_bucket).localeCompare(String(right.time_bucket)))
      .map((row) => row.amount_moving_average);
    assert(movingResult.privacy?.suppressed_groups === 1
      && !movingResult.data.some((row) => row.segment === "private-small")
      && JSON.stringify(movingSeries("growth")) === JSON.stringify([50, 75, 125])
      && JSON.stringify(movingSeries("retained")) === JSON.stringify([200, 225, 275]),
    `${engine} returned an incorrect reviewed moving average`, movingResult);

    await metricsRuntime.explore({
      ...commonPlan,
      measures: [{
        derived_measure: "amount_per_sale",
        formula: "SUM(amount_cents) / COUNT(*)",
      }],
    }).then(
      () => assert(false, `${engine} accepted a model-authored formula`),
      (error) => assert(error?.code === "EXPLORE_PLAN_INVALID"
        && /formula|unsupported/i.test(error?.message ?? ""),
      `${engine} refused a model-authored formula with an unexpected error`, {
        code: error?.code,
        message: error?.message,
      }),
    );
  } finally {
    await metricsRuntime.close();
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
  console.log(`${engine} reviewed relationship/ranking verification passed with exact totals, independent depth-three analysis opt-in (${depthThreeExecutionDurationMs} ms end-to-end verifier latency), the complete reviewed metric family, nullable semantics, high-cardinality top-N, period movers, suppression, scope, and fan-out refusal.`);
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
