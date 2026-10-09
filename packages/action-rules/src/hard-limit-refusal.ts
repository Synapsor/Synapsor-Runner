import { canonicalJsonDigest, type WritebackJob } from "@synapsor-runner/protocol";
import { ActionRuleError } from "./errors.js";

export const ACTION_RULE_HARD_LIMIT_REASON = "This change would exceed the reviewed hard limit.";
export type HardLimitRefusalBinding = Readonly<{
  job_digest: `sha256:${string}`;
  proof_digest: `sha256:${string}`;
  action_boundary_digest: `sha256:${string}`;
  compiled_plan_digest: `sha256:${string}`;
  effect_digest: `sha256:${string}`;
  invariant_digest: `sha256:${string}`;
}>;
const fields = ["job_digest", "proof_digest", "action_boundary_digest", "compiled_plan_digest", "effect_digest", "invariant_digest"] as const;
const owned = new WeakSet<object>();

/** Refusal transport only. Construction never establishes an activated invariant,
 * native metadata, approval or execution permission. The trusted verifier must
 * establish those and the false proposed-state condition before producing it. */
export class ActionRuleHardLimitRefusal extends ActionRuleError {
  readonly cause = "hard_limit_exceeded";
  readonly binding: HardLimitRefusalBinding;
  constructor(binding: HardLimitRefusalBinding) {
    super("ACTION_RULE_HARD_LIMIT_EXCEEDED", ACTION_RULE_HARD_LIMIT_REASON);
    if (!binding || Object.keys(binding).length !== fields.length
      || fields.some(field => typeof binding[field] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(binding[field]))) {
      throw new ActionRuleError("ACTION_RULE_AUTHORITY_STALE", "The hard-limit refusal binding is unavailable or invalid.");
    }
    this.name = "ActionRuleHardLimitRefusal";
    this.binding = Object.freeze({ ...binding });
    owned.add(this); Object.freeze(this);
  }
}

/** Reject foreign codes/messages/prototypes and mismatched immutable requests. */
export function matchesActionRuleHardLimitRefusal(error: unknown, job: WritebackJob | undefined): error is ActionRuleHardLimitRefusal {
  if (!error || typeof error !== "object" || !owned.has(error) || !(error instanceof ActionRuleHardLimitRefusal)
    || job?.protocol_version !== "5.0") return false;
  try {
    const proof = job.semantic_authority.proof;
    return error.binding.job_digest === canonicalJsonDigest(job)
      && error.binding.proof_digest === proof.proof_digest
      && error.binding.action_boundary_digest === proof.action_boundary_digest
      && error.binding.compiled_plan_digest === proof.compiled_plan_digest
      && error.binding.effect_digest === proof.derived_effect_digest
      && error.binding.effect_digest === job.semantic_authority.effect.effect_digest;
  } catch { return false; }
}
