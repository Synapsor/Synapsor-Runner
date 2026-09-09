import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withProjectRuntimeAdmission } from "./project-runtime-admission.js";
import mysql from "mysql2/promise";
import {
  ActionRuleError,
  resolveActivatedActionRule,
  type ActionRuleFactLoaderAdapterV1,
  type ActivatedActionRuleV1,
} from "@synapsor-runner/action-rules";
import {
  createInactiveSemanticActionRuntime,
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
  type CatalogAuthorization,
  ScopedCatalogSession,
  createDelegatedSemanticRuntime,
  createOwnerRuntimeJwtAuthenticator,
  OwnerRuntimeError,
  type DelegatedRequestContext,
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
  createActiveActionRuleAuthorityLoader,
  readActionRuleAuthorityActivation,
  type LoadedActiveActionRuleAuthorityV1,
} from "./action-rule-authority.js";
import { loadExploreAuditKey } from "./scoped-explore.js";
import { assertRuntimeControlPolicyContinuity, borrowRuntimeControlPolicies } from "./control-policy-store.js";
import { readOperatorExecutionConfig } from "./control-policy-execution.js";

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
  resolveCatalogAuthorization?: () => Promise<CatalogAuthorization>;
  catalogSession?: ScopedCatalogSession;
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
  // Retain call-site compatibility; fatal errors must not announce a Read fallback.
  _onUnavailable?: (error: unknown) => void,
): Promise<Omit<ActionRuleRuntimeServices, "authority"> | undefined> {
  return withProjectRuntimeAdmission(input.projectRoot, async (root) => createAdmittedReadActionServices(await canonicalActionInput(input, root)));
}

async function createAdmittedReadActionServices(input: ActionRuleRuntimeServiceInput): Promise<Omit<ActionRuleRuntimeServices, "authority"> | undefined> {
  // A wrong control store is a deployment failure, not optional Action absence.
  const projectRoot = path.resolve(input.config.action_rules?.project_root ?? input.projectRoot);
  const policyStore = await borrowRuntimeControlPolicies(projectRoot, input.store);
  const initial = await createOptionalActionRuleRuntimeServices(input);
  if (initial) return initial;
  const referenceContext = await actionReferenceContext(input, path.resolve(input.config.action_rules?.project_root ?? input.projectRoot));
  const inactive = createInactiveSemanticActionRuntime();
  // Keep the same client usable when its first Action is activated later.
  // Reuse the normal authority loader and validators; absence grants nothing.
  const catalogSession = input.catalogSession ?? new ScopedCatalogSession();
  const load = createActiveActionRuleAuthorityLoader(projectRoot, policyStore);
  const authorityLoader = (policyStore ? undefined : input.authorityLoader) ?? (() => load({ dependency_check: "report" }));
  let ready: ActionRuleRuntimeServices | undefined;
  let pending: Promise<ActionRuleRuntimeServices | undefined> | undefined;
  const current = async () => {
    await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
    if (ready) {
      try { await authorityLoader(); return ready; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT"
          || await readActionRuleAuthorityActivation(projectRoot, policyStore) !== undefined) throw error;
        ready = undefined;
        return undefined;
      }
    }
    pending ??= createOptionalActionRuleRuntimeServices({ ...input, authorityLoader, key: referenceContext.key, catalogSession });
    try {
      ready = await pending;
      await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
      return ready;
    }
    finally { pending = undefined; }
  };
  return admitActionServices({
    ...referenceContext,
    semanticActions: { ...inactive, callTool: async (name, args) =>
      ((await current())?.semanticActions ?? inactive).callTool(name, args) },
    subjectReferences: {
      observationRequirement: async (resource) => (await current())?.subjectReferences.observationRequirement(resource),
      issue: async (request) => (await current())?.subjectReferences.issue(request) ?? [],
      claim: async (request) => {
        const services = await current();
        if (!services) throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "No Action authority is active.");
        return services.subjectReferences.claim(request);
      },
    },
  }, projectRoot);
}

export async function createOptionalActionRuleRuntimeServices(
  input: ActionRuleRuntimeServiceInput,
): Promise<ActionRuleRuntimeServices | undefined> {
  return withProjectRuntimeAdmission(input.projectRoot, async (root) => createAdmittedActionServices(await canonicalActionInput(input, root)));
}

async function createAdmittedActionServices(input: ActionRuleRuntimeServiceInput): Promise<ActionRuleRuntimeServices | undefined> {
  const projectRoot = path.resolve(input.config.action_rules?.project_root ?? input.projectRoot);
  if (input.config.action_rules?.project_root
    && projectRoot !== path.resolve(input.projectRoot)) {
    throw new Error("ACTION_RULE_PROJECT_ROOT_MISMATCH: the runtime entry point does not match the configured Action Rule authority project.");
  }
  let authority: LoadedActiveActionRuleAuthorityV1;
  const policyStore = await borrowRuntimeControlPolicies(projectRoot, input.store);
  const readAuthority = (policyStore ? undefined : input.authorityLoader)
    ?? (() => {
      const load = createActiveActionRuleAuthorityLoader(projectRoot, policyStore);
      return () => load({ dependency_check: "report" });
    })();
  const authorityLoader = async () => {
    await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
    const current = await readAuthority();
    await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
    return current;
  };
  try {
    authority = await authorityLoader();
  } catch (error) {
    // A missing Read/revision beneath a persisted activation is not inactivity.
    if ((error as NodeJS.ErrnoException).code === "ENOENT"
      && await readActionRuleAuthorityActivation(projectRoot, policyStore) === undefined) return undefined;
    throw error;
  }
  const { key, deployment_scope: deploymentScope, workflow_session_id: workflowSessionId } = await actionReferenceContext(input, projectRoot);
  const loadAuthority = authorityLoader;
  const registry = async () => (await loadAuthority()).registry;
  const env = input.env ?? process.env;
  const delegationConfig = input.config.action_rules?.owner_delegation;
  if (delegationConfig && !policyStore) throw new OwnerRuntimeError("DELEGATION_POLICY_STORE_REQUIRED");
  const delegatedRuntime = delegationConfig && policyStore ? createDelegatedSemanticRuntime({
    repository: policyStore.repository, deployment_id: policyStore.deployment_id, parent_name: delegationConfig.parent_name,
    authenticate: createOwnerRuntimeJwtAuthenticator(delegationConfig.authentication, env),
    resolveRules: async () => (await registry()).rules.map((rule) => rule.compiled),
  }) : undefined;
  const beginDelegation = async () => {
    await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
    return delegatedRuntime?.begin(environmentValue(env, delegationConfig!.credential_env) ?? "");
  };
  const baseReferences = createSubjectReferenceService({
    store: input.store,
    registry,
    key,
  });
  const referencesFor = async (context: DelegatedRequestContext) => {
    const current = await registry();
    await context.assertCurrent();
    return createSubjectReferenceService({ store: input.store, key,
      registry: { ...current, rules: current.rules.filter((rule) => context.authorization.allowed_outcomes.includes(rule.compiled.outcome)) } });
  };
  const boundReferenceContext = (context: DelegatedRequestContext, request: Parameters<SubjectReferenceService["issue"]>[0]
    | Parameters<SubjectReferenceService["claim"]>[0]) => {
    const expected = subjectReferenceScopeFingerprints({ key, deployment_scope: deploymentScope, source_id: request.source_id,
      tenant: context.trusted_context.tenant_id, principal: context.trusted_context.principal });
    if (request.tenant_scope_fingerprint !== expected.tenant_scope_fingerprint
      || request.principal_scope_fingerprint !== expected.principal_scope_fingerprint) throw new OwnerRuntimeError("DELEGATION_IDENTITY_MISMATCH");
    return { ...request, workflow_session_id: context.workflowSessionId(request.workflow_session_id) };
  };
  const subjectReferences: SubjectReferenceService = delegatedRuntime ? {
    observationRequirement: async (resource) => {
      const context = (await beginDelegation())!;
      return (await referencesFor(context)).observationRequirement(resource);
    },
    issue: async (request) => {
      const context = (await beginDelegation())!;
      const bound = boundReferenceContext(context, request);
      const result = await (await referencesFor(context)).issue({ ...request, workflow_session_id: bound.workflow_session_id });
      await context.assertCurrent();
      return result;
    },
    claim: async (request) => {
      const context = (await beginDelegation())!;
      const bound = boundReferenceContext(context, request);
      const result = await (await referencesFor(context)).claim({ ...request, workflow_session_id: bound.workflow_session_id });
      await context.assertCurrent();
      return result;
    },
  } : baseReferences;
  const factSessionFactory = input.factSessionFactory ?? openSemanticFactSession;
  const semanticActions = createSemanticActionRuntime({
    store: input.store,
    registry,
    subjectReferences,
    delegationRequired: Boolean(delegatedRuntime),
    catalogSession: input.catalogSession,
    resolveCatalogAuthorization: async (currentRegistry) => {
      const first = currentRegistry.rules[0];
      const sourceContext = () => resolveTrustedContext(input.config, env,
        first ? semanticContextCapability(first) : undefined, input.trustedContext);
      const existing = input.resolveCatalogAuthorization ? await input.resolveCatalogAuthorization() : {
        scope_key: canonicalJsonDigest({ deployment: deploymentScope, session: workflowSessionId, context: sourceContext() }), revision: "deployment_authority" };
      const delegated = await beginDelegation();
      if (!delegated) return existing;
      assertDelegatedIdentity(delegated, sourceContext());
      const grant = delegated.authorization;
      return { scope_key: canonicalJsonDigest({ base: existing.scope_key, delegated: grant.scope_key }),
        revision: canonicalJsonDigest({ base: existing.revision, delegated: grant.revision }),
        allowed_outcomes: grant.allowed_outcomes.filter((outcome) => !existing.allowed_outcomes || existing.allowed_outcomes.includes(outcome)) };
    },
    unavailableOutcomes: async () => (await loadAuthority()).unavailable_outcomes ?? [],
    onProposalReady: async ({ proposal, activated }) => {
      if (proposal.state === "applied") {
        return { execution: "completed", source_database_changed: true };
      }
      if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
        return { execution: "human_review", source_database_changed: false };
      }
      try {
        await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
        const currentConfig = policyStore ? (await readOperatorExecutionConfig({
          projectRoot, config: input.config, policyStore,
        })).config : input.config;
        const eligibility = resolveSemanticSupervisedWorkerEligibility(currentConfig, activated, { phase: "queue" });
        if (!eligibility.eligible || !eligibility.policy || !eligibility.action_boundary_digest) {
          return { execution: "not_enabled", source_database_changed: false };
        }
        if (!input.store.enqueueWorkerProposal) {
          return { execution: "held", source_database_changed: false };
        }
        await assertRuntimeControlPolicyContinuity(projectRoot, policyStore);
        const delegated = await beginDelegation();
        if (delegated) {
          if (proposal.change_set.schema_version !== "synapsor.change-set.v4") throw new OwnerRuntimeError("DELEGATION_PROOF_REQUIRED");
          await delegated.checkExisting(proposal.proposal_id, proposal.change_set.semantic_authority);
        }
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
      const delegated = await beginDelegation();
      const loaded = await loadAuthority();
      if (loaded.unavailable_outcomes?.includes(expected.compiled.outcome)) {
        throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "This outcome requires operator review of its Read dependency.");
      }
      const current = resolveActivatedActionRule(loaded.registry, expected.compiled.outcome);
      assertSameRuleRevision(expected, current);
      const trustedContext = resolveTrustedContext(
        input.config,
        env,
        semanticContextCapability(current),
        input.trustedContext,
      );
      if (delegated) assertDelegatedIdentity(delegated, trustedContext);
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
        ...(delegated ? { delegation: delegated } : {}),
        close: factSession.close,
      };
    },
  });
  return admitActionServices({
    authority,
    subjectReferences,
    semanticActions,
    key,
    deployment_scope: deploymentScope,
    workflow_session_id: workflowSessionId,
  }, projectRoot);
}

function assertDelegatedIdentity(delegated: DelegatedRequestContext, context: TrustedContext): void {
  if (delegated.trusted_context.tenant_id !== context.tenant_id || delegated.trusted_context.principal !== context.principal) {
    throw new OwnerRuntimeError("DELEGATION_IDENTITY_MISMATCH");
  }
}

async function canonicalActionInput(input: ActionRuleRuntimeServiceInput, root: string): Promise<ActionRuleRuntimeServiceInput> {
  const configured = input.config.action_rules?.project_root;
  if (configured && await fs.realpath(configured) !== root) {
    throw new Error("ACTION_RULE_PROJECT_ROOT_MISMATCH: the runtime entry point does not match the configured Action Rule authority project.");
  }
  return { ...input, projectRoot: root, config: configured
    ? { ...input.config, action_rules: { ...input.config.action_rules!, project_root: root } } : input.config };
}

function admitActionServices<T extends Omit<ActionRuleRuntimeServices, "authority">>(services: T, projectRoot: string): T {
  const call = services.semanticActions.callTool.bind(services.semanticActions);
  services.semanticActions.callTool = (name, args) => withProjectRuntimeAdmission(projectRoot, () => call(name, args));
  const references = services.subjectReferences;
  const observation = references.observationRequirement.bind(references), issue = references.issue.bind(references), claim = references.claim.bind(references);
  references.observationRequirement = (resource) => withProjectRuntimeAdmission(projectRoot, () => observation(resource));
  references.issue = (request) => withProjectRuntimeAdmission(projectRoot, () => issue(request));
  references.claim = (request) => withProjectRuntimeAdmission(projectRoot, () => claim(request));
  return services;
}

async function actionReferenceContext(input: ActionRuleRuntimeServiceInput, projectRoot: string) {
  const keyEnvironment = input.config.action_rules?.subject_reference_hmac_key_env;
  const configuredKey = keyEnvironment ? environmentValue(input.env ?? process.env, keyEnvironment) : undefined;
  if (keyEnvironment && !configuredKey) throw new Error(`ACTION_RULE_SUBJECT_KEY_MISSING: ${keyEnvironment} is required for the shared Action Rule runtime.`);
  const key = input.key ?? (configuredKey === undefined ? await loadExploreAuditKey(projectRoot) : Buffer.from(configuredKey, "utf8"));
  if (key.byteLength < 32) throw new Error("ACTION_RULE_SUBJECT_KEY_INVALID: at least 32 bytes of Runner-owned key material are required.");
  return { key, deployment_scope: input.deployment_scope ?? input.config.action_rules?.subject_reference_namespace ?? projectRoot,
    workflow_session_id: input.workflow_session_id ?? localActionWorkflowId(projectRoot, key) };
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
