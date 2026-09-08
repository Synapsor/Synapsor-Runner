import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  createPolicyManagementJwtAuthenticator, createPolicyManagementService, createPolicyManagementTools,
  createPolicyReviewContinuationService, PolicyManagementError, type RuntimeConfig,
} from "@synapsor-runner/mcp-server";
import type { ControlPolicyScope, ProposalRuntimeStore } from "@synapsor-runner/proposal-store";
import { createActiveActionRuleAuthorityLoader } from "./action-rule-authority.js";
import { borrowRuntimeControlPolicies, assertRuntimeControlPolicyContinuity } from "./control-policy-store.js";
import { withProjectRuntimeAdmission } from "./project-runtime-admission.js";

export type LocalOwnerPolicyReview = {
  /** Trusted terminal callback, deliberately absent from the model tool list. */
  prepare(): Promise<{ summary: unknown; confirm(): Promise<unknown>; cancel(): void }>;
};

/** Local authenticated settings composition. Configuration selects a scope
 * class; signed identity and current parent grants select the actual owner. */
export async function createOptionalOwnerPolicyRuntime(input: {
  projectRoot: string; config: RuntimeConfig; store: ProposalRuntimeStore; env: NodeJS.ProcessEnv;
  /** Trusted management UI selection; current service rights still gate every call. */
  selectedScope?: ControlPolicyScope;
}) {
  const configured = input.config.action_rules?.owner_management;
  if (!configured) return undefined;
  const selectedScope = input.selectedScope ? structuredClone(input.selectedScope) : undefined;
  if (selectedScope?.level === "operator") throw new PolicyManagementError("POLICY_MANAGEMENT_FORBIDDEN");
  return withProjectRuntimeAdmission(input.projectRoot, async (root) => {
    const actionRoot = await fs.realpath(path.resolve(input.config.action_rules!.project_root));
    if (actionRoot !== root) throw new PolicyManagementError("POLICY_PROJECT_MISMATCH");
    const binding = await borrowRuntimeControlPolicies(root, input.store);
    if (!binding) throw new PolicyManagementError("POLICY_STORE_REVIEW_REQUIRED");
    const authenticate = createPolicyManagementJwtAuthenticator(configured.authentication, "assistant", input.env);
    const authenticateHuman = createPolicyManagementJwtAuthenticator({ ...configured.authentication,
      audience: configured.human_review.audience }, "human_review", input.env);
    const loadRules = createActiveActionRuleAuthorityLoader(root, binding);
    const current = () => assertRuntimeControlPolicyContinuity(root, binding);
    const service = createPolicyManagementService({ repository: binding.repository, deployment_id: binding.deployment_id,
      parent_name: configured.parent_name,
      assistant_authenticate: async (credential) => { await current(); return authenticate(credential); },
      human_authenticate: async (credential) => { await current(); return authenticateHuman(credential); },
      resolveRules: async () => {
        await current();
        return (await loadRules({ dependency_check: "report" })).registry.rules.map((rule) => rule.compiled);
      },
    });
    const credential = (name: string) => {
      const value = input.env[name];
      if (!value) throw new PolicyManagementError("POLICY_CREDENTIAL_REQUIRED");
      return value;
    };
    const resolveContext = async () => {
      await current();
      const token = credential(configured.credential_env), identity = await authenticate(token);
      const scope: ControlPolicyScope = selectedScope ?? (configured.scope === "tenant"
        ? { level: "tenant", tenant_id: identity.tenant_id }
        : { level: "principal", tenant_id: identity.tenant_id, principal: identity.principal });
      return { credential: token, scope, policy_name: configured.policy_name,
        scope_label: selectedScope ? `${selectedScope.tenant_id}${selectedScope.level === "principal" ? ` / ${selectedScope.principal}` : " / shared account"} / Agent rules`
          : configured.scope === "tenant" ? "Your account's shared agent rules" : "Your personal agent rules",
        session_id: identity.session_digest, expires_at_ms: identity.expires_at_ms };
    };
    const continuations = createPolicyReviewContinuationService(service);
    const tools = createPolicyManagementTools({ service, resolveContext,
      publishReview: async (target) => continuations.publish(target).handle,
      review_instruction: "In this project's local Ask chat, enter /review-rules to inspect the saved draft and confirm with your separate human-review sign-in. Drafting does not activate rules.",
    });
    const review: LocalOwnerPolicyReview = {
      async prepare() {
        // Reload the durable selected draft, so review also works after a
        // client restart. The human sees and confirms this exact new snapshot.
        const context = await resolveContext();
        const detail = await service.detail(context.credential, context.scope, context.policy_name);
        if (!detail.draft) throw new PolicyManagementError("POLICY_NO_DISABLED_DRAFT");
        const target = continuations.publish({ scope: context.scope, name: context.policy_name,
          revision_id: detail.draft.revision_id, expected_epoch: detail.epoch });
        let prepared: Awaited<ReturnType<typeof continuations.prepare>>;
        try {
          prepared = await continuations.prepare(credential(configured.human_review.credential_env), target.handle);
        } catch (error) {
          continuations.cancel(target.handle);
          throw error;
        }
        let cancelled = false;
        return {
          summary: prepared.summary,
          confirm: async () => {
            if (cancelled) throw new PolicyManagementError("POLICY_REVIEW_CANCELLED");
            return continuations.confirm(credential(configured.human_review.credential_env), target.handle, prepared);
          },
          cancel: () => { cancelled = true; continuations.cancel(target.handle); },
        };
      },
    };
    return { tools, review,
      scopes: (request: Parameters<typeof service.scopes>[1] = {}) => service.scopes(credential(configured.credential_env), request),
      async contextDigest() {
        const context = await resolveContext();
        await service.detail(context.credential, context.scope, context.policy_name);
        return canonicalJsonDigest({ deployment: binding.deployment_id, configured, session: context.session_id, scope: context.scope });
      } };
  });
}
