import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Pool } from "pg";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import {
  createMcpRuntime,
  loadRuntimeConfigFromFile,
  preflightGeneratedAuthority,
} from "../packages/mcp-server/dist/index.js";
import {
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  loadStructuredProjectEvidence,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import { createScopedExploreMcpServer } from "../apps/runner/dist/authoring-mcp.js";
import { detectProjectContext } from "../apps/runner/dist/project-detection.js";
import {
  activateProtectedQuery,
  createProtectedQueryDraft,
} from "../apps/runner/dist/protect-query.js";
import {
  createScopedExploreRuntime,
  prepareScopedExplore,
} from "../apps/runner/dist/scoped-explore.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "examples/auto-boundary-churn");
const compose = path.join(fixture, "docker-compose.yml");
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-auto-boundary-churn-"));
const readUrl = "postgresql://synapsor_churn_reader:synapsor_churn_reader_password@127.0.0.1:55460/synapsor_auto_boundary";
const adminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55460/synapsor_auto_boundary";
const env = {
  ...process.env,
  DATABASE_URL: readUrl,
  SYNAPSOR_TENANT_ID: "acme",
  SYNAPSOR_PRINCIPAL: "pm-1",
};

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
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

async function sourceSnapshot(pool) {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS row_count,
      md5(string_agg(
        id || ':' || tenant_id || ':' || owner_id || ':' || account_id || ':' ||
        reason_category || ':' || monthly_revenue_cents::text || ':' ||
        churned_at::text || ':' || private_note,
        '|' ORDER BY id
      )) AS digest
    FROM public.churn_events
  `);
  return result.rows[0];
}

function narrowResource(resource, input) {
  resource.selectable_fields = input.selectable;
  resource.filterable_fields = Object.fromEntries(Object.entries(resource.filterable_fields)
    .filter(([field]) => input.filterable.includes(field)));
  resource.sortable_fields = resource.sortable_fields.filter((field) => input.sortable.includes(field));
  resource.groupable_fields = resource.groupable_fields.filter((field) => input.groupable.includes(field));
  resource.aggregate_measures = resource.aggregate_measures.filter((field) => input.measures.includes(field));
  resource.count_distinct_fields = resource.count_distinct_fields.filter((field) => input.distinct.includes(field));
  resource.time_bucket_fields = Object.fromEntries(Object.entries(resource.time_bucket_fields)
    .filter(([field]) => input.time.includes(field)));
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP result did not contain structured content.");
  return JSON.parse(text);
}

function objectHasKey(value, forbidden) {
  if (Array.isArray(value)) return value.some((item) => objectHasKey(item, forbidden));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => forbidden.has(key.toLowerCase()) || objectHasKey(item, forbidden));
}

async function main() {
  fs.cpSync(fixture, projectRoot, { recursive: true });
  run("docker", ["compose", "-f", compose, "up", "-d", "--wait", "postgres"], { inherit: true });
  const adminPool = new Pool({ connectionString: adminUrl, max: 1 });
  let exploreRuntime;
  let authoringServer;
  let authoringClient;
  let protectedRuntime;
  try {
    const before = await sourceSnapshot(adminPool);
    const project = await detectProjectContext(projectRoot, env);
    assert(project.frameworks.includes("nextjs") && project.frameworks.includes("prisma"), "Golden project detection missed Next.js or Prisma.", project);
    assert(project.schema_inputs.some((item) => item.kind === "prisma"), "Golden project detection missed the Prisma schema.", project);

    const inspection = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "DATABASE_URL",
      env,
    });
    assert(inspection.role_posture?.verified === true, "Reader role posture was not verified.", inspection.role_posture);
    assert(inspection.role_posture?.read_only === true, "Reader role was not demonstrably read-only.", inspection.role_posture);
    assert(inspection.role_posture?.superuser === false && inspection.role_posture?.bypass_rls === false, "Reader role can bypass the reviewed boundary.", inspection.role_posture);
    assert(inspection.tables.every((table) => table.role_posture?.current_role_is_owner === false), "Reader unexpectedly owns an inspected relation.");
    assert(inspection.tables.filter((table) => ["accounts", "churn_events"].includes(table.name))
      .every((table) => table.row_level_security === true && table.role_posture?.row_security_effective_for_current_role === true), "Forced RLS is not effective for the exact reader role.");

    const evidence = await loadStructuredProjectEvidence(project);
    const build = buildAutoBoundary({
      inspection,
      project,
      parsedEvidence: evidence.parsed,
      existingContracts: evidence.existingContracts,
      sourceEnv: "DATABASE_URL",
    });
    assert(build.dsl.includes("PRINCIPAL SCOPE KEY owner_id"), "Generated DSL lost reviewed principal scope.");
    assert(!build.dsl.match(/ALLOW READ[^\n]*(?:tenant_id|owner_id|customer_email|private_note)/), "Generated DSL exposed trusted or likely-sensitive fields.", build.dsl);
    await writeAutoBoundaryArtifacts({ projectRoot, build });

    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.name = "product_churn";
    candidate.budgets.max_rows = 20;
    candidate.budgets.max_groups = 12;
    candidate.budgets.max_top_n = 10;
    candidate.budgets.max_measures = 3;
    candidate.budgets.max_dimensions = 2;
    candidate.budgets.max_differencing_queries = 3;
    candidate.budgets.max_queries_per_session = 12;
    candidate.budgets.max_extracted_cells_per_session = 1000;
    candidate.pack.resources = candidate.pack.resources.filter((resource) =>
      resource.id === "public.accounts" || resource.id === "public.churn_events");
    const accounts = candidate.pack.resources.find((resource) => resource.id === "public.accounts");
    const events = candidate.pack.resources.find((resource) => resource.id === "public.churn_events");
    assert(accounts && events, "Auto Boundary did not draft both golden resources.");
    narrowResource(accounts, {
      selectable: ["region", "segment"],
      filterable: ["region", "segment"],
      sortable: ["region", "segment"],
      groupable: ["region", "segment"],
      measures: [],
      distinct: ["id"],
      time: [],
    });
    narrowResource(events, {
      selectable: ["reason_category", "monthly_revenue_cents", "churned_at"],
      filterable: ["reason_category", "monthly_revenue_cents", "churned_at"],
      sortable: ["reason_category", "monthly_revenue_cents", "churned_at"],
      groupable: ["reason_category"],
      measures: ["monthly_revenue_cents"],
      distinct: ["id"],
      time: ["churned_at"],
    });
    events.relationships = events.relationships.filter((relationship) =>
      relationship.id === "churn_events_account_id_fkey");
    assert(events.relationships.length === 1, "Reviewed one-hop foreign-key relationship was not generated.", events.relationships);
    assert(accounts.rls_session?.tenant_setting === "app.tenant_id"
      && accounts.rls_session?.principal_setting === "app.principal"
      && events.rls_session?.tenant_setting === "app.tenant_id"
      && events.rls_session?.principal_setting === "app.principal", "Reviewed RLS session bindings were not derived exactly.");

    const boundaryDigest = explorationBoundaryCandidateDigest(candidate);
    await activateExplorationBoundary({
      projectRoot,
      candidate,
      expectedDigest: boundaryDigest,
      actor: "golden-path-reviewer",
      confirmation: `ACTIVATE ${boundaryDigest}`,
      confirmedDecisions: candidate.unresolved_decisions,
      currentInspection: inspection,
    });

    exploreRuntime = await createScopedExploreRuntime({
      projectRoot,
      transport: "stdio",
      env,
    });
    authoringServer = createScopedExploreMcpServer(exploreRuntime);
    authoringClient = new Client({ name: "cursor-golden-path", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await authoringServer.connect(serverTransport);
    await authoringClient.connect(clientTransport);

    const tools = await authoringClient.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data", "Authoring MCP surface is not the exact two-tool reviewed surface.", tools.tools);
    const serializedTools = JSON.stringify(tools.tools);
    assert(tools.tools.every((tool) =>
      !tool.name.match(/execute_sql|query_sql|approve|apply|commit/i)
      && !objectHasKey(tool.inputSchema, new Set(["sql", "query_sql", "execute_sql", "tenant", "tenant_id", "principal", "approve", "apply", "commit"]))
      && tool._meta?.["synapsor.raw_sql_exposed"] === false
      && tool._meta?.["synapsor.approval_tool"] === false
      && tool._meta?.["synapsor.commit_tool"] === false), "Authoring MCP leaked SQL, trusted scope, or mutation authority.", tools.tools);

    const goldenPlan = {
      kind: "aggregate",
      resource: "public.churn_events",
      relationship: "churn_events_account_id_fkey",
      measures: [
        { function: "count_distinct", field: "id", relationship: "churn_events_account_id_fkey" },
        { function: "sum", field: "monthly_revenue_cents" },
        { function: "avg", field: "monthly_revenue_cents" },
      ],
      dimensions: [
        { field: "region", relationship: "churn_events_account_id_fkey" },
        { field: "reason_category" },
      ],
      time_bucket: { field: "churned_at", bucket: "week" },
      comparison: {
        field: "churned_at",
        ranges: [
          { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
          { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
        ],
      },
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const called = await authoringClient.callTool({
      name: "app.explore_data",
      arguments: { plan: goldenPlan },
    });
    assert(called.isError !== true, "Golden aggregate MCP call failed.", called);
    const explored = resultPayload(called);
    assert(explored.ok === true && explored.source_database_changed === false, "Golden aggregate did not remain read-only.", explored);
    assert(explored.privacy?.suppressed_groups === 2 && explored.privacy?.totals_returned === false, "Small cohorts were not safely suppressed.", explored);
    assert(Array.isArray(explored.data) && explored.data.length === 5, "Golden aggregate returned the wrong reviewed groups.", explored);
    const serializedResult = JSON.stringify(explored);
    assert(!serializedResult.match(/globex|other-west|@example\.invalid|private kept-out|synthetic kept-out/), "Golden aggregate leaked cross-tenant, identifier, or kept-out data.", explored);
    assert(serializedResult.includes('"measure_0":10') && serializedResult.includes('"measure_0":5'), "Golden result did not preserve the expected churn changes.", explored);

    for (const [plan, label] of [
      [{ ...goldenPlan, dimensions: [{ field: "customer_email", relationship: "churn_events_account_id_fkey" }] }, "kept-out dimension"],
      [{ ...goldenPlan, where: [{ field: "customer_email", op: "eq", value: "hidden@example.invalid", relationship: "churn_events_account_id_fkey" }] }, "kept-out filter"],
      [{ ...goldenPlan, tenant: "globex" }, "model-selected tenant"],
      [{ ...goldenPlan, principal: "other-principal" }, "model-selected principal"],
      [{ ...goldenPlan, relationship: "unreviewed_join" }, "unreviewed join"],
      [{ ...goldenPlan, relationship: "accounts_tags_many_to_many" }, "many-to-many or ambiguous-fan-out join"],
      [{ ...goldenPlan, dimensions: [{ field: "account_id" }] }, "unreviewed high-cardinality dimension"],
      [{ ...goldenPlan, top_n: 11 }, "top-N overflow"],
      [{ ...goldenPlan, measures: [...goldenPlan.measures, { function: "count" }] }, "measure-count overflow"],
      [{ ...goldenPlan, dimensions: [...goldenPlan.dimensions, { field: "churned_at" }] }, "dimension-count overflow"],
      [{ ...goldenPlan, time_bucket: { field: "churned_at", bucket: "quarter" } }, "unreviewed time bucket"],
      [{ ...goldenPlan, measures: [{ function: "median", field: "monthly_revenue_cents" }] }, "arbitrary aggregate function"],
      [{ ...goldenPlan, sql: "SELECT * FROM public.churn_events" }, "raw SQL field"],
      [{
        ...goldenPlan,
        comparison: {
          field: "churned_at",
          ranges: [
            ...goldenPlan.comparison.ranges,
            { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" },
          ],
        },
      }, "time-range overflow"],
    ]) {
      await expectRefusal(exploreRuntime, plan, label);
    }

    for (const reason of ["price", "service", "product"]) {
      const result = await exploreRuntime.explore({
        ...goldenPlan,
        where: [{ field: "reason_category", op: "eq", value: reason }],
      });
      assert(result.ok === true, `Reviewed differencing-budget query ${reason} failed unexpectedly.`, result);
    }
    await expectAsyncRefusal(
      () => exploreRuntime.explore({
        ...goldenPlan,
        where: [{ field: "reason_category", op: "eq", value: "support" }],
      }),
      "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
    );

    const protectToken = explored.protect?.token;
    assert(typeof protectToken === "string", "Golden exploration did not create bounded Protect state.", explored);
    const protectedDraft = await createProtectedQueryDraft({
      projectRoot,
      token: protectToken,
      capabilityName: "analytics.churn_contributors_by_week",
      description: "Compare reviewed churn-account cohorts by week, region, and reason.",
      returnsHint: "Returns privacy-suppressed descriptive groups; it does not establish causation.",
      arguments: [],
    });
    assert(protectedDraft.dsl.includes("PROTECTED READ AGGREGATE"), "Protect did not emit public aggregate DSL.", protectedDraft.dsl);
    assert(protectedDraft.dsl.includes("PROTECTED RELATIONSHIP churn_events_account_id_fkey"), "Protect lost the reviewed relationship.", protectedDraft.dsl);
    assert(protectedDraft.draft.state === "disabled", "Protected capability did not begin disabled.", protectedDraft.draft);

    const activation = await activateProtectedQuery({
      projectRoot,
      capabilityName: "analytics.churn_contributors_by_week",
      expectedDigest: protectedDraft.draft.contract_digest,
      confirmation: `ACTIVATE ${protectedDraft.draft.contract_digest}`,
      actor: "golden-path-reviewer",
      disableExplore: true,
      env,
    });
    assert(activation.state === "active" && activation.exploration_disabled === true, "Protected capability activation did not disable temporary Explore.", activation);
    await expectAsyncRefusal(() => prepareScopedExplore({ projectRoot, transport: "stdio", env }), "EXPLORE_DISABLED");

    const configPath = path.join(projectRoot, "synapsor.runner.json");
    const configText = fs.readFileSync(configPath, "utf8");
    assert(configText.includes('"mode": "postgres_rls"')
      && configText.includes('"tenant_setting": "app.tenant_id"')
      && configText.includes('"principal_setting": "app.principal"'), "Protected runtime config did not preserve reviewed RLS bindings.", configText);
    const runtimeConfig = loadRuntimeConfigFromFile(configPath);
    await preflightGeneratedAuthority(runtimeConfig, env);
    protectedRuntime = createMcpRuntime(runtimeConfig, {
      env,
      storePath: path.join(projectRoot, ".synapsor/protected.db"),
      resultFormat: 2,
    });
    assert(protectedRuntime.listTools().map((tool) => tool.name).join(",") === "analytics.churn_contributors_by_week", "Production runtime exposed anything except the protected named capability.", protectedRuntime.listTools());
    await expectAsyncRefusal(
      () => protectedRuntime.callTool("app.explore_data", { plan: goldenPlan }),
      "CAPABILITY_NOT_FOUND",
    );
    const protectedResult = await protectedRuntime.callTool("analytics.churn_contributors_by_week", {});
    assert(protectedResult.ok === true && protectedResult.source_database_changed === false, "Protected named capability failed after Explore shutdown.", protectedResult);
    assert(protectedResult.data?.suppression?.suppressed_groups === 2, "Protected named capability lost cohort suppression.", protectedResult);
    assert(!JSON.stringify(protectedResult).match(/globex|@example\.invalid|private kept-out|synthetic kept-out/), "Protected capability leaked cross-tenant or kept-out values.", protectedResult);

    const after = await sourceSnapshot(adminPool);
    assert(JSON.stringify(after) === JSON.stringify(before), "Scoped Explore or Protect mutated the source database.", { before, after });

    const report = {
      ok: true,
      stack: ["PostgreSQL", "Next.js", "Prisma", "Cursor-compatible MCP", "local Workbench"],
      boundary_digest: boundaryDigest,
      protected_contract_digest: protectedDraft.draft.contract_digest,
      tools: tools.tools.map((tool) => tool.name),
      tools_list_bytes: Buffer.byteLength(serializedTools, "utf8"),
      estimated_tools_list_tokens: Math.ceil(Buffer.byteLength(serializedTools, "utf8") / 4),
      returned_groups: explored.data.length,
      suppressed_groups: explored.privacy.suppressed_groups,
      source_database_changed: false,
      production_tools: protectedRuntime.listTools().map((tool) => tool.name),
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await authoringClient?.close().catch(() => undefined);
    await authoringServer?.close().catch(() => undefined);
    await exploreRuntime?.close().catch(() => undefined);
    await protectedRuntime?.close().catch(() => undefined);
    await adminPool.end().catch(() => undefined);
    if (process.env.SYNAPSOR_KEEP_AUTO_BOUNDARY_FIXTURE === "1") {
      process.stderr.write(`Preserved synthetic Auto Boundary fixture at ${projectRoot}\n`);
    } else {
      run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }
}

async function expectRefusal(runtime, plan, label) {
  try {
    await runtime.explore(plan);
    throw new Error(`${label} unexpectedly succeeded.`);
  } catch (error) {
    assert(typeof error?.code === "string" && error.code.startsWith("EXPLORE_"), `${label} did not fail through the scoped boundary.`, {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    });
  }
}

async function expectAsyncRefusal(action, code) {
  let caught;
  let result;
  try {
    result = await action();
  } catch (error) {
    caught = error;
  }
  const observed = caught?.code ?? result?.error?.code ?? result?.error_code ?? result?.runtime_code;
  assert(observed === code, `Expected ${code}, received ${observed ?? caught?.message ?? "success"}.`);
}

await main();
