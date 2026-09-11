import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "../packages/postgres/node_modules/pg/lib/index.js";
import mysql from "../packages/mysql/node_modules/mysql2/promise.js";
import {
  compileActionRule,
  createActionRuleApprovalClasses,
  createActionRuleRegistry,
  createSemanticActionVerifier,
  evaluateSemanticActionEligibility,
} from "../packages/action-rules/dist/index.js";
import {
  canonicalJsonDigest,
  parseWritebackJob,
  parseWritebackResult,
} from "../packages/protocol/dist/index.js";
import {
  applyPostgresJob,
  createPostgresActionRuleFactLoader,
} from "../packages/postgres/dist/index.js";
import {
  applyMysqlJob,
  createMysqlActionRuleFactLoader,
} from "../packages/mysql/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(root, "examples", "runner-fleet", "docker-compose.yml");
const composeProject = `synapsor-semantic-action-${process.pid}`;
const { Pool } = pg;

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close(() => reject(new Error("Could not reserve a local test port.")));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

class MemoryIntentStore {
  result;

  claimWritebackIntent() {
    return this.result === undefined
      ? { decision: "proceed", intent_id: `wbi:live:${crypto.randomUUID()}` }
      : { decision: "existing_result", intent_id: "wbi:live:existing", result: this.result };
  }

  markWritebackIntentApplying() {}

  completeWritebackIntent(_intentId, result) {
    this.result = parseWritebackResult(result);
  }

  requireWritebackReconciliation() {}
}

function digest(value) {
  return canonicalJsonDigest(value);
}

function fixture(engine, schema, composite = false) {
  const source = "semantic_source";
  const resource = `${schema}.semantic_case_actions`;
  const text64 = { kind: "string", max_length: 64, comparison: "exact" };
  const statusType = {
    kind: "string",
    max_length: 24,
    comparison: "exact",
    enum: ["open", "closed", "scheduled"],
  };
  const riskType = {
    kind: "string",
    max_length: 24,
    comparison: "exact",
    enum: ["low", "high"],
  };
  const approvalTierType = {
    kind: "string",
    max_length: 24,
    comparison: "exact",
    enum: ["routine", "high_touch"],
  };
  const fields = [
    { name: "case_id", type: text64, nullable: false },
    { name: "tenant_id", type: text64, nullable: false },
    { name: "principal_id", type: text64, nullable: false },
    { name: "status", type: statusType, nullable: false },
    { name: "risk", type: riskType, nullable: true },
    { name: "approval_tier", type: approvalTierType, nullable: false },
    { name: "version", type: { kind: "integer" }, nullable: false },
  ];
  const generationLock = digest({ gate: "semantic-action-live", engine, schema, revision: 1 });
  const catalog = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: generationLock,
    resources: [{
      name: resource,
      source,
      engine,
      schema,
      table: "semantic_case_actions",
      primary_key: "case_id",
      tenant_key: "tenant_id",
      principal_scope_key: "principal_id",
      version_field: "version",
      ...(engine === "mysql" ? { storage_engine: "InnoDB" } : {}),
      fields,
    }],
    relationships: [],
  };
  const verificationBoundary = {
    schema_version: "synapsor.verification-boundary.v1",
    name: "support_cases.schedule_verification",
    source,
    context: "trusted_context",
    generation_lock_fingerprint: generationLock,
    resources: [{
      binding: "case",
      resource,
      source: { kind: "subject_ref" },
      primary_key: "case_id",
      version_field: "version",
      fields,
      scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" },
      cardinality: "one",
      max_rows: 1,
      overflow: "unsupported",
      lock: "for_update",
    }],
    lock_order: ["case"],
    transaction: { isolation: "repeatable_read", timezone: "UTC" },
  };
  const effectEnvelope = {
    schema_version: "synapsor.derived-effect-envelope.v1",
    name: "support_cases.schedule_effect",
    source,
    operation: "update",
    target_resource: resource,
    target_binding: "case",
    primary_key: "case_id",
    tenant_key: "tenant_id",
    principal_scope_key: "principal_id",
    conflict_key: "version",
    max_rows: 1,
    allowed_fields: [{ name: "status", type: statusType, values: ["scheduled"] }],
    version_advance: { column: "version", strategy: "integer_increment" },
    approval_classes: ["support_cases.standard_schedule"],
    writeback: { mode: "direct_sql", supervised_worker: "allowed" },
  };
  const field = (name) => ({ kind: "field", binding: "case", field: name });
  const literal = (value, valueType) => ({ kind: "literal", value, value_type: valueType });
  const rule = {
    schema_version: "synapsor.action-rule.v1",
    name: "support_cases.schedule_case",
    outcome: "support_cases.schedule_case",
    context: "trusted_context",
    source,
    verification_boundary_ref: verificationBoundary.name,
    effect_envelope_ref: effectEnvelope.name,
    subjects: [{ binding: "case", resource, input: "opaque_subject_ref" }],
    require: {
      kind: "all",
      expressions: [
        { kind: "compare", operator: "eq", left: field("status"), right: literal("open", statusType) },
        { kind: "compare", operator: "eq", left: field("risk"), right: literal("low", riskType) },
      ],
    },
    derive: { next_status: literal("scheduled", statusType) },
    effect: {
      operation: "update",
      target_resource: resource,
      target_binding: "case",
      set: { status: { kind: "derived", name: "next_status" } },
    },
    approval_class: "support_cases.standard_schedule",
    ttl_seconds: 600,
  };
  const subjectResource = composite ? `${schema}.semantic_case_offers` : resource;
  if (composite) {
    const fields = [
      { name: "offer_id", type: text64, nullable: false },
      { name: "tenant_id", type: text64, nullable: false },
      { name: "principal_id", type: text64, nullable: false },
      { name: "case_id", type: text64, nullable: true },
      { name: "version", type: { kind: "integer" }, nullable: false },
    ];
    const field_pairs = [{ local_field: "tenant_id", target_field: "tenant_id" }, { local_field: "case_id", target_field: "case_id" }];
    catalog.resources.push({ name: subjectResource, source, engine, schema, table: "semantic_case_offers",
      primary_key: "offer_id", tenant_key: "tenant_id", principal_scope_key: "principal_id", version_field: "version", fields });
    catalog.relationships.push({ name: "semantic_offer_case_fk", from_resource: subjectResource, to_resource: resource,
      field_pairs, cardinality: "many_to_one", nullable: true, target_unique: true });
    verificationBoundary.resources[0].source = { kind: "relationship", from_binding: "offer", relationship: "semantic_offer_case_fk", direction: "forward", field_pairs };
    verificationBoundary.resources.unshift({ binding: "offer", resource: subjectResource, source: { kind: "subject_ref" },
      primary_key: "offer_id", version_field: "version", fields,
      scope: { mode: "columns", tenant_field: "tenant_id", principal_field: "principal_id" },
      cardinality: "one", max_rows: 1, overflow: "unsupported", lock: "for_update" });
    verificationBoundary.lock_order = ["offer", "case"];
    rule.subjects = [{ binding: "offer", resource: subjectResource, input: "opaque_subject_ref" }];
  }
  const compiled = compileActionRule({
    rule,
    verification_boundary: verificationBoundary,
    effect_envelope: effectEnvelope,
    catalog,
  });
  const approvalClasses = createActionRuleApprovalClasses({
    rules: [compiled],
    sources: [{
      name: rule.approval_class,
      mode: "policy",
      rules: [{
        outcome: rule.outcome,
        auto_approve_when: {
          kind: "compare",
          operator: "eq",
          left: field("approval_tier"),
          right: literal("routine", approvalTierType),
        },
      }],
      required_role: "support_case_reviewer",
      required_approvals: 1,
      shared_limits: [
        {
          id: "schedule_action_24h",
          kind: "count",
          scope: "capability",
          maximum: 20,
          window_seconds: 86_400,
          capability: rule.outcome,
        },
        {
          id: "schedule_principal_24h",
          kind: "count",
          scope: "tenant_principal",
          maximum: 3,
          window_seconds: 86_400,
          capability: rule.outcome,
        },
      ],
    }],
  });
  const registry = createActionRuleRegistry({
    name: "support_cases.active_actions",
    approval_classes: approvalClasses,
    rules: [{
      read_boundary_name: "support_cases.reviewed_read",
      read_boundary_digest: digest({ read: engine, revision: 1 }),
      action_boundary_name: "support_cases.actions",
      action_boundary_digest: digest({ action: engine, revision: 1 }),
      compiled,
      activated_at: new Date().toISOString(),
    }],
  });
  return { source, resource, subjectResource, composite, compiled, approvalClasses, registry, rule };
}

function subject(fixtureValue, caseId) {
  return [{
    binding: fixtureValue.composite ? "offer" : "case",
    resource: fixtureValue.subjectResource,
    primary_key: { column: fixtureValue.composite ? "offer_id" : "case_id", value: caseId },
    subject_ref_digest: digest({ case_id: caseId, observation: "live-gate" }),
  }];
}

async function evaluateCase(input) {
  return await evaluateSemanticActionEligibility({
    registry: input.fixture.registry,
    outcome: input.fixture.rule.outcome,
    subjects: subject(input.fixture, input.caseId),
    trusted: {
      tenant: input.tenant ?? "acme",
      principal: input.principal ?? "agent_1",
      transaction_time: input.verifiedAt,
    },
    adapter: input.factLoader,
    proposal_id: input.proposalId,
    trusted_context_digest: digest({ tenant: input.tenant ?? "acme", principal: input.principal ?? "agent_1" }),
    evidence_provenance_digest: digest({ case_id: input.caseId, evidence: "live-gate" }),
    verified_at: input.verifiedAt,
  });
}

function writebackJob(engine, fixtureValue, decision, proposalId) {
  assert(decision.result === "eligible", "Cannot build a writeback job from an ineligible decision.", decision);
  const effect = decision.semantic_authority.effect;
  assert(effect.expected_version !== undefined, "Live update effect lacks a reviewed version guard.", effect);
  return parseWritebackJob({
    protocol_version: "5.0",
    job_id: `wbj_${engine}_${proposalId}`,
    proposal_id: proposalId,
    approval_id: digest({ engine, proposalId, approval: "live-gate" }),
    proposal_hash: digest({ engine, proposalId, proposal: "live-gate" }),
    source_id: fixtureValue.source,
    engine,
    operation: effect.operation,
    target: {
      schema: effect.schema,
      table: effect.table,
      primary_key: effect.primary_key,
      tenant_guard: effect.tenant_guard,
      principal_scope: {
        schema_version: "synapsor.principal-scope.v1",
        column: effect.principal_scope.column,
        binding: "principal",
        provider: "static_dev",
        value_fingerprint: digest({ principal: effect.principal_scope.value }),
        value: effect.principal_scope.value,
      },
    },
    allowed_columns: effect.allowed_columns,
    patch: effect.set,
    conflict_guard: {
      kind: "version_column",
      column: effect.expected_version.column,
      expected_value: effect.expected_version.value,
    },
    version_advance: effect.version_advance,
    semantic_authority: decision.semantic_authority,
    idempotency_key: `semantic:${engine}:${proposalId}`,
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    attempt_count: 1,
  });
}

function runnerConfig(engine, databaseUrl, store, verifier) {
  return {
    controlPlaneUrl: "http://127.0.0.1",
    runnerToken: "syn_wbr_semantic_live",
    runnerId: `runner-semantic-${engine}`,
    sourceId: "semantic_source",
    databaseUrl,
    engine,
    pollIntervalMs: 1_000,
    statementTimeoutMs: 5_000,
    logLevel: "error",
    dryRun: false,
    stateDir: ".synapsor",
    receipts: { authority: "runner_ledger" },
    writebackIntentStore: store,
    semanticActionVerifier: verifier,
  };
}

async function waitForDatabases(composeEnv) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const common = ["compose", "-p", composeProject, "-f", composeFile, "exec", "-T"];
    const postgres = run("docker", [...common, "postgres", "pg_isready", "-U", "synapsor_admin", "-d", "synapsor_fleet"], {
      allowFailure: true,
      env: composeEnv,
    });
    const mysqlReady = run("docker", [...common, "mysql", "mysqladmin", "ping", "-h", "127.0.0.1", "-proot_password"], {
      allowFailure: true,
      env: composeEnv,
    });
    if (postgres.status === 0 && mysqlReady.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Semantic Action Rule databases did not become ready.");
}

async function createDatabaseHandles(engine, urls) {
  if (engine === "postgres") {
    return {
      admin: new Pool({ connectionString: urls.admin, max: 1 }),
      facts: new Pool({ connectionString: urls.write, max: 1 }),
    };
  }
  return {
    admin: await mysql.createConnection({ uri: urls.admin, dateStrings: true }),
    facts: await mysql.createConnection({ uri: urls.write, dateStrings: true }),
  };
}

async function execute(engine, handle, sql, values = []) {
  if (engine === "postgres") return (await handle.query(sql, values)).rows;
  const [rows] = await handle.query(sql, values);
  return rows;
}

async function prepareTable(engine, admin) {
  await execute(engine, admin, "DROP TABLE IF EXISTS semantic_case_offers");
  if (engine === "postgres") {
    await execute(engine, admin, "DROP TABLE IF EXISTS public.semantic_case_actions");
    await execute(engine, admin, `CREATE TABLE public.semantic_case_actions (
      case_id text PRIMARY KEY,
      tenant_id text NOT NULL,
      principal_id text NOT NULL,
      status text NOT NULL,
      risk text,
      approval_tier text NOT NULL,
      version bigint NOT NULL,
      UNIQUE (tenant_id, case_id)
    )`);
    await execute(engine, admin, "GRANT SELECT, UPDATE ON public.semantic_case_actions TO synapsor_crud_ledger");
    await execute(engine, admin, `INSERT INTO public.semantic_case_actions
      (case_id, tenant_id, principal_id, status, risk, approval_tier, version)
      VALUES
      ('case_auto', 'acme', 'agent_1', 'open', 'low', 'routine', 7),
      ('case_human', 'acme', 'agent_1', 'open', 'low', 'high_touch', 7),
      ('case_ineligible', 'acme', 'agent_1', 'closed', 'low', 'routine', 7),
      ('case_unknown', 'acme', 'agent_1', 'open', NULL, 'routine', 7),
      ('case_wrong_tenant', 'globex', 'agent_1', 'open', 'low', 'routine', 7),
      ('case_wrong_principal', 'acme', 'agent_2', 'open', 'low', 'routine', 7),
      ('case_stale', 'acme', 'agent_1', 'open', 'low', 'routine', 7),
      ('case_deactivated', 'acme', 'agent_1', 'open', 'low', 'routine', 7)`);
    return;
  }
  await execute(engine, admin, "DROP TABLE IF EXISTS semantic_case_actions");
  await execute(engine, admin, `CREATE TABLE semantic_case_actions (
    case_id varchar(64) PRIMARY KEY,
    tenant_id varchar(64) NOT NULL,
    principal_id varchar(64) NOT NULL,
    status varchar(24) NOT NULL,
    risk varchar(24) NULL,
    approval_tier varchar(24) NOT NULL,
    version bigint NOT NULL,
    UNIQUE (tenant_id, case_id)
  ) ENGINE=InnoDB`);
  await execute(engine, admin, "GRANT SELECT, UPDATE ON synapsor_fleet.semantic_case_actions TO 'synapsor_crud_ledger'@'%'");
  await execute(engine, admin, `INSERT INTO semantic_case_actions
    (case_id, tenant_id, principal_id, status, risk, approval_tier, version)
    VALUES
    ('case_auto', 'acme', 'agent_1', 'open', 'low', 'routine', 7),
    ('case_human', 'acme', 'agent_1', 'open', 'low', 'high_touch', 7),
    ('case_ineligible', 'acme', 'agent_1', 'closed', 'low', 'routine', 7),
    ('case_unknown', 'acme', 'agent_1', 'open', NULL, 'routine', 7),
    ('case_wrong_tenant', 'globex', 'agent_1', 'open', 'low', 'routine', 7),
    ('case_wrong_principal', 'acme', 'agent_2', 'open', 'low', 'routine', 7),
    ('case_stale', 'acme', 'agent_1', 'open', 'low', 'routine', 7),
    ('case_deactivated', 'acme', 'agent_1', 'open', 'low', 'routine', 7)`);
}

async function row(engine, admin, caseId) {
  const table = engine === "postgres" ? "public.semantic_case_actions" : "semantic_case_actions";
  const parameter = engine === "postgres" ? "$1" : "?";
  return (await execute(engine, admin, `SELECT case_id, tenant_id, principal_id, status, risk, approval_tier, version FROM ${table} WHERE case_id = ${parameter}`, [caseId]))[0];
}

async function setRisk(engine, admin, caseId, risk) {
  const table = engine === "postgres" ? "public.semantic_case_actions" : "semantic_case_actions";
  const parameters = engine === "postgres" ? ["$1", "$2"] : ["?", "?"];
  await execute(engine, admin, `UPDATE ${table} SET risk = ${parameters[0]} WHERE case_id = ${parameters[1]}`, [risk, caseId]);
}

async function verifyEngine(engine, urls, composite = false) {
  const schema = engine === "postgres" ? "public" : "synapsor_fleet";
  const handles = await createDatabaseHandles(engine, urls);
  try {
    await prepareTable(engine, handles.admin);
    if (composite) {
      await execute(engine, handles.admin, "DROP TABLE IF EXISTS synapsor_writeback_receipts");
      const type = engine === "postgres" ? "text" : "varchar(64)";
      await execute(engine, handles.admin, `CREATE TABLE semantic_case_offers (
        offer_id ${type} PRIMARY KEY, tenant_id ${type} NOT NULL, principal_id ${type} NOT NULL,
        case_id ${type}, version bigint NOT NULL,
        CONSTRAINT semantic_offer_case_fk FOREIGN KEY (tenant_id, case_id) REFERENCES semantic_case_actions(tenant_id, case_id)
      )${engine === "mysql" ? " ENGINE=InnoDB" : ""}`);
      await execute(engine, handles.admin, engine === "postgres"
        ? "GRANT SELECT, UPDATE ON semantic_case_offers TO synapsor_crud_ledger"
        : "GRANT SELECT, UPDATE ON synapsor_fleet.semantic_case_offers TO 'synapsor_crud_ledger'@'%'");
      await execute(engine, handles.admin, "INSERT INTO semantic_case_offers SELECT case_id, tenant_id, principal_id, case_id, version FROM semantic_case_actions");
      await execute(engine, handles.admin, "INSERT INTO semantic_case_offers VALUES ('offer_empty', 'acme', 'agent_1', NULL, 1)");
    }
    const fixtureValue = fixture(engine, schema, composite);
    const factLoader = engine === "postgres"
      ? createPostgresActionRuleFactLoader(handles.facts)
      : createMysqlActionRuleFactLoader(handles.facts);
    const verifiedAt = new Date().toISOString();

    const automatic = await evaluateCase({
      fixture: fixtureValue,
      factLoader,
      caseId: "case_auto",
      proposalId: `proposal_${engine}_auto`,
      verifiedAt,
    });
    assert(automatic.result === "eligible" && automatic.approval.path === "automatic_eligible", `${engine} did not select the reviewed automatic policy`, automatic);

    const human = await evaluateCase({
      fixture: fixtureValue,
      factLoader,
      caseId: "case_human",
      proposalId: `proposal_${engine}_human`,
      verifiedAt,
    });
    assert(human.result === "eligible" && human.approval.path === "human_review", `${engine} did not fall back to human review`, human);

    const ineligible = await evaluateCase({
      fixture: fixtureValue,
      factLoader,
      caseId: "case_ineligible",
      proposalId: `proposal_${engine}_ineligible`,
      verifiedAt,
    });
    assert(ineligible.result === "ineligible" && !("semantic_authority" in ineligible), `${engine} derived authority for an ineligible row`, ineligible);

    const unknown = await evaluateCase({
      fixture: fixtureValue,
      factLoader,
      caseId: "case_unknown",
      proposalId: `proposal_${engine}_unknown`,
      verifiedAt,
    });
    assert(unknown.result === "unknown" && !("semantic_authority" in unknown), `${engine} derived authority from a null required fact`, unknown);

    for (const scoped of [
      { caseId: "case_wrong_tenant", tenant: "acme", principal: "agent_1" },
      { caseId: "case_wrong_principal", tenant: "acme", principal: "agent_1" },
    ]) {
      const decision = await evaluateCase({
        fixture: fixtureValue,
        factLoader,
        ...scoped,
        proposalId: `proposal_${engine}_${scoped.caseId}`,
        verifiedAt,
      });
      assert(decision.result === "unknown" && !("semantic_authority" in decision), `${engine} derived authority outside trusted scope`, decision);
    }

    const checkedAt = new Date(Date.parse(verifiedAt) + 1_000).toISOString();
    if (composite) {
      const empty = await evaluateCase({ fixture: fixtureValue, factLoader, caseId: "offer_empty", proposalId: "empty_composite", verifiedAt });
      assert(empty.result === "unknown", `${engine} null composite relationship must not resolve a target`, empty);
    }
    const store = new MemoryIntentStore();
    const job = writebackJob(engine, fixtureValue, automatic, `proposal_${engine}_auto`);
    const verifier = createSemanticActionVerifier({ registry: fixtureValue.registry, clock: () => checkedAt });
    const apply = engine === "postgres" ? applyPostgresJob : applyMysqlJob;
    const config = runnerConfig(engine, urls.write, store, verifier);
    const applied = await apply(job, config);
    assert(applied.status === "applied" && applied.affected_rows === 1, `${engine} did not apply one reverified effect`, applied);
    const appliedRow = await row(engine, handles.admin, "case_auto");
    assert(appliedRow?.status === "scheduled" && Number(appliedRow?.version) === 8, `${engine} applied row does not match the exact effect`, appliedRow);

    const replayed = await apply(job, config);
    const replayedRow = await row(engine, handles.admin, "case_auto");
    assert(replayed.status === "already_applied" && Number(replayedRow?.version) === 8, `${engine} replay touched the source row`, { replayed, replayedRow });

    const staleDecision = await evaluateCase({
      fixture: fixtureValue,
      factLoader,
      caseId: "case_stale",
      proposalId: `proposal_${engine}_stale`,
      verifiedAt,
    });
    assert(staleDecision.result === "eligible", `${engine} stale fixture was not initially eligible`, staleDecision);
    await setRisk(engine, handles.admin, "case_stale", "high");
    const staleJob = writebackJob(engine, fixtureValue, staleDecision, `proposal_${engine}_stale`);
    const staleResult = await apply(staleJob, runnerConfig(engine, urls.write, new MemoryIntentStore(), verifier));
    const staleRow = await row(engine, handles.admin, "case_stale");
    assert(staleResult.status !== "applied" && staleResult.error_code === "SEMANTIC_AUTHORITY_STALE", `${engine} did not reject stale authoritative facts`, staleResult);
    assert(staleRow?.status === "open" && Number(staleRow?.version) === 7, `${engine} stale refusal changed the source row`, staleRow);

    const deactivatedDecision = await evaluateCase({
      fixture: fixtureValue,
      factLoader,
      caseId: "case_deactivated",
      proposalId: `proposal_${engine}_deactivated`,
      verifiedAt,
    });
    assert(deactivatedDecision.result === "eligible", `${engine} deactivation fixture was not initially eligible`, deactivatedDecision);
    const changedRegistry = createActionRuleRegistry({
      name: fixtureValue.registry.name,
      approval_classes: fixtureValue.approvalClasses,
      rules: [{
        read_boundary_name: "support_cases.reviewed_read",
        read_boundary_digest: digest({ read: engine, revision: 1 }),
        action_boundary_name: "support_cases.actions",
        action_boundary_digest: digest({ action: engine, revision: 2 }),
        compiled: fixtureValue.compiled,
        activated_at: new Date().toISOString(),
      }],
    });
    const deactivatedJob = writebackJob(engine, fixtureValue, deactivatedDecision, `proposal_${engine}_deactivated`);
    const deactivatedResult = await apply(deactivatedJob, runnerConfig(
      engine,
      urls.write,
      new MemoryIntentStore(),
      createSemanticActionVerifier({ registry: changedRegistry, clock: () => checkedAt }),
    ));
    const deactivatedRow = await row(engine, handles.admin, "case_deactivated");
    assert(deactivatedResult.status !== "applied" && deactivatedResult.error_code === "SEMANTIC_AUTHORITY_STALE", `${engine} accepted stale Action Boundary authority`, deactivatedResult);
    assert(deactivatedRow?.status === "open" && Number(deactivatedRow?.version) === 7, `${engine} deactivated authority changed the source row`, deactivatedRow);

    const tampered = structuredClone(job);
    tampered.patch.status = "closed";
    let tamperRejected = false;
    try { parseWritebackJob(tampered); }
    catch { tamperRejected = true; }
    assert(tamperRejected, `${engine} accepted a patch that differed from the Runner-derived effect`);

    if (composite) {
      const selected = await evaluateCase({ fixture: fixtureValue, factLoader, caseId: "case_human", proposalId: "changed_link", verifiedAt });
      assert(selected.result === "eligible", "Link-change fixture must start eligible", selected);
      await execute(engine, handles.admin, "UPDATE semantic_case_offers SET case_id = 'case_deactivated' WHERE offer_id = 'case_human'");
      const changed = await apply(writebackJob(engine, fixtureValue, selected, "changed_link"), runnerConfig(engine, urls.write, new MemoryIntentStore(), verifier));
      assert(changed.status !== "applied", `${engine} applied a proposal after its selected link changed`, changed);
      assert((await row(engine, handles.admin, "case_human")).status === "open", "Original linked row changed after refusal");
      assert((await row(engine, handles.admin, "case_deactivated")).status === "open", "Replacement linked row changed after refusal");
      await execute(engine, handles.admin, engine === "postgres"
        ? "ALTER TABLE semantic_case_offers DROP CONSTRAINT semantic_offer_case_fk"
        : "ALTER TABLE semantic_case_offers DROP FOREIGN KEY semantic_offer_case_fk");
      let refused = false;
      try {
        const decision = await evaluateCase({ fixture: fixtureValue, factLoader, caseId: "case_deactivated", proposalId: "missing_fk", verifiedAt });
        refused = decision.result !== "eligible";
      } catch (error) { refused = error.code === "ACTION_RULE_AUTHORITY_STALE"; }
      assert(refused, `${engine} accepted a removed composite schema proof`);
    }
    process.stdout.write(`PASS ${engine}${composite ? " composite related UPDATE" : " direct UPDATE"}: live semantic evaluation, scope, approval, re-verification, apply, replay, and stale-authority refusal\n`);
  } finally {
    await handles.facts.end();
    await handles.admin.end();
  }
}

const postgresPort = await availablePort();
let mysqlPort = await availablePort();
while (mysqlPort === postgresPort) mysqlPort = await availablePort();
const composeEnv = {
  SYNAPSOR_FLEET_POSTGRES_PORT: `127.0.0.1:${postgresPort}`,
  SYNAPSOR_FLEET_MYSQL_PORT: `127.0.0.1:${mysqlPort}`,
};
const composeArgs = ["compose", "-p", composeProject, "-f", composeFile];
const urls = {
  postgres: {
    admin: `postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:${postgresPort}/synapsor_fleet`,
    write: `postgresql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:${postgresPort}/synapsor_fleet`,
  },
  mysql: {
    admin: `mysql://root:root_password@127.0.0.1:${mysqlPort}/synapsor_fleet`,
    write: `mysql://synapsor_crud_ledger:synapsor_crud_ledger_password@127.0.0.1:${mysqlPort}/synapsor_fleet`,
  },
};

try {
  run("docker", [...composeArgs, "up", "-d", "postgres", "mysql"], { inherit: true, env: composeEnv });
  await waitForDatabases(composeEnv);
  await verifyEngine("postgres", urls.postgres);
  await verifyEngine("mysql", urls.mysql);
  await verifyEngine("postgres", urls.postgres, true);
  await verifyEngine("mysql", urls.mysql, true);
  process.stdout.write("PASS live PostgreSQL/MySQL semantic Action Rule gate\n");
} finally {
  run("docker", [...composeArgs, "down", "-v", "--remove-orphans"], {
    allowFailure: true,
    inherit: true,
    env: composeEnv,
  });
}
