import { assertSemanticActionAuthorityCurrent, reverifySemanticProposal, type SemanticReverificationSubject } from "@synapsor-runner/action-rules";
import { resolveTrustedContext, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { type ProposalStore, semanticApprovalSetDigest, type StoredProposal } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, type DelayedValidationV1, protocolVersions } from "@synapsor-runner/protocol";
import { loadActiveActionRuleAuthority } from "./action-rule-authority.js";
import { assertDelayedSemanticWorkCurrent, safeDelayedValidationCode } from "./delayed-semantic-work.js";
import { openSemanticFactSession } from "./semantic-action-runtime.js";
import { semanticActionProjectRoot, semanticApprovalCapability } from "./writeback-execution.js";
import { assertPinnedOperatorPublicKeys } from "./operator-identity.js";

/** A reader-side check that is durably attributed to the original request.
 * The writer repeats the same fact/effect check inside its source transaction. */
export async function recordCurrentDelayedSemanticValidation(input: {
  proposal: StoredProposal;
  config: RuntimeConfig;
  configPath: string;
  store: ProposalStore;
  phase: "approval" | "dispatch";
  env?: NodeJS.ProcessEnv;
}): Promise<DelayedValidationV1> {
  const change = input.proposal.change_set;
  if (change.schema_version !== protocolVersions.changeSetV4 || !change.delayed_work
    || change.source.kind !== "external_postgres" || change.semantic_authority.proof.delegation) {
    throw new Error("DELAYED_WORK_UNSUPPORTED: only an opted-in, nondelegated PostgreSQL request can be reverified.");
  }
  const projectRoot = semanticActionProjectRoot(input.config, input.configPath);
  if (!projectRoot) throw new Error("DELAYED_WORK_AUTHORITY_MISSING: current Action authority is unavailable.");
  const now = new Date().toISOString();
  const approvals = input.phase === "dispatch" ? input.store.approvals(input.proposal.proposal_id) : undefined;
  assertDelayedSemanticWorkCurrent({ config: input.config, delayed_work: change.delayed_work,
    outcome: change.action, action_boundary_digest: change.semantic_authority.proof.action_boundary_digest,
    source: change.source.source_id, engine: "postgres", now, phase: input.phase, approvals });
  let attemptDigest: string;
  try { attemptDigest = input.store.beginDelayedValidation(input.proposal.proposal_id, input.phase); }
  catch (error) {
    const safeCode = safeDelayedValidationCode(error);
    throw Object.assign(new Error(`${safeCode}: the reviewed fresh-validation window or attempt bound is unavailable. The original request remains unchanged; inspect it and use authorized rejection or cancellation before a distinct new request.`),
      { code: safeCode, cause: error });
  }
  try {
  await assertPinnedOperatorPublicKeys(input.config.operator_identity, input.configPath);
  const active = await loadActiveActionRuleAuthority(projectRoot, { outcome: change.action }).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("DELAYED_WORK_AUTHORITY_CHANGED: the original Action is no longer active.");
    }
    throw error;
  });
  const effect = change.semantic_authority.effect;
  const subject: SemanticReverificationSubject = {
      proposal_id: input.proposal.proposal_id,
      source_id: change.source.source_id,
      engine: "postgres",
      semantic_authority: change.semantic_authority,
      target: { schema: effect.schema, table: effect.table, primary_key: effect.primary_key,
        ...(effect.tenant_guard ? { tenant_guard: effect.tenant_guard } : {}),
        ...(effect.organization_scope ? { organization_scope: effect.organization_scope } : {}),
        ...(change.guards.principal_scope ? { principal_scope: change.guards.principal_scope } : {}) },
  };
  const { activated, approval } = assertSemanticActionAuthorityCurrent(active.registry, subject);
  const trustedContext = resolveTrustedContext(input.config, input.env ?? process.env,
    semanticApprovalCapability(activated, approval));
  if (trustedContext.tenant_id !== (change.scope.tenant_id ?? change.scope.organization_scope!.organization_id)
    || trustedContext.principal !== change.principal.id) {
    throw new Error("DELAYED_WORK_TRUSTED_CONTEXT_CHANGED: current trusted scope differs from the original exact request.");
  }
  const session = await openSemanticFactSession({ activated, config: input.config, env: input.env ?? process.env, trustedContext });
  let result;
  try {
    result = await reverifySemanticProposal({ registry: active.registry, job: subject,
      factLoader: session.fact_loader, checkedAt: now });
  } finally { await session.close(); }
  const after = new Date().toISOString();
  assertDelayedSemanticWorkCurrent({ config: input.config, delayed_work: change.delayed_work,
    outcome: change.action, action_boundary_digest: change.semantic_authority.proof.action_boundary_digest,
    source: change.source.source_id, engine: "postgres", now: after, phase: input.phase, approvals });
  const proof = change.semantic_authority.proof;
  const freshnessMs = Date.parse(proof.valid_until) - Date.parse(proof.verified_at);
  const deadlines = [Date.parse(after) + freshnessMs,
    Date.parse(change.delayed_work.requested_at) + change.delayed_work.absolute_request_age_seconds * 1_000];
  if (input.phase === "approval") deadlines.push(Date.parse(change.delayed_work.requested_at)
    + change.delayed_work.approval_wait_seconds * 1_000);
  else for (const approval of approvals ?? []) if (approval.status === "approved") deadlines.push(Date.parse(approval.created_at)
    + change.delayed_work.approval_validity_seconds * 1_000);
  const validUntilMs = Math.min(...deadlines);
  if (!Number.isFinite(validUntilMs) || validUntilMs <= Date.parse(after)) {
    throw new Error("DELAYED_WORK_VALIDATION_EXPIRED: current verification cannot authorize this waiting operation.");
  }
  const unsigned = {
    schema_version: "synapsor.delayed-validation.v1" as const,
    phase: input.phase,
    proposal_id: input.proposal.proposal_id,
    proposal_hash: input.proposal.proposal_hash as `sha256:${string}`,
    proposal_version: input.proposal.proposal_version,
    original_proof_digest: proof.proof_digest,
    execution_policy_digest: change.delayed_work.execution_policy_digest,
    checked_at: after,
    valid_until: new Date(validUntilMs).toISOString(),
    dependency_set_digest: result.dependency_set_digest,
    effect_digest: result.effect_digest,
    ...(input.phase === "dispatch" ? { approval_set_digest: semanticApprovalSetDigest(input.proposal, approvals ?? []) } : {}),
  };
  return input.store.recordDelayedValidation({ ...unsigned, validation_digest: canonicalJsonDigest(unsigned) }, attemptDigest);
  } catch (error) {
    const safeCode = safeDelayedValidationCode(error);
    input.store.recordDelayedValidationFailure(input.proposal.proposal_id, attemptDigest, safeCode);
    const effect = input.phase === "approval" ? "No approval or source effect was granted."
      : "The original approval remains, but this check granted no worker dispatch or source effect.";
    throw Object.assign(new Error(`${safeCode}: current exact-operation validation did not complete. ${effect} Inspect the original request and use an authorized rejection or cancellation before a distinct new request.`),
      { code: safeCode, cause: error });
  }
}
