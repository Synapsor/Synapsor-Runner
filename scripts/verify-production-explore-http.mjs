import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool } from "pg";
import { ProposalStore } from "../packages/proposal-store/dist/index.js";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  loadGenerationLockSnapshot,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import {
  assertProductionExploreStartup,
} from "../apps/runner/dist/mcp-runtime.js";
import { derivedScopeIndexDoctorChecks } from "../apps/runner/dist/derived-scope-index-doctor.js";
import { createScopedExploreRuntime } from "../apps/runner/dist/scoped-explore.js";
import {
  WorkbenchAskSession,
  askToolSurfaceDigest,
  secureAskJsonRequest,
} from "../apps/runner/dist/model-ask.js";
import { verifyJwtRejectionMatrix } from "./production-explore-http-e2e-helpers.mjs";
import {
  applyProductionExploreSoakBudgets,
  assertExactNumericBandResult,
  assertSoakServerAlive,
  processGroupSnapshot,
  productionExploreSoakIdentities,
  productionExploreSoakRequested,
  runProductionExploreHttpSoak,
  runProductionExploreRecovery,
  waitForSourceConnectionQuiescence,
  verifyLocalExploreAuditRecords,
  verifyProductionExploreAuditSink,
} from "./production-explore-http-soak.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "examples/auto-boundary-churn");
const compose = path.join(fixture, "docker-compose.yml");
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-http-"));
const singleOrganizationProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-single-org-http-"));
const localParityProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-local-parity-"));
const readUrl = "postgresql://synapsor_churn_reader:synapsor_churn_reader_password@127.0.0.1:55460/synapsor_auto_boundary";
const adminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55460/synapsor_auto_boundary";
const controlUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55460/postgres";
const controlSchema = `synapsor_production_explore_${process.pid}`;

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function verifySchemaWidthScaling({ admin, client, env, plan, resources }) {
  assert(resources.length > 0, "The PostgreSQL generation lock has no authority dependencies to inspect.");
  const expectedResourceIds = resources
    .map((resource) => `${resource.schema}.${resource.table}`)
    .sort();
  const inspect = async () => {
    const started = performance.now();
    const inspection = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "DATABASE_URL",
      schema: "public",
      resources,
      env,
    });
    const actualResourceIds = inspection.tables
      .map((table) => `${table.schema}.${table.name}`)
      .sort();
    assert(JSON.stringify(actualResourceIds) === JSON.stringify(expectedResourceIds),
      "Scoped PostgreSQL inspection did not fetch exactly the generation-lock dependencies.",
      { expected: expectedResourceIds, actual: actualResourceIds });
    return performance.now() - started;
  };
  const before = [];
  for (let index = 0; index < 3; index += 1) before.push(await inspect());
  const decoys = Array.from({ length: 80 }, (_, index) =>
    `public.synapsor_unreviewed_scale_${String(index).padStart(3, "0")}`);
  try {
    await admin.query(decoys.map((name) =>
      `CREATE TABLE ${name} (id bigint PRIMARY KEY, payload text, observed_at timestamptz)`
    ).join(";\n"));
    await admin.query(`GRANT SELECT ON ${decoys.join(", ")} TO synapsor_churn_reader`);
    const after = [];
    for (let index = 0; index < 3; index += 1) after.push(await inspect());
    const full = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "DATABASE_URL",
      schema: "public",
      env,
    });
    assert(full.tables.length >= resources.length + decoys.length,
      "Whole-schema PostgreSQL discovery did not retain unrelated-table discovery.",
      { table_count: full.tables.length });
    await admin.query(`GRANT UPDATE ON ${decoys[0]} TO synapsor_churn_reader`);
    try {
      const unsafeGrant = await client.callTool({
        name: "app.explore_data",
        arguments: { plan },
      });
      assert(unsafeGrant.isError === true
        && /EXPLORE_LOCK_STALE|EXPLORE_ROLE_UNSAFE|credential posture changed/i.test(
          JSON.stringify(unsafeGrant),
        ),
      "A write grant on an unrelated PostgreSQL table bypassed the global read-only guard.",
      unsafeGrant);
    } finally {
      await admin.query(`REVOKE UPDATE ON ${decoys[0]} FROM synapsor_churn_reader`);
    }
    const query = resultPayload(await client.callTool({
      name: "app.explore_data",
      arguments: { plan },
    }));
    assert(query.ok === true,
      "Adding unrelated PostgreSQL tables changed a live boundary query or triggered false drift.", query);
    const baselineMs = median(before);
    const widenedMs = median(after);
    assert(widenedMs <= Math.max(baselineMs * 4, baselineMs + 500),
      "Dependency-scoped PostgreSQL inspection regressed materially as unrelated schema width grew.",
      { baseline_ms: baselineMs, widened_ms: widenedMs, unrelated_tables: decoys.length });
    return {
      unrelated_tables: decoys.length,
      dependency_tables_fetched: resources.length,
      unrelated_write_grant_refused: true,
      baseline_median_ms: Math.round(baselineMs * 100) / 100,
      widened_median_ms: Math.round(widenedMs * 100) / 100,
      whole_schema_tables_discovered: full.tables.length,
    };
  } finally {
    await admin.query(`DROP TABLE IF EXISTS ${decoys.join(", ")}`).catch(() => undefined);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a loopback port for the production Explore CLI verifier."));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startProductionExploreCli(configPath, env) {
  const port = await findFreePort();
  const invocation = productionExploreRunnerInvocation([
    "mcp",
    "serve",
    "--transport",
    "streamable-http",
    "--production-explore",
    "--config",
    configPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--trusted-tls-proxy",
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let exitState;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Production Explore CLI did not become ready.\n${stdout}\n${stderr}`));
    }, 30_000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const inspect = () => {
      if (settled) return;
      const match = stderr.match(/Synapsor Runner Streamable HTTP MCP listening on (https?:\/\/\S+)/);
      if (!match || !stderr.includes("PRODUCTION EXPLORE READY")) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        child,
        url: match[1],
        stdout: () => stdout,
        stderr: () => stderr,
        exitState: () => exitState,
      });
    };
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-40_000);
      inspect();
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-40_000);
      inspect();
    });
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      exitState = { code, signal, at: new Date().toISOString() };
      fail(new Error(`Production Explore CLI exited before readiness (${code ?? signal}).\n${stdout}\n${stderr}`));
    });
  });
}

function productionExploreRunnerInvocation(args) {
  const packedRunner = process.env.SYNAPSOR_PRODUCTION_EXPLORE_RUNNER?.trim();
  return packedRunner
    ? { command: packedRunner, args }
    : { command: process.execPath, args: [path.join(root, "apps/runner/dist/cli.js"), ...args] };
}

async function stopProductionExploreCli(handle) {
  if (!handle || handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  const killGroup = (signal) => {
    try {
      process.kill(-handle.child.pid, signal);
    } catch {
      handle.child.kill(signal);
    }
  };
  await new Promise((resolve) => {
    const timeout = setTimeout(() => killGroup("SIGKILL"), 5_000);
    handle.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    killGroup("SIGTERM");
  });
}

async function sourceSnapshot(pool) {
  const churn = await pool.query(`
    SELECT COUNT(*)::int AS row_count,
      md5(string_agg(id || ':' || tenant_id || ':' || owner_id || ':' || reason_category || ':' || monthly_revenue_cents::text, '|' ORDER BY id)) AS digest
    FROM public.churn_events
  `);
  const derived = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.scoped_orders) AS order_count,
      (SELECT COUNT(*)::int FROM public.scoped_order_items) AS item_count,
      (SELECT md5(string_agg(id || ':' || order_id || ':' || item_kind || ':' || quantity::text, '|' ORDER BY id))
        FROM public.scoped_order_items) AS item_digest
  `);
  const sharedReference = await pool.query(`
    SELECT COUNT(*)::int AS row_count,
      md5(string_agg(id || ':' || category, '|' ORDER BY id)) AS digest
    FROM public.shared_product_catalog
  `);
  return {
    churn: churn.rows[0],
    derived: derived.rows[0],
    shared_reference: sharedReference.rows[0],
  };
}

async function seedDerivedSource(pool) {
  await pool.query(`
    DROP TABLE IF EXISTS public.scoped_order_items;
    DROP TABLE IF EXISTS public.scoped_orders;
    DROP TABLE IF EXISTS public.shared_product_catalog;
    CREATE TABLE public.scoped_orders (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      owner_id text NOT NULL,
      category text NOT NULL CHECK (category IN ('enterprise', 'trail')),
      occurred_at timestamptz NOT NULL
    );
    CREATE TABLE public.scoped_order_items (
      id text PRIMARY KEY,
      order_id text NOT NULL,
      item_kind text NOT NULL CHECK (item_kind IN ('standard')),
      quantity integer NOT NULL CHECK (quantity > 0),
      occurred_at timestamptz NOT NULL,
      CONSTRAINT scoped_order_items_order_id_fkey
        FOREIGN KEY (order_id) REFERENCES public.scoped_orders(id) ON DELETE RESTRICT
    );
    CREATE INDEX scoped_order_items_order_id_idx ON public.scoped_order_items (order_id);
    CREATE INDEX scoped_orders_tenant_id_idx ON public.scoped_orders (tenant_id);
    CREATE INDEX scoped_orders_owner_id_idx ON public.scoped_orders (owner_id);
    CREATE TABLE public.shared_product_catalog (
      id text PRIMARY KEY,
      category text NOT NULL CHECK (category IN ('hardware', 'software')),
      internal_notes text NOT NULL
    );
    INSERT INTO public.scoped_orders (id, tenant_id, owner_id, category, occurred_at) VALUES
      ('derived-acme-order', 'acme', 'derived-acme', 'trail', '2026-07-01T00:00:00Z'),
      ('derived-globex-order', 'globex', 'derived-globex', 'enterprise', '2026-07-01T00:00:00Z');
    INSERT INTO public.scoped_orders (id, tenant_id, owner_id, category, occurred_at)
    SELECT 'fanout-acme-order-' || item, 'acme', 'fanout-acme', 'trail', '2026-07-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 5) AS item;
    INSERT INTO public.scoped_order_items (id, order_id, item_kind, quantity, occurred_at)
    SELECT 'derived-acme-item-' || item, 'derived-acme-order', 'standard', item, '2026-07-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 5) AS item;
    INSERT INTO public.scoped_order_items (id, order_id, item_kind, quantity, occurred_at)
    SELECT 'derived-globex-item-' || item, 'derived-globex-order', 'standard', item, '2026-07-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 7) AS item;
    INSERT INTO public.scoped_order_items (id, order_id, item_kind, quantity, occurred_at)
    SELECT 'fanout-acme-item-' || item, 'fanout-acme-order-' || item, 'standard', item, '2026-07-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 5) AS item;
    INSERT INTO public.shared_product_catalog (id, category, internal_notes)
    SELECT 'hardware-' || item, 'hardware', 'operator-only hardware note ' || item
      FROM generate_series(1, 6) AS item;
    INSERT INTO public.shared_product_catalog (id, category, internal_notes)
    SELECT 'software-' || item, 'software', 'operator-only software note ' || item
      FROM generate_series(1, 6) AS item;
    DELETE FROM public.churn_events
    WHERE tenant_id = 'acme'
      AND owner_id IN (
        'pm-band', 'pm-auto', 'pm-auto-equal', 'pm-auto-ties',
        'pm-running', 'pm-ollama', 'pm-relative', 'pm-other'
      );
    DELETE FROM public.accounts
    WHERE tenant_id = 'acme'
      AND owner_id IN (
        'pm-band', 'pm-auto', 'pm-auto-equal', 'pm-auto-ties',
        'pm-running', 'pm-ollama', 'pm-relative', 'pm-other'
      );
    INSERT INTO public.accounts (
      id, tenant_id, owner_id, region, segment, customer_email, internal_risk_score
    )
    SELECT
      principal || '-' || source.id,
      source.tenant_id,
      principal,
      source.region,
      source.segment,
      principal || '-' || source.id || '@example.invalid',
      source.internal_risk_score
    FROM public.accounts AS source
    CROSS JOIN (VALUES
      ('pm-band'),
      ('pm-auto'),
      ('pm-auto-equal'),
      ('pm-auto-ties'),
      ('pm-running'),
      ('pm-ollama'),
      ('pm-relative')
    ) AS copies(principal)
    WHERE source.tenant_id = 'acme' AND source.owner_id = 'pm-1';
    INSERT INTO public.churn_events (
      id, tenant_id, owner_id, account_id, reason_category,
      monthly_revenue_cents, churned_at, private_note
    )
    SELECT
      principal || '-' || source.id,
      source.tenant_id,
      principal,
      principal || '-' || source.account_id,
      source.reason_category,
      source.monthly_revenue_cents,
      source.churned_at,
      'synthetic kept-out note ' || principal || '-' || source.id
    FROM public.churn_events AS source
    CROSS JOIN (VALUES
      ('pm-band'),
      ('pm-auto'),
      ('pm-auto-equal'),
      ('pm-auto-ties'),
      ('pm-running'),
      ('pm-ollama'),
      ('pm-relative')
    ) AS copies(principal)
    WHERE source.tenant_id = 'acme' AND source.owner_id = 'pm-1';
    UPDATE public.churn_events
    SET churned_at = CURRENT_TIMESTAMP - INTERVAL '1 day'
    WHERE tenant_id = 'acme' AND owner_id = 'pm-relative';
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS row_number
      FROM public.churn_events
      WHERE tenant_id = 'acme' AND owner_id = 'pm-auto-ties'
    )
    UPDATE public.churn_events AS event
    SET monthly_revenue_cents = CASE WHEN ranked.row_number <= 17 THEN 10000 ELSE 20000 END
    FROM ranked
    WHERE event.id = ranked.id;
    INSERT INTO public.accounts (
      id, tenant_id, owner_id, region, segment, customer_email, internal_risk_score
    )
    SELECT
      'pm-other-account-' || item,
      'acme',
      'pm-other',
      'south',
      'growth',
      'pm-other-' || item || '@example.invalid',
      700 + item
    FROM generate_series(1, 5) AS item;
    INSERT INTO public.churn_events (
      id, tenant_id, owner_id, account_id, reason_category,
      monthly_revenue_cents, churned_at, private_note
    )
    SELECT
      'pm-other-event-' || item,
      'acme',
      'pm-other',
      'pm-other-account-' || item,
      'onboarding',
      31415,
      '2026-07-29T12:00:00Z'::timestamptz,
      'synthetic kept-out note pm-other-' || item
    FROM generate_series(1, 5) AS item;
    ALTER TABLE public.scoped_orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.scoped_orders FORCE ROW LEVEL SECURITY;
    CREATE POLICY scoped_orders_trusted_scope ON public.scoped_orders
      FOR SELECT
      USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.principal', true)
      );
    GRANT SELECT ON public.scoped_orders, public.scoped_order_items, public.shared_product_catalog TO synapsor_churn_reader;
  `);
}

async function seedSingleOrganizationSource(pool) {
  await pool.query(`
    DROP SCHEMA IF EXISTS single_org_http CASCADE;
    CREATE SCHEMA single_org_http;
    CREATE TABLE single_org_http.activity (
      id text PRIMARY KEY,
      category text NOT NULL CHECK (category IN ('billing', 'support')),
      amount_cents integer NOT NULL CHECK (amount_cents >= 0),
      occurred_at timestamptz NOT NULL
    );
    INSERT INTO single_org_http.activity (id, category, amount_cents, occurred_at)
    SELECT 'billing-' || item, 'billing', item * 100, '2026-08-01T00:00:00Z'::timestamptz + item * interval '1 hour'
      FROM generate_series(1, 6) AS item;
    INSERT INTO single_org_http.activity (id, category, amount_cents, occurred_at)
    SELECT 'support-' || item, 'support', item * 200, '2026-08-02T00:00:00Z'::timestamptz + item * interval '1 hour'
      FROM generate_series(1, 6) AS item;
    GRANT USAGE ON SCHEMA single_org_http TO synapsor_churn_reader;
    GRANT SELECT ON single_org_http.activity TO synapsor_churn_reader;
  `);
}

async function singleOrganizationSourceSnapshot(pool) {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS row_count,
      SUM(amount_cents)::bigint AS amount_cents,
      md5(string_agg(id || ':' || category || ':' || amount_cents::text || ':' || occurred_at::text, '|' ORDER BY id)) AS digest
    FROM single_org_http.activity
  `);
  return result.rows[0];
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP result did not contain structured content.");
  return JSON.parse(text);
}

function narrowResource(resource) {
  resource.selectable_fields = ["reason_category", "monthly_revenue_cents", "churned_at"];
  resource.filterable_fields = Object.fromEntries(Object.entries(resource.filterable_fields)
    .filter(([field]) => resource.selectable_fields.includes(field)));
  resource.sortable_fields = resource.sortable_fields.filter((field) => resource.selectable_fields.includes(field));
  resource.groupable_fields = resource.groupable_fields.filter((field) => field === "reason_category");
  resource.aggregate_measures = resource.aggregate_measures.filter((field) => field === "monthly_revenue_cents");
  resource.count_distinct_fields = resource.count_distinct_fields.filter((field) => field === "id");
  resource.time_bucket_fields = Object.fromEntries(Object.entries(resource.time_bucket_fields)
    .filter(([field]) => field === "churned_at"));
  resource.relationships = [];
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

async function token(privateKey, { tenant, principal, scope = "synapsor.explore" }) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "production-explore-test" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    tenant_id: tenant,
    scope,
    iss: "https://identity.example",
    aud: "https://runner.example/mcp",
    iat: now,
    exp: now + 600,
    ...(principal !== undefined ? { sub: principal } : {}),
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function clientFor(url, bearer, query = {}) {
  const endpoint = new URL(url);
  for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        authorization: `Bearer ${bearer}`,
        "x-synapsor-tenant-id": "header-tenant-must-not-win",
        "x-synapsor-principal": "header-principal-must-not-win",
      },
    },
  });
  return {
    client: new Client({ name: "production-explore-verifier", version: "1.0.0" }),
    transport,
  };
}

async function seedPostgresSoakPrincipals(pool, identities) {
  for (const identity of identities) {
    const lowValue = 7_000 + identity.index * 10;
    const highValue = 11_000 + identity.index * 10;
    await pool.query(`
      INSERT INTO public.accounts (
        id, tenant_id, owner_id, region, segment, customer_email, internal_risk_score
      )
      SELECT $2 || '-account-' || item, $1, $2, 'west', 'growth',
        $2 || '-' || item || '@example.invalid', 500 + item
      FROM generate_series(1, 10) AS item
    `, [identity.tenant, identity.principal]);
    await pool.query(`
      INSERT INTO public.churn_events (
        id, tenant_id, owner_id, account_id, reason_category,
        monthly_revenue_cents, churned_at, private_note
      )
      SELECT $2 || '-event-' || item, $1, $2, $2 || '-account-' || item,
        CASE WHEN item <= 5 THEN 'onboarding' ELSE 'price' END,
        CASE WHEN item <= 5 THEN $3 + item ELSE $4 + (item - 5) END,
        CASE WHEN item <= 5 THEN CURRENT_TIMESTAMP - INTERVAL '8 days'
          ELSE CURRENT_TIMESTAMP - INTERVAL '1 day' END,
        'synthetic kept-out soak note ' || $2 || '-' || item
      FROM generate_series(1, 10) AS item
    `, [identity.tenant, identity.principal, lowValue, highValue]);
    const category = identity.index % 2 === 0 ? "trail" : "enterprise";
    await pool.query(`
      INSERT INTO public.scoped_orders (id, tenant_id, owner_id, category, occurred_at)
      VALUES ($2 || '-order', $1, $2, $3, CURRENT_TIMESTAMP - INTERVAL '8 days')
    `, [identity.tenant, identity.principal, category]);
    await pool.query(`
      INSERT INTO public.scoped_order_items (id, order_id, item_kind, quantity, occurred_at)
      SELECT $1 || '-item-' || item, $1 || '-order', 'standard', item,
        CURRENT_TIMESTAMP - INTERVAL '8 days'
      FROM generate_series(1, 5) AS item
    `, [identity.principal]);
  }
}

function assertSoak(condition, message, detail) {
  if (!condition) throw new Error(`${message}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
}

function postgresSoakOperations() {
  const aggregatePlan = {
    kind: "aggregate",
    resource: "public.churn_events",
    measures: [{ function: "count" }, { function: "sum", field: "monthly_revenue_cents" }],
    dimensions: [{ field: "reason_category" }],
    order_by: { kind: "measure", index: 0, direction: "desc" },
    top_n: 10,
  };
  const validateBase = (payload, identity) => {
    const byCategory = new Map((payload.data ?? []).map((row) => [row.reason_category, row]));
    const lowValue = 7_000 + identity.index * 10;
    const highValue = 11_000 + identity.index * 10;
    assertSoak(payload.ok === true && payload.source_database_changed === false,
      "PostgreSQL result was not verified against the locked source.", payload);
    assertSoak(byCategory.size === 2
      && byCategory.get("onboarding")?.count === 5
      && byCategory.get("onboarding")?.sum_monthly_revenue_cents === lowValue * 5 + 15
      && byCategory.get("price")?.count === 5
      && byCategory.get("price")?.sum_monthly_revenue_cents === highValue * 5 + 15,
    "PostgreSQL exact tenant/principal scope isolation failed.", payload.data);
  };
  const legal = (name, weight, plan, validate) => ({
    name,
    weight,
    request: () => ({ name: "app.explore_data", arguments: { plan } }),
    validate,
  });
  return [
    {
      name: "catalog",
      weight: 5,
      request: () => ({ name: "app.describe_data", arguments: {} }),
      validate: (payload) => assertSoak(payload.ok === true
        && payload.resources?.length === 4
        && payload.resources.some((resource) => resource.id === "public.scoped_order_items")
        && payload.resources.some((resource) => resource.id === "public.shared_product_catalog"),
      "PostgreSQL metadata catalog changed during soak.", payload),
    },
    legal("grouped_count_sum", 25, aggregatePlan, validateBase),
    legal("weekly_grouping", 10, {
      ...aggregatePlan,
      measures: [{ function: "count" }],
      time_bucket: { field: "churned_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
    }, (payload) => assertSoak((payload.data ?? []).reduce((sum, row) => sum + row.count, 0) === 10,
      "PostgreSQL weekly grouping escaped exact scope.", payload.data)),
    legal("relative_time_window", 10, {
      ...aggregatePlan,
      measures: [{ function: "count" }],
      time_window: { field: "churned_at", window: "last_30_days" },
    }, (payload) => assertSoak(
      (payload.data ?? []).reduce((sum, row) => sum + row.count, 0) === 10
        && payload.operator_time_windows === undefined
        && payload.resolved_time_windows === undefined,
      "PostgreSQL relative window escaped scope or exposed operator-only resolution metadata.",
      payload,
    )),
    legal("numeric_band", 10, {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [{ function: "count" }],
      dimensions: [{ numeric_band: "monthly_revenue_band" }],
      top_n: 10,
    }, (payload, identity) => assertExactNumericBandResult(payload, {
      field: "monthly_revenue_band",
      values: [
        ...Array.from({ length: 5 }, (_unused, index) => 7_000 + identity.index * 10 + index + 1),
        ...Array.from({ length: 5 }, (_unused, index) => 11_000 + identity.index * 10 + index + 1),
      ],
      edges: [6_500, 10_000, 20_000],
      labels: ["under 65", "65 to 99", "100 to 199", "200 or more"],
      minimum_count: 5,
      context: "PostgreSQL numeric-band result did not match the exact scoped cohorts.",
    })),
    legal("auto_band", 10, {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [{ function: "count" }],
      dimensions: [{
        numeric_band: {
          field: "monthly_revenue_cents",
          method: "quantile",
          buckets: 2,
        },
      }],
      top_n: 10,
    }, (payload) => assertSoak(payload.ok === true
      && payload.data?.length === 2
      && payload.data.every((row) => /^Q[12] of 2$/.test(row.monthly_revenue_cents_quantile_band)
        && row.count === 5)
      && payload.privacy?.auto_bands?.[0]?.requested_buckets === 2
      && payload.privacy?.auto_bands?.[0]?.raw_edges_returned === false
      && !JSON.stringify(payload).includes("__auto_"),
    "PostgreSQL automatic quantile bands leaked internals or escaped the reviewed scope.", payload)),
    legal("dispersion", 10, {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [
        { function: "stddev_pop", field: "monthly_revenue_cents" },
        { function: "var_pop", field: "monthly_revenue_cents" },
      ],
      dimensions: [{ field: "reason_category" }],
      top_n: 10,
    }, (payload) => assertSoak(payload.data?.length === 2
      && payload.data.every((row) => Number.isFinite(row.stddev_pop_monthly_revenue_cents)
        && Number.isFinite(row.var_pop_monthly_revenue_cents)),
    "PostgreSQL contributor-safe dispersion did not return two reviewed cohorts.", payload.data)),
    legal("running_total", 10, {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [{ derived_measure: "revenue_running_total" }],
      dimensions: [{ field: "reason_category" }],
      time_bucket: { field: "churned_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
      top_n: 25,
    }, (payload) => assertSoak(payload.data?.length === 2
      && payload.data.every((row) => Number.isFinite(row.revenue_running_total)),
    "PostgreSQL reviewed running total failed during soak.", payload.data)),
    legal("derived_relationship", 20, {
      kind: "aggregate",
      resource: "public.scoped_order_items",
      measures: [{ function: "count" }, { function: "sum", field: "quantity" }],
      dimensions: [{ field: "category", relationship: "scoped_order_items_order_id_fkey" }],
      top_n: 10,
    }, (payload, identity) => assertSoak(payload.data?.length === 1
      && payload.data[0].scoped_orders_category === (identity.index % 2 === 0 ? "trail" : "enterprise")
      && payload.data[0].count === 5
      && payload.data[0].sum_quantity === 15,
    "PostgreSQL derived tenant/principal scope isolation failed.", payload.data)),
    legal("shared_reference", 5, {
      kind: "aggregate",
      resource: "public.shared_product_catalog",
      measures: [{ function: "count" }],
      dimensions: [{ field: "category" }],
      top_n: 10,
    }, (payload) => assertSoak(payload.data?.length === 2
      && payload.data.every((row) => row.count === 6),
    "PostgreSQL shared-reference result changed across tenants.", payload.data)),
    {
      name: "invalid_enum_refusal",
      weight: 3,
      expected_refusal: true,
      request: () => ({
        name: "app.explore_data",
        arguments: { plan: { ...aggregatePlan, where: [{ field: "reason_category", op: "eq", value: "not-reviewed" }] } },
      }),
      validate_refusal: (result) => /not a reviewed value|EXPLORE_FIELD_ENUM_VALUE_FORBIDDEN/i.test(JSON.stringify(result)),
    },
    {
      name: "model_scope_refusal",
      weight: 2,
      expected_refusal: true,
      request: () => ({
        name: "app.explore_data",
        arguments: {
          tenant_id: "wrong-tenant",
          principal: "wrong-principal",
          plan: { ...aggregatePlan, tenant_id: "wrong-tenant", principal: "wrong-principal" },
        },
      }),
      validate_refusal: (result) => /unrecognized|unsupported|invalid/i.test(JSON.stringify(result)),
    },
  ];
}

async function verifyOllamaAgentOverProductionHttp(input) {
  const bearer = await token(input.privateKey, {
    tenant: "acme",
    principal: "pm-ollama",
  });
  const handle = clientFor(input.url, bearer);
  let closed = false;
  await handle.client.connect(handle.transport);
  try {
    const listed = await handle.client.listTools();
    const tools = listed.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description ?? "",
      input_schema: tool.inputSchema,
      metadata: tool._meta,
    }));
    assert(tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      "Ollama received a production tool surface other than the exact reviewed two tools.", tools);
    const gateway = {
      mode: "runtime",
      listTools: () => tools,
      callTool: async (name, args) => {
        const result = await handle.client.callTool({ name, arguments: args });
        const value = resultPayload(result);
        return {
          ok: result.isError !== true && value.ok !== false,
          value,
          provider_value: value,
          ...(typeof value.error_code === "string" ? { error_code: value.error_code } : {}),
        };
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await handle.client.close();
      },
    };
    const session = new WorkbenchAskSession();
    session.configure({
      provider: "openai_compatible",
      model: input.model,
      base_url: process.env.SYNAPSOR_TEST_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434/v1",
      request_timeout_seconds: 180,
      authority_digest: askToolSurfaceDigest(tools),
      egress_acknowledged: true,
    });
    const result = await session.run(
      "How many churn events are there by reason category?",
      gateway,
      { requestJson: secureAskJsonRequest },
    );
    const explored = result.tool_calls.find((call) => call.tool === "app.explore_data" && call.status === "ok");
    assert(explored,
      "Ollama did not execute an accepted Explore plan over production HTTP.", result.tool_calls);
    const measure = explored.arguments?.plan?.measures?.[0];
    const countEquivalent = measure?.function === "count"
      || (measure?.function === "non_null_count" && measure?.field === "reason_category");
    assert(explored.arguments?.plan?.resource === "public.churn_events"
      && explored.arguments?.plan?.measures?.length === 1
      && countEquivalent
      && explored.arguments?.plan?.dimensions?.[0]?.field === "reason_category",
    "Ollama's production HTTP plan did not match the reviewed question.", explored.arguments);
    assert(!/tenant|principal/i.test(JSON.stringify(explored.arguments)),
      "Ollama attempted to supply trusted tenant or principal authority.", explored.arguments);
    return {
      model: input.model,
      answer_source: result.answer_source,
      tools: tools.map((tool) => tool.name),
      reviewed_plan_executed: true,
      model_supplied_scope: false,
    };
  } finally {
    if (!closed) await handle.client.close().catch(() => undefined);
  }
}

function ollamaSoakIntegerEnv(name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function writeOllamaSoakResult(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function ollamaSoakQuestions() {
  const aggregate = (plan) => plan?.kind === "aggregate";
  const hasMeasure = (plan, functions, field) => Array.isArray(plan?.measures)
    && plan.measures.some((measure) => functions.includes(measure?.function)
      && (field === undefined || measure?.field === field));
  const hasDimension = (plan, field, relationship) => Array.isArray(plan?.dimensions)
    && plan.dimensions.some((dimension) => dimension?.field === field
      && (relationship === undefined || dimension?.relationship === relationship));
  return [
    {
      question: "How many churn events are there by reason category?",
      validate: (plan) => aggregate(plan)
        && plan.resource === "public.churn_events"
        && hasMeasure(plan, ["count", "non_null_count"], undefined)
        && hasDimension(plan, "reason_category"),
    },
    {
      question: "What is the total monthly revenue in cents by churn reason category?",
      validate: (plan) => aggregate(plan)
        && plan.resource === "public.churn_events"
        && hasMeasure(plan, ["sum"], "monthly_revenue_cents")
        && hasDimension(plan, "reason_category"),
    },
    {
      question: "Show weekly churn event counts, oldest week first.",
      validate: (plan) => aggregate(plan)
        && plan.resource === "public.churn_events"
        && hasMeasure(plan, ["count", "non_null_count"], undefined)
        && plan.time_bucket?.field === "churned_at"
        && plan.time_bucket?.bucket === "week",
    },
    {
      question: "How many churn events were there in the last 30 days by reason category?",
      validate: (plan) => aggregate(plan)
        && plan.resource === "public.churn_events"
        && hasMeasure(plan, ["count", "non_null_count"], undefined)
        && hasDimension(plan, "reason_category")
        && plan.time_window?.field === "churned_at"
        && plan.time_window?.window === "last_30_days",
    },
    {
      question: "How many churn events fall in each reviewed monthly revenue band?",
      validate: (plan) => aggregate(plan)
        && plan.resource === "public.churn_events"
        && hasMeasure(plan, ["count", "non_null_count"], undefined)
        && Array.isArray(plan.dimensions)
        && plan.dimensions.some((dimension) => dimension?.numeric_band === "monthly_revenue_band"),
    },
    {
      question: "What is the population standard deviation of monthly revenue cents by churn reason?",
      validate: (plan) => aggregate(plan)
        && plan.resource === "public.churn_events"
        && hasMeasure(plan, ["stddev_pop"], "monthly_revenue_cents")
        && hasDimension(plan, "reason_category"),
    },
    {
      question: "Show the reviewed running revenue total by week and churn reason.",
      validate: (plan) => aggregate(plan)
        && plan.resource === "public.churn_events"
        && Array.isArray(plan.measures)
        && plan.measures.some((measure) => measure?.derived_measure === "revenue_running_total")
        && plan.time_bucket?.field === "churned_at",
    },
    {
      question: "How many scoped order items are there by their order category?",
      validate: (plan) => aggregate(plan)
        && plan.resource === "public.scoped_order_items"
        && hasMeasure(plan, ["count", "non_null_count"], undefined)
        && hasDimension(plan, "category", "scoped_order_items_order_id_fkey"),
    },
    {
      question: "How many shared products are there by product category?",
      validate: (plan) => aggregate(plan)
        && plan.resource === "public.shared_product_catalog"
        && hasMeasure(plan, ["count", "non_null_count"], undefined)
        && hasDimension(plan, "category"),
    },
  ];
}

async function createOllamaProductionGateway(input) {
  const bearer = await token(input.privateKey, input.identity);
  const handle = clientFor(input.url, bearer);
  let closed = false;
  await handle.client.connect(handle.transport);
  try {
    const listed = await handle.client.listTools();
    const tools = listed.tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description ?? "",
      input_schema: tool.inputSchema,
      metadata: tool._meta,
    }));
    assert(tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      "Ollama soak received a production tool surface other than the exact reviewed two tools.", tools);
    return {
      tools,
      gateway: {
        mode: "runtime",
        listTools: () => tools,
        callTool: async (name, args) => {
          const result = await handle.client.callTool({ name, arguments: args });
          const value = resultPayload(result);
          return {
            ok: result.isError !== true && value.ok !== false,
            value,
            provider_value: value,
            ...(typeof value.error_code === "string" ? { error_code: value.error_code } : {}),
          };
        },
        close: async () => {
          if (closed) return;
          closed = true;
          await handle.client.close();
        },
      },
    };
  } catch (error) {
    if (!closed) await handle.client.close().catch(() => undefined);
    throw error;
  }
}

async function runOllamaAgentSoak(input) {
  const durationMs = ollamaSoakIntegerEnv("SYNAPSOR_SOAK_OLLAMA_DURATION_MS", 60 * 60 * 1_000, 1_000);
  const targetQuestions = ollamaSoakIntegerEnv("SYNAPSOR_SOAK_OLLAMA_QUESTIONS", 100, 1, 1_000);
  const questionsPerIdentity = ollamaSoakIntegerEnv("SYNAPSOR_SOAK_OLLAMA_QUESTIONS_PER_IDENTITY", 6, 1, 10);
  const requiredIdentities = Math.ceil(targetQuestions / questionsPerIdentity);
  assert(input.identities.length >= requiredIdentities,
    "Ollama soak did not reserve enough independently budgeted principals.", {
      required: requiredIdentities,
      available: input.identities.length,
    });
  const startedAt = Date.now();
  const deadline = startedAt + durationMs;
  const intervalMs = durationMs / targetQuestions;
  const questions = ollamaSoakQuestions();
  const state = {
    schema_version: "synapsor.production-explore-ollama-soak.v1",
    model: input.model,
    started_at: new Date(startedAt).toISOString(),
    duration_ms: durationMs,
    target_questions: targetQuestions,
    attempted: 0,
    accepted_explore_queries: 0,
    expected_refusals: 0,
    semantic_matches: 0,
    no_tool_answers: 0,
    provider_errors: 0,
    security_failures: 0,
    identity_rotations: 0,
    conversation_clears: 0,
    maximum_source_connections: 0,
    process_samples: [],
    latencies_ms: [],
    outcomes: [],
    failures: [],
  };
  let session;
  let identity;
  let gateway;
  let expectedServerProcesses;

  const persist = () => writeOllamaSoakResult(input.result_path, {
    ...state,
    completed_at: state.completed_at,
  });

  for (let index = 0; index < targetQuestions && Date.now() < deadline; index += 1) {
    const scheduledAt = startedAt + Math.floor(index * intervalMs);
    if (Date.now() < scheduledAt) {
      await new Promise((resolve) => setTimeout(resolve, scheduledAt - Date.now()));
    }
    const identityIndex = Math.floor(index / questionsPerIdentity);
    if (!session || identity !== input.identities[identityIndex]) {
      if (gateway) await gateway.close().catch(() => undefined);
      gateway = undefined;
      identity = input.identities[identityIndex];
      session = new WorkbenchAskSession();
      state.identity_rotations += 1;
    } else if (index % 3 === 0) {
      session.clearConversation();
      state.conversation_clears += 1;
    }
    const testCase = questions[index % questions.length];
    const began = performance.now();
    try {
      if (!gateway) {
        const connected = await createOllamaProductionGateway({
          url: input.url,
          privateKey: input.privateKey,
          identity,
        });
        gateway = connected.gateway;
        if (!session.status().configured) {
          session.configure({
            provider: "openai_compatible",
            model: input.model,
            base_url: process.env.SYNAPSOR_TEST_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434/v1",
            request_timeout_seconds: 180,
            authority_digest: askToolSurfaceDigest(connected.tools),
            egress_acknowledged: true,
          });
        }
      }
      const turnGateway = {
        ...gateway,
        close: async () => undefined,
      };
      const result = await session.run(
        testCase.question,
        turnGateway,
        { requestJson: secureAskJsonRequest },
      );
      const scopeAttempt = result.tool_calls.some((call) =>
        /tenant|principal/i.test(JSON.stringify(call.arguments)));
      const scopeDisclosure = JSON.stringify(result.tool_calls).includes(identity.tenant)
        || JSON.stringify(result.tool_calls).includes(identity.principal);
      if (scopeAttempt || scopeDisclosure || result.source_database_changed) {
        state.security_failures += 1;
        throw new Error("Ollama supplied or received trusted scope, or the source changed.");
      }
      const accepted = [...result.tool_calls].reverse().find((call) =>
        call.tool === "app.explore_data" && call.status === "ok");
      const refused = result.tool_calls.some((call) =>
        call.tool === "app.explore_data" && call.status === "refused");
      const toolAttempts = result.tool_calls.map((call) => ({
        tool: call.tool,
        status: call.status,
        error_code: call.error_code,
        arguments: call.arguments,
      }));
      if (accepted) {
        state.accepted_explore_queries += 1;
        const semanticMatch = testCase.validate(accepted.arguments?.plan);
        if (semanticMatch) state.semantic_matches += 1;
        state.outcomes.push({
          question: testCase.question,
          status: "accepted",
          semantic_match: semanticMatch,
          plan: accepted.arguments?.plan,
          tool_attempts: toolAttempts,
        });
      } else if (refused) {
        state.expected_refusals += 1;
        const refusal = [...result.tool_calls].reverse().find((call) =>
          call.tool === "app.explore_data" && call.status === "refused");
        state.outcomes.push({
          question: testCase.question,
          status: "refused",
          error_code: refusal?.error_code,
          plan: refusal?.arguments?.plan,
          tool_attempts: toolAttempts,
        });
      } else {
        state.no_tool_answers += 1;
        state.outcomes.push({
          question: testCase.question,
          status: "no_tool_answer",
          tool_attempts: toolAttempts,
        });
      }
    } catch (error) {
      state.provider_errors += 1;
      state.failures.push({
        at: new Date().toISOString(),
        question: testCase.question,
        error: String(error instanceof Error ? error.message : error).slice(0, 1_000),
      });
      state.outcomes.push({
        question: testCase.question,
        status: "provider_error",
        error: String(error instanceof Error ? error.message : error).slice(0, 1_000),
      });
      state.failures = state.failures.slice(-100);
      if (state.security_failures > 0) {
        if (gateway) await gateway.close().catch(() => undefined);
        gateway = undefined;
        persist();
        throw error;
      }
    } finally {
      state.attempted += 1;
      state.latencies_ms.push(Math.round((performance.now() - began) * 100) / 100);
      const sourceConnections = await input.source_connection_count();
      state.maximum_source_connections = Math.max(state.maximum_source_connections, sourceConnections);
      if (sourceConnections > input.source_connection_ceiling) {
        state.security_failures += 1;
        if (gateway) await gateway.close().catch(() => undefined);
        gateway = undefined;
        persist();
        throw new Error(
          `Ollama soak exceeded source connection ceiling: ${sourceConnections} > ${input.source_connection_ceiling}.`,
        );
      }
      const processSample = processGroupSnapshot(input.server_pid);
      expectedServerProcesses = assertSoakServerAlive({
        exit_state: input.server_exit_state?.(),
        process_sample: processSample,
        expected_processes: expectedServerProcesses,
      });
      state.process_samples.push(processSample);
      persist();
      if (state.attempted % 10 === 0) {
        process.stderr.write(`[soak:ollama] attempted=${state.attempted} accepted=${state.accepted_explore_queries} semantic=${state.semantic_matches} errors=${state.provider_errors}\n`);
      }
    }
  }

  if (gateway) await gateway.close().catch(() => undefined);
  gateway = undefined;

  state.completed_at = new Date().toISOString();
  const acceptanceRate = state.attempted === 0 ? 0 : state.accepted_explore_queries / state.attempted;
  const semanticRate = state.accepted_explore_queries === 0
    ? 0
    : state.semantic_matches / state.accepted_explore_queries;
  state.acceptance_rate = acceptanceRate;
  state.semantic_match_rate = semanticRate;
  state.pass = state.security_failures === 0
    && state.attempted >= Math.max(1, Math.floor(targetQuestions * 0.8))
    && acceptanceRate >= 0.8
    && semanticRate >= 0.7;
  persist();
  if (!state.pass) {
    throw new Error(`Ollama production Explore soak missed its usability gate: ${JSON.stringify({
      attempted: state.attempted,
      accepted: state.accepted_explore_queries,
      acceptanceRate,
      semanticRate,
      providerErrors: state.provider_errors,
      securityFailures: state.security_failures,
    })}.`);
  }
  return state;
}

async function productionControlCounts(control, schema) {
  const result = await control.query(`
    SELECT
      (SELECT COUNT(*)::int FROM "${schema}".production_explore_audit_events) AS audit_events,
      (SELECT COUNT(*)::int FROM "${schema}".production_explore_budget_reservations) AS budget_reservations
  `);
  return result.rows[0];
}

async function runLocalParityPlan(env, principal, plan, tenant = "acme") {
  const runtime = await createScopedExploreRuntime({
    projectRoot: localParityProjectRoot,
    transport: "stdio",
    env: {
      ...env,
      SYNAPSOR_TENANT_ID: tenant,
      SYNAPSOR_PRINCIPAL: principal,
    },
  });
  try {
    return await runtime.explore(plan);
  } finally {
    await runtime.close();
  }
}

async function verifyPostgresLocalExploreAudit(env, identity, operations, outputRoot) {
  const successful = operations.filter((operation) => [
    "grouped_count_sum",
    "numeric_band",
    "auto_band",
    "derived_relationship",
  ].includes(operation.name));
  for (const operation of successful) {
    const plan = operation.request(identity).arguments.plan;
    const result = await runLocalParityPlan(env, identity.principal, plan, identity.tenant);
    operation.validate(result, identity);
  }
  const refusal = operations.find((operation) => operation.name === "invalid_enum_refusal");
  let refused = false;
  try {
    await runLocalParityPlan(
      env,
      identity.principal,
      refusal.request(identity).arguments.plan,
      identity.tenant,
    );
  } catch (error) {
    refused = /not a reviewed value|EXPLORE_FIELD_ENUM_VALUE_FORBIDDEN/i.test(String(error));
  }
  assert(refused, "Local PostgreSQL Explore did not refuse an unreviewed enum value before source execution.");
  const store = new ProposalStore(path.join(localParityProjectRoot, ".synapsor/local.db"));
  try {
    return verifyLocalExploreAuditRecords({
      engine: "postgres",
      evidence: store.listEvidenceBundles(),
      audits: store.listQueryAudit(),
      expected_successes: successful.length,
      expected_refusals: 1,
      forbidden_values: [identity.tenant, identity.principal, "not-reviewed", "synthetic kept-out", "@example.invalid"],
      result_path: path.join(outputRoot, "postgres-local-audit.json"),
    });
  } finally {
    store.close();
  }
}

function comparableAnalyticsResult(result) {
  return {
    ok: result.ok,
    status: result.outcome?.status ?? result.outcome?.result?.status,
    data: result.data,
    privacy: {
      minimum_cohort_size: result.privacy?.minimum_cohort_size,
      suppressed_groups: result.privacy?.suppressed_groups,
      enum_allowlist_excluded_rows: result.privacy?.enum_allowlist_excluded_rows,
    },
  };
}

function generatedAuthorityText(projectRoot, configPath) {
  const roots = [configPath, path.join(projectRoot, ".synapsor"), path.join(projectRoot, "synapsor/generated")];
  const files = [];
  const visit = (entry) => {
    if (!fs.existsSync(entry)) return;
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) visit(path.join(entry, child));
      return;
    }
    if (/\.(?:json|md|sql|txt|ya?ml)$/i.test(entry)) files.push(entry);
  };
  for (const entry of roots) visit(entry);
  return files.map((file) => `${file}\n${fs.readFileSync(file, "utf8")}`).join("\n");
}

function assertConfigAndArtifactHygiene(input) {
  const text = generatedAuthorityText(input.projectRoot, input.configPath);
  for (const secret of input.forbiddenValues.filter(Boolean)) {
    assert(!text.includes(secret), "Production Explore config or authority artifact persisted secret material.", secret);
  }
  assert(!/-----BEGIN (?:RSA )?PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\./i.test(text),
    "Production Explore config or authority artifact persisted a private JWT key or bearer token.");
}

async function verifySingleOrganizationProductionExplore(input) {
  const { admin, controlSchema, controlUrl, privateKey, publicKeyPem } = input;
  const clients = [];
  let server;
  await seedSingleOrganizationSource(admin);
  const before = await singleOrganizationSourceSnapshot(admin);
  const env = {
    ...process.env,
    DATABASE_URL: readUrl,
    SYNAPSOR_CONTROL_DATABASE_URL: controlUrl,
    SYNAPSOR_SESSION_PUBLIC_KEY: publicKeyPem,
    SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "single-organization-budget-hmac-key-material-1234567890",
  };
  delete env.SYNAPSOR_TENANT_ID;
  try {
    const inspection = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "DATABASE_URL",
      schema: "single_org_http",
      env,
    });
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: singleOrganizationProjectRoot,
        package_manager: "pnpm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "single_org_http",
      deploymentProfile: "production",
      httpClaims: { principalClaim: "sub" },
      singleOrganization: { organizationId: "internal-finance" },
    });
    await writeAutoBoundaryArtifacts({ projectRoot: singleOrganizationProjectRoot, build });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.name = "internal_finance_production";
    assert(candidate.pack.resources.length === 1
      && candidate.pack.resources[0].id === "single_org_http.activity"
      && candidate.pack.resources[0].tenant_key === undefined
      && candidate.pack.resources[0].tenant_scope === undefined,
    "Single-organization production boundary did not retain one tenant-free reviewed resource.", candidate);
    candidate.budgets.max_queries_per_session = 1;
    candidate.budgets.rate_limit_per_minute = 10;
    candidate.budgets.max_extracted_cells_per_session = 100;
    candidate.budgets.max_differencing_queries = 10;
    const digest = explorationBoundaryCandidateDigest(candidate);
    await activateExplorationBoundary({
      projectRoot: singleOrganizationProjectRoot,
      candidate,
      expectedDigest: digest,
      actor: "production-owner@example.test",
      confirmation: `ACTIVATE ${digest}`,
      confirmedDecisions: candidate.unresolved_decisions,
      currentInspection: inspection,
    });

    const runtimeConfig = {
      version: 1,
      mode: "read_only",
      storage: {
        sqlite_path: path.join(singleOrganizationProjectRoot, ".synapsor/local.db"),
        shared_postgres: {
          mode: "runtime_store",
          url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
          schema: controlSchema,
          lock_timeout_ms: 5_000,
          max_entries: 100_000,
        },
      },
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          statement_timeout_ms: 3_000,
        },
      },
      trusted_context: { provider: "http_claims" },
      session_auth: {
        provider: "jwt_asymmetric",
        algorithms: ["RS256"],
        public_key_env: "SYNAPSOR_SESSION_PUBLIC_KEY",
        issuer: "https://identity.example",
        audience: "https://runner.example/mcp",
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
        project_root: singleOrganizationProjectRoot,
        required_oauth_scope: "synapsor.explore",
        budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
        accounting_namespace: "verify.production.explore.single-organization",
        single_organization_id: "internal-finance",
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
    const mismatchConfig = structuredClone(runtimeConfig);
    mismatchConfig.production_explore.single_organization_id = "different-organization";
    let mismatchError = "";
    try {
      await assertProductionExploreStartup(mismatchConfig, env);
    } catch (error) {
      mismatchError = String(error);
    }
    assert(/claim bindings do not match|not ready/i.test(mismatchError),
      "A runtime configured for a different fixed organization did not fail closed.", mismatchError);

    const posture = await assertProductionExploreStartup(runtimeConfig, env);
    assert(posture.ok
      && posture.tools.join(",") === "app.describe_data,app.explore_data"
      && posture.checks.some((check) => check.name === "verified-principal-scope"
        && check.ok && check.message.includes("internal-finance")),
    "Single-organization production startup did not attest principal-only JWT scope.", posture);
    const configPath = path.join(singleOrganizationProjectRoot, "synapsor.runner.json");
    fs.writeFileSync(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
    server = await startProductionExploreCli(configPath, env);

    const alice = clientFor(server.url, await token(privateKey, { tenant: undefined, principal: "analyst-a" }));
    clients.push(alice.client);
    await alice.client.connect(alice.transport);
    const tools = await alice.client.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      "Single-organization MCP exposed more than the two reviewed Explore tools.", tools.tools);
    const described = resultPayload(await alice.client.callTool({
      name: "app.describe_data",
      arguments: {},
    }));
    const describedText = JSON.stringify(described);
    assert(describedText.includes("single_organization")
      && !describedText.includes("internal-finance"),
    "Model-facing catalog did not report the fixed posture safely.", described);
    assert(described.resources?.[0]?.id === "single_org_http.activity"
      && !("label" in described.resources[0])
      && !("plan_resource" in described.resources[0]),
    "Production describe_data did not publish one canonical resource id.", described);
    const plan = {
      kind: "aggregate",
      resource: "activity",
      measures: [{ function: "count" }, { function: "sum", field: "amount_cents" }],
      dimensions: [{ field: "category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const aliceResult = resultPayload(await alice.client.callTool({
      name: "app.explore_data",
      arguments: { plan },
    }));
    assert(aliceResult.ok === true
      && aliceResult.source_database_changed === false
      && aliceResult.data.length === 2
      && aliceResult.data.reduce((sum, row) => sum + row.count, 0) === 12,
    "Principal-only JWT production Explore did not resolve an unambiguous table alias.", aliceResult);
    const exhausted = await alice.client.callTool({ name: "app.explore_data", arguments: { plan } });
    assert(exhausted.isError === true
      && JSON.stringify(exhausted).includes("Authenticated-principal budget: query-volume allowance exhausted"),
      "The single-organization principal did not exhaust only its own reviewed budget.", exhausted);

    const bob = clientFor(server.url, await token(privateKey, { tenant: undefined, principal: "analyst-b" }));
    clients.push(bob.client);
    await bob.client.connect(bob.transport);
    const bobResult = resultPayload(await bob.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(bobResult.ok === true && bobResult.data.length === 2,
      "A second principal was starved by the first principal in the fixed organization.", bobResult);

    const missingPrincipal = clientFor(server.url, await token(privateKey, { tenant: undefined, principal: undefined }));
    await missingPrincipal.client.connect(missingPrincipal.transport)
      .then(() => { throw new Error("JWT without a principal unexpectedly initialized single-organization production Explore."); })
      .catch((error) => assert(/401|unauthorized/i.test(String(error)),
        "Single-organization production Explore did not require a verified principal.", String(error)));
    const after = await singleOrganizationSourceSnapshot(admin);
    assert(JSON.stringify(after) === JSON.stringify(before),
      "Single-organization production Explore mutated its source database.", { before, after });
    return {
      tools: tools.tools.map((tool) => tool.name),
      principal_only_jwt: true,
      fixed_organization: true,
      principal_budget_isolated: true,
      source_database_changed: false,
    };
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopProductionExploreCli(server).catch(() => undefined);
  }
}

async function main() {
  fs.cpSync(fixture, projectRoot, { recursive: true });
  run("docker", ["compose", "-f", compose, "up", "-d", "--wait", "postgres"], { inherit: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const control = new Pool({ connectionString: controlUrl, max: 1 });
  const soakRequested = productionExploreSoakRequested();
  const soakIdentities = soakRequested ? productionExploreSoakIdentities() : [];
  let server;
  let tenantBudgetServer;
  const clients = [];
  try {
    if (process.env.SYNAPSOR_SKIP_PRODUCTION_EXPLORE_ACCOUNTING_TEST !== "1") {
      run("corepack", [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--maxWorkers=1",
        "--minWorkers=1",
        "--testTimeout=30000",
        "--hookTimeout=30000",
        "packages/proposal-store/src/production-explore-postgres.test.ts",
      ], {
        inherit: true,
        env: { ...process.env, SYNAPSOR_TEST_POSTGRES_URL: controlUrl },
      });
    }
    await seedDerivedSource(admin);
    if (soakRequested) await seedPostgresSoakPrincipals(admin, soakIdentities);
    const before = await sourceSnapshot(admin);
    const env = { ...process.env, DATABASE_URL: readUrl };
    const inspection = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "DATABASE_URL",
      env,
    });
    assert(inspection.role_posture?.verified === true && inspection.role_posture.read_only === true,
      "Production Explore fixture reader is not demonstrably read-only.", inspection.role_posture);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: projectRoot,
        package_manager: "pnpm",
        frameworks: ["node", "nextjs", "prisma"],
        schema_inputs: [{ kind: "prisma", path: "prisma/schema.prisma" }],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      deploymentProfile: "production",
      httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          "public.churn_events": {
            metadata: {
              label: "Customer churn events",
              description: "Reviewed customer churn events used for retention analysis.",
              actor: "production-owner@example.test",
              reason: "Give operators and AI clients business context without changing resource authority.",
              decided_at: "2026-08-10T12:00:00.000Z",
            },
            field_metadata: {
              reason_category: {
                label: "Churn reason",
                description: "Reviewed category describing why the customer churned.",
                actor: "production-owner@example.test",
                reason: "Clarify an existing reviewed grouping field.",
                decided_at: "2026-08-10T12:01:00.000Z",
              },
              private_note: {
                label: "Operator private note",
                description: "Human-only context that must remain outside model metadata.",
                actor: "production-owner@example.test",
                reason: "Help the human reviewer recognize a field that remains kept out.",
                decided_at: "2026-08-10T12:02:00.000Z",
              },
            },
            fields: {
              private_note: {
                exposure: "keep_out",
                actor: "production-owner@example.test",
                reason: "Private operator notes are never part of reviewed model access.",
                decided_at: "2026-08-10T12:02:00.000Z",
              },
            },
          },
          "public.scoped_order_items": {
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
          "public.shared_product_catalog": {
            shared_reference_scope: {
              value: SHARED_REFERENCE_ACKNOWLEDGEMENT,
              actor: "production-owner@example.test",
              reason: "This centrally maintained catalog contains the same reviewed rows for every tenant.",
              decided_at: "2026-08-07T12:00:00.000Z",
            },
          },
        },
      },
    });
    await writeAutoBoundaryArtifacts({ projectRoot, build });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.name = "customer_churn_production";
    candidate.pack.resources = candidate.pack.resources.filter((resource) => [
      "public.churn_events",
      "public.scoped_orders",
      "public.scoped_order_items",
      "public.shared_product_catalog",
    ].includes(resource.id));
    assert(candidate.pack.resources.length === 4,
      "Production fixture did not draft its direct, derived, and shared-reference resources.", candidate.pack.resources);
    const churnResource = candidate.pack.resources.find((resource) => resource.id === "public.churn_events");
    const scopedOrders = candidate.pack.resources.find((resource) => resource.id === "public.scoped_orders");
    const scopedOrderItems = candidate.pack.resources.find((resource) => resource.id === "public.scoped_order_items");
    const sharedProductCatalog = candidate.pack.resources.find((resource) =>
      resource.id === "public.shared_product_catalog");
    assert(churnResource && scopedOrders && scopedOrderItems?.tenant_scope && scopedOrderItems?.principal_scope
      && sharedProductCatalog?.shared_reference_scope?.acknowledgement === SHARED_REFERENCE_ACKNOWLEDGEMENT,
    "Production fixture did not preserve its derived scope and explicit shared-reference authority.", candidate.pack.resources);
    assert(churnResource.label === "Customer churn events"
      && churnResource.description === "Reviewed customer churn events used for retention analysis."
      && churnResource.field_metadata?.reason_category?.label === "Churn reason"
      && churnResource.field_metadata?.private_note?.label === "Operator private note"
      && churnResource.kept_out_fields.includes("private_note"),
    "Production fixture did not bind reviewed metadata while keeping private_note out.", churnResource);
    assert(
      JSON.stringify(churnResource.field_enums.reason_category)
        === JSON.stringify(["onboarding", "price", "product", "service"]),
      "PostgreSQL CHECK-constrained values did not reach the reviewed boundary from live schema metadata.",
      churnResource.field_enums,
    );
    narrowResource(churnResource);
    churnResource.numeric_bands = [{
      name: "monthly_revenue_band",
      label: "Monthly revenue band",
      field: "monthly_revenue_cents",
      edges: [6_500, 10_000, 20_000],
      bucket_labels: ["under 65", "65 to 99", "100 to 199", "200 or more"],
    }];
    churnResource.auto_bands = [{
      field: "monthly_revenue_cents",
      methods: ["quantile", "equal_width"],
      min_buckets: 2,
      max_buckets: 8,
      min_bucket_width: 5_000,
      label_style: "ordinal",
    }];
    churnResource.derived_measures = [{
      name: "revenue_running_total",
      label: "Revenue running total",
      shape: "running_total",
      base_measure: { function: "sum", field: "monthly_revenue_cents" },
    }];
    narrowDerivedResources(scopedOrders, scopedOrderItems);
    scopedOrders.derived_measures = [{
      name: "scoped_order_item_count",
      label: "Scoped order item count",
      shape: "child_count_total",
      child_resource: "public.scoped_order_items",
      relationship: "scoped_order_items_order_id_fkey",
    }];
    sharedProductCatalog.selectable_fields = ["category"];
    sharedProductCatalog.filterable_fields = Object.fromEntries(
      Object.entries(sharedProductCatalog.filterable_fields).filter(([field]) => field === "category"),
    );
    sharedProductCatalog.sortable_fields = sharedProductCatalog.sortable_fields
      .filter((field) => field === "category");
    sharedProductCatalog.groupable_fields = sharedProductCatalog.groupable_fields
      .filter((field) => field === "category");
    sharedProductCatalog.aggregate_measures = [];
    sharedProductCatalog.count_distinct_fields = [];
    sharedProductCatalog.time_bucket_fields = {};
    sharedProductCatalog.relationships = [];
    const indexedChecks = derivedScopeIndexDoctorChecks({
      boundaries: [candidate],
      inspectionsBySource: new Map([[candidate.source, [inspection]]]),
    });
    assert(indexedChecks.some((check) => check.name === "derived-scope-indexes:complete"),
      "PostgreSQL live catalog did not attest the indexed derived-scope path.", indexedChecks);
    await admin.query("DROP INDEX public.scoped_order_items_order_id_idx");
    const missingIndexInspection = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "DATABASE_URL",
      env,
    });
    const missingIndexChecks = derivedScopeIndexDoctorChecks({
      boundaries: [candidate],
      inspectionsBySource: new Map([[candidate.source, [missingIndexInspection]]]),
    });
    assert(missingIndexChecks.filter((check) => check.advisory === "warning").length === 2
      && missingIndexChecks.every((check) => check.ok === true)
      && missingIndexChecks.every((check) => check.message.includes("scoped_order_items.order_id"))
      && missingIndexChecks.every((check) => check.message.includes("CREATE INDEX")),
    "PostgreSQL dropped-index advisory did not name both reviewed scope paths without gating them.", missingIndexChecks);
    await admin.query("CREATE INDEX scoped_order_items_order_id_idx ON public.scoped_order_items (order_id)");

    const localBuild = buildAutoBoundary({
      inspection,
      project: {
        root: localParityProjectRoot,
        package_manager: "pnpm",
        frameworks: ["node", "nextjs", "prisma"],
        schema_inputs: [{ kind: "prisma", path: "prisma/schema.prisma" }],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      deploymentProfile: "staging",
      overrides: build.overrides,
    });
    await writeAutoBoundaryArtifacts({ projectRoot: localParityProjectRoot, build: localBuild });
    const localCandidate = structuredClone(localBuild.exploration_boundary);
    localCandidate.pack.name = "customer_churn_local_parity";
    localCandidate.pack.resources = structuredClone(candidate.pack.resources);
    const localDigest = explorationBoundaryCandidateDigest(localCandidate);
    await activateExplorationBoundary({
      projectRoot: localParityProjectRoot,
      candidate: localCandidate,
      expectedDigest: localDigest,
      actor: "production-e2e-local-parity@example.test",
      confirmation: `ACTIVATE ${localDigest}`,
      confirmedDecisions: localCandidate.unresolved_decisions,
      currentInspection: inspection,
    });

    if (!soakRequested) {
      candidate.budgets.max_queries_per_session = 1;
      candidate.budgets.rate_limit_per_minute = 10;
      candidate.budgets.max_extracted_cells_per_session = 100;
      candidate.budgets.max_differencing_queries = 10;
    }
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
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
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
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
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
        accounting_namespace: "verify.production.explore",
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
    if (soakRequested) applyProductionExploreSoakBudgets(undefined, runtimeConfig);
    Object.assign(env, {
      SYNAPSOR_CONTROL_DATABASE_URL: controlUrl,
      SYNAPSOR_SESSION_PUBLIC_KEY: publicKeyPem,
      SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "shared-production-budget-hmac-key-material-1234567890",
    });

    const posture = await assertProductionExploreStartup(runtimeConfig, env);
    assert(posture.ok && posture.tools.join(",") === "app.describe_data,app.explore_data",
      "Production Explore startup posture did not attest the exact two-tool surface.", posture);
    const configPath = path.join(projectRoot, "synapsor.runner.json");
    fs.writeFileSync(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
    assertConfigAndArtifactHygiene({
      projectRoot,
      configPath,
      forbiddenValues: [readUrl, adminUrl, controlUrl, env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY],
    });
    for (const presentationArgs of [
      ["--result-format", "json"],
      ["--tool-name-style", "snake_case"],
    ]) {
      const rejectedInvocation = productionExploreRunnerInvocation([
        "mcp", "serve",
        "--transport", "streamable-http",
        "--production-explore",
        "--config", configPath,
        "--host", "127.0.0.1",
        "--trusted-tls-proxy",
        ...presentationArgs,
      ]);
      const rejected = run(rejectedInvocation.command, rejectedInvocation.args, { env, allowFailure: true });
      assert(rejected.status !== 0
        && /fixed app\.describe_data\/app\.explore_data|not available on this surface/i.test(`${rejected.stdout}\n${rejected.stderr}`),
      `Production Explore accepted presentation override ${presentationArgs[0]}.`, rejected);
    }
    const migrationInvocation = productionExploreRunnerInvocation([
      "store",
      "shared-postgres",
      "apply-migration",
      "--schema",
      controlSchema,
      "--url-env",
      "SYNAPSOR_CONTROL_DATABASE_URL",
      "--yes",
    ]);
    run(migrationInvocation.command, migrationInvocation.args, { env });
    const doctorInvocation = productionExploreRunnerInvocation([
      "doctor",
      "--config",
      configPath,
      "--json",
      "--transport",
      "streamable-http",
      "--host",
      "127.0.0.1",
      "--trusted-tls-proxy",
    ]);
    const doctorResult = run(doctorInvocation.command, doctorInvocation.args, { env });
    const doctor = JSON.parse(doctorResult.stdout);
    assert(doctor.ok === true, "Production Explore doctor did not attest deployment readiness.", doctor);
    assert(doctor.tools?.join(",") === "app.describe_data,app.explore_data",
      "Production Explore doctor did not report the exact model-facing tool surface.", doctor.tools);
    assert(doctor.checks?.some((check) => check.name === "production-explore:verified-principal-scope" && check.ok === true),
      "Production Explore doctor did not attest verified tenant/principal scope.", doctor.checks);
    assert(doctor.checks?.some((check) => check.name === "production-explore:source-connection-ceiling"
      && check.ok === true && check.message.includes("capped at 2 total connections")),
    "Production Explore doctor did not attest the process-wide source connection ceiling.", doctor.checks);
    assert(doctor.checks?.some((check) => check.name === "derived-scope-indexes:complete"
      && check.level === "pass" && check.message.includes("2 reviewed derived-scope paths")),
    "Production Explore doctor did not attest live derived-scope index coverage.", doctor.checks);
    assert(doctor.checks?.some((check) =>
      check.name === "shared-reference:customer_churn_production:public.shared_product_catalog"
      && check.ok === true
      && check.message.includes("no tenant predicate")),
    "Production Explore doctor did not attest the exact reviewed Shared reference.", doctor.checks);
    const doctorSerialized = JSON.stringify(doctor);
    assert(!doctorSerialized.includes(controlUrl)
      && !doctorSerialized.includes(readUrl)
      && !doctorSerialized.includes(env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY),
    "Production Explore doctor disclosed a database URL or HMAC key.");
    server = await startProductionExploreCli(configPath, env);

    const authCountsBefore = await productionControlCounts(control, controlSchema);
    const wrongKeyPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const authRefusals = await verifyJwtRejectionMatrix({
      url: server.url,
      privateKey,
      wrongPrivateKey: wrongKeyPair.privateKey,
      tenant: "acme",
      principal: "pm-1",
    });
    const authCountsAfter = await productionControlCounts(control, controlSchema);
    assert(authRefusals.length === 11,
      "Production Explore did not execute the complete JWT rejection matrix.", authRefusals);
    assert(JSON.stringify(authCountsAfter) === JSON.stringify(authCountsBefore),
      "An authentication failure reached production query budget or evidence accounting.", {
        before: authCountsBefore,
        after: authCountsAfter,
      });

    if (soakRequested) {
      const outputRoot = process.env.SYNAPSOR_SOAK_OUTPUT_DIR?.trim()
        || path.resolve(root, "..", "synapsor-1.7.0-soak");
      const operations = postgresSoakOperations();
      const groupedOperation = operations.find((operation) => operation.name === "grouped_count_sum");
      const recoveryIdentity = soakIdentities.at(-1);
      const ollamaTargetQuestions = ollamaSoakIntegerEnv("SYNAPSOR_SOAK_OLLAMA_QUESTIONS", 100, 1, 1_000);
      const ollamaQuestionsPerIdentity = ollamaSoakIntegerEnv(
        "SYNAPSOR_SOAK_OLLAMA_QUESTIONS_PER_IDENTITY",
        6,
        1,
        10,
      );
      const ollamaIdentityCount = Math.ceil(ollamaTargetQuestions / ollamaQuestionsPerIdentity);
      const ollamaIdentities = soakIdentities.slice(-(ollamaIdentityCount + 1), -1);
      const loadIdentities = soakIdentities.slice(0, -(ollamaIdentityCount + 1));
      const result = await runProductionExploreHttpSoak({
        engine: "postgres",
        server_pid: server.child.pid,
        server_exit_state: server.exitState,
        source_connection_ceiling: runtimeConfig.production_explore.source_max_connections,
        source_connection_count: async () => {
          const count = await admin.query(`
            SELECT COUNT(*)::int AS count
            FROM pg_stat_activity
            WHERE datname = current_database() AND usename = 'synapsor_churn_reader'
          `);
          return Number(count.rows[0]?.count ?? 0);
        },
        identities: loadIdentities,
        create_client: async (identity) => clientFor(server.url, await token(privateKey, identity), {
          tenant_id: "query-tenant-must-not-win",
          principal: "query-principal-must-not-win",
        }),
        operations,
        result_path: path.join(outputRoot, "postgres-http-soak.json"),
      });
      const ollama = await runOllamaAgentSoak({
        url: server.url,
        privateKey,
        model: process.env.SYNAPSOR_TEST_OLLAMA_MODEL?.trim() || "qwen2.5:7b",
        identities: ollamaIdentities,
        server_pid: server.child.pid,
        server_exit_state: server.exitState,
        source_connection_ceiling: runtimeConfig.production_explore.source_max_connections,
        source_connection_count: async () => {
          const count = await admin.query(`
            SELECT COUNT(*)::int AS count
            FROM pg_stat_activity
            WHERE datname = current_database() AND usename = 'synapsor_churn_reader'
          `);
          return Number(count.rows[0]?.count ?? 0);
        },
        result_path: path.join(outputRoot, "postgres-http-ollama-soak.json"),
      });
      const countsAfterSoak = await productionControlCounts(control, controlSchema);
      assert(Number(countsAfterSoak.audit_events) > Number(authCountsAfter.audit_events)
        && Number(countsAfterSoak.budget_reservations) > Number(authCountsAfter.budget_reservations),
      "PostgreSQL soak traffic did not produce durable budget and metadata-only audit records.", {
        before: authCountsAfter,
        after: countsAfterSoak,
      });
      const audit = await verifyProductionExploreAuditSink({
        engine: "postgres",
        control,
        schema: controlSchema,
        soak: result,
        additional_successful_explore_queries: ollama.accepted_explore_queries,
        additional_expected_refusals: ollama.expected_refusals,
        forbidden_values: [
          "soak-",
          "synthetic kept-out",
          "@example.invalid",
        ],
        result_path: path.join(outputRoot, "postgres-http-audit.json"),
      });

      await stopProductionExploreCli(server);
      await waitForSourceConnectionQuiescence({
        engine: "postgres",
        source_connection_count: async () => {
          const count = await admin.query(`
            SELECT COUNT(*)::int AS count
            FROM pg_stat_activity
            WHERE datname = current_database() AND usename = 'synapsor_churn_reader'
          `);
          return Number(count.rows[0]?.count ?? 0);
        },
      });
      server = await startProductionExploreCli(configPath, env);
      const recovery = await runProductionExploreRecovery({
        engine: "postgres",
        server_pid: server.child.pid,
        source_connection_ceiling: runtimeConfig.production_explore.source_max_connections,
        source_connection_count: async () => {
          const count = await admin.query(`
            SELECT COUNT(*)::int AS count
            FROM pg_stat_activity
            WHERE datname = current_database() AND usename = 'synapsor_churn_reader'
          `);
          return Number(count.rows[0]?.count ?? 0);
        },
        identity: recoveryIdentity,
        create_client: async (identity) => clientFor(server.url, await token(privateKey, identity)),
        request: groupedOperation.request,
        validate: groupedOperation.validate,
        result_path: path.join(outputRoot, "postgres-http-recovery.json"),
      });
      await stopProductionExploreCli(server);
      server = undefined;
      const localAudit = await verifyPostgresLocalExploreAudit(
        env,
        soakIdentities[0],
        operations,
        outputRoot,
      );
      const after = await sourceSnapshot(admin);
      assert(JSON.stringify(after) === JSON.stringify(before),
        "PostgreSQL production HTTP soak mutated the source database.", { before, after });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        engine: "postgres",
        soak: result,
        ollama,
        local_audit: localAudit,
        audit,
        recovery,
        auth_rejections: authRefusals.length,
        source_database_changed: false,
      }, null, 2)}\n`);
      return;
    }

    const plan = {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [{ function: "count" }],
      dimensions: [{ field: "reason_category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const aliceToken = await token(privateKey, { tenant: "acme", principal: "pm-1" });
    const alice = clientFor(server.url, aliceToken, { tenant_id: "globex", principal: "pm-2" });
    clients.push(alice.client);
    await alice.client.connect(alice.transport);
    const aliceSecond = clientFor(server.url, aliceToken);
    clients.push(aliceSecond.client);
    await aliceSecond.client.connect(aliceSecond.transport);
    const aliceThird = clientFor(server.url, aliceToken);
    await aliceThird.client.connect(aliceThird.transport)
      .then(() => { throw new Error("One principal exceeded the reviewed concurrent-session ceiling."); })
      .catch((error) => assert(
        /429|principal_session_capacity_exhausted/i.test(String(error)),
        "The per-principal session ceiling did not return a clear refusal.",
        String(error),
      ));
    const tools = await alice.client.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      "Production MCP exposed more than the reviewed two-tool surface.", tools.tools);
    assert(tools.tools.every((tool) => tool._meta?.["synapsor.production_explore"] === true
      && tool._meta?.["synapsor.raw_sql_exposed"] === false
      && tool._meta?.["synapsor.approval_tool"] === false
      && tool._meta?.["synapsor.commit_tool"] === false),
    "Production MCP tool metadata did not preserve the read-only boundary.", tools.tools);

    const described = resultPayload(await alice.client.callTool({
      name: "app.describe_data",
      arguments: {},
    }));
    const describedChurn = described.resources?.find((resource) => resource.id === "public.churn_events");
    const focusedTimeDescription = resultPayload(await alice.client.callTool({
      name: "app.describe_data",
      arguments: { resource: "public.churn_events" },
    }));
    const describedItems = described.resources?.find((resource) => resource.id === "public.scoped_order_items");
    assert(described.ok === true
      && described.resources?.length === 4
      && JSON.stringify(describedChurn?.field_enums?.reason_category)
        === JSON.stringify(["onboarding", "price", "product", "service"])
      && describedChurn?.label === "Customer churn events"
      && describedChurn?.description === "Reviewed customer churn events used for retention analysis."
      && describedChurn?.fields?.some((field) => field.id === "reason_category"
        && field.label === "Churn reason"
        && field.description === "Reviewed category describing why the customer churned.")
      && !describedChurn?.fields?.some((field) => field.id === "private_note"
        || field.label === "Operator private note")
      && describedChurn?.numeric_bands?.some((band) => band.name === "monthly_revenue_band")
      && describedChurn?.auto_bands?.some((policy) => policy.field === "monthly_revenue_cents"
        && JSON.stringify(policy.methods) === JSON.stringify(["quantile", "equal_width"])
        && policy.min_buckets === 2
        && policy.max_buckets === 8
        && policy.label_style === "ordinal"
        && policy.raw_edges_returned === false
        && !Object.hasOwn(policy, "min_bucket_width"))
      && describedChurn?.derived_measures?.some((measure) => measure.name === "revenue_running_total")
      && describedChurn?.aggregate_measure_functions?.monthly_revenue_cents?.includes("sum")
      && describedChurn?.time_bucket_fields?.churned_at?.includes("week")
      && !Object.hasOwn(described, "relative_time_windows")
      && focusedTimeDescription.relative_time_windows?.available === true
      && focusedTimeDescription.relative_time_windows?.reporting_timezone === "UTC"
      && focusedTimeDescription.relative_time_windows?.windows?.includes("last_7_days")
      && describedChurn?.relative_time_window_fields?.includes("churned_at")
      && describedItems?.relationships?.some((relationship) =>
        relationship.id === "scoped_order_items_order_id_fkey" && relationship.activation === "active"),
    "Production describe_data did not return the complete reviewed metadata catalog.", described);
    assert(!JSON.stringify(described).match(/event-p1-|pm-other-event|@example\.invalid|synthetic kept-out note|31415/i),
      "Production describe_data returned source-row data instead of metadata only.", described);

    const ollamaModel = process.env.SYNAPSOR_TEST_OLLAMA_MODEL?.trim();
    const ollamaAgent = ollamaModel
      ? await verifyOllamaAgentOverProductionHttp({
        url: server.url,
        privateKey,
        model: ollamaModel,
      })
      : undefined;

    const injectedScope = await alice.client.callTool({
      name: "app.explore_data",
      arguments: {
        tenant_id: "globex",
        principal: "pm-2",
        plan: { ...plan, tenant_id: "globex", principal: "pm-2" },
      },
    });
    assert(injectedScope.isError === true
      && /unrecognized|unsupported|invalid/i.test(JSON.stringify(injectedScope)),
    "Production Explore accepted model-supplied tenant or principal authority.", injectedScope);

    const invalidEnum = await alice.client.callTool({
      name: "app.explore_data",
      arguments: {
        plan: {
          ...plan,
          where: [{ field: "reason_category", op: "eq", value: "not-a-reviewed-reason" }],
        },
      },
    });
    assert(invalidEnum.isError === true
      && /not a reviewed value|onboarding.*price.*product.*service/i.test(JSON.stringify(invalidEnum)),
    "Production Explore did not enforce the reviewed field-enum allowlist before execution.", invalidEnum);

    const aliceResult = resultPayload(await alice.client.callTool({
      name: "app.explore_data",
      arguments: { plan },
    }));
    assert(aliceResult.ok === true && aliceResult.source_database_changed === false,
      "Production Explore did not return a verified read-only result.", aliceResult);
    assert(aliceResult.privacy?.suppressed_groups === 1,
      "Production Explore did not suppress the sub-threshold product cohort.", aliceResult);
    assert(!Object.hasOwn(aliceResult, "protect"), "Remote production Explore exposed local Protect authority.");
    const aliceSerialized = JSON.stringify(aliceResult);
    assert(!aliceSerialized.match(/globex|pm-2|@example\.invalid|synthetic kept-out|SELECT\s/i),
      "Production result leaked another scope, kept-out values, or SQL.", aliceResult);

    const localAliceResult = await runLocalParityPlan(env, "pm-1", plan);
    assert(JSON.stringify(comparableAnalyticsResult(localAliceResult))
      === JSON.stringify(comparableAnalyticsResult(aliceResult)),
    "Suppression or reviewed enum grouping differed between local stdio and production HTTP.", {
      local: comparableAnalyticsResult(localAliceResult),
      http: comparableAnalyticsResult(aliceResult),
    });

    const evidenceRows = await control.query(`
      SELECT event_id, event_kind, payload_json
      FROM "${controlSchema}".production_explore_audit_events
      WHERE event_id = $1 OR payload_json::text LIKE $2 OR payload_json::text LIKE $3
      ORDER BY event_kind
    `, [
      aliceResult.evidence_bundle_id,
      `%${aliceResult.evidence_bundle_id}%`,
      `%${aliceResult.audit.query_fingerprint}%`,
    ]);
    const evidenceSerialized = JSON.stringify(evidenceRows.rows);
    const evidenceEvent = evidenceRows.rows.find((row) => row.event_kind === "evidence_bundle");
    assert(evidenceEvent
      && Array.isArray(evidenceEvent.payload_json?.evidence_bundle?.query_audit)
      && evidenceEvent.payload_json.evidence_bundle.query_audit.length === 1
      && /"tenant_id":"keyed:[a-f0-9]{64}"/i.test(evidenceSerialized)
      && /"result_fingerprint":"hmac-sha256:[a-f0-9]{64}"/i.test(evidenceSerialized)
      && /"result_values_persisted":false/i.test(evidenceSerialized)
      && !evidenceSerialized.includes("acme")
      && !evidenceSerialized.includes("pm-1")
      && !evidenceSerialized.includes("synthetic kept-out")
      && !evidenceSerialized.includes("@example.invalid"),
    "Production evidence did not preserve keyed scope, metadata-only audit, and result fingerprint invariants.",
    evidenceRows.rows);

    const relativePlan = {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [{ function: "count" }],
      dimensions: [{ field: "reason_category" }],
      time_window: { field: "churned_at", window: "last_7_days" },
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const relativeClient = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "pm-relative",
    }));
    clients.push(relativeClient.client);
    await relativeClient.client.connect(relativeClient.transport);
    const relativeResult = resultPayload(await relativeClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: relativePlan },
    }));
    const localRelativeResult = await runLocalParityPlan(env, "pm-relative", relativePlan);
    assert(relativeResult.ok === true
      && relativeResult.data?.length > 0
      && JSON.stringify(comparableAnalyticsResult(localRelativeResult))
        === JSON.stringify(comparableAnalyticsResult(relativeResult))
      && localRelativeResult.operator_time_windows?.[0]?.window === "last_7_days"
      && !Object.hasOwn(relativeResult, "operator_time_windows")
      && !JSON.stringify(relativeResult).match(/resolved_time_windows|start_inclusive|end_exclusive/i),
    "PostgreSQL reviewed relative time differed between local stdio and production HTTP or exposed operator timestamps to the model.", {
      local: comparableAnalyticsResult(localRelativeResult),
      http: comparableAnalyticsResult(relativeResult),
    });
    const relativeEvidenceRows = await control.query(`
      SELECT event_kind, payload_json
      FROM "${controlSchema}".production_explore_audit_events
      WHERE event_id = $1 OR payload_json::text LIKE $2
      ORDER BY event_kind
    `, [
      relativeResult.evidence_bundle_id,
      `%${relativeResult.evidence_bundle_id}%`,
    ]);
    const relativeEvidence = JSON.stringify(relativeEvidenceRows.rows);
    assert(relativeEvidenceRows.rows.some((row) => row.event_kind === "evidence_bundle")
      && relativeEvidence.includes('"resolved_time_windows"')
      && relativeEvidence.includes('"window":"last_7_days"')
      && relativeEvidence.includes('"reporting_timezone":"UTC"')
      && /"start_inclusive":"[^"]+Z"/.test(relativeEvidence)
      && /"end_exclusive":"[^"]+Z"/.test(relativeEvidence)
      && !relativeEvidence.includes("pm-relative"),
    "PostgreSQL relative-window evidence did not preserve the exact resolved UTC range without raw principal identity.",
    relativeEvidenceRows.rows);

    const numericBandPlan = {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [{ function: "count" }],
      dimensions: [{ numeric_band: "monthly_revenue_band" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const bandClient = clientFor(server.url, await token(privateKey, { tenant: "acme", principal: "pm-band" }));
    clients.push(bandClient.client);
    await bandClient.client.connect(bandClient.transport);
    const bandResult = resultPayload(await bandClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: numericBandPlan },
    }));
    const localBandResult = await runLocalParityPlan(env, "pm-band", numericBandPlan);
    assert(bandResult.ok === true
      && bandResult.privacy?.suppressed_groups === 1
      && bandResult.data?.some((row) => row.monthly_revenue_band === "100 to 199" && row.count === 15)
      && bandResult.data?.some((row) => row.monthly_revenue_band === "200 or more" && row.count === 12)
      && JSON.stringify(comparableAnalyticsResult(localBandResult))
        === JSON.stringify(comparableAnalyticsResult(bandResult)),
    "Reviewed numeric bands differed between local stdio and production HTTP.", {
      local: comparableAnalyticsResult(localBandResult),
      http: comparableAnalyticsResult(bandResult),
    });

    const autoBandPlan = {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [{ function: "count" }],
      dimensions: [{
        numeric_band: {
          field: "monthly_revenue_cents",
          method: "quantile",
          buckets: 2,
        },
      }],
      top_n: 10,
    };
    const autoBandClient = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "pm-auto",
    }));
    clients.push(autoBandClient.client);
    await autoBandClient.client.connect(autoBandClient.transport);
    const autoBandResult = resultPayload(await autoBandClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: autoBandPlan },
    }));
    const localAutoBandResult = await runLocalParityPlan(env, "pm-auto", autoBandPlan);
    const autoBandSerialized = JSON.stringify(autoBandResult);
    assert(autoBandResult.ok === true
      && autoBandResult.data?.length === 2
      && autoBandResult.data.every((row) => /^Q[12] of 2$/.test(row.monthly_revenue_cents_quantile_band)
        && Number.isInteger(row.count)
        && row.count >= 5)
      && autoBandResult.privacy?.minimum_cohort_size === 5
      && autoBandResult.privacy?.auto_bands?.[0]?.requested_buckets === 2
      && autoBandResult.privacy?.auto_bands?.[0]?.effective_buckets === 2
      && autoBandResult.privacy?.auto_bands?.[0]?.raw_edges_returned === false
      && !autoBandSerialized.includes("__auto_")
      && !autoBandSerialized.match(/SELECT\s|monthly_revenue_cents\s*[<>]=?\s*\d/i)
      && JSON.stringify(comparableAnalyticsResult(localAutoBandResult))
        === JSON.stringify(comparableAnalyticsResult(autoBandResult)),
    "Reviewed automatic bands differed between local stdio and production HTTP or exposed raw edges.", {
      local: comparableAnalyticsResult(localAutoBandResult),
      http: comparableAnalyticsResult(autoBandResult),
    });

    const tieBandPlan = {
      ...autoBandPlan,
      dimensions: [{
        numeric_band: {
          field: "monthly_revenue_cents",
          method: "quantile",
          buckets: 8,
        },
      }],
    };
    const tieBandClient = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "pm-auto-ties",
    }));
    clients.push(tieBandClient.client);
    await tieBandClient.client.connect(tieBandClient.transport);
    const tieBandResult = resultPayload(await tieBandClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: tieBandPlan },
    }));
    const localTieBandResult = await runLocalParityPlan(env, "pm-auto-ties", tieBandPlan);
    const tieCounts = new Map(tieBandResult.data?.map((row) => [
      row.monthly_revenue_cents_quantile_band,
      row.count,
    ]));
    assert(tieBandResult.ok === true
      && tieCounts.size === 2
      && tieCounts.get("Q4 of 8") === 17
      && tieCounts.get("Q8 of 8") === 18
      && tieBandResult.privacy?.auto_bands?.[0]?.requested_buckets === 8
      && tieBandResult.privacy?.auto_bands?.[0]?.effective_buckets === 2
      && tieBandResult.privacy?.auto_bands?.[0]?.reduced === true
      && tieBandResult.privacy?.auto_bands?.[0]?.raw_edges_returned === false
      && JSON.stringify(comparableAnalyticsResult(localTieBandResult))
        === JSON.stringify(comparableAnalyticsResult(tieBandResult)),
    "PostgreSQL tie-heavy quantiles did not collapse without splitting equal values.", {
      local: comparableAnalyticsResult(localTieBandResult),
      http: comparableAnalyticsResult(tieBandResult),
    });

    const equalWidthPlan = {
      ...autoBandPlan,
      dimensions: [{
        numeric_band: {
          field: "monthly_revenue_cents",
          method: "equal_width",
          buckets: 8,
        },
      }],
    };
    const equalWidthClient = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "pm-auto-equal",
    }));
    clients.push(equalWidthClient.client);
    await equalWidthClient.client.connect(equalWidthClient.transport);
    const equalWidthResult = resultPayload(await equalWidthClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: equalWidthPlan },
    }));
    const localEqualWidthResult = await runLocalParityPlan(env, "pm-auto-equal", equalWidthPlan);
    const equalWidthCounts = new Map(equalWidthResult.data?.map((row) => [
      row.monthly_revenue_cents_equal_width_band,
      row.count,
    ]));
    assert(equalWidthResult.ok === true
      && equalWidthCounts.size === 3
      && equalWidthCounts.get("Band 1 of 3") === 8
      && equalWidthCounts.get("Band 2 of 3") === 15
      && equalWidthCounts.get("Band 3 of 3") === 12
      && equalWidthResult.privacy?.auto_bands?.[0]?.requested_buckets === 8
      && equalWidthResult.privacy?.auto_bands?.[0]?.effective_buckets === 3
      && equalWidthResult.privacy?.auto_bands?.[0]?.reduced === true
      && equalWidthResult.privacy?.auto_bands?.[0]?.raw_edges_returned === false
      && !JSON.stringify(equalWidthResult).includes("__auto_")
      && JSON.stringify(comparableAnalyticsResult(localEqualWidthResult))
        === JSON.stringify(comparableAnalyticsResult(equalWidthResult)),
    "PostgreSQL equal-width auto bands did not honor the reviewed minimum width.", {
      local: comparableAnalyticsResult(localEqualWidthResult),
      http: comparableAnalyticsResult(equalWidthResult),
    });
    const autoBandEvidenceRows = await control.query(`
      SELECT event_kind, payload_json
      FROM "${controlSchema}".production_explore_audit_events
      WHERE event_id = $1 OR payload_json::text LIKE $2
      ORDER BY event_kind
    `, [
      tieBandResult.evidence_bundle_id,
      `%${tieBandResult.evidence_bundle_id}%`,
    ]);
    const autoBandEvidence = JSON.stringify(autoBandEvidenceRows.rows);
    assert(autoBandEvidenceRows.rows.some((row) => row.event_kind === "evidence_bundle")
      && /"result_values_persisted":false/i.test(autoBandEvidence)
      && !/__auto_|"edges"|"raw_edges"|"bucket_min"|"bucket_max"/i.test(autoBandEvidence)
      && !autoBandEvidence.includes("pm-auto-ties"),
    "PostgreSQL automatic-band evidence persisted raw edges, result values, or principal identity.",
    autoBandEvidenceRows.rows);

    const runningTotalPlan = {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [{ derived_measure: "revenue_running_total" }],
      dimensions: [{ field: "reason_category" }],
      time_bucket: { field: "churned_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
      top_n: 25,
    };
    const runningClient = clientFor(server.url, await token(privateKey, { tenant: "acme", principal: "pm-running" }));
    clients.push(runningClient.client);
    await runningClient.client.connect(runningClient.transport);
    const runningResult = resultPayload(await runningClient.client.callTool({
      name: "app.explore_data",
      arguments: { plan: runningTotalPlan },
    }));
    const localRunningResult = await runLocalParityPlan(env, "pm-running", runningTotalPlan);
    assert(runningResult.ok === true
      && runningResult.privacy?.suppressed_groups >= 1
      && runningResult.data?.every((row) => Number.isFinite(row.revenue_running_total))
      && JSON.stringify(comparableAnalyticsResult(localRunningResult))
        === JSON.stringify(comparableAnalyticsResult(runningResult)),
    "The named post-suppression running total differed between local stdio and production HTTP.", {
      local: comparableAnalyticsResult(localRunningResult),
      http: comparableAnalyticsResult(runningResult),
    });

    const exhausted = await alice.client.callTool({ name: "app.explore_data", arguments: { plan } });
    const exhaustedText = JSON.stringify(exhausted);
    assert(exhausted.isError === true
      && exhaustedText.includes("Authenticated-principal budget: query-volume allowance exhausted")
      && exhaustedText.includes("Used 1 of 1 queries")
      && exhaustedText.includes("expire no later than")
      && exhaustedText.includes("L Limits"),
      "One principal did not exhaust only its own reviewed query budget.", exhausted);

    const bobToken = await token(privateKey, { tenant: "acme", principal: "pm-other" });
    const bob = clientFor(server.url, bobToken);
    clients.push(bob.client);
    await bob.client.connect(bob.transport);
    const bobResult = resultPayload(await bob.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(bobResult.ok === true
      && bobResult.data.length === 1
      && bobResult.data[0].reason_category === "onboarding"
      && bobResult.data[0].count === 5,
      "A second principal was starved by the first principal or read the first principal's rows.", bobResult);

    const globexToken = await token(privateKey, { tenant: "globex", principal: "pm-2" });
    const globex = clientFor(server.url, globexToken);
    clients.push(globex.client);
    await globex.client.connect(globex.transport);
    const globexResult = resultPayload(await globex.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(globexResult.ok === true
      && globexResult.data.length === 1
      && globexResult.data[0].reason_category === "price"
      && globexResult.data[0].count === 8,
    "Verified tenant/principal claims did not isolate the Globex result.", globexResult);

    const sharedReferencePlan = {
      kind: "aggregate",
      resource: "public.shared_product_catalog",
      measures: [{ function: "count" }],
      dimensions: [{ field: "category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const sharedAcme = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "shared-reference-acme",
    }));
    clients.push(sharedAcme.client);
    await sharedAcme.client.connect(sharedAcme.transport);
    const sharedAcmeResult = resultPayload(await sharedAcme.client.callTool({
      name: "app.explore_data",
      arguments: { plan: sharedReferencePlan },
    }));
    const sharedGlobex = clientFor(server.url, await token(privateKey, {
      tenant: "globex",
      principal: "shared-reference-globex",
    }));
    clients.push(sharedGlobex.client);
    await sharedGlobex.client.connect(sharedGlobex.transport);
    const sharedGlobexResult = resultPayload(await sharedGlobex.client.callTool({
      name: "app.explore_data",
      arguments: { plan: sharedReferencePlan },
    }));
    const expectedSharedData = [
      { category: "hardware", count: 6 },
      { category: "software", count: 6 },
    ];
    const sharedAcmeData = [...(sharedAcmeResult.data ?? [])]
      .sort((left, right) => left.category.localeCompare(right.category));
    const sharedGlobexData = [...(sharedGlobexResult.data ?? [])]
      .sort((left, right) => left.category.localeCompare(right.category));
    assert(sharedAcmeResult.ok === true
      && sharedGlobexResult.ok === true
      && JSON.stringify(sharedAcmeData) === JSON.stringify(expectedSharedData)
      && JSON.stringify(sharedGlobexData) === JSON.stringify(expectedSharedData)
      && sharedAcmeResult.source_database_changed === false
      && sharedGlobexResult.source_database_changed === false,
    "Production HTTP Shared reference did not return the same reviewed global rows to two JWT tenants.", {
      sharedAcmeResult,
      sharedGlobexResult,
    });
    assert(!JSON.stringify([sharedAcmeResult, sharedGlobexResult]).match(/operator-only|internal_notes|SELECT\s/i),
      "Production HTTP Shared reference leaked a kept-out field or compiled SQL.", {
        sharedAcmeResult,
        sharedGlobexResult,
      });

    const derivedPlan = {
      kind: "aggregate",
      resource: "public.scoped_order_items",
      measures: [{ function: "count" }, { function: "sum", field: "quantity" }],
      dimensions: [{
        field: "category",
        relationship: "scoped_order_items_order_id_fkey",
      }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const derivedAcme = clientFor(server.url, await token(privateKey, {
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
    "PostgreSQL production Explore did not isolate a normalized child through its mandatory scope path.", derivedAcmeResult);
    assert(!JSON.stringify(derivedAcmeResult).match(/globex|enterprise|derived-globex|SELECT\s/i),
      "PostgreSQL derived-scope result leaked another scope or compiled SQL.", derivedAcmeResult);

    const derivedGlobex = clientFor(server.url, await token(privateKey, {
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
    "PostgreSQL derived scope did not isolate the second tenant/principal.", derivedGlobexResult);

    const fanoutAcme = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "fanout-acme",
    }));
    clients.push(fanoutAcme.client);
    await fanoutAcme.client.connect(fanoutAcme.transport);
    const fanoutResult = resultPayload(await fanoutAcme.client.callTool({
      name: "app.explore_data",
      arguments: {
        plan: {
          kind: "aggregate",
          resource: "public.scoped_orders",
          measures: [{ derived_measure: "scoped_order_item_count" }],
          dimensions: [{ field: "category" }],
          top_n: 10,
        },
      },
    }));
    assert(fanoutResult.ok === true
      && fanoutResult.data.length === 1
      && fanoutResult.data[0].category === "trail"
      && fanoutResult.data[0].scoped_order_item_count === 5
      && fanoutResult.privacy.minimum_cohort_size >= 5,
    "PostgreSQL production HTTP Explore did not execute the reviewed scoped child count.", fanoutResult);
    assert(!JSON.stringify(fanoutResult).match(/globex|derived-acme|SELECT\s/i),
      "PostgreSQL reviewed child count leaked another principal, tenant, or compiled SQL.", fanoutResult);

    const loadClients = await Promise.all(Array.from({ length: 8 }, async (_unused, index) => {
      const handle = clientFor(server.url, await token(privateKey, {
        tenant: "acme",
        principal: `load-principal-${index}`,
      }));
      clients.push(handle.client);
      await handle.client.connect(handle.transport);
      return handle;
    }));
    await Promise.all(loadClients.map((handle) => handle.client.callTool({
      name: "app.explore_data",
      arguments: { plan },
    })));
    const sourceConnections = await admin.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'synapsor_churn_reader'
    `);
    assert(Number(sourceConnections.rows[0]?.count) <= 2,
      "Production MCP sessions exceeded the process-wide source connection ceiling.", sourceConnections.rows);

    const tenantBudgetConfig = structuredClone(runtimeConfig);
    tenantBudgetConfig.production_explore.accounting_namespace = "verify.production.explore.tenant-budget";
    tenantBudgetConfig.production_explore.tenant_limits.max_queries_per_rolling_24_hours = 2;
    const tenantBudgetConfigPath = path.join(projectRoot, "synapsor.tenant-budget.runner.json");
    fs.writeFileSync(tenantBudgetConfigPath, `${JSON.stringify(tenantBudgetConfig, null, 2)}\n`, "utf8");
    assertConfigAndArtifactHygiene({
      projectRoot,
      configPath: tenantBudgetConfigPath,
      forbiddenValues: [readUrl, adminUrl, controlUrl, env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY],
    });
    tenantBudgetServer = await startProductionExploreCli(tenantBudgetConfigPath, env);
    const tenantBudgetClients = [];
    try {
      const tenantResults = [];
      for (const principal of ["tenant-budget-1", "tenant-budget-2", "tenant-budget-3"]) {
        const handle = clientFor(tenantBudgetServer.url, await token(privateKey, { tenant: "acme", principal }));
        tenantBudgetClients.push(handle.client);
        await handle.client.connect(handle.transport);
        tenantResults.push(await handle.client.callTool({
          name: "app.explore_data",
          arguments: { plan: sharedReferencePlan },
        }));
      }
      assert(resultPayload(tenantResults[0]).ok === true
        && resultPayload(tenantResults[1]).ok === true
        && tenantResults[2].isError === true
        && /tenant/i.test(JSON.stringify(tenantResults[2])),
      "The reviewed tenant query ceiling did not throttle only the exhausted tenant.", tenantResults);

      const otherTenant = clientFor(tenantBudgetServer.url, await token(privateKey, {
        tenant: "globex",
        principal: "tenant-budget-other",
      }));
      tenantBudgetClients.push(otherTenant.client);
      await otherTenant.client.connect(otherTenant.transport);
      const otherTenantResult = resultPayload(await otherTenant.client.callTool({
        name: "app.explore_data",
        arguments: { plan: sharedReferencePlan },
      }));
      assert(otherTenantResult.ok === true && otherTenantResult.data.length === 2,
        "One tenant's exhausted budget starved another tenant on the same production server.", otherTenantResult);
    } finally {
      await Promise.allSettled(tenantBudgetClients.map((client) => client.close()));
      await stopProductionExploreCli(tenantBudgetServer).catch(() => undefined);
      tenantBudgetServer = undefined;
    }

    const activeLock = await loadGenerationLockSnapshot(
      projectRoot,
      candidate.generation_lock_fingerprint,
    );
    const dependencyResources = Object.values(activeLock.authority_dependencies?.resources ?? {})
      .map((dependency) => ({ schema: dependency.schema, table: dependency.table }));
    const schemaWidthClient = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "schema-width",
    }));
    clients.push(schemaWidthClient.client);
    await schemaWidthClient.client.connect(schemaWidthClient.transport);
    const schemaWidthScaling = await verifySchemaWidthScaling({
      admin,
      client: schemaWidthClient.client,
      env,
      plan,
      resources: dependencyResources,
    });

    const auditStorage = await control.query(`
      SELECT
        (SELECT COUNT(*)::int FROM "${controlSchema}".production_explore_audit_events) AS dedicated_events,
        (SELECT COUNT(*)::int FROM "${controlSchema}".ledger_entries
          WHERE kind IN ('evidence_bundle', 'evidence_item', 'query_audit')) AS proposal_ledger_events
    `);
    assert(Number(auditStorage.rows[0]?.dedicated_events) >= 12,
      "Production Explore did not append metadata evidence to its dedicated sink.", auditStorage.rows[0]);
    assert(Number(auditStorage.rows[0]?.proposal_ledger_events) === 0,
      "Production Explore query volume still entered the proposal/writeback ledger.", auditStorage.rows[0]);

    await admin.query("ALTER TABLE public.churn_events ALTER COLUMN monthly_revenue_cents TYPE bigint");
    try {
      const driftClient = clientFor(server.url, await token(privateKey, {
        tenant: "acme",
        principal: "pm-drift",
      }));
      clients.push(driftClient.client);
      await driftClient.client.connect(driftClient.transport);
      const driftRefusal = await driftClient.client.callTool({
        name: "app.explore_data",
        arguments: { plan },
      });
      assert(driftRefusal.isError === true
        && /EXPLORE_LOCK_STALE|generated authority is stale/i.test(JSON.stringify(driftRefusal)),
      "A reviewed PostgreSQL column-type drift did not fail closed before source execution.", driftRefusal);
    } finally {
      await admin.query("ALTER TABLE public.churn_events ALTER COLUMN monthly_revenue_cents TYPE integer");
    }

    const singleOrganization = await verifySingleOrganizationProductionExplore({
      admin,
      controlSchema,
      controlUrl,
      privateKey,
      publicKeyPem,
    });
    const after = await sourceSnapshot(admin);
    assert(JSON.stringify(after) === JSON.stringify(before),
      "Production HTTP Explore mutated the application source database.", { before, after });

    process.stdout.write(`${JSON.stringify({
      ok: true,
      boundary: candidate.pack.name,
      tools: tools.tools.map((tool) => tool.name),
      principal_budget_isolated: true,
      tenant_budget_isolated: true,
      tenant_and_principal_rows_isolated: true,
      derived_tenant_and_principal_scope_isolated: true,
      reviewed_child_count_scope_isolated: true,
      shared_reference_same_across_tenants: true,
      concurrent_budget_reservation: true,
      source_connection_ceiling: 2,
      principal_session_ceiling: 2,
      dedicated_audit_sink: true,
      complete_jwt_rejection_matrix: authRefusals.map((item) => item.label),
      metadata_only_catalog: true,
      ollama_agent_http: ollamaAgent ?? "not_requested",
      analytics_http_stdio_parity: true,
      schema_width_scaling: schemaWidthScaling,
      drift_refused_over_http: true,
      config_and_artifact_hygiene: true,
      public_cli_entrypoint: true,
      packed_artifact: Boolean(process.env.SYNAPSOR_PRODUCTION_EXPLORE_RUNNER?.trim()),
      doctor_attested: true,
      derived_scope_indexes_attested: true,
      suppressed_groups: aliceResult.privacy.suppressed_groups,
      single_organization: singleOrganization,
      source_database_changed: false,
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopProductionExploreCli(tenantBudgetServer).catch(() => undefined);
    await stopProductionExploreCli(server).catch(() => undefined);
    await control.query(`DROP SCHEMA IF EXISTS "${controlSchema}" CASCADE`).catch(() => undefined);
    await Promise.allSettled([admin.end(), control.end()]);
    if (process.env.SYNAPSOR_KEEP_PRODUCTION_EXPLORE_FIXTURE === "1") {
      process.stderr.write(`Preserved production Explore fixture at ${projectRoot}\n`);
    } else {
      run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(singleOrganizationProjectRoot, { recursive: true, force: true });
      fs.rmSync(localParityProjectRoot, { recursive: true, force: true });
    }
  }
}

await main();
