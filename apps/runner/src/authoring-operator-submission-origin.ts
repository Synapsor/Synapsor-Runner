import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readAuthoringBindingsSchema } from "./control-policy-record.js";

export const operatorSubmissionDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u)
  .transform(value => value as `sha256:${string}`);
/** Immutable PRE-save custody reference. Pending and confirmation writes have
 * distinct acknowledged successors; never rebase this origin to their epoch.
 * Shape/hashes are not native custody, meaning or permission. */
export const operatorSubmissionOriginSchema = z.object({
  kind: z.literal("operator_submission"), route: z.enum(["structured_file", "operator_exact"]),
  submission_digest: operatorSubmissionDigestSchema,
  review_bundle_digest: operatorSubmissionDigestSchema,
  bindings: readAuthoringBindingsSchema,
  entry_id: z.string().regex(/^bnd_[a-f0-9]{32}$/u),
  candidate_digest: operatorSubmissionDigestSchema,
  action_baseline_digest: operatorSubmissionDigestSchema.nullable(),
}).strict();
export type OperatorSubmissionOrigin = z.infer<typeof operatorSubmissionOriginSchema>;

export function parseOperatorSubmissionOrigin(value: unknown): OperatorSubmissionOrigin {
  const parsed = operatorSubmissionOriginSchema.safeParse(value);
  if (!parsed.success || canonicalJsonDigest(parsed.data) !== canonicalJsonDigest(value))
    throw new Error("AUTHORING_OPERATOR_ORIGIN_INVALID: Preserve the exact original operator submission and native baseline; no custody was inferred.");
  return structuredClone(parsed.data);
}
