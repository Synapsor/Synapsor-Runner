import crypto from "node:crypto";
import path from "node:path";
import mysql from "mysql2/promise";
import {
  resolveActivatedActionRule,
  type ActionRuleFactLoaderAdapterV1,
  type ActivatedActionRuleV1,
} from "@synapsor-runner/action-rules";
import {
  createSemanticActionRuntime,
  createSubjectReferenceService,
  resolveSemanticSupervisedWorkerEligibility,
  resolveRuntimeSourceCredential,
  resolveTrustedContext,
  subjectReferenceScopeFingerprints,
  type RuntimeConfig,
  type RuntimeCapabilityConfig,
  type SemanticActionRuntime,
  type SubjectReferenceService,
  type TenantCredentialResolver,
  type TrustedContext,
} from "@synapsor-runner/mcp-server";
import type { ProposalRuntimeStore } from "@synapsor-runner/proposal-store";
import {
  bindPostgresActionRuleScope,
  configurePostgresActionRuleTransaction,
  createPostgresActionRuleFactLoader,
  createPostgresPool,
  postgresActionRuleIsolation,
  type PostgresActionRuleRlsScope,
} from "@synapsor-runner/postgres";
import {
  configureMysqlActionRuleTransaction,
  createMysqlActionRuleFactLoader,
  mysqlActionRuleIsolation,
} from "@synapsor-runner/mysql";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  loadActiveActionRuleAuthority,
  type LoadedActiveActionRuleAuthorityV1,
} from "./action-rule-authority.js";
import { loadExploreAuditKey } from "./scoped-explore.js";

type SemanticFactSession = {
  fact_loader: ActionRuleFactLoaderAdapterV1;
  close(): Promise<void>;
};

export type ActionRuleRuntimeServices = {
  authority: LoadedActiveActionRuleAuthorityV1;
  subjectReferences: SubjectReferenceService;
  semanticActions: SemanticActionRuntime;
  key: Buffer;
  deployment_scope: string;
  workflow_session_id: string;
};

export type ActionRuleRuntimeServiceInput = {
  projectRoot: string;
  config: RuntimeConfig;
  env?: NodeJS.ProcessEnv;
  store: ProposalRuntimeStore;
  key?: Buffer;
  deployment_scope?: string;
  workflow_session_id?: string;
  trustedContext?: TrustedContext;
  credentialResolver?: TenantCredentialResolver;
  authorityLoader?: () => Promise<LoadedActiveActionRuleAuthorityV1>;
  factSessionFactory?: (input: {
    activated: ActivatedActionRuleV1;
    config: RuntimeConfig;
    env: NodeJS.ProcessEnv;
    trustedContext: TrustedContext;
    credentialResolver?: TenantCredentialResolver;
  }) => Promise<SemanticFactSession>;
};

export async function createOptionalReadActionRuleRuntimeServices(
  input: ActionRuleRuntimeServiceInput,
  onUnavailable?: (error: unknown) => void,
): Promise<ActionRuleRuntimeServices | undefined> {
  try {
    return await createOptionalActionRuleRuntimeServices(input);
  } catch (error) {
    onUnavailable?.(error);
    return undefined;
  }
}

export async function createOptionalActionRuleRuntimeServices(
  input: ActionRuleRuntimeServiceInput,
): Promise<ActionRuleRuntimeServices | undefined> {
  const projectRoot = path.resolve(input.config.action_rules?.project_root ?? input.projectRoot);
  if (input.config.action_rules?.project_root
    && projectRoot !== path.resolve(input.projectRoot)) {
    throw new Error("ACTION_RULE_PROJECT_ROOT_MISMATCH: the runtime entry point does not match the configured Action Rule authority project.");
  }
  let authority: LoadedActiveActionRuleAuthorityV1;
  const authorityLoader = input.authorityLoader
    ?? (async () => await loadActiveActionRuleAuthority(projectRoot));
  try {
    authority = await authorityLoader();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const configuredKeyEnvironment = input.config.action_rules?.subject_reference_hmac_key_env;
  const configuredKey = configuredKeyEnvironment
    ? environmentValue(input.env ?? process.env, configuredKeyEnvironment)
    : undefined;
  if (configuredKeyEnvironment && !configuredKey) {
    throw new Error(`ACTION_RULE_SUBJECT_KEY_MISSING: ${configuredKeyEnvironment} is required for the shared Action Rule runtime.`);
  }
  const key = input.key
    ?? (configuredKey === undefined ? await loadExploreAuditKey(projectRoot) : Buffer.from(configuredKey, "utf8"));
  if (key.byteLength < 32) throw new Error("ACTION_RULE_SUBJECT_KEY_INVALID: at least 32 bytes of Runner-owned key material are required.");
  const deploymentScope = input.deployment_scope
    ?? input.config.action_rules?.subject_reference_namespace
    ?? projectRoot;
  const workflowSessionId = input.workflow_session_id ?? localActionWorkflowId(projectRoot, key);
  const loadAuthority = authorityLoader;
  const registry = async () => (await loadAuthority()).registry;
  const subjectReferences = createSubjectReferenceService({
    store: input.store,
    registry,
    key,
  });
  const env = input.env ?? process.env;
  const factSessionFactory = input.factSessionFactory ?? openSemanticFactSession;
  const semanticActions = createSemanticActionRuntime({
    store: input.store,
    registry,
    subjectReferences,
    onProposalReady: async ({ proposal, activated }) => {
      if (proposal.state === "applied") {
        return { execution: "completed", source_database_changed: true };
      }
      if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
        return { execution: "human_review", source_database_changed: false };
      }
      const eligibility = resolveSemanticSupervisedWorkerEligibility(input.config, activated, { phase: "queue" });
      if (!eligibility.eligible || !eligibility.policy || !eligibility.action_boundary_digest) {
        return { execution: "not_enabled", source_database_changed: false };
      }
      if (!input.store.enqueueWorkerProposal) {
        return { execution: "held", source_database_changed: false };
      }
      try {
        await input.store.enqueueWorkerProposal({
          proposal_id: proposal.proposal_id,
          execution_mode: "supervised_worker",
          contract_digest: eligibility.action_boundary_digest,
          max_attempts: eligibility.policy.max_attempts,
          queue_limit: eligibility.policy.queue_limit,
        });
        return { execution: "queued", source_database_changed: false };
      } catch {
        return { execution: "held", source_database_changed: false };
      }
    },
    resolveContext: async (expected) => {
      const current = resolveActivatedActionRule((await loadAuthority()).registry, expected.compiled.outcome);
      assertSameRuleRevision(expected, current);
      const trustedContext = resolveTrustedContext(
        input.config,
        env,
        semanticContextCapability(current),
        input.trustedContext,
      );
      const scope = subjectReferenceScopeFingerprints({
        key,
        deployment_scope: deploymentScope,
        source_id: current.compiled.source,
        tenant: trustedContext.tenant_id,
        principal: trustedContext.principal,
      });
      const factSession = await factSessionFactory({
        activated: current,
        config: input.config,
        env,
        trustedContext,
        ...(input.credentialResolver ? { credentialResolver: input.credentialResolver } : {}),
      });
      return {
        trusted_context: trustedContext,
        subject_authority: {
          source_id: current.compiled.source,
          read_boundary_digest: current.read_boundary_digest,
          generation_lock_fingerprint: current.compiled.generation_lock_fingerprint,
          ...scope,
          workflow_session_id: workflowSessionId,
        },
        fact_loader: factSession.fact_loader,
        close: factSession.close,
      };
    },
  });
  return {
    authority,
    subjectReferences,
    semanticActions,
    key,
    deployment_scope: deploymentScope,
    workflow_session_id: workflowSessionId,
  };
}

export function semanticContextCapability(activated: ActivatedActionRuleV1): RuntimeCapabilityConfig {
  const target = activated.compiled.target_resource;
  const envelope = activated.compiled.effect_envelope;
  return {
    name: activated.compiled.outcome,
    kind: "proposal",
    source: activated.compiled.source,
    context: activated.compiled.context,
    target: {
      schema: target.schema,
      table: target.table,
      primary_key: target.primary_key,
      ...(envelope.tenant_key === undefined ? {} : { tenant_key: envelope.tenant_key }),
      ...(envelope.principal_scope_key === undefined
        ? {}
        : { principal_scope_key: envelope.principal_scope_key }),
    },
    ...(envelope.organization_scope === undefined
      ? {}
      : { organization_scope: envelope.organization_scope }),
    args: {},
    lookup: { id_from_arg: target.primary_key },
    visible_columns: [],
  };
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function authenticatedActionWorkflowId(authenticationFingerprint: string): string {
  const fingerprint = authenticationFingerprint.trim();
  if (!fingerprint || fingerprint.length > 512) throw new Error("ACTION_RULE_WORKFLOW_INVALID: authenticated session binding is unavailable.");
  return `http_${canonicalJsonDigest({
    schema_version: "synapsor.action-workflow.v1",
    authentication_fingerprint: fingerprint,
  }).slice("sha256:".length)}`;
}

function localActionWorkflowId(projectRoot: string, key: Buffer): string {
  return `local_${crypto.createHmac("sha256", key)
    .update("synapsor/action-workflow/v1\0", "utf8")
    .update(projectRoot, "utf8")
    .digest("hex")}`;
}

function assertSameRuleRevision(expected: ActivatedActionRuleV1, current: ActivatedActionRuleV1): void {
  if (expected.action_boundary_digest !== current.action_boundary_digest
    || expected.read_boundary_digest !== current.read_boundary_digest
    || expected.compiled.rule_digest !== current.compiled.rule_digest
    || expected.compiled.compiled_plan_digest !== current.compiled.compiled_plan_digest) {
    throw new Error("ACTION_RULE_AUTHORITY_STALE: the activated semantic rule changed during the request.");
  }
}

async function openSemanticFactSession(input: {
  activated: ActivatedActionRuleV1;
  config: RuntimeConfig;
  env: NodeJS.ProcessEnv;
  trustedContext: TrustedContext;
  credentialResolver?: TenantCredentialResolver;
}): Promise<SemanticFactSession> {
  const sourceName = input.activated.compiled.source;
  const source = input.config.sources?.[sourceName];
  if (!source || source.engine !== input.activated.compiled.target_resource.engine) {
    throw new Error("ACTION_RULE_SOURCE_UNAVAILABLE: the activated rule source is not present in the runtime config.");
  }
  const credential = await resolveRuntimeSourceCredential({
    sourceName,
    source,
    context: input.trustedContext,
    env: input.env,
    ...(input.credentialResolver ? { resolver: input.credentialResolver } : {}),
    access: "read",
  });
  if (source.engine === "postgres") {
    const pool = createPostgresPool(credential.connectionUrl, {
      max: 1,
      connectionTimeoutMillis: source.pool?.connection_timeout_ms ?? 3_000,
      idleTimeoutMillis: source.pool?.idle_timeout_ms ?? 30_000,
    });
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      const isolation = postgresActionRuleIsolation(
        input.activated.compiled.verification_boundary.transaction.isolation,
      );
      await client.query(`BEGIN ISOLATION LEVEL ${isolation} READ ONLY`);
      transactionStarted = true;
      await configurePostgresActionRuleTransaction(client);
      const databaseScope: PostgresActionRuleRlsScope | undefined = source.database_scope?.mode === "postgres_rls"
        ? {
          tenantSetting: source.database_scope.tenant_setting,
          ...(source.database_scope.principal_setting
            ? { principalSetting: source.database_scope.principal_setting }
            : {}),
          tenantId: input.trustedContext.tenant_id,
          principal: input.trustedContext.principal,
        }
        : undefined;
      if (databaseScope) await bindPostgresActionRuleScope(client, databaseScope);
      return {
        fact_loader: createPostgresActionRuleFactLoader(client, databaseScope),
        close: async () => {
          if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
          client.release();
          await pool.end();
        },
      };
    } catch (error) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  const connection = await mysql.createConnection({
    uri: credential.connectionUrl,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  let transactionStarted = false;
  try {
    const isolation = mysqlActionRuleIsolation(
      input.activated.compiled.verification_boundary.transaction.isolation,
    );
    await connection.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
    await connection.query("SET TRANSACTION READ ONLY");
    await connection.beginTransaction();
    transactionStarted = true;
    await configureMysqlActionRuleTransaction(connection);
    return {
      fact_loader: createMysqlActionRuleFactLoader(connection),
      close: async () => {
        if (transactionStarted) await connection.rollback().catch(() => undefined);
        await connection.end();
      },
    };
  } catch (error) {
    if (transactionStarted) await connection.rollback().catch(() => undefined);
    await connection.end().catch(() => undefined);
    throw error;
  }
}
