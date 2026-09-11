import {
  ActionRuleError,
  actionRuleDiscoveryContract,
  actionRuleDiscoveryMetadata,
  snapshotActionRuleRegistry,
  evaluateSemanticActionEligibility,
  resolveActivatedApprovalClass,
  resolveActivatedActionRule,
  validateActionRuleInputs,
  type ActivatedActionRuleV1,
  type ActionRuleFactSetV1,
  type RuntimeActionRuleRegistryV1,
} from "@synapsor-runner/action-rules";
import {
  ProposalStoreError,
  type ProposalRuntimeStore,
  type StoredProposal,
} from "@synapsor-runner/proposal-store";
import {
  canonicalJsonDigest,
  canonicalJsonStringify,
  protocolVersions,
} from "@synapsor-runner/protocol";
import { buildDerivedChangeSet } from "./proposal-builder.js";
import { McpRuntimeError } from "./runtime-errors.js";
import type {
  LocalToolMetadata,
  SemanticActionContextResolver,
  SemanticActionRuntime,
  TrustedContext,
} from "./runtime-types.js";
import type {
  ResolvedSubjectRequest,
  SubjectReferenceService,
} from "./subject-references.js";
import { semanticActionInputSchema } from "./semantic-action-schema.js";
import { ScopedCatalogIndex, ScopedCatalogSession, type CatalogRequest } from "./scoped-catalog.js";
import { OwnerRuntimeError } from "./owner-runtime-identity.js";
import { PostgresRlsPrerequisiteError } from "@synapsor-runner/postgres";

export const DESCRIBE_ACTIONS_TOOL = "app.describe_actions";
export const REQUEST_CHANGE_TOOL = "app.request_change";

const OUTCOME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u;
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SUBJECT_REFERENCE_PATTERN = /^obj_[A-Za-z0-9_-]{32,128}$/u;

export function createInactiveSemanticActionRuntime(): SemanticActionRuntime {
  return {
    listTools: () => semanticActionToolMetadata(),
    hasTool: (name) => name === DESCRIBE_ACTIONS_TOOL || name === REQUEST_CHANGE_TOOL,
    async callTool(name, args) {
      if (name === DESCRIBE_ACTIONS_TOOL) {
        parseCatalogRequest(args);
        return { ok: true, actions: [], availability: "operator_review_required", source_database_changed: false };
      }
      if (name === REQUEST_CHANGE_TOOL) {
        parseRequestChange(args);
        throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "No reviewed Action authority is available. An operator must activate an Action Boundary; no proposal or source change was created.");
      }
      throw new McpRuntimeError("MCP_TOOL_NOT_FOUND", "The requested tool is not available.");
    },
  };
}

type RegistryLoader = RuntimeActionRuleRegistryV1
  | (() => RuntimeActionRuleRegistryV1 | Promise<RuntimeActionRuleRegistryV1>);

export type SemanticActionContinuation = {
  execution: "human_review" | "not_enabled" | "queued" | "held" | "completed";
  source_database_changed: boolean;
};

export type CatalogAuthorization = {
  scope_key: string;
  revision: string;
  /** Absent only for the deployment's unpartitioned operator-reviewed catalog. */
  allowed_outcomes?: readonly string[];
};

export function createSemanticActionRuntime(input: {
  store: ProposalRuntimeStore;
  registry: RegistryLoader;
  subjectReferences: SubjectReferenceService;
  resolveContext: SemanticActionContextResolver;
  resolveCatalogAuthorization: (registry: RuntimeActionRuleRegistryV1) => CatalogAuthorization | Promise<CatalogAuthorization>;
  catalogSession?: ScopedCatalogSession;
  delegationRequired?: boolean;
  unavailableOutcomes?: () => string[] | Promise<string[]>;
  onProposalReady?: (input: {
    proposal: StoredProposal;
    activated: ActivatedActionRuleV1;
  }) => Promise<SemanticActionContinuation>;
}): SemanticActionRuntime {
  const loadRegistry = async () => snapshotActionRuleRegistry(typeof input.registry === "function"
    ? await input.registry()
    : input.registry);
  const tools = semanticActionToolMetadata();
  const catalogSession = input.catalogSession ?? new ScopedCatalogSession();
  let cachedCatalog: { binding: string; index: ScopedCatalogIndex } | undefined;

  return {
    listTools: () => structuredClone(tools),
    hasTool: (name) => name === DESCRIBE_ACTIONS_TOOL || name === REQUEST_CHANGE_TOOL,
    async callTool(name, args) {
      if (name === DESCRIBE_ACTIONS_TOOL) {
        const registry = await loadRegistry();
        const authorization = await input.resolveCatalogAuthorization(registry);
        const request = parseCatalogRequest(args);
        const unavailable = await input.unavailableOutcomes?.() ?? [];
        const binding = canonicalJsonDigest({ registry: registry.digest, authorization, unavailable });
        if (!cachedCatalog || cachedCatalog.binding !== binding) {
          const allowed = authorization.allowed_outcomes ? new Set(authorization.allowed_outcomes) : undefined;
          const visible = registry.rules.filter((entry) => !allowed || allowed.has(entry.compiled.outcome));
          const unavailableSet = new Set(unavailable);
          const index = new ScopedCatalogIndex(visible.map((entry) => {
            const activated = resolveActivatedActionRule(registry, entry.compiled.outcome);
            const metadata = actionRuleDiscoveryMetadata(activated.compiled.rule);
            const description = metadata.title;
            const availability = unavailableSet.has(activated.compiled.outcome) ? "operator_review_required" : "available";
            return { id: activated.compiled.outcome, ...metadata,
              value: { outcome: activated.compiled.outcome, description, summary: metadata.summary, availability,
                subjects: activated.compiled.rule.subjects.map(({ binding, resource }) => ({ binding, resource })),
                eligibility: "not_checked" },
              detail: () => describeAction(registry, activated, availability),
            };
          }));
          cachedCatalog = { binding, index };
        }
        const current = await loadRegistry();
        const currentAuthorization = await input.resolveCatalogAuthorization(current);
        const currentUnavailable = await input.unavailableOutcomes?.() ?? [];
        if (canonicalJsonDigest({ registry: current.digest, authorization: currentAuthorization, unavailable: currentUnavailable }) !== binding) {
          throw new McpRuntimeError("CATALOG_CURSOR_INVALID", "Reviewed authority changed during discovery. Restart discovery with the current authorized catalog.");
        }
        return catalogSession.describe({ index: cachedCatalog.index, binding, request,
          legacy: Object.keys(args).length === 0, key: "actions", context: actionCatalogContext(Boolean(request.detail)) });
      }
      if (name !== REQUEST_CHANGE_TOOL) {
        throw new McpRuntimeError("MCP_TOOL_NOT_FOUND", "The requested Synapsor Action tool is not available.");
      }
      const request = parseRequestChange(args);
      try {
        const registry = await loadRegistry();
        const authorization = await input.resolveCatalogAuthorization(registry);
        if (authorization.allowed_outcomes && !authorization.allowed_outcomes.includes(request.outcome)) {
          throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "The requested outcome is not available in the current authorized catalog.");
        }
        const expected = resolveActivatedActionRule(registry, request.outcome);
        if ((await input.unavailableOutcomes?.() ?? []).includes(request.outcome)) {
          throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "This outcome needs operator review of its changed Read dependency. Other reviewed outcomes remain available. No proposal or source change was created.");
        }
        let businessInputs: ReturnType<typeof validateActionRuleInputs>;
        try {
          businessInputs = validateActionRuleInputs(expected.compiled.rule, request.inputs);
        } catch (error) {
          throw new McpRuntimeError("ARGUMENT_INVALID", error instanceof Error ? error.message : "Invalid reviewed business inputs.");
        }
        const resolvedContext = await input.resolveContext(expected);
        try {
          assertRuntimeContext(expected, resolvedContext);
          if (input.delegationRequired && !resolvedContext.delegation) throw new OwnerRuntimeError("DELEGATION_PROOF_REQUIRED");
          const claimed = await input.subjectReferences.claim({
            ...resolvedContext.subject_authority,
            outcome: request.outcome,
            subject_refs: request.subject_refs,
            inputs: businessInputs,
          });
          assertSameActivatedAuthority(expected, claimed.activated);

          const existing = await input.store.getProposal(claimed.proposal_id);
          if (existing !== undefined) {
            assertExistingProposal(existing, claimed);
            if (existing.change_set.schema_version === protocolVersions.changeSetV4) {
              if (Boolean(existing.change_set.semantic_authority.proof.delegation) !== Boolean(resolvedContext.delegation)) {
                throw new OwnerRuntimeError("DELEGATION_PROOF_REQUIRED");
              }
              await resolvedContext.delegation?.checkExisting(existing.proposal_id, existing.change_set.semantic_authority);
            }
            await ensureSemanticEvidence(input.store, existing);
            const continuation = input.onProposalReady
              ? await input.onProposalReady({ proposal: existing, activated: expected })
              : undefined;
            return await semanticProposalResult(input.store, existing, expected, "existing", continuation);
          }

          const verifiedAt = claimed.claimed_at;
          const decision = await evaluateSemanticActionEligibility({
            registry,
            outcome: request.outcome,
            subjects: claimed.subjects,
            trusted: trustedFacts(expected, resolvedContext.trusted_context, verifiedAt),
            adapter: resolvedContext.fact_loader,
            proposal_id: claimed.proposal_id,
            trusted_context_digest: claimed.trusted_context_digest,
            evidence_provenance_digest: claimed.evidence_provenance_digest,
            verified_at: verifiedAt,
            inputs: businessInputs,
            check_delegation: resolvedContext.delegation?.checkProposal,
          });
          if (decision.result !== "eligible") {
            await recordSemanticRefusal(input.store, {
              outcome: request.outcome,
              source: expected.compiled.source,
              table: `${expected.compiled.target_resource.schema}.${expected.compiled.target_resource.table}`,
              trustedContext: resolvedContext.trusted_context,
              result: decision.result,
              checkedAt: verifiedAt,
            });
            const unavailable = decision.result === "unknown";
            throw new McpRuntimeError(
              unavailable ? "SEMANTIC_ACTION_UNAVAILABLE" : "SEMANTIC_ACTION_NOT_ELIGIBLE",
              unavailable
                ? "Runner could not prove this reviewed outcome from current authoritative facts. No proposal or source change was created."
                : "Current authoritative facts do not permit this reviewed outcome. No proposal or source change was created.",
            );
          }

          const evidenceBundleId = `ev_rule_${claimed.proposal_id.slice("wrp_rule_".length)}`;
          const queryFingerprint = semanticQueryFingerprint(decision.semantic_authority.proof);
          const changeSet = buildDerivedChangeSet({
            decision,
            context: resolvedContext.trusted_context,
            proposalId: claimed.proposal_id,
            createdAt: claimed.claimed_at,
            evidenceBundleId,
            queryFingerprint,
          });
          let proposal: StoredProposal;
          try {
            proposal = await input.store.createProposal(changeSet);
          } catch (error) {
            if (error instanceof ProposalStoreError && error.code === "PROPOSAL_ALREADY_EXISTS") {
              throw new McpRuntimeError(
                "PROPOSAL_ALREADY_EXISTS",
                "An active proposal already exists for this reviewed subject and outcome.",
              );
            }
            throw error;
          }
          await ensureSemanticEvidence(input.store, proposal);
          await resolvedContext.delegation?.checkExisting(proposal.proposal_id, decision.semantic_authority);
          if (decision.approval.path === "automatic_eligible") {
            const approvalDecision = await input.store.approveProposalByPolicy(proposal.proposal_id, {
              policy: decision.approval.authority.name,
              proposal_hash: proposal.proposal_hash,
              proposal_version: proposal.proposal_version,
              reason: "Exact semantic Action Rule and reviewed automatic-approval policy matched current authoritative facts.",
              action_boundary: {
                name: decision.activated.action_boundary_name,
                digest: decision.activated.action_boundary_digest,
                limits: decision.approval.authority.shared_limits,
              },
              now: verifiedAt,
            });
            proposal = approvalDecision.proposal;
          }
          const continuation = input.onProposalReady
            ? await input.onProposalReady({ proposal, activated: decision.activated })
            : undefined;
          return await semanticProposalResult(input.store, proposal, decision.activated, "created", continuation);
        } finally {
          await resolvedContext.close?.();
        }
      } catch (error) {
        if (error instanceof McpRuntimeError) throw error;
        if (error instanceof PostgresRlsPrerequisiteError) {
          throw new McpRuntimeError("SEMANTIC_ACTION_DATABASE_REVIEW_REQUIRED",
            "Database row-filtering prerequisites are not satisfied. An operator must recheck database access in the saved setup before retrying. No proposal or source change was created.");
        }
        if (error instanceof OwnerRuntimeError) {
          throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "Current delegated authority could not be verified. No source change was executed. Refresh the authorized catalog before retrying.");
        }
        if (error instanceof ActionRuleError) {
          if (error.code === "ACTION_RULE_NOT_ELIGIBLE" && error.path === "outcome") {
            throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE",
              "The requested outcome is not available in the current authorized catalog. Refresh the action list before retrying. No proposal or source change was created.");
          }
          throw new McpRuntimeError(
            error.code === "ACTION_RULE_NOT_ELIGIBLE"
              ? "SEMANTIC_ACTION_NOT_ELIGIBLE"
              : "SEMANTIC_ACTION_UNAVAILABLE",
            error.code === "ACTION_RULE_NOT_ELIGIBLE"
              ? "Current authoritative facts do not permit this reviewed outcome. No proposal or source change was created."
              : "Runner could not prove this reviewed outcome from current authoritative facts. No proposal or source change was created.",
          );
        }
        throw error;
      }
    },
  };
}

function semanticActionToolMetadata(): LocalToolMetadata[] {
  return [
    {
      name: DESCRIBE_ACTIONS_TOOL,
      title: "Describe reviewed actions",
      description: "Search reviewed actions with query/limit/cursor, or use outcome alone for the complete request contract. Limit is a maximum; byte-bounded pages may contain fewer entries. Follow next_cursor until null. Search returns bounded summaries; an empty call retains a bounded compatibility page of full contracts. Browse or search a shortlist, inspect the chosen outcome, then request it. Availability is not eligibility. No source rows are read and no authority is granted.",
      kind: "action_catalog",
      input_schema: { query: { type: "string", required: false }, limit: { type: "number", required: false },
        cursor: { type: "string", required: false }, outcome: { type: "string", required: false } },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        raw_sql_exposed: false,
        approval_or_commit_tool: false,
      },
    },
    {
      name: REQUEST_CHANGE_TOOL,
      title: "Request a reviewed change",
      description: "Request one activated business outcome using opaque Explore references and only the typed business inputs described by app.describe_actions. Runner validates those inputs and reloads authoritative facts to derive an immutable proposal; this tool cannot approve, apply, or accept an arbitrary patch.",
      kind: "semantic_action",
      input_schema: {
        outcome: { type: "string", required: true },
        subject_refs: { type: "object", required: true },
        inputs: { type: "object", required: false },
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        raw_sql_exposed: false,
        approval_or_commit_tool: false,
      },
    },
  ];
}

function describeAction(registry: RuntimeActionRuleRegistryV1, activated: ActivatedActionRuleV1, availability: string): Record<string, unknown> {
  return actionRuleDiscoveryContract(activated.compiled, resolveActivatedApprovalClass(registry, activated.compiled.outcome).mode, availability);
}

function actionCatalogContext(exactDetail = false): Record<string, unknown> {
  return {
    ...(!exactDetail ? { request_shape: {
      outcome: "<one listed outcome>",
      subject_refs: { "<binding from the selected action's request_shape>": "obj_<opaque reference>" },
    } } : {}),
    request_guidance: "Use the selected action's request_shape and reviewed inputs, not another outcome's subjects. Listed availability is not customer eligibility.",
    authority: {
      proposal_only: true,
      model_can_supply_patch: false,
      model_can_supply_trusted_scope: false,
      approval_and_apply_are_separate: true,
    },
    execution_status: { enablement: "not_reported_by_discovery", worker_liveness: "unknown",
      guidance: "request_change never writes source data. This does not establish whether a separate execution worker is enabled. Approval is not completion; only a successful execution receipt establishes completion." },
    source_database_changed: false,
  };
}

function parseCatalogRequest(args: Record<string, unknown>): CatalogRequest {
  const parsed = semanticActionInputSchema(DESCRIBE_ACTIONS_TOOL).safeParse(args);
  // Keep the registered schema an object: the MCP SDK otherwise advertises a
  // top-level refinement as an empty object. Enforce the cross-field rule here.
  if (!parsed.success || args.outcome !== undefined && (args.query !== undefined || args.limit !== undefined || args.cursor !== undefined)) {
    throw new McpRuntimeError("ARGUMENT_INVALID", "Use outcome alone for detail, or query (up to 256 characters), limit (1-20) and the returned cursor for discovery.");
  }
  return { ...(typeof args.outcome === "string" ? { detail: args.outcome } : {}),
    ...(typeof args.query === "string" ? { query: args.query } : {}),
    ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
    ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}) };
}

function parseRequestChange(args: Record<string, unknown>): {
  outcome: string;
  subject_refs: Record<string, string>;
  inputs?: Record<string, unknown>;
} {
  assertExactKeys(args, ["outcome", "subject_refs", ...(Object.hasOwn(args, "inputs") ? ["inputs"] : [])]);
  if (args.inputs !== undefined && !isRecord(args.inputs)) {
    throw new McpRuntimeError("ARGUMENT_INVALID", "inputs must be an object of reviewed business values.");
  }
  if (typeof args.outcome !== "string" || !OUTCOME_PATTERN.test(args.outcome)) {
    throw new McpRuntimeError("ARGUMENT_INVALID", "outcome must be one exact activated semantic outcome.");
  }
  if (!isRecord(args.subject_refs)) {
    throw new McpRuntimeError("ARGUMENT_INVALID", "subject_refs must map exact subject bindings to opaque references.");
  }
  const entries = Object.entries(args.subject_refs);
  if (entries.length < 1 || entries.length > 8) {
    throw new McpRuntimeError("ARGUMENT_INVALID", "subject_refs must contain from 1 through 8 exact subject bindings.");
  }
  const subjectRefs: Record<string, string> = {};
  for (const [binding, value] of entries) {
    if (!BINDING_PATTERN.test(binding) || typeof value !== "string" || !SUBJECT_REFERENCE_PATTERN.test(value)) {
      throw new McpRuntimeError("ARGUMENT_INVALID", "subject_refs contains an invalid binding or opaque reference.");
    }
    subjectRefs[binding] = value;
  }
  return { outcome: args.outcome, subject_refs: subjectRefs, ...(isRecord(args.inputs) ? { inputs: args.inputs } : {}) };
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
  if (canonicalJsonStringify(Object.keys(value).sort()) !== canonicalJsonStringify([...expected].sort())) {
    throw new McpRuntimeError("ARGUMENT_INVALID", "The semantic Action tool input contains unsupported fields.");
  }
}

function assertRuntimeContext(
  activated: ActivatedActionRuleV1,
  resolved: Awaited<ReturnType<SemanticActionContextResolver>>,
): void {
  if (resolved.subject_authority.source_id !== activated.compiled.source
    || resolved.fact_loader.engine !== activated.compiled.target_resource.engine
    || !resolved.trusted_context.tenant_id
    || !resolved.trusted_context.principal) {
    throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "The trusted Action runtime does not match the activated rule authority.");
  }
}

function assertSameActivatedAuthority(expected: ActivatedActionRuleV1, actual: ActivatedActionRuleV1): void {
  if (expected.action_boundary_name !== actual.action_boundary_name
    || expected.action_boundary_digest !== actual.action_boundary_digest
    || expected.compiled.rule_digest !== actual.compiled.rule_digest
    || expected.compiled.compiled_plan_digest !== actual.compiled.compiled_plan_digest
    || expected.approval_policy_digest !== actual.approval_policy_digest) {
    throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "The activated Action authority changed during this request.");
  }
}

function trustedFacts(
  activated: ActivatedActionRuleV1,
  context: TrustedContext,
  transactionTime: string,
): ActionRuleFactSetV1["trusted"] {
  const organizations = new Set(activated.compiled.verification_boundary.resources.flatMap((resource) =>
    resource.scope.mode === "single_organization" ? [resource.scope.organization_id] : []));
  if (organizations.size > 1) {
    throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "The activated Action rule has inconsistent organization scope.");
  }
  const organizationId = [...organizations][0];
  if (organizationId !== undefined) {
    if (organizationId !== context.tenant_id) {
      throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "The activated Action rule does not match the trusted organization context.");
    }
    return {
      organization_scope: { mode: "single_organization", organization_id: organizationId },
      principal: context.principal,
      transaction_time: transactionTime,
    };
  }
  return {
    tenant: context.tenant_id,
    principal: context.principal,
    transaction_time: transactionTime,
  };
}

function assertExistingProposal(proposal: StoredProposal, claimed: ResolvedSubjectRequest): void {
  const changeSet = proposal.change_set;
  const subjectBindings = claimed.subjects
    .map(({ binding, resource, subject_ref_digest }) => ({ binding, resource, subject_ref_digest }))
    .sort((left, right) => left.binding.localeCompare(right.binding));
  if (changeSet.schema_version !== protocolVersions.changeSetV4
    || proposal.action !== claimed.activated.compiled.outcome
    || changeSet.semantic_authority.proof.action_boundary_digest !== claimed.activated.action_boundary_digest
    || changeSet.semantic_authority.proof.action_rule_digest !== claimed.activated.compiled.rule_digest
    || changeSet.semantic_authority.proof.compiled_plan_digest !== claimed.activated.compiled.compiled_plan_digest
    || changeSet.semantic_authority.proof.approval_policy_digest !== claimed.activated.approval_policy_digest
    || changeSet.semantic_authority.proof.trusted_context_digest !== claimed.trusted_context_digest
    || changeSet.semantic_authority.proof.evidence_provenance_digest !== claimed.evidence_provenance_digest
    || changeSet.semantic_authority.proof.subject_bindings_digest !== canonicalJsonDigest(subjectBindings)) {
    throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "The existing proposal does not match the current reviewed Action request.");
  }
}

async function ensureSemanticEvidence(store: ProposalRuntimeStore, proposal: StoredProposal): Promise<void> {
  if (proposal.change_set.schema_version !== protocolVersions.changeSetV4) return;
  const changeSet = proposal.change_set;
  if (await store.getEvidenceBundle(changeSet.evidence.bundle_id)) return;
  const proof = changeSet.semantic_authority.proof;
  await store.recordEvidenceBundle({
    evidence_bundle_id: changeSet.evidence.bundle_id,
    proposal_id: proposal.proposal_id,
    tenant_id: proposal.scope_id,
    principal: proposal.principal,
    capability: proposal.action,
    source_id: changeSet.source.source_id,
    source_table: `${changeSet.source.schema}.${changeSet.source.table}`,
    business_object: proposal.business_object,
    object_id: proposal.object_id,
    query_fingerprint: changeSet.evidence.query_fingerprint,
    payload: {
      kind: "semantic_action_eligibility",
      outcome: proposal.action,
      result: "eligible",
      proposal_id: proposal.proposal_id,
      action_boundary_digest: proof.action_boundary_digest,
      action_rule_digest: proof.action_rule_digest,
      compiled_plan_digest: proof.compiled_plan_digest,
      verified_facts_digest: proof.verified_facts_digest,
      dependency_set_digest: proof.dependency_set_digest,
      derived_effect_digest: proof.derived_effect_digest,
      approval_policy_digest: proof.approval_policy_digest,
      approval_path: proof.approval_path,
      subject_identity_values_persisted_in_evidence: false,
      source_database_changed: false,
    },
    items: changeSet.semantic_authority.subject_bindings.map((subject) => ({
      kind: "opaque_subject_provenance",
      binding: subject.binding,
      resource: subject.resource,
      subject_ref_digest: subject.subject_ref_digest,
      raw_identity_persisted: false,
    })),
    query_audit: [{
      proposal_id: proposal.proposal_id,
      evidence_bundle_id: changeSet.evidence.bundle_id,
      tenant_id: proposal.scope_id,
      principal: proposal.principal,
      capability: proposal.action,
      source_id: changeSet.source.source_id,
      query_fingerprint: changeSet.evidence.query_fingerprint,
      table_name: `${changeSet.source.schema}.${changeSet.source.table}`,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
      row_count: changeSet.semantic_authority.dependencies.length,
      payload: {
        kind: "semantic_action_verification",
        outcome: proposal.action,
        parameterized: true,
        trusted_scope_applied: true,
        raw_sql_persisted: false,
        source_values_persisted: false,
      },
      created_at: changeSet.created_at,
    }],
    created_at: changeSet.created_at,
  });
}

async function recordSemanticRefusal(store: ProposalRuntimeStore, input: {
  outcome: string;
  source: string;
  table: string;
  trustedContext: TrustedContext;
  result: "ineligible" | "unknown";
  checkedAt: string;
}): Promise<void> {
  const fingerprint = canonicalJsonDigest({
    kind: "semantic_action_refusal",
    outcome: input.outcome,
    result: input.result,
    checked_at: input.checkedAt,
  });
  await store.recordQueryAudit({
    tenant_id: input.trustedContext.tenant_id,
    principal: input.trustedContext.principal,
    capability: input.outcome,
    source_id: input.source,
    query_fingerprint: fingerprint,
    table_name: input.table,
    row_count: 0,
    payload: {
      kind: "semantic_action_verification",
      outcome: input.outcome,
      result: input.result,
      proposal_created: false,
      source_execution_started: true,
      source_database_changed: false,
      parameters_redacted: true,
    },
    created_at: input.checkedAt,
  });
}

function semanticQueryFingerprint(proof: {
  action_rule_digest: string;
  compiled_plan_digest: string;
  subject_bindings_digest: string;
  trusted_context_digest: string;
  verified_at: string;
}): `sha256:${string}` {
  return canonicalJsonDigest({
    kind: "semantic_action_verification",
    action_rule_digest: proof.action_rule_digest,
    compiled_plan_digest: proof.compiled_plan_digest,
    subject_bindings_digest: proof.subject_bindings_digest,
    trusted_context_digest: proof.trusted_context_digest,
    verified_at: proof.verified_at,
  });
}

async function semanticProposalResult(
  store: ProposalRuntimeStore,
  proposal: StoredProposal,
  activated: ActivatedActionRuleV1,
  disposition: "created" | "existing",
  continuation?: SemanticActionContinuation,
): Promise<Record<string, unknown>> {
  // A continuation may have run synchronously. Its label is not execution
  // evidence: reload durable state and require the successful receipt.
  proposal = await store.getProposal(proposal.proposal_id) ?? proposal;
  if (proposal.change_set.schema_version !== protocolVersions.changeSetV4) {
    throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "Runner could not load the semantic proposal result safely.");
  }
  const completed = proposal.state === "applied" && (await store.receipts(proposal.proposal_id)).some((record) =>
    record.proposal_id === proposal.proposal_id && record.status === "applied"
    && record.receipt.status === "applied" && record.receipt.source_database_mutated === true
    && record.receipt.rows_affected > 0);
  const execution = completed ? "completed"
    : continuation?.execution === "completed" || proposal.state === "applied" ? "held"
    : continuation?.execution ?? (proposal.state === "approved" || proposal.state === "pending_worker"
        ? "not_enabled"
        : proposal.state === "pending_review"
          ? "human_review"
          : "held");
  const approval = await semanticApprovalStatus(store, proposal);
  const status = semanticActionStatus(proposal.state, execution);
  const effect = activated.compiled.effect_envelope;
  return {
    ok: true,
    outcome: proposal.action,
    status,
    request_disposition: disposition === "created" ? "created" : "already_recorded",
    result_summary: {
      description: humanizeOutcome(proposal.action),
      change: `${effect.operation === "update" ? "Update" : "Insert"} one reviewed ${effect.target_resource} record using only the exact Runner-derived effect.`,
      fields: effect.allowed_fields.map((field) => field.name),
      values_disclosed: false,
      ...(status === "completed"
        ? { next: "Re-read the reviewed resource to present current source values." }
        : {}),
    },
    authorization: {
      eligibility: "verified",
      approval,
      execution,
    },
    proposal: {
      status: proposal.state,
      approval: proposal.state === "approved" || proposal.state === "pending_worker" || proposal.state === "applied"
        ? approval === "automatic"
          ? "automatically approved; apply remains a separate authority"
          : approval === "human"
            ? "approved by a human reviewer; apply remains a separate authority"
            : "approved; approval provenance is available to the operator"
        : proposal.change_set.semantic_authority.proof.approval_path === "automatic_eligible"
          ? "pending human review because an automatic-approval limit did not pass"
          : "human review required",
    },
    execution,
    eligibility: "verified from current authoritative facts",
    exact_effect: "Runner-derived and sealed in the operator proposal record",
    source_database_changed: proposal.source_database_mutated,
    model_authority: {
      supplied_outcome_and_opaque_subjects_only: !Object.keys(proposal.change_set.semantic_authority.business_inputs ?? {}).length,
      supplied_only_reviewed_business_inputs: true,
      supplied_patch: false,
      approval: false,
      apply: false,
    },
  };
}

async function semanticApprovalStatus(
  store: ProposalRuntimeStore,
  proposal: StoredProposal,
): Promise<"automatic" | "human" | "pending_human_review" | "not_approved" | "approved"> {
  if (proposal.state === "pending_review") return "pending_human_review";
  if (proposal.state === "rejected" || proposal.state === "canceled") return "not_approved";
  if (proposal.state !== "approved" && proposal.state !== "pending_worker" && proposal.state !== "applied") {
    return "approved";
  }
  const approvals = await store.approvals?.(proposal.proposal_id);
  const accepted = approvals?.filter((approval) => approval.status === "approved") ?? [];
  if (accepted.some((approval) => approval.approver.startsWith("policy:"))) return "automatic";
  if (accepted.length > 0) return "human";
  return "approved";
}

function semanticActionStatus(
  state: StoredProposal["state"],
  execution: SemanticActionContinuation["execution"],
): "completed" | "approved_pending_execution" | "pending_human_review" | "closed" | "attention_required" {
  if (execution === "completed") return "completed";
  if (state === "approved" || state === "pending_worker") return "approved_pending_execution";
  if (state === "pending_review") return "pending_human_review";
  if (state === "rejected" || state === "canceled") return "closed";
  return "attention_required";
}

function humanizeOutcome(outcome: string): string {
  const final = outcome.split(".").at(-1) ?? outcome;
  return final.replace(/[_-]+/gu, " ").replace(/^./u, (character) => character.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
