import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Pool } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-fitflow-"));
const packRoot = path.join(tempRoot, "pack");
const installRoot = path.join(tempRoot, "install");
const analyticsRoot = path.join(tempRoot, "fitflow-analytics");
const trainerRoot = path.join(tempRoot, "fitflow-trainer");
const resultPath = path.join(root, "development", "runner-1.6.3-fitflow-results.json");
const readUrl = "postgresql://fitflow_analytics_reader:fitflow_analytics_reader_password@127.0.0.1:55463/fitflow";
const trainerUrl = "postgresql://fitflow_trainer_reader:fitflow_trainer_reader_password@127.0.0.1:55463/fitflow";
const writerUrl = "postgresql://fitflow_writer:fitflow_writer_password@127.0.0.1:55463/fitflow";
const adminUrl = "postgresql://fitflow_admin:fitflow_admin_password@127.0.0.1:55463/fitflow";
const sharedEnv = {
  ...process.env,
  SYNAPSOR_TENANT_ID: "org-fitflow",
  SYNAPSOR_PRINCIPAL: "trainer-alex",
  SYNAPSOR_OPERATOR_ID: "fitflow-reviewer@example.test",
};

let compose;
let adminPool;
let analyticsUi;
let trainerUi;
let oidcFixture;
const timing = {};
const interactions = {
  shell_commands_in_human_golden_path_through_first_proposal: 1,
  workbench_primary_actions: 11,
  distinct_human_authority_decisions: 4,
  manual_file_edits: 0,
  external_documentation_consulted: false,
};

try {
  await fsp.mkdir(packRoot);
  await fsp.mkdir(installRoot);
  run("corepack", ["pnpm", "build:runner-package"], { cwd: root });
  const specTarball = packCurrent(packRoot, path.join(root, "packages", "spec"));
  const runnerTarball = packCurrent(packRoot, path.join(root, "apps", "runner"));
  run("npm", ["init", "-y"], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", specTarball], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", runnerTarball], { cwd: installRoot });

  const packageRoot = path.join(installRoot, "node_modules", "@synapsor", "runner");
  const packagedFixture = path.join(packageRoot, "examples", "fitflow-guided-onboarding");
  const packagedOidcIssuer = path.join(packageRoot, "examples", "operator-oidc", "issuer.mjs");
  const packagedOidcGuide = path.join(packageRoot, "docs", "approval-roles-and-operator-identity.md");
  const cli = path.join(installRoot, "node_modules", ".bin", "synapsor-runner");
  assert.ok(fs.existsSync(path.join(packagedFixture, "prisma", "schema.prisma")), "packed Runner omitted FitFlow Prisma");
  assert.ok(fs.existsSync(path.join(packageRoot, "docs", "agent-guided-setup.md")), "packed Runner omitted agent-guided setup");
  assert.ok(fs.existsSync(packagedOidcIssuer), "packed Runner omitted the local OIDC/JWKS fixture");
  assert.ok(fs.existsSync(packagedOidcGuide), "packed Runner omitted the approval-role identity guide");
  await verifyPackedJsonOutput(cli, path.join(tempRoot, "json-output"));
  const documentedOperatorIdentity = readDocumentedOidcOperatorConfig(packagedOidcGuide);
  await fsp.cp(packagedFixture, analyticsRoot, { recursive: true });
  await fsp.cp(packagedFixture, trainerRoot, { recursive: true });
  compose = path.join(analyticsRoot, "docker-compose.yml");
  // The Postgres image owns an anonymous data volume. Remove any prior
  // synthetic fixture state so repeated verifier runs always start from seed.
  run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], {
    cwd: analyticsRoot,
    allowFailure: true,
  });
  run("docker", ["compose", "-f", compose, "up", "-d", "--wait", "postgres"], {
    cwd: analyticsRoot,
    inherit: true,
  });
  adminPool = new Pool({ connectionString: adminUrl, max: 1 });
  const initialSource = await sourceSnapshot(adminPool);

  const analyticsEnv = { ...sharedEnv, DATABASE_URL: readUrl };
  const productStarted = Date.now();
  analyticsUi = await startPublicGuidedCommand({
    cli,
    projectRoot: analyticsRoot,
    env: analyticsEnv,
  });
  timing.schema_summary_ms = analyticsUi.readyAt - productStarted;
  assert.ok(timing.schema_summary_ms <= 60_000, `schema summary took ${timing.schema_summary_ms}ms`);
  assert.match(analyticsUi.output(), /Database connected|Existing Synapsor guided project found/);
  assert.match(analyticsUi.output(), /Next: Review what the agent can see/);
  assert.doesNotMatch(analyticsUi.output(), /fitflow_analytics_reader_password/);

  const beforeActivation = await sourceSnapshot(adminPool);
  assert.deepEqual(beforeActivation, initialSource, "fresh onboarding changed FitFlow before activation");
  const projectText = collectText(analyticsRoot, [
    ".synapsor",
    "synapsor",
    "synapsor.runner.json",
    ".env.example",
  ]);
  assert.doesNotMatch(
    projectText,
    /synthetic-card-token|Synthetic Street|synthetic private medical note|other-secret-payment/i,
    "metadata-only onboarding persisted source rows",
  );
  assert.doesNotMatch(projectText, /fitflow_analytics_reader_password|fitflow_admin_password/);
  for (const required of [
    "synapsor.runner.json",
    ".synapsor/guided-onboarding.json",
    ".synapsor/generation-lock.json",
    ".synapsor/local.db",
    "synapsor/generated/domain.synapsor.sql",
    "synapsor/generated/read-capabilities.synapsor.sql",
    "synapsor/generated/synapsor.candidate.contract.json",
  ]) {
    assert.ok(fs.existsSync(path.join(analyticsRoot, required)), `guided start omitted ${required}`);
  }
  const generatedClients = await verifyGeneratedMcpConfigs(analyticsRoot);

  const landing = await analyticsUi.html("/");
  assert.match(landing, /small set of database powers your agent may use/i);
  assert.match(landing, /does not give the agent SQL access/i);
  assert.match(landing, /Writes create proposals and cannot be approved or applied by the model/i);
  assert.match(landing, /Review security exceptions/);
  assert.match(landing, /Advanced permissions/);

  let boundaryPayload = await analyticsUi.json("GET", "/api/boundary");
  const inspectedResourceCount = boundaryPayload.candidate.pack.resources.length;
  assert.ok(
    inspectedResourceCount >= 30 && inspectedResourceCount <= 50,
    `FitFlow scale fixture exposed ${inspectedResourceCount} reviewed resources instead of 30-50`,
  );
  const memberReview = boundaryPayload.review.resources.find((resource) => resource.id === "public.members");
  assert.ok(memberReview, "FitFlow member sensitivity review is missing");
  for (const field of ["payment_method", "home_address", "medical_waiver_notes"]) {
    const classification = memberReview.fields.find((item) => item.name === field);
    assert.equal(classification?.sensitive_suggestion, true, `${field} was not kept out`);
    assert.equal(classification?.sensitivity.state, "high_confidence_sensitive", `${field} was not high-confidence sensitive`);
  }
  const memberDraft = boundaryPayload.candidate.pack.resources.find((resource) => resource.id === "public.members");
  assert.deepEqual(
    memberDraft.kept_out_fields.filter((field) =>
      ["payment_method", "home_address", "medical_waiver_notes"].includes(field)).sort(),
    ["home_address", "medical_waiver_notes", "payment_method"],
  );

  const analyticsCandidate = narrowAnalyticsBoundary(structuredClone(boundaryPayload.candidate));
  const preview = await analyticsUi.json("POST", "/api/boundary/preview", {
    candidate: analyticsCandidate,
  });
  await analyticsUi.json("POST", "/api/boundary/activate", {
    candidate: analyticsCandidate,
    expected_digest: preview.digest,
    actor: "fitflow-reviewer@example.test",
    confirmation: `ACTIVATE ${preview.digest}`,
    confirmed_decisions: analyticsCandidate.unresolved_decisions,
  });
  timing.boundary_activation_ms = Date.now() - productStarted;
  await analyticsUi.json("POST", "/api/explore/trusted-context", {
    tenant: "org-fitflow",
    principal: "trainer-alex",
  });
  const preflight = await analyticsUi.json("GET", "/api/explore/preflight");
  assert.equal(preflight.ready, true);
  assert.equal(preflight.source_database_changed, false);

  const noNamedTools = JSON.parse(run(cli, [
    "try", "call", "--list", "--format", "json",
  ], { cwd: analyticsRoot, env: analyticsEnv, allowFailure: true }).stdout);
  assert.deepEqual(noNamedTools.active_tools, [], "authoring-boundary activation silently activated named tools");

  const pmPlan = {
    kind: "aggregate",
    resource: "public.check_ins",
    relationship: "check_ins_location_id_fkey",
    measures: [{ function: "count_distinct", field: "id" }],
    dimensions: [
      { field: "name", relationship: "check_ins_location_id_fkey" },
      { field: "outcome" },
    ],
    time_bucket: { field: "checked_in_at", bucket: "week" },
    order_by: { kind: "time_bucket", direction: "asc" },
    top_n: 10,
  };

  const firstSafe = JSON.parse(run(cli, [
    "try", "explore", "--suggested", "--json",
  ], { cwd: analyticsRoot, env: analyticsEnv }).stdout);
  assert.equal(firstSafe.ok, true);
  assert.equal(firstSafe.authoring_only, true);
  assert.equal(firstSafe.source_database_changed, false);
  assert.ok(firstSafe.result.audit.returned_rows_or_groups >= 1);
  timing.first_safe_read_ms = Date.now() - productStarted;
  assert.ok(timing.first_safe_read_ms <= 180_000, `first safe read took ${timing.first_safe_read_ms}ms`);

  const workbenchAggregate = await analyticsUi.json("POST", "/api/explore/run", {
    plan: pmPlan,
  });
  assert.equal(workbenchAggregate.result.ok, true);
  assert.equal(workbenchAggregate.source_database_changed, false);

  let genericMcpAggregate;
  await withPackedMcp({
    cli,
    args: ["mcp", "serve", "--authoring", "--project-root", "."],
    cwd: analyticsRoot,
    env: analyticsEnv,
    name: "packed-fitflow-generic-stdio",
  }, async (client) => {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["app.describe_data", "app.explore_data"],
    );
    assert.equal(
      objectHasForbiddenKey(listed.tools.map((tool) => tool.inputSchema), new Set([
        "sql",
        "query_sql",
        "execute_sql",
        "tenant",
        "tenant_id",
        "principal",
        "approve",
        "apply",
        "commit",
      ])),
      false,
      "authoring MCP exposed model-controlled authority in its input schema",
    );
    const described = resultPayload(await client.callTool({
      name: "app.describe_data",
      arguments: { resource: "public.check_ins", limit: 1 },
    }));
    assert.equal(described.ok, true);
    assert.equal(described.boundary_digest, preview.digest);
    const called = await client.callTool({
      name: "app.explore_data",
      arguments: { plan: pmPlan },
    });
    assert.notEqual(called.isError, true, JSON.stringify(called));
    genericMcpAggregate = resultPayload(called);
  });

  const pmAggregate = JSON.parse(run(cli, [
    "try",
    "explore",
    "--resource",
    "public.check_ins",
    "--count-distinct",
    "id",
    "--group-by",
    "name@check_ins_location_id_fkey",
    "--group-by",
    "outcome",
    "--time-bucket",
    "checked_in_at:week",
    "--top",
    "10",
    "--json",
  ], { cwd: analyticsRoot, env: analyticsEnv }).stdout);
  assert.equal(pmAggregate.ok, true);
  assert.equal(pmAggregate.result.privacy.suppressed_groups, 1);
  assert.equal(pmAggregate.result.audit.returned_rows_or_groups, 3);
  assert.deepEqual(
    comparableExploreResult(workbenchAggregate.result),
    comparableExploreResult(genericMcpAggregate),
    "Workbench and generic stdio returned different results for the same reviewed plan",
  );
  assert.deepEqual(
    comparableExploreResult(pmAggregate.result),
    comparableExploreResult(genericMcpAggregate),
    "CLI Try and generic stdio returned different results for the same reviewed plan",
  );
  assert.doesNotMatch(
    JSON.stringify(pmAggregate),
    /member-00|synthetic-card-token|Synthetic Street|medical note|org-other|Other Downtown/i,
  );
  timing.pm_aggregate_ms = Date.now() - productStarted;
  assert.ok(timing.pm_aggregate_ms <= 300_000, `PM aggregate took ${timing.pm_aggregate_ms}ms`);

  const protectedDraft = JSON.parse(run(cli, [
    "try",
    "protect",
    "--name",
    "analytics.weekly_location_attendance",
    "--description",
    "Return reviewed weekly attendance cohorts by location and outcome.",
    "--json",
  ], { cwd: analyticsRoot, env: analyticsEnv }).stdout);
  assert.equal(protectedDraft.state, "disabled");
  assert.equal(protectedDraft.model_can_activate, false);
  assert.equal(protectedDraft.source_database_changed, false);
  assert.match(await fsp.readFile(path.resolve(analyticsRoot, protectedDraft.dsl_path), "utf8"), /CREATE CAPABILITY analytics\.weekly_location_attendance/);
  await analyticsUi.json("POST", "/api/protect/activate", {
    capability_name: protectedDraft.capability,
    expected_digest: protectedDraft.contract_digest,
    confirmation: `ACTIVATE ${protectedDraft.contract_digest}`,
    actor: "fitflow-reviewer@example.test",
    disable_explore: true,
  });
  timing.protected_capability_ms = Date.now() - productStarted;
  assert.ok(timing.protected_capability_ms <= 480_000, `Protect took ${timing.protected_capability_ms}ms`);
  assert.equal(fs.existsSync(path.join(analyticsRoot, ".synapsor", "exploration-boundary.active.json")), false);

  const activeTools = JSON.parse(run(cli, [
    "try", "call", "--list", "--format", "json",
  ], { cwd: analyticsRoot, env: analyticsEnv }).stdout);
  assert.deepEqual(activeTools.active_tools, ["analytics.weekly_location_attendance"]);
  assert.equal(activeTools.model_can_activate, false);
  assert.equal(activeTools.model_can_approve, false);
  assert.equal(activeTools.model_can_apply, false);
  assert.doesNotMatch(JSON.stringify(activeTools.active_tools), /app\.explore_data|execute_sql|approve|apply|commit/i);
  const protectedCall = JSON.parse(run(cli, [
    "try", "call", "analytics.weekly_location_attendance", "--sample", "--json",
  ], { cwd: analyticsRoot, env: analyticsEnv }).stdout);
  assert.equal(protectedCall.ok, true);
  assert.equal(protectedCall.source_database_changed, false);
  const smokeCall = JSON.parse(run(cli, [
    "smoke", "call", "analytics.weekly_location_attendance", "--json", "{}",
  ], { cwd: analyticsRoot, env: analyticsEnv }).stdout);
  assert.equal(smokeCall.ok, true);
  assert.equal(smokeCall.result.source_database_changed, false);

  const beforeResume = await stableProjectDigests(analyticsRoot);
  await analyticsUi.close();
  analyticsUi = await startPublicGuidedCommand({
    cli,
    projectRoot: analyticsRoot,
    env: analyticsEnv,
  });
  assert.match(analyticsUi.output(), /Existing Synapsor guided project found/);
  assert.match(analyticsUi.output(), /No schema inspection, digest change, or file rewrite was performed/);
  const afterResume = await stableProjectDigests(analyticsRoot);
  assert.deepEqual(afterResume, beforeResume, "resume rewrote a reviewed project");

  const trainerEnv = {
    ...sharedEnv,
    DATABASE_URL: trainerUrl,
    SYNAPSOR_DATABASE_WRITE_URL: writerUrl,
  };
  trainerUi = await startPublicGuidedCommand({
    cli,
    projectRoot: trainerRoot,
    env: trainerEnv,
  });
  await trainerUi.json("POST", "/api/boundary/regenerate", {
    kind: "principal_key",
    resource_id: "public.members",
    value: "assigned_trainer_id",
    actor: "fitflow-reviewer@example.test",
    reason: "Each trainer may inspect and propose changes only for assigned members.",
  });
  boundaryPayload = await trainerUi.json("GET", "/api/boundary");
  const trainerCandidate = narrowTrainerBoundary(structuredClone(boundaryPayload.candidate));
  const trainerPreview = await trainerUi.json("POST", "/api/boundary/preview", {
    candidate: trainerCandidate,
  });
  await trainerUi.json("POST", "/api/boundary/activate", {
    candidate: trainerCandidate,
    expected_digest: trainerPreview.digest,
    actor: "fitflow-reviewer@example.test",
    confirmation: `ACTIVATE ${trainerPreview.digest}`,
    confirmed_decisions: trainerCandidate.unresolved_decisions,
  });
  await trainerUi.json("POST", "/api/explore/trusted-context", {
    tenant: "org-fitflow",
    principal: "trainer-alex",
  });

  const actionOptions = await trainerUi.json("GET", "/api/actions/guided");
  const members = actionOptions.options.resources.find((resource) => resource.id === "public.members");
  assert.equal(members.principal_key, "assigned_trainer_id");
  assert.equal(members.operation_availability.update.available, true);
  const actionDraft = await trainerUi.json("POST", "/api/actions/guided/draft", {
    action: {
      capability_name: "membership.set_loyalty_balance",
      description: "Propose a reviewed loyalty balance for one assigned member.",
      resource: "public.members",
      operation: "update",
      conflict_column: "version",
      version_advance: "integer_increment",
      approval_role: "membership_reviewer",
      receipt_mode: "runner_ledger",
      auto_approval: {
        field: "loyalty_balance",
        maximum: 20,
        max_per_day: 2,
        max_total_per_day: 40,
      },
      supervised_worker_execution: true,
      patches: [{
        column: "loyalty_balance",
        value_source: "argument",
        argument_name: "loyalty_balance",
        minimum: 0,
        maximum: 500,
      }],
      confirmed_trusted_scope: true,
    },
  });
  assert.equal(actionDraft.draft.state, "disabled");
  assert.equal(actionDraft.source_database_changed, false);
  assert.equal(actionDraft.draft.supervised_worker_execution, true);
  assert.match(actionDraft.dsl, /ALLOW SUPERVISED WORKER APPLY/);
  const actionReadClause = actionDraft.dsl.match(/^ALLOW READ (.+)$/m)?.[1] ?? "";
  const actionWriteClause = actionDraft.dsl.match(/^ALLOW WRITE (.+)$/m)?.[1] ?? "";
  const actionKeepOutClause = actionDraft.dsl.match(/^KEEP OUT (.+)$/m)?.[1] ?? "";
  for (const field of ["payment_method", "home_address", "medical_waiver_notes"]) {
    assert.doesNotMatch(actionReadClause, new RegExp(`\\b${field}\\b`), `${field} leaked into ALLOW READ`);
    assert.doesNotMatch(actionWriteClause, new RegExp(`\\b${field}\\b`), `${field} leaked into ALLOW WRITE`);
    assert.match(actionKeepOutClause, new RegExp(`\\b${field}\\b`), `${field} was not explicitly kept out`);
  }
  const actionProposal = await trainerUi.json("POST", "/api/actions/guided/preview", {
    capability_name: "membership.set_loyalty_balance",
    args: { member_id: "member-002", loyalty_balance: 25 },
  });
  assert.equal(actionProposal.source_database_changed, false);
  assert.equal(actionProposal.model_can_approve, false);
  assert.equal(actionProposal.model_can_apply, false);
  assert.match(actionProposal.message, /Proposal created/);
  await trainerUi.json("POST", "/api/actions/guided/activate", {
    capability_name: "membership.set_loyalty_balance",
    expected_digest: actionDraft.draft.contract_digest,
    confirmation: `ACTIVATE ${actionDraft.draft.contract_digest}`,
    actor: "fitflow-reviewer@example.test",
  });
  timing.first_guided_proposal_ms = Date.now() - productStarted;
  assert.ok(timing.first_guided_proposal_ms <= 600_000, `first guided proposal took ${timing.first_guided_proposal_ms}ms`);

  oidcFixture = await startOidcFixture(packagedOidcIssuer);
  assert.equal(oidcFixture.metadata.issuer, documentedOperatorIdentity.issuer);
  assert.equal(oidcFixture.metadata.audience, documentedOperatorIdentity.audience);
  assert.equal(oidcFixture.metadata.approval_role, "membership_reviewer");
  assert.ok(documentedOperatorIdentity.apply_roles.includes(oidcFixture.metadata.apply_role));
  await configureOperatorIdentity(trainerRoot, documentedOperatorIdentity);
  const oidcEnv = {
    ...trainerEnv,
    SYNAPSOR_OPERATOR_JWKS_URL: oidcFixture.metadata.jwks_url,
    SYNAPSOR_OPERATOR_ATTESTATION_SECRET: "fitflow-operator-attestation-key-material-32-bytes",
  };
  run(cli, ["config", "validate", "--config", "./synapsor.runner.json"], {
    cwd: trainerRoot,
    env: oidcEnv,
  });
  await trainerUi.close();
  trainerUi = await startPublicGuidedCommand({
    cli,
    projectRoot: trainerRoot,
    env: oidcEnv,
  });
  assert.match(trainerUi.output(), /Existing Synapsor guided project found/);
  assert.match(trainerUi.output(), /No schema inspection, digest change, or file rewrite was performed/);

  const liveWriteback = await proveLiveWriteback({
    cli,
    projectRoot: trainerRoot,
    env: oidcEnv,
    ui: trainerUi,
    adminPool,
    firstProposalId: actionProposal.preview.proposal_id,
    supervisedContractDigest: actionDraft.draft.contract_digest,
    oidc: oidcFixture,
  });
  timing.first_guarded_apply_ms = Date.now() - productStarted;
  assert.ok(timing.first_guarded_apply_ms <= 1_200_000, `first guarded apply took ${timing.first_guarded_apply_ms}ms`);

  const finalSource = await sourceSnapshot(adminPool);
  assert.equal(finalSource.members, initialSource.members, "guided writeback changed the member count");
  assert.equal(finalSource.check_ins, initialSource.check_ins, "guided writeback changed the check-in count");
  assert.notEqual(finalSource.member_digest, initialSource.member_digest, "guarded FitFlow writes never reached the source");
  const report = {
    ok: true,
    package: "@synapsor/runner",
    fixture: "FitFlow",
    inspected_resources: inspectedResourceCount,
    packed_artifact: true,
    public_first_command: "npx -y @synapsor/runner@latest start --from-env DATABASE_URL",
    measured_clock_excludes: ["package download", "database startup"],
    timing,
    interactions,
    clients: {
      generated: generatedClients,
      workbench_same_authority: true,
      generic_stdio_same_authority: true,
      cli_try_same_authority: true,
    },
    live_writeback: liveWriteback,
    authority: {
      organization_analytics_pack: true,
      trainer_member_pack: true,
      raw_sql: false,
      model_activation: false,
      model_approval: false,
      model_apply: false,
      source_database_changed: false,
    },
    comprehension_check: [
      "no raw SQL",
      "reviewed fields and trusted tenant/principal scope",
      "writes create proposals",
      "the model cannot activate, approve, or apply",
    ],
  };
  await fsp.writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await analyticsUi?.close().catch(() => undefined);
  await trainerUi?.close().catch(() => undefined);
  await oidcFixture?.close().catch(() => undefined);
  await adminPool?.end().catch(() => undefined);
  if (compose && process.env.SYNAPSOR_KEEP_FITFLOW_FIXTURE !== "1") {
    run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], {
      cwd: analyticsRoot,
      allowFailure: true,
    });
  }
  if (process.env.SYNAPSOR_KEEP_FITFLOW_FIXTURE === "1") {
    process.stderr.write(`Preserved packed FitFlow fixture at ${tempRoot}\n`);
  } else {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

function narrowAnalyticsBoundary(candidate) {
  candidate.pack.name = "fitflow_organization_analytics";
  candidate.budgets.max_rows = 20;
  candidate.budgets.max_groups = 12;
  candidate.budgets.max_top_n = 10;
  candidate.budgets.max_measures = 3;
  candidate.budgets.max_dimensions = 2;
  candidate.budgets.max_differencing_queries = 6;
  candidate.pack.resources = candidate.pack.resources.filter((resource) =>
    resource.id === "public.check_ins" || resource.id === "public.locations");
  const checkIns = requiredResource(candidate, "public.check_ins");
  const locations = requiredResource(candidate, "public.locations");
  narrowResource(checkIns, {
    selectable: ["outcome", "checked_in_at"],
    filterable: ["outcome", "checked_in_at"],
    sortable: ["outcome", "checked_in_at"],
    groupable: ["outcome"],
    measures: [],
    distinct: ["id"],
    time: ["checked_in_at"],
  });
  narrowResource(locations, {
    selectable: ["name", "region"],
    filterable: ["name", "region"],
    sortable: ["name", "region"],
    groupable: ["name", "region"],
    measures: [],
    distinct: ["id"],
    time: [],
  });
  checkIns.relationships = checkIns.relationships.filter((relationship) =>
    relationship.id === "check_ins_location_id_fkey");
  assert.equal(checkIns.relationships.length, 1, "location relationship was not reviewed");
  return candidate;
}

function narrowTrainerBoundary(candidate) {
  candidate.pack.name = "fitflow_trainer_members";
  candidate.pack.resources = candidate.pack.resources.filter((resource) =>
    resource.id === "public.members");
  const members = requiredResource(candidate, "public.members");
  assert.equal(members.principal_key, "assigned_trainer_id");
  narrowResource(members, {
    selectable: ["membership_status", "membership_tier", "loyalty_balance", "version"],
    filterable: ["membership_status", "membership_tier"],
    sortable: ["membership_status", "membership_tier"],
    groupable: ["membership_status", "membership_tier"],
    measures: ["loyalty_balance"],
    distinct: ["id"],
    time: [],
  });
  members.relationships = [];
  return candidate;
}

function requiredResource(candidate, id) {
  const resource = candidate.pack.resources.find((item) => item.id === id);
  assert.ok(resource, `Auto Boundary did not generate ${id}`);
  return resource;
}

function narrowResource(resource, fields) {
  resource.selectable_fields = resource.selectable_fields.filter((field) => fields.selectable.includes(field));
  resource.filterable_fields = Object.fromEntries(Object.entries(resource.filterable_fields)
    .filter(([field]) => fields.filterable.includes(field)));
  resource.sortable_fields = resource.sortable_fields.filter((field) => fields.sortable.includes(field));
  resource.groupable_fields = resource.groupable_fields.filter((field) => fields.groupable.includes(field));
  resource.aggregate_measures = resource.aggregate_measures.filter((field) => fields.measures.includes(field));
  resource.count_distinct_fields = resource.count_distinct_fields.filter((field) => fields.distinct.includes(field));
  resource.time_bucket_fields = Object.fromEntries(Object.entries(resource.time_bucket_fields)
    .filter(([field]) => fields.time.includes(field)));
}

async function proveLiveWriteback(input) {
  const setup = JSON.parse(run(input.cli, [
    "writeback", "setup", "--profile", "staging", "--json",
  ], { cwd: input.projectRoot, env: input.env }).stdout);
  assert.equal(setup.plan.receipt_mode, "runner_ledger");
  assert.equal(setup.plan.execution, "no_source_ddl");
  assert.deepEqual(setup.plan.source_objects, []);
  assert.deepEqual(setup.plan.writer_grants, []);
  assert.equal(setup.plan.source_database_changed, false);

  const firstBefore = await memberState(input.adminPool, "member-002");
  assert.deepEqual(firstBefore, {
    id: "member-002",
    membership_status: "active",
    loyalty_balance: 20,
    version: 1,
  });

  const tokenNames = [
    "reviewer",
    "applier",
    "missing_role",
    "similar_role",
    "bad_signature",
    "unknown_key",
    "expired",
    "not_yet_valid",
    "wrong_issuer",
    "wrong_audience",
    "unsafe_subject",
    "malformed_roles",
    "missing_expiry",
  ];
  const tokens = Object.fromEntries(await Promise.all(tokenNames.map(async (name) =>
    [name, await input.oidc.token(name)])));
  input.identity = {
    reviewerToken: tokens.reviewer,
    applierToken: tokens.applier,
    allTokens: Object.values(tokens),
  };

  const beforeDeniedIdentityAttempts = await sourceSnapshot(input.adminPool);
  for (const name of [
    "missing_role",
    "similar_role",
    "bad_signature",
    "unknown_key",
    "expired",
    "not_yet_valid",
    "wrong_issuer",
    "wrong_audience",
    "unsafe_subject",
    "malformed_roles",
    "missing_expiry",
  ]) {
    expectOidcApprovalDenied(input, input.firstProposalId, tokens[name], name);
  }
  expectOidcApprovalDenied(input, input.firstProposalId, tokens.reviewer, "short_attestation_secret", {
    SYNAPSOR_OPERATOR_ATTESTATION_SECRET: "too-short",
  });
  expectOidcApprovalDenied(input, input.firstProposalId, tokens.reviewer, "unavailable_jwks", {
    SYNAPSOR_OPERATOR_JWKS_URL: "http://127.0.0.1:1/jwks",
  });
  assert.deepEqual(
    await sourceSnapshot(input.adminPool),
    beforeDeniedIdentityAttempts,
    "rejected OIDC approval attempts changed the source",
  );

  const pendingDetail = proposalDetail(input, input.firstProposalId);
  const missingWorkbenchApprovalToken = await input.ui.jsonResponse(
    "POST",
    `/api/proposals/${encodeURIComponent(input.firstProposalId)}/approve`,
    {
      confirmation_step: "approval_only",
      confirm: `APPROVE ${pendingDetail.proposal.proposal_hash}`,
      reason: "This request deliberately omits the required OIDC token.",
    },
  );
  assert.equal(missingWorkbenchApprovalToken.response.status, 403);
  assert.equal(missingWorkbenchApprovalToken.payload.ok, false);
  assert.match(JSON.stringify(missingWorkbenchApprovalToken.payload), /fresh OIDC bearer token/i);
  assert.equal(proposalDetail(input, input.firstProposalId).proposal.state, "pending_review");
  assert.deepEqual(
    await sourceSnapshot(input.adminPool),
    beforeDeniedIdentityAttempts,
    "Workbench approval without an OIDC token changed the source",
  );

  const wrongRoleWorkbenchApproval = await input.ui.jsonResponse(
    "POST",
    `/api/proposals/${encodeURIComponent(input.firstProposalId)}/approve`,
    {
      confirmation_step: "approval_only",
      confirm: `APPROVE ${pendingDetail.proposal.proposal_hash}`,
      reason: "This request deliberately uses an identity without the required reviewer role.",
      identity_token: tokens.missing_role,
    },
  );
  assert.equal(wrongRoleWorkbenchApproval.response.status, 403);
  assert.equal(wrongRoleWorkbenchApproval.payload.ok, false);
  assertNoBearerToken(
    JSON.stringify(wrongRoleWorkbenchApproval.payload),
    input.identity.allTokens,
    "Workbench approval denial",
  );
  assert.equal(proposalDetail(input, input.firstProposalId).proposal.state, "pending_review");
  assert.deepEqual(
    await sourceSnapshot(input.adminPool),
    beforeDeniedIdentityAttempts,
    "Workbench approval with the wrong role changed the source",
  );

  const approved = await input.ui.json(
    "POST",
    `/api/proposals/${encodeURIComponent(input.firstProposalId)}/approve`,
    {
      confirmation_step: "approval_only",
      confirm: `APPROVE ${pendingDetail.proposal.proposal_hash}`,
      reason: "Exact FitFlow effect reviewed in the local Workbench.",
      identity_token: input.identity.reviewerToken,
    },
  );
  assert.equal(approved.proposal.state, "approved");
  assert.equal(approved.source_database_changed, false);
  const approvedDetail = proposalDetail(input, input.firstProposalId);
  const approvalReplay = replay(input, input.firstProposalId);
  const storedApproval = approvalReplay.approvals.find((item) => item.status === "approved");
  assert.ok(storedApproval, "verified OIDC approval was not present in replay");
  assert.deepEqual(storedApproval.identity.roles, ["membership_reviewer"]);
  assert.deepEqual(storedApproval.identity, {
    provider: "jwt_oidc",
    verified: true,
    subject: "reviewer@example.test",
    roles: ["membership_reviewer"],
    key_id: "fitflow-key-1",
    algorithm: "RS256",
    issuer: input.oidc.metadata.issuer,
    decision: {
      schema_version: "synapsor.operator-decision.v1",
      action: "approve",
      proposal_id: input.firstProposalId,
      proposal_version: approvedDetail.proposal.proposal_version,
      proposal_hash: approvedDetail.proposal.proposal_hash,
      subject: "reviewer@example.test",
      issued_at: storedApproval.identity.decision.issued_at,
      reason: "Exact FitFlow effect reviewed in the local Workbench.",
    },
    decision_hash: storedApproval.identity.decision_hash,
    signature: storedApproval.identity.signature,
    integrity_hash: storedApproval.identity.integrity_hash,
  });
  assert.match(storedApproval.identity.decision_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(typeof storedApproval.identity.signature, "string");
  assert.match(storedApproval.identity.integrity_hash, /^sha256:[a-f0-9]{64}$/);
  assertNoBearerToken(JSON.stringify(approvalReplay), input.identity.allTokens, "OIDC approval replay");

  const reviewerApply = run(input.cli, [
    "apply", input.firstProposalId, "--json",
  ], {
    cwd: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.reviewerToken),
    allowFailure: true,
  });
  assert.notEqual(reviewerApply.status, 0, "approval role unexpectedly granted apply authority");
  assert.match(`${reviewerApply.stdout}\n${reviewerApply.stderr}`, /lacks an apply role|writeback_operator/i);
  assert.deepEqual(await memberState(input.adminPool, "member-002"), firstBefore);

  const reviewerWorkbenchApply = await input.ui.jsonResponse(
    "POST",
    `/api/proposals/${encodeURIComponent(input.firstProposalId)}/apply`,
    {
      confirmation_step: "apply_only",
      confirm: `APPLY ${approvedDetail.proposal.proposal_hash}`,
      reason: "This request deliberately uses the reviewer-only identity.",
      identity_token: input.identity.reviewerToken,
    },
  );
  assert.equal(reviewerWorkbenchApply.response.status, 403);
  assert.equal(reviewerWorkbenchApply.payload.ok, false);
  assert.match(JSON.stringify(reviewerWorkbenchApply.payload), /apply role|writeback_operator/i);
  assertNoBearerToken(
    JSON.stringify(reviewerWorkbenchApply.payload),
    input.identity.allTokens,
    "Workbench apply denial",
  );
  assert.deepEqual(
    await memberState(input.adminPool, "member-002"),
    firstBefore,
    "Workbench reviewer-only apply changed the source",
  );

  await input.oidc.rotate();
  const applied = await input.ui.json(
    "POST",
    `/api/proposals/${encodeURIComponent(input.firstProposalId)}/apply`,
    {
      confirmation_step: "apply_only",
      confirm: `APPLY ${approvedDetail.proposal.proposal_hash}`,
      reason: "Commit the independently approved FitFlow effect.",
      identity_token: input.identity.applierToken,
    },
  );
  assert.equal(applied.proposal.state, "applied");
  assert.equal(applied.source_database_changed, true);
  assert.equal(applied.lifecycle.writeback.latest_outcome.status, "applied");
  assert.equal(applied.lifecycle.writeback.latest_outcome.rows_affected, 1);
  assert.deepEqual(await memberState(input.adminPool, "member-002"), {
    id: "member-002",
    membership_status: "active",
    loyalty_balance: 25,
    version: 2,
  });
  const afterFirstApply = await sourceSnapshot(input.adminPool);
  const duplicate = run(input.cli, [
    "apply", input.firstProposalId, "--json",
  ], {
    cwd: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.applierToken),
    allowFailure: true,
  });
  assert.notEqual(duplicate.status, 0, "terminal direct apply unexpectedly created another writeback attempt");
  assert.match(`${duplicate.stdout}\n${duplicate.stderr}`, /already applied|is applied|PROPOSAL_NOT_APPROVED/i);
  assert.deepEqual(await sourceSnapshot(input.adminPool), afterFirstApply, "terminal apply retry duplicated the source mutation");
  const firstReceipts = receiptList(input).filter((receipt) => receipt.proposal_id === input.firstProposalId);
  assert.equal(firstReceipts.length, 1);
  assert.equal(firstReceipts[0].status, "applied");
  const firstReplay = replay(input, input.firstProposalId);
  assert.equal(firstReplay.proposal.state, "applied");
  assert.equal(firstReplay.receipts.length, 1);

  const autoCall = callAction(input, "membership.set_loyalty_balance", {
    member_id: "member-004",
    loyalty_balance: 15,
  });
  const autoProposal = proposalDetail(input, autoCall.proposalId);
  assert.equal(autoProposal.proposal.state, "approved");
  assert.ok(autoProposal.events.some((event) => event.kind === "proposal_approved" && String(event.actor).startsWith("policy:")));
  const autoApplied = applyProposal(input, autoCall.proposalId);
  assert.equal(autoApplied.status, "applied");
  assert.deepEqual(await memberState(input.adminPool, "member-004"), {
    id: "member-004",
    membership_status: "active",
    loyalty_balance: 15,
    version: 2,
  });

  configureSupervisedWorker(input.projectRoot, input.supervisedContractDigest);
  run(input.cli, ["config", "validate", "--config", "./synapsor.runner.json"], {
    cwd: input.projectRoot,
    env: input.env,
  });

  const workerAutoCall = callAction(input, "membership.set_loyalty_balance", {
    member_id: "member-018",
    loyalty_balance: 12,
  });
  assert.equal(workerAutoCall.payload.result.proposal.state, "queued_for_trusted_execution");
  assert.equal(workerAutoCall.payload.result.proposal.approval_required, false);
  assert.equal(workerAutoCall.payload.result.proposal.approval.mode, "policy");
  assert.match(
    workerAutoCall.payload.result.proposal.next,
    /trusted writeback\/apply is still separate/i,
  );
  const workerAutoBefore = await memberState(input.adminPool, "member-018");
  const competing = await runCompetingSupervisedWorkers({
    cli: input.cli,
    projectRoot: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.applierToken),
  });
  assert.equal(competing.filter((result) => result.status === 0).length, 2);
  assert.deepEqual(await memberState(input.adminPool, "member-018"), {
    id: "member-018",
    membership_status: "active",
    loyalty_balance: 12,
    version: 2,
  });
  assert.notDeepEqual(await memberState(input.adminPool, "member-018"), workerAutoBefore);
  const workerAutoDetail = proposalDetail(input, workerAutoCall.proposalId);
  assert.equal(workerAutoDetail.proposal.state, "applied");
  assert.equal(
    workerAutoDetail.events.filter((event) => event.kind === "writeback_worker_claimed").length,
    1,
  );
  assert.equal(receiptList(input).filter((receipt) => receipt.proposal_id === workerAutoCall.proposalId).length, 1);

  const limitedCall = callAction(input, "membership.set_loyalty_balance", {
    member_id: "member-006",
    loyalty_balance: 10,
  });
  const limitedProposal = proposalDetail(input, limitedCall.proposalId);
  assert.equal(limitedProposal.proposal.state, "pending_review");
  assert.ok(
    limitedProposal.events.some((event) => event.kind === "policy_auto_approval_deferred"),
    "daily policy circuit did not record its human-review fallback",
  );
  assert.deepEqual(await memberState(input.adminPool, "member-006"), {
    id: "member-006",
    membership_status: "active",
    loyalty_balance: 60,
    version: 1,
  });

  const humanWorkerCall = callAction(input, "membership.set_loyalty_balance", {
    member_id: "member-020",
    loyalty_balance: 220,
  });
  approveProposal(input, humanWorkerCall.proposalId);
  runSupervisedWorker({
    cli: input.cli,
    projectRoot: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.applierToken),
    workerId: "fitflow-human-worker",
  });
  assert.deepEqual(await memberState(input.adminPool, "member-020"), {
    id: "member-020",
    membership_status: "active",
    loyalty_balance: 220,
    version: 2,
  });
  assert.equal(proposalDetail(input, humanWorkerCall.proposalId).proposal.state, "applied");

  const staleCall = callAction(input, "membership.set_loyalty_balance", {
    member_id: "member-022",
    loyalty_balance: 230,
  });
  approveProposal(input, staleCall.proposalId);
  await input.adminPool.query(`
    UPDATE public.members
    SET loyalty_balance = loyalty_balance + 1, version = version + 1
    WHERE id = 'member-022'
  `);
  runSupervisedWorker({
    cli: input.cli,
    projectRoot: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.applierToken),
    workerId: "fitflow-stale-worker",
  });
  const stale = proposalDetail(input, staleCall.proposalId);
  assert.equal(stale.proposal.state, "conflict");
  assert.ok(stale.events.some((event) =>
    event.kind === "writeback_worker_completed"
    && event.payload.outcome === "conflict"));
  assert.deepEqual(await memberState(input.adminPool, "member-022"), {
    id: "member-022",
    membership_status: "active",
    loyalty_balance: 221,
    version: 2,
  });

  const freezeDraft = await input.ui.json("POST", "/api/actions/guided/draft", {
    action: {
      capability_name: "membership.freeze_membership",
      description: "Propose freezing one assigned active membership.",
      resource: "public.members",
      operation: "update",
      conflict_column: "version",
      version_advance: "integer_increment",
      approval_role: "membership_reviewer",
      receipt_mode: "runner_ledger",
      reversible: true,
      patches: [{
        column: "membership_status",
        value_source: "fixed",
        fixed_value: "frozen",
        allowed_from: ["active"],
      }],
      confirmed_trusted_scope: true,
    },
  });
  assert.match(freezeDraft.dsl, /REVERSIBLE/);
  assert.doesNotMatch(freezeDraft.dsl, /AUTO APPROVE/);
  const freezePreview = await input.ui.json("POST", "/api/actions/guided/preview", {
    capability_name: "membership.freeze_membership",
    args: { member_id: "member-010" },
  });
  await input.ui.json("POST", "/api/actions/guided/activate", {
    capability_name: "membership.freeze_membership",
    expected_digest: freezeDraft.draft.contract_digest,
    confirmation: `ACTIVATE ${freezeDraft.draft.contract_digest}`,
    actor: "fitflow-reviewer@example.test",
  });
  const freezeProposalId = freezePreview.preview.proposal_id;
  approveProposal(input, freezeProposalId);
  const freezeApplied = applyProposal(input, freezeProposalId);
  assert.equal(freezeApplied.status, "applied");
  assert.deepEqual(await memberState(input.adminPool, "member-010"), {
    id: "member-010",
    membership_status: "frozen",
    loyalty_balance: 100,
    version: 2,
  });

  const revertProposal = JSON.parse(run(input.cli, [
    "revert",
    freezeProposalId,
    "--reason",
    "Restore the reviewed membership state after the test.",
    "--json",
  ], {
    cwd: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.reviewerToken),
  }).stdout);
  assert.equal(revertProposal.state, "pending_review");
  assert.equal(revertProposal.source_database_mutated, false);
  assert.equal(revertProposal.change_set.compensation.descriptor.forward_proposal_id, freezeProposalId);
  assert.equal((await memberState(input.adminPool, "member-010")).membership_status, "frozen");
  approveProposal(input, revertProposal.proposal_id);
  const reverted = applyProposal(input, revertProposal.proposal_id);
  assert.equal(reverted.status, "applied");
  assert.deepEqual(await memberState(input.adminPool, "member-010"), {
    id: "member-010",
    membership_status: "active",
    loyalty_balance: 100,
    version: 3,
  });
  const compensationReplay = replay(input, revertProposal.proposal_id);
  assert.equal(compensationReplay.proposal.state, "applied");
  assert.ok(compensationReplay.receipts.length >= 1);

  const tamperedCall = callAction(input, "membership.set_loyalty_balance", {
    member_id: "member-012",
    loyalty_balance: 130,
  });
  approveProposal(input, tamperedCall.proposalId);
  tamperApprovalProof(input.projectRoot, tamperedCall.proposalId);
  const tamperedBefore = await memberState(input.adminPool, "member-012");
  const tamperedApply = run(input.cli, [
    "apply", tamperedCall.proposalId, "--json",
  ], {
    cwd: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.applierToken),
    allowFailure: true,
  });
  assert.notEqual(tamperedApply.status, 0, "tampered OIDC approval proof was accepted");
  assert.match(`${tamperedApply.stdout}\n${tamperedApply.stderr}`, /attestation verification failed|integrity/i);
  assert.deepEqual(await memberState(input.adminPool, "member-012"), tamperedBefore);

  const replayTarget = callAction(input, "membership.set_loyalty_balance", {
    member_id: "member-016",
    loyalty_balance: 170,
  });
  approveProposal(input, replayTarget.proposalId);
  replayApprovalProof(
    input.projectRoot,
    input.firstProposalId,
    replayTarget.proposalId,
  );
  const replayTargetBefore = await memberState(input.adminPool, "member-016");
  const replayedApprovalApply = run(input.cli, [
    "apply", replayTarget.proposalId, "--json",
  ], {
    cwd: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.applierToken),
    allowFailure: true,
  });
  assert.notEqual(replayedApprovalApply.status, 0, "approval proof replayed onto a different proposal");
  assert.match(`${replayedApprovalApply.stdout}\n${replayedApprovalApply.stderr}`, /identity record failed integrity checks|proposal.*hash|proposal.*version/i);
  assert.deepEqual(await memberState(input.adminPool, "member-016"), replayTargetBefore);

  const appliedReplay = replay(input, input.firstProposalId);
  const applyAuthorization = appliedReplay.events.find((event) => event.kind === "writeback_authorized");
  assert.ok(applyAuthorization, "replay omitted the independent apply authorization event");
  assert.deepEqual(applyAuthorization.payload.identity, {
    provider: "jwt_oidc",
    verified: true,
    subject: "writeback@example.test",
    roles: ["writeback_operator"],
    key_id: "fitflow-key-2",
    algorithm: "RS256",
    decision_hash: applyAuthorization.payload.identity.decision_hash,
    integrity_hash: applyAuthorization.payload.identity.integrity_hash,
  });
  assert.ok(appliedReplay.receipts.length >= 1);
  const notificationProof = await provePackedNotifications(input);
  assertNoPersistedBearerTokens(input.projectRoot, input.identity.allTokens);

  return {
    runner_ledger_source_ddl: false,
    human_approved_apply: "applied",
    workbench_approval_and_apply: "separate_verified_oidc_decisions",
    terminal_retry_duplicate_mutations: 0,
    adapter_idempotency_covered_by_guarded_crud_gate: true,
    policy_auto_approval: "applied",
    policy_auto_approval_manual_execution: "applied",
    policy_auto_approval_supervised_execution: "applied_once_by_two_competing_workers",
    human_approval_supervised_execution: "applied",
    daily_policy_limit: "fell_back_to_human_review",
    stale_version: "supervised_worker_conflict",
    receipts_and_replay: "verified",
    compensation: "new_reviewed_proposal_applied",
    notifications: notificationProof,
    oidc_approval: {
      provider: "jwt_oidc",
      exact_role: "accepted",
      denied_cases: [
        "missing_role",
        "similar_role",
        "bad_signature",
        "unknown_key",
        "expired",
        "not_yet_valid",
        "wrong_issuer",
        "wrong_audience",
        "unsafe_subject",
        "malformed_roles",
        "missing_expiry",
        "short_attestation_secret",
        "unavailable_jwks",
      ],
      rejected_source_mutations: 0,
      bearer_tokens_persisted: 0,
      proposal_binding: "verified",
      tamper_detection: "verified",
      apply_role_separate: true,
      rotated_apply_key: "fitflow-key-2",
    },
  };
}

async function provePackedNotifications(input) {
  configurePackedNotifications(input.projectRoot);
  const notificationEnv = {
    ...input.env,
    SYNAPSOR_NOTIFY_WEBHOOK_URL: "https://169.254.169.254/latest/meta-data",
    SYNAPSOR_NOTIFY_SIGNING_SECRET: "fitflow-notification-signing-key-material-32-bytes",
  };
  run(input.cli, ["config", "validate", "--config", "./synapsor.runner.json"], {
    cwd: input.projectRoot,
    env: notificationEnv,
  });
  const before = await sourceSnapshot(input.adminPool);
  const competing = await runCompetingNotificationDispatchers({
    cli: input.cli,
    projectRoot: input.projectRoot,
    env: notificationEnv,
    sink: "packed_development",
  });
  const envelopes = competing.flatMap((result) => notificationEnvelopes(result.stdout));
  assert.ok(envelopes.length > 0, "packed dispatchers emitted no meaningful human-attention notification");
  assert.equal(
    new Set(envelopes.map((envelope) => envelope.id)).size,
    envelopes.length,
    "competing packed dispatchers delivered a duplicate CloudEvent id",
  );
  assert.ok(
    envelopes.some((envelope) => envelope.type === "ai.synapsor.proposal.review_required"),
    "packed notification proof omitted human review attention",
  );
  const attentionIds = envelopes
    .map((envelope) => envelope.data.attention_id)
    .filter((value) => typeof value === "string");
  assert.equal(
    new Set(attentionIds).size,
    attentionIds.length,
    "one coalesced attention item generated more than one immediate interruption",
  );
  for (const forbidden of [
    "ai.synapsor.proposal.created",
    "ai.synapsor.proposal.auto_approved",
    "ai.synapsor.proposal.approved",
    "ai.synapsor.proposal.queued",
    "ai.synapsor.proposal.applied",
    "ai.synapsor.worker.started",
    "ai.synapsor.worker.retry_scheduled",
  ]) {
    assert.equal(
      envelopes.some((envelope) => envelope.type === forbidden),
      false,
      `${forbidden} interrupted the operator under the quiet default`,
    );
  }
  const serialized = JSON.stringify(envelopes);
  for (const forbidden of [
    "fitflow_analytics_reader_password",
    "fitflow_trainer_reader_password",
    "fitflow_writer_password",
    "fitflow_admin_password",
    "org-fitflow",
    "trainer-alex",
    "synthetic-card-token",
    "Synthetic Street",
    "medical_waiver_notes",
    "SELECT ",
    "UPDATE ",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `notification payload leaked ${forbidden}`);
  }
  assertNoBearerToken(serialized, input.identity.allTokens, "packed notification envelopes");

  const quietRows = notificationStoreRows(input.projectRoot, `
    SELECT ae.event_type, nd.status
    FROM notification_deliveries nd
    JOIN attention_events ae ON ae.event_id = nd.event_id
    WHERE nd.sink_id = 'packed_development'
      AND ae.event_type IN (
        'proposal.auto_approved',
        'proposal.approved',
        'proposal.queued',
        'proposal.applied',
        'worker.started',
        'worker.retry_scheduled'
      )
  `);
  assert.ok(quietRows.length > 0, "packed quiet-default proof found no successful lifecycle events");
  assert.equal(
    quietRows.some((row) => row.status === "delivered" || row.status === "pending"),
    false,
    "normal successful activity was routed as an immediate external notification",
  );

  const secondPass = run(input.cli, [
    "notifications",
    "dispatch",
    "--sink",
    "packed_development",
    "--owner",
    "packed-dispatcher-after-race",
  ], {
    cwd: input.projectRoot,
    env: notificationEnv,
  });
  assert.equal(
    notificationEnvelopes(secondPass.stdout).length,
    0,
    "a second packed dispatch redelivered an already delivered attention event",
  );

  const synthetic = run(input.cli, [
    "notifications",
    "test",
    "--sink",
    "packed_development",
  ], {
    cwd: input.projectRoot,
    env: notificationEnv,
  });
  const [syntheticEnvelope] = notificationEnvelopes(synthetic.stdout);
  assert.equal(syntheticEnvelope?.data.details.synthetic_test, true);
  assert.equal(syntheticEnvelope?.data.details.source_database_changed, false);
  assert.doesNotMatch(JSON.stringify(syntheticEnvelope), /org-fitflow|trainer-alex|password|postgresql:\/\//i);

  const blocked = run(input.cli, [
    "notifications",
    "dispatch",
    "--sink",
    "blocked_metadata",
    "--owner",
    "packed-blocked-destination",
    "--limit",
    "1",
  ], {
    cwd: input.projectRoot,
    env: notificationEnv,
    allowFailure: true,
  });
  assert.equal(blocked.status, 3, `metadata webhook did not fail closed:\n${blocked.stdout}\n${blocked.stderr}`);
  const [deadLetter] = notificationStoreRows(input.projectRoot, `
    SELECT delivery_id, event_id, status, attempts, last_error_code
    FROM notification_deliveries
    WHERE sink_id = 'blocked_metadata' AND status = 'dead_letter'
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  assert.ok(deadLetter, "blocked metadata webhook did not create a durable dead letter");
  assert.equal(deadLetter.last_error_code, "NOTIFICATION_DESTINATION_BLOCKED");

  const replayReason = "Blocked destination removed after operator review";
  const replayed = JSON.parse(run(input.cli, [
    "notifications",
    "replay",
    "latest",
    "--yes",
    "--reason",
    replayReason,
    "--json",
  ], {
    cwd: input.projectRoot,
    env: operatorTokenEnv({ ...input, env: notificationEnv }, input.identity.reviewerToken),
  }).stdout);
  assert.equal(replayed.delivery.delivery_id, deadLetter.delivery_id);
  assert.equal(replayed.delivery.event_id, deadLetter.event_id);
  assert.equal(replayed.delivery.status, "pending");
  assert.equal(replayed.approval_replayed, false);
  assert.equal(replayed.mutation_replayed, false);
  assert.equal(replayed.source_database_changed, false);
  assert.deepEqual(replayed.operator, {
    subject: "reviewer@example.test",
    provider: "jwt_oidc",
    decision_hash: replayed.operator.decision_hash,
  });
  assert.match(replayed.operator.decision_hash, /^sha256:[a-f0-9]{64}$/);

  const [replayAudit] = notificationStoreRows(input.projectRoot, `
    SELECT event_type, details_json
    FROM attention_events
    WHERE event_type = 'notification.replayed'
    ORDER BY created_at DESC
    LIMIT 1
  `);
  assert.ok(replayAudit, "verified notification replay omitted its immutable audit event");
  assert.deepEqual(JSON.parse(replayAudit.details_json), {
    approval_replayed: false,
    delivery_id: deadLetter.delivery_id,
    identity_provider: "jwt_oidc",
    mutation_replayed: false,
    operator_decision_hash: replayed.operator.decision_hash,
    operator_subject: "reviewer@example.test",
    reason: replayReason,
    replayed_event_id: deadLetter.event_id,
    sink_id: "blocked_metadata",
    source_database_changed: false,
  });
  assert.deepEqual(
    await sourceSnapshot(input.adminPool),
    before,
    "notification dispatch or replay changed the FitFlow source database",
  );
  return {
    packed_artifact: true,
    competing_dispatchers: 2,
    unique_immediate_events: envelopes.length,
    review_attention_delivered: true,
    successful_activity_immediate_notifications: 0,
    duplicate_immediate_deliveries: 0,
    ssrf_metadata_destination: "blocked_and_dead_lettered",
    verified_operator_replay: "notification_only",
    source_database_changed: false,
  };
}

function configurePackedNotifications(projectRoot) {
  const configPath = path.join(projectRoot, "synapsor.runner.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.notifications = {
    enabled: true,
    sinks: [{
      id: "packed_development",
      type: "jsonl",
      destination: "stdout",
      minimum_severity: "warning",
      delivery: "immediate",
      max_attempts: 2,
      environments: ["staging"],
      budgets: {
        per_minute: 20,
        per_hour: 100,
        immediate_informational_per_hour: 0,
        aggregation_window_seconds: 300,
        cooldown_seconds: 300,
        max_unresolved_reminders: 0,
        digest_cadence_minutes: 1_440,
        escalation_delay_seconds: 60,
        retry_attempt_threshold: 3,
        degraded_duration_seconds: 60,
        queue_depth_threshold: 20,
        queue_age_seconds: 300,
      },
    }, {
      id: "blocked_metadata",
      type: "webhook",
      url_env: "SYNAPSOR_NOTIFY_WEBHOOK_URL",
      signing_secret_env: "SYNAPSOR_NOTIFY_SIGNING_SECRET",
      minimum_severity: "warning",
      events: ["proposal.review_required"],
      environments: ["staging"],
      delivery: "immediate",
      max_attempts: 1,
      timeout_ms: 1_000,
      max_response_bytes: 1_024,
      replay_window_seconds: 300,
    }],
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function runCompetingNotificationDispatchers(input) {
  const start = (owner) => new Promise((resolve, reject) => {
    const child = spawn(input.cli, [
      "notifications",
      "dispatch",
      "--sink",
      input.sink,
      "--owner",
      owner,
      "--limit",
      "100",
    ], {
      cwd: input.projectRoot,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`notification dispatcher ${owner} exceeded its bounded timeout`));
    }, 60_000);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ owner, status: status ?? -1, signal, stdout, stderr });
    });
  });
  const results = await Promise.all([
    start("packed-notification-a"),
    start("packed-notification-b"),
  ]);
  for (const result of results) {
    assert.equal(
      result.status,
      0,
      `${result.owner} failed (${result.signal ?? result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return results;
}

function notificationEnvelopes(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((value) =>
      value?.specversion === "1.0"
      && value?.data?.schema_version === "synapsor.notification.v1");
}

function notificationStoreRows(projectRoot, sql) {
  const database = new DatabaseSync(path.join(projectRoot, ".synapsor", "local.db"));
  try {
    return database.prepare(sql).all();
  } finally {
    database.close();
  }
}

function configureSupervisedWorker(projectRoot, contractDigest) {
  const configPath = path.join(projectRoot, "synapsor.runner.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.supervised_worker = {
    enabled: true,
    profile: "staging",
    capabilities: [{
      capability: "membership.set_loyalty_balance",
      contract_digest: contractDigest,
      mode: "supervised_worker",
      concurrency: 1,
      queue_limit: 20,
      lease_seconds: 30,
      max_attempts: 2,
      proposal_ttl_seconds: 3_600,
      rate_limit: {
        executions: 10,
        window_seconds: 60,
      },
      write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
    }],
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function runSupervisedWorker(input) {
  return run(input.cli, [
    "worker",
    "run",
    "--supervised",
    "--once",
    "--yes",
    "--worker-id",
    input.workerId,
  ], {
    cwd: input.projectRoot,
    env: input.env,
  });
}

async function runCompetingSupervisedWorkers(input) {
  const start = (workerId) => new Promise((resolve, reject) => {
    const child = spawn(input.cli, [
      "worker",
      "run",
      "--supervised",
      "--once",
      "--yes",
      "--worker-id",
      workerId,
    ], {
      cwd: input.projectRoot,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`supervised worker ${workerId} exceeded its bounded timeout`));
    }, 60_000);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ workerId, status: status ?? -1, signal, stdout, stderr });
    });
  });
  const results = await Promise.all([
    start("fitflow-worker-a"),
    start("fitflow-worker-b"),
  ]);
  for (const result of results) {
    assert.equal(
      result.status,
      0,
      `${result.workerId} failed (${result.signal ?? result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return results;
}

function callAction(input, capability, args) {
  const payload = JSON.parse(run(input.cli, [
    "try", "call", capability, "--json", JSON.stringify(args),
  ], { cwd: input.projectRoot, env: input.env }).stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.source_database_changed, false);
  assert.equal(payload.result.source_database_changed, false);
  assert.equal(typeof payload.result.proposal?.id, "string");
  return { proposalId: payload.result.proposal.id, payload };
}

function approveProposal(input, proposalId) {
  const approved = JSON.parse(run(input.cli, [
    "proposals",
    "approve",
    proposalId,
    "--yes",
    "--json",
  ], {
    cwd: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.reviewerToken),
  }).stdout);
  assert.equal(approved.state, "approved");
  return approved;
}

function applyProposal(input, proposalId) {
  return JSON.parse(run(input.cli, [
    "apply",
    proposalId,
    "--json",
  ], {
    cwd: input.projectRoot,
    env: operatorTokenEnv(input, input.identity.applierToken),
  }).stdout);
}

function expectOidcApprovalDenied(input, proposalId, token, name, envOverride = {}) {
  const result = run(input.cli, [
    "proposals",
    "approve",
    proposalId,
    "--yes",
    "--json",
  ], {
    cwd: input.projectRoot,
    env: {
      ...operatorTokenEnv(input, token),
      ...envOverride,
    },
    allowFailure: true,
  });
  assert.notEqual(result.status, 0, `${name} unexpectedly approved the proposal`);
  assertNoBearerToken(`${result.stdout}\n${result.stderr}`, [token], `${name} approval output`);
  const detail = proposalDetail(input, proposalId);
  assert.equal(detail.proposal.state, "pending_review", `${name} changed proposal state`);
  assert.equal(detail.approval_progress.approved, 0, `${name} appended an approval`);
  assert.equal(
    detail.events.some((event) =>
      event.kind === "proposal_approved" || event.kind === "proposal_approval_recorded"),
    false,
    `${name} appended a successful approval event`,
  );
}

function operatorTokenEnv(input, token) {
  return {
    ...input.env,
    SYNAPSOR_OPERATOR_TOKEN: token,
  };
}

function tamperApprovalProof(projectRoot, proposalId) {
  const database = new DatabaseSync(path.join(projectRoot, ".synapsor", "local.db"));
  try {
    const row = database.prepare(`
      SELECT approval_id, identity_json
      FROM approvals
      WHERE proposal_id = ? AND status = 'approved'
      ORDER BY approval_id DESC
      LIMIT 1
    `).get(proposalId);
    assert.ok(row, `approval missing for tamper fixture ${proposalId}`);
    const identity = JSON.parse(String(row.identity_json));
    identity.roles = [...identity.roles, "tampered_role"];
    database.prepare("UPDATE approvals SET identity_json = ? WHERE approval_id = ?")
      .run(JSON.stringify(identity), row.approval_id);
  } finally {
    database.close();
  }
}

function replayApprovalProof(projectRoot, sourceProposalId, targetProposalId) {
  const database = new DatabaseSync(path.join(projectRoot, ".synapsor", "local.db"));
  try {
    const source = database.prepare(`
      SELECT identity_json, decision_hash, signature, integrity_hash
      FROM approvals
      WHERE proposal_id = ? AND status = 'approved'
      ORDER BY approval_id DESC
      LIMIT 1
    `).get(sourceProposalId);
    const target = database.prepare(`
      SELECT approval_id
      FROM approvals
      WHERE proposal_id = ? AND status = 'approved'
      ORDER BY approval_id DESC
      LIMIT 1
    `).get(targetProposalId);
    assert.ok(source, `source approval missing for ${sourceProposalId}`);
    assert.ok(target, `target approval missing for ${targetProposalId}`);
    database.prepare(`
      UPDATE approvals
      SET identity_json = ?, decision_hash = ?, signature = ?, integrity_hash = ?
      WHERE approval_id = ?
    `).run(
      source.identity_json,
      source.decision_hash,
      source.signature,
      source.integrity_hash,
      target.approval_id,
    );
  } finally {
    database.close();
  }
}

function assertNoPersistedBearerTokens(projectRoot, tokens) {
  const projectText = collectText(projectRoot, [
    ".synapsor",
    "synapsor",
    "synapsor.runner.json",
    ".env.example",
  ]);
  assertNoBearerToken(projectText, tokens, "generated project text");
  const store = fs.readFileSync(path.join(projectRoot, ".synapsor", "local.db"));
  for (const token of tokens) {
    assert.equal(
      store.includes(Buffer.from(token)),
      false,
      "local ledger persisted an operator bearer token",
    );
  }
}

function assertNoBearerToken(value, tokens, location) {
  for (const token of tokens) {
    assert.equal(String(value).includes(token), false, `${location} exposed an operator bearer token`);
  }
}

function proposalDetail(input, proposalId) {
  return JSON.parse(run(input.cli, [
    "proposals", "show", proposalId, "--json",
  ], { cwd: input.projectRoot, env: input.env }).stdout);
}

function receiptList(input) {
  return JSON.parse(run(input.cli, [
    "receipts", "list", "--json",
  ], { cwd: input.projectRoot, env: input.env }).stdout).receipts;
}

function replay(input, proposalId) {
  return JSON.parse(run(input.cli, [
    "replay", "show", proposalId, "--json",
  ], { cwd: input.projectRoot, env: input.env }).stdout);
}

async function memberState(pool, memberId) {
  const result = await pool.query(`
    SELECT id, membership_status, loyalty_balance, version
    FROM public.members
    WHERE id = $1
  `, [memberId]);
  assert.equal(result.rowCount, 1);
  return result.rows[0];
}

async function verifyGeneratedMcpConfigs(projectRoot) {
  const mcpRoot = path.join(projectRoot, ".synapsor", "mcp");
  const jsonFiles = ["cursor.json", "claude.json", "generic-stdio.json"];
  const configs = await Promise.all(jsonFiles.map(async (name) =>
    JSON.parse(await fsp.readFile(path.join(mcpRoot, name), "utf8"))));
  for (const config of configs.slice(1)) assert.deepEqual(config, configs[0]);
  const entry = configs[0]?.mcpServers?.synapsor_authoring;
  assert.equal(entry?.command, "npx");
  assert.deepEqual(entry?.args?.slice(-5), [
    "mcp",
    "serve",
    "--authoring",
    "--project-root",
    ".",
  ]);
  const codex = await fsp.readFile(path.join(mcpRoot, "codex.toml"), "utf8");
  assert.match(codex, /^\[mcp_servers\.synapsor_authoring\]$/m);
  assert.match(codex, /^command = "npx"$/m);
  assert.match(codex, /"mcp","serve","--authoring","--project-root","\."/);
  const serialized = `${JSON.stringify(configs)}\n${codex}`;
  assert.doesNotMatch(
    serialized,
    /fitflow_analytics_reader_password|fitflow_admin_password|DATABASE_URL|SYNAPSOR_TENANT_ID|SYNAPSOR_PRINCIPAL/,
    "generated MCP client configuration contained secrets or trusted-scope values",
  );
  return ["Cursor", "Claude", "Codex", "generic stdio"];
}

function readDocumentedOidcOperatorConfig(guidePath) {
  const guide = fs.readFileSync(guidePath, "utf8");
  const match = guide.match(
    /<!-- synapsor-oidc-operator-config:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- synapsor-oidc-operator-config:end -->/,
  );
  assert.ok(match, "approval-role guide omitted its tested OIDC config block");
  assert.match(guide, /synapsor-runner proposals approve latest[\s\S]*--yes[\s\S]*--json/);
  assert.match(guide, /synapsor-runner apply latest[\s\S]*--json/);
  assert.match(guide, /node \.\/node_modules\/@synapsor\/runner\/examples\/operator-oidc\/issuer\.mjs/);
  return JSON.parse(match[1]);
}

async function verifyPackedJsonOutput(cli, fixtureRoot) {
  await fsp.mkdir(fixtureRoot, { recursive: true });
  const configPath = path.join(fixtureRoot, "synapsor.runner.json");
  const initialized = run(cli, [
    "config",
    "init",
    "--output",
    configPath,
    "--engine",
    "postgres",
    "--read-url-env",
    "DATABASE_URL",
    "--json",
  ], { cwd: fixtureRoot });
  assert.equal(JSON.parse(initialized.stdout).ok, true);

  const validated = run(cli, [
    "config",
    "validate",
    "--config",
    configPath,
    "--json",
  ], { cwd: fixtureRoot });
  assert.equal(JSON.parse(validated.stdout).ok, true);

  const malformedPath = path.join(fixtureRoot, "malformed.runner.json");
  await fsp.writeFile(malformedPath, [
    "{",
    '  "version": 1,',
    '  "mode": "read_only"',
    '  "capabilities": []',
    "}",
    "",
  ].join("\n"), "utf8");
  const malformed = run(cli, [
    "config",
    "validate",
    "--config",
    malformedPath,
    "--json",
  ], { cwd: fixtureRoot, allowFailure: true });
  assert.equal(malformed.status, 1);
  const malformedPayload = JSON.parse(malformed.stdout);
  assert.equal(malformedPayload.ok, false);
  assert.match(malformedPayload.error.message, /line \d+, column \d+/);
  assert.equal(malformedPayload.recovery.source_database_changed, false);
  assert.match(malformedPayload.recovery.next_action, /config validate/);

  const invalidPath = path.join(fixtureRoot, "invalid.runner.json");
  await fsp.writeFile(invalidPath, `${JSON.stringify({
    version: 1,
    mode: "unsafe",
    capabilities: [],
  }, null, 2)}\n`, "utf8");
  const invalid = run(cli, [
    "config",
    "validate",
    "--config",
    invalidPath,
    "--json",
  ], { cwd: fixtureRoot, allowFailure: true });
  assert.equal(invalid.status, 1);
  const invalidPayload = JSON.parse(invalid.stdout);
  assert.equal(invalidPayload.ok, false);
  assert.ok(invalidPayload.errors.some((error) =>
    error.path === "$.mode" && error.code === "INVALID_MODE"));
  assert.match(invalidPayload.next_action, /config validate/);
}

async function configureOperatorIdentity(projectRoot, operatorIdentity) {
  const configPath = path.join(projectRoot, "synapsor.runner.json");
  const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
  config.operator_identity = operatorIdentity;
  await fsp.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function startOidcFixture(issuerPath) {
  const child = spawn(process.execPath, [issuerPath], {
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      SYNAPSOR_EXAMPLE_OIDC_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const metadata = await waitForValue(
    () => {
      const line = stdout.split(/\r?\n/).find((item) => item.trim());
      if (line) return JSON.parse(line);
      if (child.exitCode !== null) throw new Error(`OIDC fixture exited before readiness (${child.exitCode}): ${stderr}`);
      return undefined;
    },
    10_000,
    () => `OIDC fixture did not become ready:\n${stdout}\n${stderr}`,
  );
  assert.equal(metadata.fixture, "synapsor.operator-oidc.v1");
  assert.match(metadata.base_url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(metadata.jwks_url, `${metadata.base_url}/jwks`);

  return {
    metadata,
    async token(name) {
      const response = await fetch(`${metadata.base_url}/token/${name}`);
      assert.equal(response.status, 200, `OIDC fixture did not mint ${name}`);
      const payload = await response.json();
      assert.equal(payload.token_type, "Bearer");
      assert.equal(typeof payload.access_token, "string");
      return payload.access_token;
    },
    async rotate() {
      const response = await fetch(`${metadata.base_url}/rotate`, { method: "POST" });
      assert.equal(response.status, 200, "OIDC fixture rotation failed");
      const payload = await response.json();
      assert.deepEqual(payload.active_kids, ["fitflow-key-1", "fitflow-key-2"]);
    },
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

async function withPackedMcp(input, action) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [input.cli, ...input.args],
    cwd: input.cwd,
    env: input.env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: input.name, version: "1.0.0" });
  try {
    await client.connect(transport);
    return await action(client);
  } catch (error) {
    if (error instanceof Error && stderr.trim()) error.message += `\nMCP stderr:\n${stderr.trim()}`;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", "MCP result omitted structured content and JSON text");
  return JSON.parse(text);
}

function comparableExploreResult(result) {
  return {
    ok: result.ok,
    kind: result.kind,
    boundary_digest: result.boundary_digest,
    source_database_changed: result.source_database_changed,
    data: result.data,
    privacy: result.privacy,
    returned_rows_or_groups: result.audit?.returned_rows_or_groups,
    returned_cells: result.audit?.returned_cells,
  };
}

function objectHasForbiddenKey(value, forbidden) {
  if (Array.isArray(value)) return value.some((item) => objectHasForbiddenKey(item, forbidden));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    forbidden.has(key.toLowerCase()) || objectHasForbiddenKey(item, forbidden));
}

async function startPublicGuidedCommand(input) {
  const command = [
    shellQuote(input.cli),
    "start",
    "--from-env",
    "DATABASE_URL",
  ].join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: input.projectRoot,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const url = await waitForValue(() => {
    const match = stdout.match(/Synapsor Runner local UI: (http:\/\/[^\s\r]+)/);
    return match?.[1];
  }, 45_000, () => `Public guided start did not reach Workbench.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  const readyAt = Date.now();
  const parsed = new URL(url);
  const token = parsed.searchParams.get("token");
  assert.ok(token, "Workbench URL omitted bootstrap token");
  const origin = parsed.origin;
  const headers = { "x-synapsor-ui-token": token };
  const page = await fetch(`${origin}/`, { headers });
  assert.equal(page.status, 200);
  const html = await page.text();
  const csrf = html.match(/const csrf="([^"]+)"/)?.[1];
  assert.ok(csrf, "Workbench page omitted CSRF token");
  return {
    readyAt,
    output: () => `${stdout}\n${stderr}`,
    async html(pathname) {
      const response = await fetch(`${origin}${pathname}`, { headers });
      assert.equal(response.status, 200);
      return response.text();
    },
    async json(method, pathname, body) {
      const response = await fetch(`${origin}${pathname}`, {
        method,
        headers: {
          ...headers,
          ...(method === "POST"
            ? { "content-type": "application/json", "x-synapsor-csrf": csrf }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(`${method} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    async jsonResponse(method, pathname, body) {
      const response = await fetch(`${origin}${pathname}`, {
        method,
        headers: {
          ...headers,
          ...(method === "POST"
            ? { "content-type": "application/json", "x-synapsor-csrf": csrf }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        response,
        payload: await response.json(),
      };
    },
    async close() {
      if (child.exitCode !== null) return;
      if (!killProcessGroup(child.pid, "SIGTERM")) return;
      try {
        await waitForValue(
          () => child.exitCode !== null ? child.exitCode : undefined,
          5_000,
          () => "guided Workbench did not stop after SIGTERM",
        );
      } catch {
        if (!killProcessGroup(child.pid, "SIGKILL")) return;
        await waitForValue(
          () => child.exitCode !== null ? child.exitCode : undefined,
          5_000,
          () => "guided Workbench did not stop after SIGKILL",
        );
      }
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function sourceSnapshot(pool) {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.members) AS members,
      (SELECT COUNT(*)::int FROM public.check_ins) AS check_ins,
      (SELECT md5(string_agg(
        id || ':' || membership_status || ':' || loyalty_balance::text || ':' || version::text,
        '|' ORDER BY id
      )) FROM public.members) AS member_digest
  `);
  return result.rows[0];
}

async function stableProjectDigests(projectRoot) {
  const paths = [
    "synapsor.runner.json",
    ".synapsor/guided-onboarding.json",
    ".synapsor/generation-lock.json",
    "synapsor/generated/domain.synapsor.sql",
    "synapsor/generated/read-capabilities.synapsor.sql",
    "synapsor/generated/synapsor.candidate.contract.json",
  ];
  return Object.fromEntries(await Promise.all(paths.map(async (relative) => {
    const contents = await fsp.readFile(path.join(projectRoot, relative));
    return [relative, crypto.createHash("sha256").update(contents).digest("hex")];
  })));
}

function collectText(projectRoot, entries) {
  return entries
    .map((entry) => collectPathText(path.join(projectRoot, entry)))
    .join("\n");
}

function collectPathText(resolved) {
  if (!fs.existsSync(resolved)) return "";
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) return "";
  if (stat.isDirectory()) {
    return fs.readdirSync(resolved)
      .map((entry) => collectPathText(path.join(resolved, entry)))
      .join("\n");
  }
  if (stat.size > 2_000_000 || /\.(?:db|png|gif|mp4|tgz)$/i.test(resolved)) return "";
  return fs.readFileSync(resolved, "utf8");
}

function packCurrent(destination, packageDirectory) {
  const result = run("corepack", [
    "pnpm",
    "pack",
    "--pack-destination",
    destination,
  ], { cwd: packageDirectory });
  const filename = result.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert.ok(filename, `pnpm pack did not report a tarball filename:\n${result.stdout}`);
  return path.join(destination, path.basename(filename));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? result.error?.message})\n` +
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  const normalizedArgs = args.map(String);
  const machineJson = path.basename(command) === "synapsor-runner"
    && (
      normalizedArgs.includes("--json")
      || normalizedArgs.includes("--format=json")
      || normalizedArgs.some((arg, index) =>
        arg === "--format" && normalizedArgs[index + 1] === "json")
    );
  if (machineJson && !options.inherit) {
    assertMachineJson(result.stdout ?? "", `${command} ${args.join(" ")}`);
  }
  return result;
}

function assertMachineJson(output, label) {
  assert.doesNotThrow(() => JSON.parse(output), `${label} did not emit exactly one JSON value`);
  assert.doesNotMatch(output, /\u001b\[[0-9;]*m/, `${label} emitted ANSI on stdout`);
  const jq = spawnSync("jq", ["-e", "."], {
    input: output,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  assert.equal(
    jq.status,
    0,
    `${label} did not pass jq -e .\nstdout:\n${output}\njq stderr:\n${jq.stderr ?? ""}`,
  );
}

async function waitForValue(read, timeoutMs, failure) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(failure());
}
