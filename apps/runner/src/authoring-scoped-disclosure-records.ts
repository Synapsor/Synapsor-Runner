import { canonicalJsonDigest } from "@synapsor-runner/protocol";

/** An operator-registered source condition, not automatic privacy classification. */
export type ScopedDisclosureReview = {
  origin: "OPERATOR-SOURCE-DISCLOSURE-REVIEW"; id: string; source_digest: string; source_session: string;
  start: number; end: number; source_excerpt: string;
  audience: "scoped_assistant"; purpose: "reviewed_read_discovery";
  read_digest: string; store_digest: string; metadata_digest: string;
  fields: Array<{ resource: string; field: string; binding_digest: string;
    decision: "unanswered" | "deferred" | "confirmed_non_sensitive" | "not_confirmed" }>;
  actor: string; reviewed_at: string; verified: false;
  previous: string | null; digest: string;
};
export type ScopedDisclosureInventory = {
  version: 1; reviews_digest: string;
  items: Array<{ id: string; resource: string; field: string;
    state: "unanswered" | "deferred" | "confirmed_non_sensitive" | "not_confirmed" | "stale";
    assurance: "operator_assertion_only"; verified: false }>;
};
const sha = (v: unknown): v is string => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
export function scopedDisclosureIdentity(r: Pick<ScopedDisclosureReview, "source_digest" | "source_session" | "start" | "end" | "audience" | "purpose" | "fields">) {
  return canonicalJsonDigest({ source: r.source_digest, session:r.source_session, start: r.start, end: r.end, audience: r.audience,
    purpose: r.purpose, fields: r.fields.map(f => ({resource: f.resource, field: f.field})) });
}
export function validScopedDisclosureReview(value: ScopedDisclosureReview): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const {digest, ...body} = value;
  return value.origin === "OPERATOR-SOURCE-DISCLOSURE-REVIEW" && sha(value.source_digest)
    && typeof value.source_session === "string" && /^[a-f0-9-]{36}$/u.test(value.source_session)
    && sha(value.read_digest) && sha(value.store_digest) && sha(value.metadata_digest) && (value.previous === null || sha(value.previous))
    && Number.isInteger(value.start) && value.start >= 1 && Number.isInteger(value.end) && value.end >= value.start
    && typeof value.source_excerpt === "string" && value.source_excerpt.length > 0 && value.source_excerpt.length <= 16_000
    && value.audience === "scoped_assistant" && value.purpose === "reviewed_read_discovery" && value.verified === false
    && typeof value.actor === "string" && value.actor.length > 0 && value.actor.length <= 128
    && typeof value.reviewed_at === "string" && Number.isFinite(Date.parse(value.reviewed_at)) && Array.isArray(value.fields) && value.fields.length > 0 && value.fields.length <= 128
    && value.fields.every(f => f && typeof f.resource === "string" && f.resource.length > 0 && f.resource.length <= 256
      && typeof f.field === "string" && f.field.length > 0 && f.field.length <= 256 && sha(f.binding_digest)
      && ["unanswered", "deferred", "confirmed_non_sensitive", "not_confirmed"].includes(f.decision))
    && new Set(value.fields.map(f => `${f.resource}\0${f.field}`)).size === value.fields.length
    && value.id === scopedDisclosureIdentity(value) && digest === canonicalJsonDigest(body);
}
/** The ledger here is the existing PolicySourceSession; validate rather than
 * dropping malformed requirement records and accidentally making review ready. */
export function assertScopedDisclosureReviews(reviews: unknown): asserts reviews is ScopedDisclosureReview[] {
  if (reviews === undefined) return;
  if (!Array.isArray(reviews) || reviews.length > 64)
    throw new Error("SCOPED_DISCLOSURE_EVIDENCE_INVALID: Source requirements remain pending; restore the saved review records.");
  const latest = new Map<string, string>();
  for (const review of reviews) {
    if (!validScopedDisclosureReview(review) || review.previous !== (latest.get(review.id) ?? null))
      throw new Error("SCOPED_DISCLOSURE_EVIDENCE_INVALID: Source requirements remain pending; their saved lineage is invalid.");
    latest.set(review.id, review.digest);
  }
}
