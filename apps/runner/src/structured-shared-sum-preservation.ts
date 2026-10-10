import type { ActionRuleAuthorityV1 } from "@synapsor-runner/action-rules";

/** Containment until the native reviewed replacement owner is supported.
 * Per-rule reconstruction does not carry the bundle's shared designation. */
export function assertStructuredSharedSumRewriteAvailable(existing?: ActionRuleAuthorityV1): void {
  if (existing?.shared_sum === undefined) return;
  const code = "STRUCTURED_DRAFT_SHARED_SUM_REVIEW_REQUIRED";
  throw Object.assign(new Error(`${code}: The saved Action authority contains a shared total. This draft route cannot yet preserve its separately reviewed designation through a replacement. Reopen its native invariant review. The submitted file and saved authorities remain unchanged.`), { code });
}
