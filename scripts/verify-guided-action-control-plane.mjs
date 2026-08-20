import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "../packages/postgres/node_modules/pg/lib/index.js";
import mysql from "../packages/mysql/node_modules/mysql2/promise.js";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import { createMcpRuntime, loadRuntimeConfigFromFile } from "../packages/mcp-server/dist/index.js";
import {
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  loadStructuredProjectEvidence,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import { initializeGuidedProject } from "../apps/runner/dist/guided-project.js";
import {
  activateGuidedAction,
  createGuidedActionDraft,
  guidedActionStatus,
  recordGuidedActionPreview,
  reviseGuidedActionAuthority,
} from "../apps/runner/dist/guided-action.js";
import { executeGuidedActionPreview } from "../apps/runner/dist/guided-action-runtime.js";
import { createActionOperatorService } from "../apps/runner/dist/action-operator.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "examples", "runner-fleet", "docker-compose.yml");
const { Pool } = pg;

const engines = {
  postgres: {
    schema: "public",
    readUrl: "postgresql://synapsor_reader:synapsor_reader_password@127.0.0.1:55439/synapsor_fleet",
    writeUrl: "postgresql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:55439/synapsor_fleet",
    adminUrl: "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55439/synapsor_fleet",
  },
  mysql: {
    schema: "synapsor_fleet",
    readUrl: "mysql://synapsor_reader:synapsor_reader_password@127.0.0.1:53309/synapsor_fleet",
    writeUrl: "mysql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:53309/synapsor_fleet",
    adminUrl: "mysql://root:root_password@127.0.0.1:53309/synapsor_fleet",
  },
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
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

async function waitForDatabases() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const postgres = run("docker", [
      "compose", "-f", composeFile, "exec", "-T", "postgres",
      "pg_isready", "-U", "synapsor_admin", "-d", "synapsor_fleet",
    ], { allowFailure: true });
    const mysqlReady = run("docker", [
      "compose", "-f", composeFile, "exec", "-T", "mysql",
      "mysqladmin", "ping", "-h", "127.0.0.1", "-proot_password",
    ], { allowFailure: true });
    if (postgres.status === 0 && mysqlReady.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("guided Safe Action databases did not become ready");
}

function actionDefinitions(schema) {
  const resource = `${schema}.guard_crud_items`;
  const proposalOnly = {
    authority_posture: "proposal_only",
    writeback: { mode: "none" },
    receipt_mode: "runner_ledger",
    confirmed_trusted_scope: true,
    approval_role: "guard_reviewer",
  };
  return [
    {
      capability: "guard.propose_set_value",
      action: {
        ...proposalOnly,
        capability_name: "guard.propose_set_value",
        description: "Propose setting one guarded item value.",
        resource,
        operation: "update",
        lookup_argument: "item_id",
        patches: [{
          column: "value_cents",
          value_source: "argument",
          argument_name: "value_cents",
          minimum: 0,
          maximum: 10_000,
        }],
        conflict_column: "version",
        version_advance: "integer_increment",
      },
      proposalArgs: { item_id: 1001, value_cents: 301 },
      executableArgs: { item_id: 1011, value_cents: 3_011 },
    },
    {
      capability: "guard.propose_create_item",
      action: {
        ...proposalOnly,
        capability_name: "guard.propose_create_item",
        description: "Propose creating one tenant-owned guarded item.",
        resource,
        operation: "insert",
        patches: [{
          column: "value_cents",
          value_source: "argument",
          argument_name: "value_cents",
          minimum: 0,
          maximum: 10_000,
        }],
        dedup_proposal_column: "request_id",
      },
      proposalArgs: { value_cents: 302 },
      executableArgs: { value_cents: 3_012 },
    },
    {
      capability: "guard.propose_delete_item",
      action: {
        ...proposalOnly,
        capability_name: "guard.propose_delete_item",
        description: "Propose deleting one exact guarded item.",
        resource,
        operation: "delete",
        lookup_argument: "item_id",
        conflict_column: "version",
        delete_confirmation: `DELETE ${resource}`,
      },
      proposalArgs: { item_id: 1002 },
      executableArgs: { item_id: 1012 },
    },
  ];
}

async function createAdmin(engine) {
  if (engine === "postgres") return new Pool({ connectionString: engines.postgres.adminUrl, max: 1 });
  return mysql.createConnection(engines.mysql.adminUrl);
}

async function query(engine, admin, sql, values = []) {
  if (engine === "postgres") return (await admin.query(sql, values)).rows;
  const [rows] = await admin.query(sql, values);
  return rows;
}

async function sourceSnapshot(engine, admin) {
  const table = engine === "postgres" ? "public.guard_crud_items" : "guard_crud_items";
  const rows = await query(
    engine,
    admin,
    `SELECT id, tenant_id, request_id, value_cents, version FROM ${table} ORDER BY id`,
  );
  return JSON.stringify(rows.map((row) => ({
    id: String(row.id),
    tenant_id: row.tenant_id,
    request_id: row.request_id,
    value_cents: Number(row.value_cents),
    version: String(row.version),
  })));
}

async function rowById(engine, admin, id) {
  const table = engine === "postgres" ? "public.guard_crud_items" : "guard_crud_items";
  const rows = await query(engine, admin, `SELECT id, tenant_id, request_id, value_cents, version FROM ${table} WHERE id = ${engine === "postgres" ? "$1" : "?"}`, [id]);
  return rows[0];
}

async function rowByRequest(engine, admin, requestId) {
  const table = engine === "postgres" ? "public.guard_crud_items" : "guard_crud_items";
  const rows = await query(engine, admin, `SELECT id, tenant_id, request_id, value_cents, version FROM ${table} WHERE tenant_id = 'acme' AND request_id = ${engine === "postgres" ? "$1" : "?"}`, [requestId]);
  return rows[0];
}

function proposalId(result) {
  const proposal = result?.proposal && typeof result.proposal === "object" ? result.proposal : {};
  const id = typeof result?.proposal_id === "string" ? result.proposal_id : proposal.id;
  assert(typeof id === "string", "semantic action did not return immutable proposal identity", result);
  return id;
}

async function callAction(configPath, storePath, env, capability, args) {
  let runtime;
  try {
    runtime = createMcpRuntime(loadRuntimeConfigFromFile(configPath), { env, storePath });
    const tools = runtime.listTools().map((tool) => tool.name).sort();
    assert(tools.every((name) => name.startsWith("guard.propose_")), "action runtime exposed a non-semantic control tool", tools);
    const result = await runtime.callTool(capability, args);
    return { result, tools };
  } finally {
    await runtime?.close();
  }
}

async function activateDraft(projectRoot, inspection, env, created) {
  const preview = await executeGuidedActionPreview({
    projectRoot,
    capabilityName: created.draft.capability,
    args: created.previewArgs,
    env,
  });
  await recordGuidedActionPreview({
    projectRoot,
    capabilityName: created.draft.capability,
    contractDigest: preview.draft_digest,
    proposalId: preview.proposal_id,
    proposalHash: preview.proposal_hash,
    sourceDatabaseChanged: false,
  });
  return activateGuidedAction({
    projectRoot,
    capabilityName: created.draft.capability,
    expectedDigest: created.draft.contract_digest,
    confirmation: `ACTIVATE ${created.draft.contract_digest}`,
    actor: "guided-action-live-test",
    inspection,
  });
}

async function prepareProject(engine, projectRoot, inspection, env) {
  const project = {
    root: projectRoot,
    package_manager: "unknown",
    frameworks: [],
    schema_inputs: [],
    database_env_names: ["DATABASE_URL"],
  };
  const evidence = await loadStructuredProjectEvidence(project);
  const resourceId = `${engines[engine].schema}.guard_crud_items`;
  const reviewedAt = "2026-08-20T00:00:00.000Z";
  const reviewedDecision = {
    actor: "guided-action-live-test",
    reason: "Live qualification of an explicitly reviewed direct-scope action resource.",
    decided_at: reviewedAt,
  };
  const build = buildAutoBoundary({
    inspection,
    project,
    parsedEvidence: evidence.parsed,
    existingContracts: evidence.existingContracts,
    sourceEnv: "DATABASE_URL",
    deploymentProfile: "staging",
    overrides: {
      schema_version: "synapsor.auto-boundary-overrides.v1",
      resources: {
        [resourceId]: {
          row_identity: { ...reviewedDecision, value: "id" },
          tenant_key: { ...reviewedDecision, value: "tenant_id" },
          principal_key: { ...reviewedDecision, value: null },
        },
      },
    },
  });
  await writeAutoBoundaryArtifacts({ projectRoot, build });
  await initializeGuidedProject({ projectRoot, build, runnerVersion: "1.7.1" });
  const candidate = structuredClone(build.exploration_boundary);
  candidate.pack.name = `guard_${engine}`;
  candidate.pack.resources = candidate.pack.resources.filter((resource) => resource.id === resourceId);
  assert(candidate.pack.resources.length === 1, `${engine} boundary did not inspect the guarded CRUD table`, candidate.pack.resources);
  assert(candidate.pack.resources[0].tenant_key === "tenant_id", `${engine} boundary did not derive the direct tenant key`, candidate.pack.resources[0]);
  const digest = explorationBoundaryCandidateDigest(candidate);
  await activateExplorationBoundary({
    projectRoot,
    candidate,
    expectedDigest: digest,
    actor: "guided-action-live-test",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  assert(env.SYNAPSOR_TENANT_ID === "acme", "test trusted tenant context changed unexpectedly");
}

async function verifyEngine(engine) {
  const details = engines[engine];
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `synapsor-guided-actions-${engine}-`));
  const storePath = path.join(projectRoot, ".synapsor", "action-live.db");
  const env = {
    ...process.env,
    DATABASE_URL: details.readUrl,
    SYNAPSOR_DATABASE_WRITE_URL: details.writeUrl,
    SYNAPSOR_TENANT_ID: "acme",
    SYNAPSOR_PRINCIPAL: "operator-1",
  };
  const operatorEnvironment = [
    "DATABASE_URL",
    "SYNAPSOR_DATABASE_WRITE_URL",
    "SYNAPSOR_TENANT_ID",
    "SYNAPSOR_PRINCIPAL",
  ];
  const previousEnvironment = Object.fromEntries(
    operatorEnvironment.map((name) => [name, process.env[name]]),
  );
  for (const name of operatorEnvironment) process.env[name] = env[name];
  const admin = await createAdmin(engine);
  let passed = false;
  try {
    const inspection = await inspectDatabase({ engine, databaseUrlEnv: "DATABASE_URL", env });
    assert(inspection.role_posture?.read_only === true, `${engine} authoring inspection did not use the read-only role`, inspection.role_posture);
    await prepareProject(engine, projectRoot, inspection, env);
    const definitions = actionDefinitions(details.schema);
    const proposalOnlyActivations = new Map();

    for (const definition of definitions) {
      const created = await createGuidedActionDraft({ projectRoot, action: definition.action, inspection });
      const activation = await activateDraft(projectRoot, inspection, env, {
        draft: created.draft,
        previewArgs: definition.proposalArgs,
      });
      assert(activation.authority_posture === "proposal_only" && activation.writeback_mode === "none", `${engine} first activation was not proposal-only`, activation);
      proposalOnlyActivations.set(definition.capability, activation);
    }

    const configPath = path.join(projectRoot, "synapsor.actions.runner.json");
    const baseline = await sourceSnapshot(engine, admin);
    const oldProposals = new Map();
    let expectedTools;
    for (const definition of definitions) {
      const { result, tools } = await callAction(configPath, storePath, env, definition.capability, definition.proposalArgs);
      assert(result.ok === true && result.source_database_changed === false, `${engine} proposal-only action did not create a safe proposal`, result);
      expectedTools ??= tools;
      assert(JSON.stringify(tools) === JSON.stringify(expectedTools), `${engine} semantic tool surface changed between calls`, tools);
      oldProposals.set(definition.capability, { id: proposalId(result) });
    }
    assert(expectedTools.length === 3, `${engine} action runtime did not expose exactly the three activated semantic tools`, expectedTools);
    assert(await sourceSnapshot(engine, admin) === baseline, `${engine} proposal-only actions mutated the source database`);

    const proposalOnlyService = createActionOperatorService({ configPath, storePath });
    for (const proposal of oldProposals.values()) {
      const detail = await proposalOnlyService.detail(proposal.id);
      proposal.hash = detail.proposal.proposal_hash;
      assert(detail.proposal.change_set.writeback.mode === "read_only", `${engine} proposal did not freeze proposal-only authority`, detail.proposal.change_set.writeback);
      const approved = await proposalOnlyService.approve(proposal.id, {
        actor: "guided-action-live-test",
        reason: "Approve the immutable proposal while retaining proposal-only execution authority.",
        expected_proposal_hash: proposal.hash,
      });
      assert(approved.proposal.state === "approved", `${engine} proposal-only review could not be completed`, approved.proposal.state);
    }

    const executableActivations = new Map();
    for (const definition of definitions) {
      const previous = proposalOnlyActivations.get(definition.capability);
      const revision = await reviseGuidedActionAuthority({
        projectRoot,
        capabilityName: definition.capability,
        expectedCurrentDigest: previous.contract_digest,
        authority: {
          authority_posture: "executable",
          writeback: { mode: "direct_sql" },
          receipt_mode: "runner_ledger",
          write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
        },
        inspection,
      });
      assert(revision.draft.contract_digest !== previous.contract_digest, `${engine} execution promotion reused the proposal-only digest`);
      const activation = await activateDraft(projectRoot, inspection, env, {
        draft: revision.draft,
        previewArgs: definition.executableArgs,
      });
      assert(activation.authority_posture === "executable" && activation.writeback_mode === "direct_sql", `${engine} promoted revision lacks execution authority`, activation);
      executableActivations.set(definition.capability, activation);
    }

    const executableService = createActionOperatorService({ configPath, storePath });
    for (const [capability, proposal] of oldProposals) {
      let blocked = false;
      try {
        const attempted = await executableService.apply(proposal.id, {
          actor: "guided-action-live-test",
          reason: "Verify proposal-only authority cannot be promoted retroactively.",
          expected_proposal_hash: proposal.hash,
        });
        blocked = attempted.code !== 0 && attempted.detail.proposal.state !== "applied";
      } catch (error) {
        blocked = /WRITEBACK|READ_ONLY|CONTRACT|AUTHORITY|EXECUT/i.test(String(error?.code ?? error?.message ?? error));
      }
      assert(blocked, `${engine} old ${capability} proposal became executable after promotion`);
    }
    assert(await sourceSnapshot(engine, admin) === baseline, `${engine} old proposal changed the source after promotion`);

    const applied = new Map();
    for (const definition of definitions) {
      const { result } = await callAction(configPath, storePath, env, definition.capability, definition.executableArgs);
      assert(result.ok === true && result.source_database_changed === false, `${engine} executable action did not remain proposal-first`, result);
      const id = proposalId(result);
      const before = await executableService.detail(id);
      const proposal = { id, hash: before.proposal.proposal_hash };
      assert(before.proposal.change_set.contract?.digest === executableActivations.get(definition.capability).contract_digest, `${engine} executable proposal did not freeze the active digest`, before.proposal.change_set.contract);
      const decision = {
        actor: "guided-action-live-test",
        reason: "Apply the exact live qualification proposal.",
        expected_proposal_hash: proposal.hash,
      };
      let approved;
      try {
        approved = await executableService.approve(proposal.id, decision);
      } catch (error) {
        const failed = await executableService.detail(proposal.id);
        throw new Error(`${engine} ${definition.capability} approval failed: ${error?.message ?? error}\n${JSON.stringify({
          freshness_status: failed.freshness_status,
          state: failed.proposal.state,
          events: failed.events.slice(-3),
        }, null, 2)}`);
      }
      assert(approved.proposal.state === "approved", `${engine} proposal was not approved`, approved.proposal.state);
      const outcome = await executableService.apply(proposal.id, decision);
      assert(outcome.code === 0 && outcome.detail.proposal.state === "applied", `${engine} exact proposal did not apply`, outcome);
      assert(outcome.detail.receipts.length === 1, `${engine} applied proposal did not record one receipt`, outcome.detail.receipts);
      applied.set(definition.capability, proposal);
    }

    const updated = await rowById(engine, admin, 1011);
    assert(Number(updated?.value_cents) === 3_011 && Number(updated?.version) === 2 && updated?.tenant_id === "acme", `${engine} UPDATE did not affect exactly the scoped row/version`, updated);
    const inserted = await rowByRequest(engine, admin, applied.get("guard.propose_create_item").id);
    assert(Number(inserted?.value_cents) === 3_012 && inserted?.tenant_id === "acme", `${engine} INSERT did not inject trusted scope and proposal dedup identity`, inserted);
    assert(await rowById(engine, admin, 1012) === undefined, `${engine} DELETE left its exact target row behind`);
    const untouched = await rowById(engine, admin, 1001);
    assert(Number(untouched?.value_cents) === 100 && Number(untouched?.version) === 1, `${engine} proposal-only UPDATE target changed`, untouched);
    assert(await rowById(engine, admin, 1002), `${engine} proposal-only DELETE target was removed`);
    assert(await rowByRequest(engine, admin, oldProposals.get("guard.propose_create_item").id) === undefined, `${engine} proposal-only INSERT appeared in the source`);

    const wrongTenant = await callAction(configPath, storePath, env, "guard.propose_set_value", { item_id: 1031, value_cents: 9_999 });
    assert(wrongTenant.result.ok === false && wrongTenant.result.source_database_changed === false, `${engine} cross-tenant target did not fail closed`, wrongTenant.result);
    const globex = await rowById(engine, admin, 1031);
    assert(globex?.tenant_id === "globex" && Number(globex?.value_cents) === 230, `${engine} cross-tenant refusal changed the row`, globex);

    const status = await guidedActionStatus(projectRoot);
    assert(status.activations.length === 3 && status.activations.every((activation) => activation.authority_posture === "executable"), `${engine} active action status does not match the exact promoted revisions`, status);
    passed = true;
    process.stdout.write(`PASS ${engine}: proposal-only -> exact-digest promotion -> guarded INSERT/UPDATE/DELETE apply\n`);
  } finally {
    await admin.end();
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (passed || process.env.SYNAPSOR_KEEP_FAILED_GUIDED_ACTION_PROJECT !== "1") {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(`Preserved failed ${engine} project at ${projectRoot}\n`);
    }
  }
}

async function main() {
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true });
  run("docker", ["compose", "-f", composeFile, "up", "-d", "postgres", "mysql"], { inherit: true });
  await waitForDatabases();
  await verifyEngine("postgres");
  await verifyEngine("mysql");
  process.stdout.write("PASS guided Safe Action control plane live matrix\n");
}

try {
  await main();
} finally {
  run("docker", ["compose", "-f", composeFile, "down", "-v", "--remove-orphans"], { allowFailure: true, inherit: true });
}
