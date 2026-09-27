import {
  ActionRuleError,
  actionRuleDiscoveryContract,
  actionRulePublicEffects,
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
import { semanticRequestLifecycle, type SemanticRequestExecution } from "./semantic-request-lifecycle.js";
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
import { semanticActionCatalogSchema } from "./semantic-action-schema.js";
import { ScopedCatalogIndex, ScopedCatalogSession, type CatalogRequest } from "./scoped-catalog.js";
import { OwnerRuntimeError } from "./owner-runtime-identity.js";
import { PostgresRlsPrerequisiteError } from "@synapsor-runner/postgres";

export const DESCRIBE_ACTIONS_TOOL = "app.describe_actions";
export const REQUEST_CHANGE_TOOL = "app.request_change";

const OUTCOME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,255}$/u;
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SUBJECT_REFERENCE_PATTERN = /^obj_[A-Za-z0-9_-]{32,128}$/u;
const APPROVAL_DISCLOSURE_GUIDANCE = "Omitted or undisclosed approval conditions do not mean automatic approval is absent or human review is the only path. Proposal-only separates requesting from execution; it does not mean manual-only. Exact detail may disclose the approval mode but not private conditions. Actual request disposition governs; request_change is not a read-only eligibility probe. Approval never establishes execution readiness.";

export function createInactiveSemanticActionRuntime(): SemanticActionRuntime {
  return {
    listTools: () => semanticActionToolMetadata(),
    hasTool: (name) => name === DESCRIBE_ACTIONS_TOOL || name === REQUEST_CHANGE_TOOL,
    async callTool(name, args) {
      if (name === DESCRIBE_ACTIONS_TOOL) {
        parseCatalogRequest(args);
        return { ok: true, actions: [], availability: "operator_review_required",
          approval_information: { disclosure: "unavailable", guidance: APPROVAL_DISCLOSURE_GUIDANCE }, source_database_changed: false };
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

const subjectRequestTurns = new WeakMap<ProposalRuntimeStore, Map<string, Promise<void>>>();

/** Only same-process admission: each waiter must rerun authority, context and
 * reference checks. Store transactions still enforce cross-process limits. */
async function withSubjectRequestTurn<T>(store: ProposalRuntimeStore,
  request: { outcome: string; subject_refs: Record<string, string> }, operation: () => Promise<T>): Promise<T> {
  let turns = subjectRequestTurns.get(store);
  if (!turns) subjectRequestTurns.set(store, turns = new Map());
  const key = canonicalJsonDigest({ outcome: request.outcome, subject_refs: request.subject_refs });
  const previous = turns.get(key);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  turns.set(key, current);
  try {
    await previous;
    return await operation();
  } finally {
    release();
    if (turns.get(key) === current) turns.delete(key);
    if (turns.size === 0) subjectRequestTurns.delete(store);
  }
}

export type SemanticActionContinuation = {
  execution: SemanticRequestExecution;
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
  resolveDelayedWork?: (input: { outcome: string; activated: ActivatedActionRuleV1 }) => Promise<
    Omit<import("@synapsor-runner/protocol").DelayedSemanticWorkV1, "schema_version" | "requested_at"> | undefined>;
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
    async callTool(name, args, options) {
      if (name === DESCRIBE_ACTIONS_TOOL) {
        const registry = await loadRegistry();
        const authorization = await input.resolveCatalogAuthorization(registry);
        const request = parseCatalogRequest(args);
        const unavailable = await input.unavailableOutcomes?.() ?? [];
        const allowed = authorization.allowed_outcomes ? new Set(authorization.allowed_outcomes) : undefined;
        const visible = registry.rules.filter((entry) => !allowed || allowed.has(entry.compiled.outcome));
        const catalogBinding = canonicalJsonDigest({ registry: registry.digest, authorization, unavailable });
        if (!cachedCatalog || cachedCatalog.binding !== catalogBinding) {
          const unavailableSet = new Set(unavailable);
          const index = new ScopedCatalogIndex(visible.map((entry) => {
            const activated = resolveActivatedActionRule(registry, entry.compiled.outcome);
            const metadata = actionRuleDiscoveryMetadata(activated.compiled.rule);
            const availability = unavailableSet.has(activated.compiled.outcome) ? "operator_review_required" : "available";
            return { id: activated.compiled.outcome, ...metadata,
              // A listing is a shortlist, explicitly not a shortened executable
              // contract. Complete inputs/effects remain on the exact route.
              value: { outcome: activated.compiled.outcome, description: metadata.title, summary: metadata.summary, availability,
                contract_status: "exact_detail_required", exact_detail: { outcome: activated.compiled.outcome },
                eligibility: "not_checked", approval: { disclosure: availability === "available" ? "not_reported" : "unavailable" } },
              detail: () => describeAction(registry, activated, availability),
            };
          }));
          cachedCatalog = { binding: catalogBinding, index };
        }
        const index = cachedCatalog.index;
        const searchResult = !request.detail && request.query ? index.search(request.query) : undefined;
        // Detail and inline both select from the same currently authorized
        // registry, never from a merely listed Read or private verifier facts.
        const selectedId = request.detail ?? searchResult?.unambiguous_id;
        const selected = selectedId ? visible.find(entry => entry.compiled.outcome === selectedId) : undefined;
        const navigationResources = selected ? selected.compiled.rule.subjects.map(({ resource }) => resource) : [];
        let navigation: { binding: string; resources: Record<string, Record<string, unknown>> } | undefined;
        let inlineUnavailable = false;
        try { navigation = navigationResources.length ? await options?.describeSubjectNavigation?.(navigationResources) : undefined; }
        catch (error) {
          if (request.detail || !(error instanceof McpRuntimeError) || error.code !== "CATALOG_ENTRY_UNAVAILABLE") throw error;
          // A metadata listing cannot turn a denied exact Read projection into
          // inline disclosure. Preserve the shortlist, with truthful guidance.
          inlineUnavailable = true;
        }
        const binding = canonicalJsonDigest({ registry: registry.digest, authorization, unavailable,
          navigation: navigation?.binding ?? null, navigation_subject: selected?.compiled.outcome ?? null });
        const availability = selected && unavailable.includes(selected.compiled.outcome) ? "operator_review_required" : "available";
        const contract = selected && !inlineUnavailable ? describeAction(registry, resolveActivatedActionRule(registry, selected.compiled.outcome), availability, navigation?.resources) : undefined;
        const currentNavigation = navigationResources.length && !inlineUnavailable ? await options?.describeSubjectNavigation?.(navigationResources) : undefined;
        const current = await loadRegistry();
        const currentAuthorization = await input.resolveCatalogAuthorization(current);
        const currentUnavailable = await input.unavailableOutcomes?.() ?? [];
        if (canonicalJsonDigest({ registry: current.digest, authorization: currentAuthorization, unavailable: currentUnavailable,
          navigation: currentNavigation?.binding ?? null, navigation_subject: selected?.compiled.outcome ?? null }) !== binding) {
          throw new McpRuntimeError("CATALOG_CURSOR_INVALID", "Reviewed authority changed during discovery. Restart discovery with the current authorized catalog.");
        }
        return catalogSession.describe({ index, binding, request, searchResult,
          legacy: Object.keys(args).length === 0, key: "actions", inlineUnavailable, context: actionCatalogContext(Boolean(request.detail)),
          ...(request.detail && contract ? { detailValue: contract, detailNextSteps: actionContractNextSteps(contract) } : {}),
          ...(!request.detail && selected && contract ? { inlineDetail: { id: selected.compiled.outcome, value: contract,
            nextSteps: actionContractNextSteps(contract) } } : {}) });
      }
      if (name !== REQUEST_CHANGE_TOOL) {
        throw new McpRuntimeError("MCP_TOOL_NOT_FOUND", "The requested Synapsor Action tool is not available.");
      }
      const request = parseRequestChange(args);
      return withSubjectRequestTurn(input.store, request, async () => {
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
              ...(input.resolveDelayedWork ? { delayedWork: await input.resolveDelayedWork({ outcome: request.outcome, activated: decision.activated }) } : {}),
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
              const approve = resolvedContext.approveAutomatic ?? input.store.approveProposalByPolicy.bind(input.store);
              const approvalDecision = await approve(proposal.proposal_id, {
                policy: decision.approval.authority.name,
                proposal_hash: proposal.proposal_hash,
                proposal_version: proposal.proposal_version,
                reason: "Exact semantic Action Rule and reviewed automatic-approval policy matched current authoritative facts.",
                action_boundary: {
                  name: decision.activated.action_boundary_name,
                  digest: decision.activated.action_boundary_digest,
                  limits: decision.approval.authority.shared_limits,
                },
                // Fact evidence keeps its claim time. Approval accounting must
                // use the store's admission time, after any durable writer wait,
                // so a later-started request already committed is still counted.
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
                "The requested outcome is not available in the current authorized catalog. Refresh the action list. An operator can inspect existing requests before deciding whether to retry. No source change was executed.");
            }
            throw new McpRuntimeError(
              error.code === "ACTION_RULE_NOT_ELIGIBLE"
                ? "SEMANTIC_ACTION_NOT_ELIGIBLE"
                : "SEMANTIC_ACTION_UNAVAILABLE",
              error.code === "ACTION_RULE_NOT_ELIGIBLE"
                ? "Current authoritative facts do not permit this reviewed outcome. No source change was executed. An unapproved proposal may remain; ask the operator to inspect existing requests before retrying."
                : "Runner could not prove this reviewed outcome from current authoritative facts. No source change was executed. An unapproved proposal may remain; ask the operator to inspect existing requests before retrying.",
            );
          }
          throw error;
        }
      });
    },
  };
}

function semanticActionToolMetadata(): LocalToolMetadata[] {
  return [
    {
      name: DESCRIBE_ACTIONS_TOOL,
      title: "Describe reviewed actions",
      description: 'Browse compact metadata {"limit":5} or search {"query":"text","limit":5}; exact detail {"outcome":"<exact id>"}. Limit is a maximum; byte-bounded pages may contain fewer entries. Follow next_cursor until null. Oversized detail returns partial contract_navigation with executable section calls; follow exact section/item/limit/cursor routes. Missing sections are not optional inputs or permission. Never mix query with exact detail/sections; null means omitted. Unambiguous search may include complete inline_contract; otherwise use exact_detail. Follow discovery.next_steps and pagination.state; CATALOG_CURSOR_INVALID needs a fresh current lookup without that cursor. Exact detail connects permitted Read/reference navigation and required caller inputs; ask the caller if missing, never guess private verifier values. Reuse still-current detail. Ranking identifies alternatives, not caller intent. Totals count authorized catalog metadata or the explicitly selected section, never source rows. Keep the same query/section/item/limit/context on continuation. Explicit listing is a shortlist; empty input keeps a bounded compatibility page. Availability is not eligibility; no source rows or authority are supplied. ' + APPROVAL_DISCLOSURE_GUIDANCE,
      kind: "action_catalog",
      input_schema: { query: { type: "string", required: false }, limit: { type: "number", required: false },
        section: { type: "string", required: false }, contract_revision: { type: "string", required: false }, item: { type: "string", required: false },
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
      description: "Request one activated business outcome using opaque Explore references and only the typed business inputs described by app.describe_actions. Required caller inputs must come from the authorized caller or their established business process; ask if missing instead of guessing private verification values. Runner validates those inputs and reloads authoritative facts to derive an immutable proposal; this tool cannot approve, apply, or accept an arbitrary patch. To check an accepted request later, repeat the identical outcome, original subject_refs and inputs. An already recorded request returns its durable status, not a second proposal. Do not obtain new references to check status. Completion requires a verified execution receipt; if authority or context changed, report unavailable rather than recreating the request.",
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

function describeAction(registry: RuntimeActionRuleRegistryV1, activated: ActivatedActionRuleV1, availability: string,
  navigation?: Record<string, Record<string, unknown>>): Record<string, unknown> {
  const contract = actionRuleDiscoveryContract(activated.compiled, resolveActivatedApprovalClass(registry, activated.compiled.outcome).mode, availability);
  if (!navigation) return contract;
  return { ...contract, subjects: (contract.subjects as Array<Record<string, unknown>>).map(subject => ({ ...subject,
    ...(navigation[String(subject.resource)] ? { navigation: navigation[String(subject.resource)] } : {}),
  })) };
}

/** Copy only checked exact-contract guidance; never synthesize caller values. */
function actionContractNextSteps(contract: Record<string, unknown>): Record<string, unknown>[] {
  const steps: Record<string, unknown>[] = [];
  const inputs = Array.isArray(contract.inputs) ? contract.inputs.filter(isRecord) : [];
  const required = inputs.filter(input => input.required === true && input.origin === "caller_business_input").map(input => input.name);
  if (required.length) steps.push({ kind: "ask_caller_for_required_inputs", inputs: required,
    guidance: "Ask the authorized caller for any missing reviewed input; no value has been supplied or inferred by discovery." });
  for (const subject of Array.isArray(contract.subjects) ? contract.subjects.filter(isRecord) : []) {
    const navigation = isRecord(subject.navigation) ? subject.navigation : undefined;
    if (navigation?.status === "rows_reference_available" && isRecord(navigation.explore_data)) {
      steps.push({ kind: "acquire_permitted_subject_reference", subject_binding: subject.binding,
        tool: "app.explore_data", arguments: navigation.explore_data,
        guidance: "Use the selected returned row's existing opaque reference when present. This permitted rows template does not choose the caller's intended subject or establish eligibility." });
    } else steps.push({ kind: "inspect_subject_navigation", subject_binding: subject.binding,
      status: navigation?.status ?? "not_established",
      ...(isRecord(navigation?.describe_data) ? { tool: "app.describe_data", arguments: navigation.describe_data } : {}),
      guidance: navigation?.guidance ?? "No current permitted subject-reference route is established; do not fabricate a reference." });
  }
  return steps.length ? steps : [{ kind: "inspect_selected_contract", guidance: "Review the exact permitted contract; discovery does not select caller intent or check eligibility." }];
}

function actionCatalogContext(exactDetail = false): Record<string, unknown> {
  return {
    ...(!exactDetail ? { request_shape: {
      outcome: "<one listed outcome>",
      subject_refs: { "<binding from the selected action's request_shape>": "obj_<opaque reference>" },
    } } : {}),
    request_guidance: "Use the selected action's request_shape and reviewed inputs, not another outcome's subjects. Listed availability is not customer eligibility.",
    approval_information: { disclosure: "partial", guidance: APPROVAL_DISCLOSURE_GUIDANCE },
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
  const parsed = semanticActionCatalogSchema.safeParse(args);
  if (!parsed.success) {
    throw new McpRuntimeError("ARGUMENT_INVALID", "Use outcome alone for detail, or query (up to 256 characters), limit (1-20) and the returned cursor for discovery. Optional null means omitted; do not combine meaningful listing fields with outcome.");
  }
  return { ...(typeof args.outcome === "string" ? { detail: args.outcome } : {}),
    ...(typeof args.section === "string" ? { section: args.section } : {}),
    ...(typeof args.contract_revision === "string" ? { contract_revision: args.contract_revision } : {}),
    ...(typeof args.item === "string" ? { item: args.item } : {}),
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
  const projection = await semanticRequestLifecycle(store, proposal, continuation);
  proposal = projection.proposal;
  if (proposal.change_set.schema_version !== protocolVersions.changeSetV4) {
    throw new McpRuntimeError("SEMANTIC_ACTION_UNAVAILABLE", "Runner could not load the semantic proposal result safely.");
  }
  const { approval, execution, status } = projection;
  const effect = activated.compiled.effect_envelope;
  return {
    ok: true,
    outcome: proposal.action,
    status,
    request_disposition: disposition === "created" ? "created" : "already_recorded",
    status_check: {
      tool: REQUEST_CHANGE_TOOL,
      guidance: "Only an exact replay of this already recorded request can return its existing status: identical outcome, original subject_refs and inputs. A fresh request_change can create work and is not a harmless status probe. Do not substitute newly explored references or inputs. If current authority or context no longer permits replay, report status unavailable; do not recreate the request.",
      completion_evidence: "Only completed with a verified execution_receipt confirms completion; approval or a changed source row alone does not.",
    },
    ...(projection.executionReceipt ? { execution_receipt: projection.executionReceipt } : {}),
    invocation: { operation: disposition === "existing" ? "returned_existing_request" : "created_request",
      source_database_changed: disposition === "existing" ? false : projection.sourceChanged === true },
    lifecycle: projection.lifecycle,
    result_summary: {
      description: humanizeOutcome(proposal.action),
      change: `Primary component: ${effect.operation === "update" ? "update" : "insert"} one reviewed ${effect.target_resource} record using only the exact Runner-derived effect.`,
      fields: effect.allowed_fields.map((field) => field.name),
      values_disclosed: false,
      next: projection.next,
    },
    authorization: {
      eligibility: projection.stable ? "verified" : "unknown",
      eligibility_basis: disposition === "existing" ? "original_request" : "current_request",
      approval,
      execution,
    },
    proposal: {
      status: projection.stable ? proposal.state : "unavailable",
      approval: projection.approvalText,
    },
    execution,
    eligibility: !projection.stable ? "verification details unavailable during this status read"
      : disposition === "existing" ? "verified for the original request; not re-evaluated by this replay" : "verified from current authoritative facts",
    business_effects: actionRulePublicEffects(activated.compiled),
    exact_effect: "Runner-derived and sealed in the operator proposal record",
    source_database_changed: projection.sourceChanged,
    model_authority: {
      supplied_outcome_and_opaque_subjects_only: !Object.keys(proposal.change_set.semantic_authority.business_inputs ?? {}).length,
      supplied_only_reviewed_business_inputs: true,
      supplied_patch: false,
      approval: false,
      apply: false,
    },
  };
}

function humanizeOutcome(outcome: string): string {
  const final = outcome.split(".").at(-1) ?? outcome;
  return final.replace(/[_-]+/gu, " ").replace(/^./u, (character) => character.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
