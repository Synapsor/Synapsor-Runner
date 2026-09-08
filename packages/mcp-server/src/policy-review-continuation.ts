import { randomBytes } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyReview, ControlPolicyReviewReceipt, ControlPolicyScope } from "@synapsor-runner/proposal-store";

type ReviewService = {
  prepareReview(credential: string, input: {
    scope: ControlPolicyScope; name: string; expected_epoch: number; revision_id: string; operation: "activate" | "revoke";
  }): Promise<{ review: ControlPolicyReview; nonce: string; summary: unknown }>;
  confirmReview(credential: string, input: { review: ControlPolicyReview; nonce: string }): Promise<ControlPolicyReviewReceipt>;
};

type Target = {
  scope: ControlPolicyScope;
  name: string;
  expected_epoch: number;
  revision_id: string;
};
type Prepared = { review: ControlPolicyReview; digest: string };
type Continuation = { target: Target; expires_at_ms: number; prepared?: Prepared; confirmed?: { digest: string } };

export class PolicyReviewContinuationError extends Error {
  constructor(readonly code: string) { super(code); this.name = "PolicyReviewContinuationError"; }
}

/** Trusted-provider continuation bridge. It has no authority to activate or
 * revoke policies: it only carries one exact pending review to the existing
 * human-authenticated policy-management service. Handles are opaque and never
 * contain policy scope, reviewer identity, review nonce, or a callback URL. */
export function createPolicyReviewContinuationService(service: ReviewService, options: {
  ttl_ms?: number;
  confirmed_ttl_ms?: number;
  max_handles?: number;
  now?: () => number;
} = {}) {
  const ttl = positive(options.ttl_ms ?? 300_000, "POLICY_REVIEW_CONTINUATION_TTL_INVALID", 300_000);
  const confirmedTtl = positive(options.confirmed_ttl_ms ?? Math.min(60_000, ttl), "POLICY_REVIEW_CONTINUATION_TTL_INVALID", ttl);
  const maxHandles = positive(options.max_handles ?? 128, "POLICY_REVIEW_CONTINUATION_LIMIT_INVALID", 128);
  const now = options.now ?? Date.now;
  const records = new Map<string, Continuation>();

  function prune() {
    const current = clock(now);
    for (const [handle, record] of records) if (record.expires_at_ms <= current) records.delete(handle);
  }
  function current(handle: string): Continuation {
    prune();
    if (!isHandle(handle)) throw fail("POLICY_REVIEW_CONTINUATION_INVALID");
    const record = records.get(handle);
    if (!record) throw fail("POLICY_REVIEW_CONTINUATION_INVALID");
    return record;
  }

  return {
    /** Called only after a trusted backend has saved an exact disabled draft. */
    publish(input: Target) {
      prune();
      if (records.size >= maxHandles) throw fail("POLICY_REVIEW_CONTINUATION_LIMIT");
      const handle = `pvr_${randomBytes(32).toString("base64url")}`;
      const expires_at_ms = clock(now) + ttl;
      records.set(handle, { target: structuredClone(input), expires_at_ms });
      return { handle, expires_at_ms };
    },
    /** The human UI receives the service-produced summary, review challenge,
     * and nonce. A later authorized reviewer may replace an unconfirmed
     * challenge for the same opaque continuation. */
    async prepare(credential: string, handle: string) {
      const record = current(handle);
      if (record.confirmed) throw fail("POLICY_REVIEW_CONTINUATION_CONFIRMED");
      const prepared = await service.prepareReview(credential, { ...record.target, operation: "activate" });
      if (!matches(record.target, prepared.review)) throw fail("POLICY_REVIEW_CONTINUATION_INVALID");
      record.prepared = { review: structuredClone(prepared.review), digest: canonicalJsonDigest(prepared.review) };
      return prepared;
    },
    /** Confirms only the latest exact service challenge. Even an exact retry
     * re-enters the service so current human rights and durable review replay
     * remain authoritative. */
    async confirm(credential: string, handle: string, input: { review: ControlPolicyReview; nonce: string }) {
      const record = current(handle), digest = canonicalJsonDigest(input.review);
      if (record.confirmed) {
        if (record.confirmed.digest !== confirmationDigest(digest, input.nonce)) throw fail("POLICY_REVIEW_CONTINUATION_INVALID");
        return service.confirmReview(credential, input);
      }
      if (!record.prepared || record.prepared.digest !== digest) throw fail("POLICY_REVIEW_CONTINUATION_INVALID");
      const result = await service.confirmReview(credential, input);
      record.confirmed = { digest: confirmationDigest(digest, input.nonce) };
      record.expires_at_ms = Math.min(record.expires_at_ms, clock(now) + confirmedTtl);
      return result;
    },
    /** A trusted provider can discard an abandoned unconfirmed handle. A
     * confirmed handle stays briefly available only for exact durable retries. */
    cancel(handle: string) {
      const record = current(handle);
      if (record.confirmed) throw fail("POLICY_REVIEW_CONTINUATION_CONFIRMED");
      records.delete(handle);
    },
  };
}

function matches(target: Target, review: ControlPolicyReview): boolean {
  return review.operation === "activate" && review.expected_epoch === target.expected_epoch && review.revision_id === target.revision_id
    && review.key.kind === "delegation" && review.key.name === target.name
    && canonicalJsonDigest(review.key.scope) === canonicalJsonDigest(target.scope);
}
function confirmationDigest(reviewDigest: string, nonce: string): string {
  return canonicalJsonDigest({ review: reviewDigest, nonce });
}
function isHandle(value: unknown): value is string { return typeof value === "string" && /^pvr_[A-Za-z0-9_-]{43}$/u.test(value); }
function positive(value: number, code: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw fail(code);
  return value;
}
function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw fail("POLICY_REVIEW_CONTINUATION_CLOCK_INVALID");
  return value;
}
function fail(code: string): never { throw new PolicyReviewContinuationError(code); }
