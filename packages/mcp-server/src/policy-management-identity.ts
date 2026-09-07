import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyScope } from "@synapsor-runner/proposal-store";
import { z } from "zod";
import { createJwtVerifier, type JwtVerificationConfig } from "./jwt-auth.js";

const id = z.string().min(1).max(256).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
export const policyOwnerScopeSchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("operator") }).strict(),
  z.object({ level: z.literal("tenant"), tenant_id: id }).strict(),
  z.object({ level: z.literal("principal"), tenant_id: id, principal: id }).strict(),
]);
const permission = z.enum(["inspect", "draft", "activate", "revoke", "audit"]);
export type PolicyManagementPermission = z.infer<typeof permission>;
export const policyManagerGrantSchema = z.object({
  subject: id,
  actor_kind: z.enum(["human", "agent", "service"]),
  tenant_id: id,
  scope: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("personal") }).strict(),
    z.object({ mode: z.literal("exact"), scope: policyOwnerScopeSchema }).strict(),
    z.object({ mode: z.literal("deployment") }).strict(),
  ]),
  permissions: z.array(permission).min(1).max(5),
}).strict().superRefine((grant, context) => {
  if (new Set(grant.permissions).size !== grant.permissions.length) context.addIssue({ code: "custom", message: "Duplicate management permission" });
  if (grant.actor_kind !== "human" && grant.permissions.some((p) => p === "activate" || p === "revoke")) {
    context.addIssue({ code: "custom", message: "Policy activation and revocation require an authenticated human" });
  }
  if (grant.actor_kind !== "human" && grant.scope.mode === "deployment") {
    context.addIssue({ code: "custom", message: "Deployment-wide management requires an authenticated human" });
  }
});
export type PolicyManagerGrant = z.infer<typeof policyManagerGrantSchema>;
export type PolicyManagementIdentity = {
  subject: string;
  actor_kind: "human" | "agent" | "service";
  tenant_id: string;
  principal: string;
  agent_id?: string;
  actor: string;
  session_digest: string;
  expires_at_ms: number;
  channel: "assistant" | "human_review";
};

export class PolicyManagementError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PolicyManagementError"; }
}

export type PolicyManagementAuthenticator = (credential: string) => Promise<PolicyManagementIdentity>;

/** Use a dedicated backend-issued audience, not an ordinary source-reader JWT.
 * The human-review authenticator belongs on the trusted confirmation endpoint,
 * never in the runtime MCP dispatcher. Claims do not grant management rights. */
export function createPolicyManagementJwtAuthenticator(
  config: JwtVerificationConfig & { issuer: string; audience: string },
  channel: PolicyManagementIdentity["channel"],
  env: NodeJS.ProcessEnv,
): PolicyManagementAuthenticator {
  if (!config.issuer?.trim() || !config.audience?.trim()) throw new PolicyManagementError("POLICY_AUTH_CONFIGURATION_INVALID");
  const verifier = createJwtVerifier({ ...config, clock_skew_seconds: 0 }, env);
  return async (credential) => {
    try {
      if (typeof credential !== "string" || credential.length > 16 * 1024) throw new Error("Invalid credential");
      const { payload } = await verifier(credential);
      const subject = id.parse(payload.sub), tenant = id.parse(payload.tenant_id), principal = id.parse(payload.principal);
      const actorKind = z.enum(["human", "agent", "service"]).parse(payload.actor_kind);
      const session = id.parse(payload.sid);
      if (payload.policy_channel !== channel || (channel === "human_review" && actorKind !== "human")) throw new Error("Wrong confirmation channel");
      const agent = actorKind === "agent" ? id.parse(payload.agent_id) : undefined;
      if (actorKind !== "agent" && payload.agent_id !== undefined) throw new Error("Unexpected agent identity");
      const expires = z.number().int().positive().safe().parse(payload.exp) * 1000;
      if (!Number.isSafeInteger(expires) || expires <= Date.now()) throw new Error("Expired identity");
      return {
        subject, tenant_id: tenant, principal, actor_kind: actorKind, ...(agent ? { agent_id: agent } : {}),
        actor: canonicalJsonDigest({ issuer: config.issuer, subject, tenant, actor_kind: actorKind }),
        session_digest: canonicalJsonDigest({ issuer: config.issuer, audience: config.audience, subject,
          tenant, principal, actor_kind: actorKind, agent: agent ?? null, session, channel }),
        expires_at_ms: expires, channel,
      };
    } catch { throw new PolicyManagementError("POLICY_AUTHENTICATION_FAILED"); }
  };
}

/** The grants must come from the current operator-reviewed parent, never from
 * request arguments or token roles. Check before fetching any owner content. */
export function assertPolicyManagementRight(identity: PolicyManagementIdentity, rawGrants: unknown,
  rawScope: ControlPolicyScope, operation: PolicyManagementPermission): void {
  const grants = z.array(policyManagerGrantSchema).max(256).safeParse(rawGrants);
  const scope = policyOwnerScopeSchema.safeParse(rawScope);
  if (!grants.success || !scope.success) throw new PolicyManagementError("POLICY_MANAGEMENT_CONFIGURATION_INVALID");
  if (identity.expires_at_ms <= Date.now()) throw new PolicyManagementError("POLICY_AUTHENTICATION_FAILED");
  if ((operation === "activate" || operation === "revoke") && (identity.actor_kind !== "human" || identity.channel !== "human_review")) {
    throw new PolicyManagementError("POLICY_HUMAN_REVIEW_REQUIRED");
  }
  const allowed = grants.data.some((grant) => {
    if (grant.subject !== identity.subject || grant.actor_kind !== identity.actor_kind || grant.tenant_id !== identity.tenant_id
        || !grant.permissions.includes(operation)) return false;
    if (grant.scope.mode === "deployment") return true;
    if (grant.scope.mode === "personal") return scope.data.level === "principal" && scope.data.tenant_id === identity.tenant_id
      && scope.data.principal === identity.principal;
    return canonicalJsonDigest(grant.scope.scope) === canonicalJsonDigest(scope.data);
  });
  if (!allowed) throw new PolicyManagementError("POLICY_MANAGEMENT_FORBIDDEN");
}
