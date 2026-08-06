import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import mysql from "../packages/mysql/node_modules/mysql2/promise.js";
import { Pool } from "pg";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import { startStreamableHttpMcpServer } from "../packages/mcp-server/dist/index.js";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import {
  assertProductionExploreStartup,
  productionExploreSessionFactory,
} from "../apps/runner/dist/mcp-runtime.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = path.join(root, "examples/runner-fleet/docker-compose.yml");
const composeProject = `synapsor-production-explore-mysql-${process.pid}`;
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-mysql-http-"));
const mysqlAdminUrl = "mysql://root:root_password@127.0.0.1:53309";
const mysqlReadUrl = "mysql://synapsor_production_reader:synapsor_production_reader_password@127.0.0.1:53309/synapsor_production_explore";
const controlUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet";
const controlSchema = `synapsor_production_mysql_${process.pid}`;
const sourceSchema = "synapsor_production_explore";
const sourceId = `${sourceSchema}.events`;
const scopedOrdersId = `${sourceSchema}.scoped_orders`;
const scopedOrderItemsId = `${sourceSchema}.scoped_order_items`;

function assert(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
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

async function seedSource(connection) {
  await connection.query(`
    DROP DATABASE IF EXISTS ${sourceSchema};
    CREATE DATABASE ${sourceSchema};
    CREATE TABLE ${sourceSchema}.events (
      id varchar(64) PRIMARY KEY,
      tenant_id varchar(64) NOT NULL,
      category enum('growth', 'retained', 'private-small', 'enterprise') NOT NULL,
      amount_cents integer NOT NULL,
      occurred_at timestamp NOT NULL
    );
    CREATE TABLE ${sourceSchema}.scoped_orders (
      id varchar(64) PRIMARY KEY,
      tenant_id varchar(64) NOT NULL,
      owner_id varchar(64) NOT NULL,
      category enum('enterprise', 'trail') NOT NULL,
      occurred_at timestamp NOT NULL
    );
    CREATE TABLE ${sourceSchema}.scoped_order_items (
      id varchar(64) PRIMARY KEY,
      order_id varchar(64) NOT NULL,
      item_kind enum('standard') NOT NULL,
      quantity integer NOT NULL,
      occurred_at timestamp NOT NULL,
      CONSTRAINT scoped_order_items_order_id_fkey
        FOREIGN KEY (order_id) REFERENCES ${sourceSchema}.scoped_orders(id) ON DELETE RESTRICT
    );
    INSERT INTO ${sourceSchema}.events (id, tenant_id, category, amount_cents, occurred_at) VALUES
      ('a-1', 'acme', 'growth', 100, '2026-07-01 00:00:00'),
      ('a-2', 'acme', 'growth', 110, '2026-07-02 00:00:00'),
      ('a-3', 'acme', 'growth', 120, '2026-07-03 00:00:00'),
      ('a-4', 'acme', 'growth', 130, '2026-07-04 00:00:00'),
      ('a-5', 'acme', 'growth', 140, '2026-07-05 00:00:00'),
      ('a-6', 'acme', 'retained', 200, '2026-07-06 00:00:00'),
      ('a-7', 'acme', 'retained', 210, '2026-07-07 00:00:00'),
      ('a-8', 'acme', 'retained', 220, '2026-07-08 00:00:00'),
      ('a-9', 'acme', 'retained', 230, '2026-07-09 00:00:00'),
      ('a-10', 'acme', 'retained', 240, '2026-07-10 00:00:00'),
      ('a-private-1', 'acme', 'private-small', 999, '2026-07-11 00:00:00'),
      ('a-private-2', 'acme', 'private-small', 999, '2026-07-12 00:00:00'),
      ('g-1', 'globex', 'enterprise', 500, '2026-07-01 00:00:00'),
      ('g-2', 'globex', 'enterprise', 510, '2026-07-02 00:00:00'),
      ('g-3', 'globex', 'enterprise', 520, '2026-07-03 00:00:00'),
      ('g-4', 'globex', 'enterprise', 530, '2026-07-04 00:00:00'),
      ('g-5', 'globex', 'enterprise', 540, '2026-07-05 00:00:00');
    INSERT INTO ${sourceSchema}.scoped_orders (id, tenant_id, owner_id, category, occurred_at) VALUES
      ('derived-acme-order', 'acme', 'derived-acme', 'trail', '2026-07-01 00:00:00'),
      ('derived-globex-order', 'globex', 'derived-globex', 'enterprise', '2026-07-01 00:00:00');
    INSERT INTO ${sourceSchema}.scoped_order_items (id, order_id, item_kind, quantity, occurred_at) VALUES
      ('derived-acme-item-1', 'derived-acme-order', 'standard', 1, '2026-07-01 00:00:00'),
      ('derived-acme-item-2', 'derived-acme-order', 'standard', 2, '2026-07-01 00:00:00'),
      ('derived-acme-item-3', 'derived-acme-order', 'standard', 3, '2026-07-01 00:00:00'),
      ('derived-acme-item-4', 'derived-acme-order', 'standard', 4, '2026-07-01 00:00:00'),
      ('derived-acme-item-5', 'derived-acme-order', 'standard', 5, '2026-07-01 00:00:00'),
      ('derived-globex-item-1', 'derived-globex-order', 'standard', 1, '2026-07-01 00:00:00'),
      ('derived-globex-item-2', 'derived-globex-order', 'standard', 2, '2026-07-01 00:00:00'),
      ('derived-globex-item-3', 'derived-globex-order', 'standard', 3, '2026-07-01 00:00:00'),
      ('derived-globex-item-4', 'derived-globex-order', 'standard', 4, '2026-07-01 00:00:00'),
      ('derived-globex-item-5', 'derived-globex-order', 'standard', 5, '2026-07-01 00:00:00'),
      ('derived-globex-item-6', 'derived-globex-order', 'standard', 6, '2026-07-01 00:00:00'),
      ('derived-globex-item-7', 'derived-globex-order', 'standard', 7, '2026-07-01 00:00:00');
    CREATE USER IF NOT EXISTS 'synapsor_production_reader'@'%' IDENTIFIED BY 'synapsor_production_reader_password';
    GRANT SELECT ON ${sourceSchema}.* TO 'synapsor_production_reader'@'%';
    FLUSH PRIVILEGES;
  `);
}

async function sourceSnapshot(connection) {
  const [rows] = await connection.query(`
    SELECT COUNT(*) AS row_count,
      SUM(amount_cents) AS total,
      MAX(occurred_at) AS latest
    FROM ${sourceSchema}.events
  `);
  return {
    row_count: Number(rows[0].row_count),
    total: Number(rows[0].total),
    latest: new Date(rows[0].latest).toISOString(),
    derived: await derivedSourceSnapshot(connection),
  };
}

async function derivedSourceSnapshot(connection) {
  const [rows] = await connection.query(`
    SELECT
      (SELECT COUNT(*) FROM ${sourceSchema}.scoped_orders) AS order_count,
      (SELECT COUNT(*) FROM ${sourceSchema}.scoped_order_items) AS item_count,
      (SELECT SUM(quantity) FROM ${sourceSchema}.scoped_order_items) AS quantity_total
  `);
  return {
    order_count: Number(rows[0].order_count),
    item_count: Number(rows[0].item_count),
    quantity_total: Number(rows[0].quantity_total),
  };
}

function narrowDerivedResources(parent, child) {
  parent.selectable_fields = ["category", "occurred_at"];
  parent.filterable_fields = Object.fromEntries(Object.entries(parent.filterable_fields)
    .filter(([field]) => parent.selectable_fields.includes(field)));
  parent.sortable_fields = parent.sortable_fields.filter((field) => parent.selectable_fields.includes(field));
  parent.groupable_fields = parent.groupable_fields.filter((field) => field === "category");
  parent.aggregate_measures = [];
  parent.time_bucket_fields = Object.fromEntries(Object.entries(parent.time_bucket_fields)
    .filter(([field]) => field === "occurred_at"));

  child.selectable_fields = ["item_kind", "quantity", "occurred_at"];
  child.filterable_fields = Object.fromEntries(Object.entries(child.filterable_fields)
    .filter(([field]) => child.selectable_fields.includes(field)));
  child.sortable_fields = child.sortable_fields.filter((field) => child.selectable_fields.includes(field));
  child.groupable_fields = child.groupable_fields.filter((field) => field === "item_kind");
  child.aggregate_measures = child.aggregate_measures.filter((field) => field === "quantity");
  child.time_bucket_fields = Object.fromEntries(Object.entries(child.time_bucket_fields)
    .filter(([field]) => field === "occurred_at"));
  child.relationships = child.relationships.filter((relationship) =>
    relationship.id === "scoped_order_items_order_id_fkey");
}

function signedToken(privateKey, { tenant, principal }) {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify({
    tenant_id: tenant,
    sub: principal,
    scope: "synapsor.explore",
    iss: "https://identity.example",
    aud: "https://runner.example/mcp",
    iat: now,
    exp: now + 600,
  })).toString("base64url");
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  return `${unsigned}.${crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

function mcpClient(url, bearer) {
  const client = new Client({ name: "production-explore-mysql-verifier", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  return { client, transport };
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP result did not contain structured content.");
  return JSON.parse(text);
}

async function main() {
  run("docker", ["compose", "-p", composeProject, "-f", compose, "up", "-d", "--wait", "postgres", "mysql"], { inherit: true });
  const mysqlAdmin = await mysql.createConnection({ uri: mysqlAdminUrl, multipleStatements: true });
  const control = new Pool({ connectionString: controlUrl, max: 1 });
  let server;
  const clients = [];
  try {
    await seedSource(mysqlAdmin);
    const before = await sourceSnapshot(mysqlAdmin);
    const env = { ...process.env, MYSQL_DATABASE_URL: mysqlReadUrl };
    const inspection = await inspectDatabase({
      engine: "mysql",
      databaseUrlEnv: "MYSQL_DATABASE_URL",
      schema: sourceSchema,
      env,
    });
    assert(inspection.role_posture?.verified === true && inspection.role_posture.read_only === true,
      "MySQL production fixture reader is not demonstrably read-only.", inspection.role_posture);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: projectRoot,
        package_manager: "unknown",
        frameworks: [],
        schema_inputs: [],
        database_env_names: ["MYSQL_DATABASE_URL"],
      },
      sourceEnv: "MYSQL_DATABASE_URL",
      inspectedSchema: sourceSchema,
      deploymentProfile: "production",
      httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          [sourceId]: {
            tenant_key: {
              value: "tenant_id",
              actor: "production-owner@example.test",
              reason: "The application owner confirms tenant_id is the row authorization boundary.",
              decided_at: "2026-08-04T00:00:00.000Z",
            },
          },
          [scopedOrdersId]: {
            tenant_key: {
              value: "tenant_id",
              actor: "production-owner@example.test",
              reason: "The application owner confirms tenant_id is the order authorization boundary.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
            principal_key: {
              value: "owner_id",
              actor: "production-owner@example.test",
              reason: "The verified owner claim scopes each reviewed order.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
          },
          [scopedOrderItemsId]: {
            tenant_scope_path: {
              value: "scoped_order_items_order_id_fkey",
              actor: "production-owner@example.test",
              reason: "Every item belongs to the tenant of its required reviewed order.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
            principal_scope_path: {
              value: "scoped_order_items_order_id_fkey",
              actor: "production-owner@example.test",
              reason: "Every item belongs to the principal of its required reviewed order.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
          },
        },
      },
    });
    await writeAutoBoundaryArtifacts({ projectRoot, build });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.name = "mysql_events_production";
    candidate.pack.resources = candidate.pack.resources.filter((resource) => [
      sourceId,
      scopedOrdersId,
      scopedOrderItemsId,
    ].includes(resource.id));
    assert(candidate.pack.resources.length === 3, "MySQL production fixture did not draft the direct and derived resources.", candidate.pack.resources);
    const resource = candidate.pack.resources.find((candidateResource) => candidateResource.id === sourceId);
    const scopedOrders = candidate.pack.resources.find((candidateResource) => candidateResource.id === scopedOrdersId);
    const scopedOrderItems = candidate.pack.resources.find((candidateResource) => candidateResource.id === scopedOrderItemsId);
    assert(resource && scopedOrders && scopedOrderItems?.tenant_scope && scopedOrderItems?.principal_scope,
      "MySQL production fixture did not preserve the reviewed derived tenant/principal path.", candidate.pack.resources);
    assert(
      JSON.stringify(resource.field_enums.category)
        === JSON.stringify(["growth", "retained", "private-small", "enterprise"]),
      "MySQL ENUM values did not reach the reviewed boundary from live schema metadata.",
      resource.field_enums,
    );
    resource.selectable_fields = ["category", "amount_cents", "occurred_at"];
    resource.filterable_fields = Object.fromEntries(Object.entries(resource.filterable_fields)
      .filter(([field]) => resource.selectable_fields.includes(field)));
    resource.sortable_fields = resource.sortable_fields.filter((field) => resource.selectable_fields.includes(field));
    resource.groupable_fields = resource.groupable_fields.filter((field) => field === "category");
    resource.aggregate_measures = resource.aggregate_measures.filter((field) => field === "amount_cents");
    resource.count_distinct_fields = resource.count_distinct_fields.filter((field) => field === "id");
    resource.time_bucket_fields = Object.fromEntries(Object.entries(resource.time_bucket_fields)
      .filter(([field]) => field === "occurred_at"));
    resource.relationships = [];
    narrowDerivedResources(scopedOrders, scopedOrderItems);
    candidate.budgets.max_queries_per_session = 1;
    candidate.budgets.rate_limit_per_minute = 10;
    candidate.budgets.max_extracted_cells_per_session = 100;
    candidate.budgets.max_differencing_queries = 10;
    const boundaryDigest = explorationBoundaryCandidateDigest(candidate);
    await activateExplorationBoundary({
      projectRoot,
      candidate,
      expectedDigest: boundaryDigest,
      actor: "production-owner@example.test",
      confirmation: `ACTIVATE ${boundaryDigest}`,
      confirmedDecisions: candidate.unresolved_decisions,
      currentInspection: inspection,
    });

    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const runtimeConfig = {
      version: 1,
      mode: "read_only",
      storage: {
        sqlite_path: path.join(projectRoot, ".synapsor/local.db"),
        shared_postgres: {
          mode: "runtime_store",
          url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
          schema: controlSchema,
          lock_timeout_ms: 5_000,
          max_entries: 100_000,
        },
      },
      sources: {
        [build.exploration_boundary.source]: {
          engine: "mysql",
          read_url_env: "MYSQL_DATABASE_URL",
          statement_timeout_ms: 3_000,
        },
      },
      trusted_context: {
        provider: "http_claims",
      },
      session_auth: {
        provider: "jwt_asymmetric",
        algorithms: ["RS256"],
        public_key_env: "SYNAPSOR_SESSION_PUBLIC_KEY",
        issuer: "https://identity.example",
        audience: "https://runner.example/mcp",
        tenant_claim: "tenant_id",
        principal_claim: "sub",
      },
      http_security: {
        deployment: "shared",
        channel: "trusted_tls_proxy",
        allowed_hosts: ["127.0.0.1"],
        oauth_resource: {
          resource: "https://runner.example/mcp",
          authorization_servers: ["https://identity.example"],
          scopes_supported: ["synapsor.explore"],
          required_scopes: ["synapsor.explore"],
        },
      },
      production_explore: {
        enabled: true,
        project_root: projectRoot,
        required_oauth_scope: "synapsor.explore",
        budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
        accounting_namespace: "verify.production.mysql",
        source_max_connections: 2,
        max_sessions_per_principal: 2,
        tenant_limits: {
          max_queries_per_rolling_24_hours: 100,
          max_extracted_cells_per_rolling_24_hours: 10_000,
          max_differencing_queries_per_rolling_24_hours: 100,
          requests_per_minute: 100,
          max_response_cells_per_response: 500,
        },
      },
    };
    Object.assign(env, {
      SYNAPSOR_CONTROL_DATABASE_URL: controlUrl,
      SYNAPSOR_SESSION_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }),
      SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "shared-production-mysql-hmac-key-material-1234567890",
    });
    const posture = await assertProductionExploreStartup(runtimeConfig, env);
    assert(posture.ok, "MySQL production Explore posture did not pass startup attestation.", posture);
    server = await startStreamableHttpMcpServer({
      config: runtimeConfig,
      env,
      host: "127.0.0.1",
      port: 0,
      trustedTlsProxy: true,
      log: false,
      streamableSessionFactory: productionExploreSessionFactory(runtimeConfig, env),
    });

    const plan = {
      kind: "aggregate",
      resource: sourceId,
      measures: [{ function: "count" }, { function: "sum", field: "amount_cents" }],
      dimensions: [{ field: "category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const alice = mcpClient(server.url, signedToken(privateKey, { tenant: "acme", principal: "alice" }));
    clients.push(alice.client);
    await alice.client.connect(alice.transport);
    const tools = await alice.client.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      "MySQL production MCP exposed an unexpected tool surface.", tools.tools);
    const aliceResult = resultPayload(await alice.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(aliceResult.ok === true && aliceResult.privacy?.suppressed_groups === 1,
      "MySQL production Explore did not return the expected suppressed aggregate.", aliceResult);
    assert(!JSON.stringify(aliceResult).match(/globex|enterprise|private-small|SELECT\s|`events`/i),
      "MySQL production result leaked another tenant, a suppressed label, or compiled SQL.", aliceResult);
    const exhausted = await alice.client.callTool({ name: "app.explore_data", arguments: { plan } });
    assert(exhausted.isError === true, "MySQL production principal budget did not enforce its reviewed query ceiling.", exhausted);

    const secondPrincipal = mcpClient(server.url, signedToken(privateKey, { tenant: "acme", principal: "bob" }));
    clients.push(secondPrincipal.client);
    await secondPrincipal.client.connect(secondPrincipal.transport);
    const secondResult = resultPayload(await secondPrincipal.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(secondResult.ok === true && secondResult.data.length === aliceResult.data.length,
      "A second MySQL principal was starved by the first principal's budget.", secondResult);

    const globex = mcpClient(server.url, signedToken(privateKey, { tenant: "globex", principal: "carol" }));
    clients.push(globex.client);
    await globex.client.connect(globex.transport);
    const globexResult = resultPayload(await globex.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(globexResult.ok === true
      && globexResult.data.length === 1
      && globexResult.data[0].category === "enterprise"
      && globexResult.data[0].count === 5,
    "MySQL production tenant predicate did not isolate the Globex result.", globexResult);

    const derivedPlan = {
      kind: "aggregate",
      resource: scopedOrderItemsId,
      measures: [{ function: "count" }, { function: "sum", field: "quantity" }],
      dimensions: [{
        field: "category",
        relationship: "scoped_order_items_order_id_fkey",
      }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const derivedAcme = mcpClient(server.url, signedToken(privateKey, {
      tenant: "acme",
      principal: "derived-acme",
    }));
    clients.push(derivedAcme.client);
    await derivedAcme.client.connect(derivedAcme.transport);
    const derivedAcmeResult = resultPayload(await derivedAcme.client.callTool({
      name: "app.explore_data",
      arguments: { plan: derivedPlan },
    }));
    assert(derivedAcmeResult.ok === true
      && derivedAcmeResult.data.length === 1
      && derivedAcmeResult.data[0].scoped_orders_category === "trail"
      && derivedAcmeResult.data[0].count === 5,
    "MySQL production Explore did not isolate a normalized child through its mandatory scope path.", derivedAcmeResult);
    assert(!JSON.stringify(derivedAcmeResult).match(/globex|enterprise|derived-globex|SELECT\s|`scoped_/i),
      "MySQL derived-scope result leaked another scope or compiled SQL.", derivedAcmeResult);

    const derivedGlobex = mcpClient(server.url, signedToken(privateKey, {
      tenant: "globex",
      principal: "derived-globex",
    }));
    clients.push(derivedGlobex.client);
    await derivedGlobex.client.connect(derivedGlobex.transport);
    const derivedGlobexResult = resultPayload(await derivedGlobex.client.callTool({
      name: "app.explore_data",
      arguments: { plan: derivedPlan },
    }));
    assert(derivedGlobexResult.ok === true
      && derivedGlobexResult.data.length === 1
      && derivedGlobexResult.data[0].scoped_orders_category === "enterprise"
      && derivedGlobexResult.data[0].count === 7,
    "MySQL derived scope did not isolate the second tenant/principal.", derivedGlobexResult);

    const after = await sourceSnapshot(mysqlAdmin);
    assert(JSON.stringify(after) === JSON.stringify(before),
      "Production HTTP Explore mutated the MySQL source database.", { before, after });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      engine: "mysql",
      boundary: candidate.pack.name,
      tools: tools.tools.map((tool) => tool.name),
      principal_budget_isolated: true,
      tenant_rows_isolated: true,
      derived_tenant_and_principal_scope_isolated: true,
      source_connection_ceiling: 2,
      principal_session_ceiling: 2,
      source_database_changed: false,
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await server?.close().catch(() => undefined);
    await control.query(`DROP SCHEMA IF EXISTS "${controlSchema}" CASCADE`).catch(() => undefined);
    await Promise.allSettled([control.end(), mysqlAdmin.end()]);
    run("docker", ["compose", "-p", composeProject, "-f", compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

await main();
