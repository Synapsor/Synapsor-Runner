import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createJwtVerifier, type JwtVerificationConfig } from "./jwt-auth.js";

const id = z.string().min(1).max(256).refine((value) => value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value));
export const ownerRuntimeIdentitySchema = z.object({
  subject: id, tenant_id: id, principal: id, agent_id: id, delegator: id, run_id: id,
  actor_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  expires_at_ms: z.number().int().positive().safe(),
}).strict();
export type OwnerRuntimeIdentity = z.infer<typeof ownerRuntimeIdentitySchema>;
export type OwnerRuntimeAuthenticator = (credential: string) => Promise<OwnerRuntimeIdentity>;
export class OwnerRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OwnerRuntimeError"; }
}

/** A workload credential identifies an agent run, not a human login kept alive
 * indefinitely. The issuing backend must verify the delegator association. */
export function createOwnerRuntimeJwtAuthenticator(config: JwtVerificationConfig & { issuer: string; audience: string },
  env: NodeJS.ProcessEnv): OwnerRuntimeAuthenticator {
  if (!config.issuer?.trim() || !config.audience?.trim()) throw new OwnerRuntimeError("DELEGATION_AUTH_CONFIGURATION_INVALID");
  const verify = createJwtVerifier({ ...config, clock_skew_seconds: 0 }, env);
  return async (credential) => {
    try {
      if (typeof credential !== "string" || credential.length > 16_384) throw new Error("Invalid credential");
      const { payload } = await verify(credential);
      if (payload.actor_kind !== "agent" || payload.delegation_channel !== "runtime") throw new Error("Not a workload credential");
      const binding = { subject: id.parse(payload.sub), tenant_id: id.parse(payload.tenant_id), principal: id.parse(payload.principal),
        agent_id: id.parse(payload.agent_id), delegator: id.parse(payload.delegator), run_id: id.parse(payload.run_id) };
      const identity = ownerRuntimeIdentitySchema.parse({ ...binding,
        actor_digest: canonicalJsonDigest({ issuer: config.issuer, audience: config.audience, ...binding }),
        expires_at_ms: z.number().int().positive().parse(payload.exp) * 1000 });
      if (identity.expires_at_ms <= Date.now()) throw new Error("Expired workload");
      return identity;
    } catch { throw new OwnerRuntimeError("DELEGATION_AUTHENTICATION_FAILED"); }
  };
}
