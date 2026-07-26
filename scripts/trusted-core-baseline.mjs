import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const baselinePath = path.join(root, "development", "trusted-core-refactor-baseline.json");
const capture = process.argv.includes("--capture");

const declarationEntries = [
  "packages/proposal-store/dist/index.d.ts",
  "packages/mcp-server/dist/index.d.ts",
  "apps/runner/dist/cli.d.ts",
  "apps/runner/dist/runtime.d.ts",
  "apps/runner/dist/authoring.d.ts",
  "apps/runner/dist/shadow.d.ts",
];

function publicDeclarationSurface() {
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(path.join(root, "tsconfig.base.json"), ts.sys.readFile).config,
    ts.sys,
    root,
    {
      declaration: false,
      declarationMap: false,
      noEmit: true,
      skipLibCheck: false,
    },
  );
  const entries = declarationEntries.map((entry) => path.join(root, entry));
  const program = ts.createProgram({ rootNames: entries, options: config.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }));
  }
  const checker = program.getTypeChecker();
  return Object.fromEntries(declarationEntries.map((entry, index) => {
    const source = program.getSourceFile(entries[index]);
    if (!source) throw new Error(`Declaration entry was not loaded: ${entry}`);
    const moduleSymbol = checker.getSymbolAtLocation(source);
    if (!moduleSymbol) throw new Error(`Declaration entry has no module symbol: ${entry}`);
    const symbols = checker.getExportsOfModule(moduleSymbol)
      .map((symbol) => {
        const target = symbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(symbol)
          : symbol;
        const declaration = target.valueDeclaration ?? target.declarations?.[0];
        const hasValue = (target.flags & ts.SymbolFlags.Value) !== 0;
        const hasType = (target.flags & ts.SymbolFlags.Type) !== 0;
        const valueSignature = hasValue && declaration
          ? checker.typeToString(
              checker.getTypeOfSymbolAtLocation(target, declaration),
              declaration,
              ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
            )
          : undefined;
        return {
          name: symbol.name,
          kind: `${hasType ? "type" : ""}${hasType && hasValue ? "+" : ""}${hasValue ? "value" : ""}` || "namespace",
          ...(valueSignature ? { value_signature: valueSignature } : {}),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return [entry, symbols];
  }));
}

function cliHelp() {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "apps", "runner", "dist", "runner.mjs"), "--help"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SYNAPSOR_RUNNER_COMMAND_NAME: "synapsor-runner",
      },
    },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result.stdout;
}

function packageSurface() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "apps", "runner", "package.json"), "utf8"));
  return JSON.parse(JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    type: manifest.type,
    engines: manifest.engines,
    bin: manifest.bin,
    exports: manifest.exports,
    files: manifest.files,
    dependencies: manifest.dependencies,
    optionalDependencies: manifest.optionalDependencies,
    peerDependencies: manifest.peerDependencies,
  }));
}

function aggregateCapability() {
  return {
    name: "analytics.churn_by_week",
    kind: "aggregate_read",
    source: "local_postgres",
    target: {
      schema: "public",
      table: "subscriptions",
      primary_key: "id",
      tenant_key: "tenant_id",
      principal_scope_key: "owner_id",
    },
    args: {
      period_start: { type: "string", required: true, max_length: 32 },
      period_end: { type: "string", required: true, max_length: 32 },
    },
    lookup: { id_from_arg: "unused" },
    visible_columns: [],
    kept_out_fields: ["customer_id", "email"],
    protected_read: {
      version: "1",
      mode: "aggregate",
      boundary_digest: `sha256:${"a".repeat(64)}`,
      generation_lock_fingerprint: `sha256:${"b".repeat(64)}`,
      predicates: [{ field: "status", operator: "eq", value: { fixed: "churned" } }],
      aggregate: {
        counted_entity: "subject",
        measures: [{ name: "churned_accounts", function: "count" }],
        dimensions: [{ name: "region", field: "region" }],
        time_bucket: { name: "churn_week", field: "churned_at", bucket: "week" },
        comparison: {
          field: "churned_at",
          ranges: [{
            start: { from_arg: "period_start" },
            end: { from_arg: "period_end" },
          }],
        },
        order_by: { kind: "measure", measure: "churned_accounts", direction: "desc" },
        top_n: 10,
        minimum_group_size: 5,
      },
      limits: {
        max_rows: 20,
        max_groups: 20,
        max_response_cells: 200,
        max_response_bytes: 32_000,
        statement_timeout_ms: 3_000,
        max_queries_per_session: 20,
        max_extracted_cells_per_session: 2_000,
        max_differencing_queries: 4,
        rate_limit_per_minute: 20,
      },
    },
    contract_provenance: { digest: `sha256:${"a".repeat(64)}`, version: "1.5.0" },
  };
}

function fixtureChangeSet() {
  return {
    schema_version: "synapsor.change-set.v1",
    proposal_id: "wrp_trusted_core_baseline",
    proposal_version: 1,
    action: "billing.waive_late_fee",
    mode: "review_required",
    principal: { id: "fixture-principal", source: "trusted_session" },
    scope: { tenant_id: "fixture-tenant", business_object: "invoice", object_id: "INV-FIXTURE" },
    source: {
      kind: "external_postgres",
      source_id: "src_fixture",
      schema: "public",
      table: "invoices",
      primary_key: { column: "id", value: "INV-FIXTURE" },
    },
    before: { late_fee_cents: 5500, waiver_reason: null, updated_at: "2026-01-01T00:00:00Z" },
    patch: { late_fee_cents: 0, waiver_reason: "reviewed fixture" },
    after: { late_fee_cents: 0, waiver_reason: "reviewed fixture", updated_at: "2026-01-01T00:00:00Z" },
    guards: {
      tenant: { column: "tenant_id", value: "fixture-tenant" },
      allowed_columns: ["late_fee_cents", "waiver_reason"],
      expected_version: { column: "updated_at", value: "2026-01-01T00:00:00Z" },
    },
    evidence: { bundle_id: "ev_fixture", query_fingerprint: "sha256:fixture-query", items: [] },
    approval: { status: "pending", required_role: "support_lead" },
    writeback: { status: "not_applied", mode: "trusted_worker_required" },
    source_database_mutated: false,
    integrity: { proposal_hash: "sha256:fixture-proposal" },
    created_at: "2026-01-01T00:00:01Z",
  };
}

async function runtimeBehavior() {
  const mcp = await import(pathToFileURL(path.join(root, "packages", "mcp-server", "dist", "index.js")));
  const proposalStore = await import(pathToFileURL(path.join(root, "packages", "proposal-store", "dist", "index.js")));
  const protocol = await import(pathToFileURL(path.join(root, "packages", "protocol", "dist", "index.js")));
  const spec = await import(pathToFileURL(path.join(root, "packages", "spec", "dist", "index.js")));

  const exampleDir = path.join(root, "examples", "support-plan-credit");
  const config = JSON.parse(fs.readFileSync(path.join(exampleDir, "synapsor.runner.json"), "utf8"));
  const resolved = mcp.resolveRuntimeConfig(config, exampleDir);
  resolved.storage = { sqlite_path: ":memory:" };
  const runtime = mcp.createMcpRuntime(resolved, {
    storePath: ":memory:",
    readRow: async () => null,
  });
  const toolCatalog = runtime.listTools();
  await runtime.close();

  const query = mcp.buildProtectedReadQuery(
    aggregateCapability(),
    "$",
    {
      period_start: "2026-07-01T00:00:00.000Z",
      period_end: "2026-08-01T00:00:00.000Z",
    },
    {
      tenant_id: "fixture-tenant",
      principal: "fixture-principal",
      provenance: "environment",
    },
  );

  const store = new proposalStore.ProposalStore(":memory:");
  try {
    const created = store.createProposal(fixtureChangeSet());
    const approval = store.approveProposalByPolicy(created.proposal_id, {
      policy: "fixture_auto_policy",
      proposal_hash: created.proposal_hash,
      proposal_version: created.proposal_version,
      reason: "fixture within reviewed policy",
    });
    const events = store.events(created.proposal_id);
    const attention = store.listAttentionItems({ proposal_id: created.proposal_id });
    const ledger = {
      created: {
        proposal_id: created.proposal_id,
        state: "pending_review",
        source_database_mutated: created.source_database_mutated,
      },
      approved: {
        approved: approval.approved,
        state: approval.proposal.state,
        policy: approval.policy,
      },
      events: events.map((event) => ({ kind: event.kind, actor: event.actor })),
      attention: attention.map((item) => ({
        event_type: item.event_type,
        severity: item.severity,
        status: item.status,
        occurrence_count: item.occurrence_count,
      })),
      approvals: store.approvals(created.proposal_id).map((item) => ({
        status: item.status,
        approver: item.approver,
        proposal_hash: item.proposal_hash,
      })),
    };

    const contract = spec.normalizeContract(
      JSON.parse(fs.readFileSync(path.join(exampleDir, "synapsor.contract.json"), "utf8")),
    );
    return {
      tool_catalog: toolCatalog,
      protected_read_query: query,
      canonical_contract_digest: protocol.canonicalJsonDigest(contract),
      shared_postgres_migration: proposalStore.sharedPostgresRuntimeStoreMigration("synapsor_runner"),
      ledger,
    };
  } finally {
    store.close();
  }
}

async function snapshot() {
  return {
    schema_version: 1,
    versions: {
      runner: JSON.parse(fs.readFileSync(path.join(root, "apps", "runner", "package.json"), "utf8")).version,
      spec: JSON.parse(fs.readFileSync(path.join(root, "packages", "spec", "package.json"), "utf8")).version,
      dsl: JSON.parse(fs.readFileSync(path.join(root, "packages", "dsl", "package.json"), "utf8")).version,
    },
    public_declarations: publicDeclarationSurface(),
    package_surface: packageSurface(),
    cli_help: cliHelp(),
    runtime_behavior: await runtimeBehavior(),
  };
}

const current = await snapshot();
if (capture) {
  fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`Captured trusted-core baseline: ${path.relative(root, baselinePath)}\n`);
} else {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  assert.deepEqual(current, baseline);
  process.stdout.write("Trusted-core baseline verification passed.\n");
}
