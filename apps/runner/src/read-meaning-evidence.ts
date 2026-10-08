export type ReadMeaningTarget = { resource: string; field?: string };
/** Historical audit shape only. Parsing preserves recorded provenance; it does not
 * establish current meaning, applicability, permission, or business completeness. */
export type ReadMeaningEvidence = ReadMeaningTarget & {
  origin: "HOST-RESOLVED";
  context_digest: `sha256:${string}`;
  requested_use_digest: `sha256:${string}`;
  reference: {
    kind: "policy_source" | "operator_statement" | "answered_clarification";
    source_id: string;
    source_digest: string;
    source_version?: number;
    start_line: number;
    end_line: number;
    text: string;
  };
};

export type ReadMeaningAttempt = ReadMeaningTarget & {
  question: string; request_digest: `sha256:${string}`; context_digest: `sha256:${string}`;
  answer: string; actor: "local_installation_operator"; recorded_at: string;
};
/** Historical raw audit only. Its text never establishes meaning or resumes a
 * typed mapping; the native producer refuses unsupported semantic history. */
export function normalizeReadMeaningAttempts(value: unknown): ReadMeaningAttempt[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("READ_WORKLOAD_MEANING_ATTEMPTS_INVALID");
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some(key => !["resource", "field", "question", "request_digest", "context_digest", "answer", "actor", "recorded_at"].includes(key))
      || typeof entry.resource !== "string" || !entry.resource || entry.resource.length > 256
      || entry.field !== undefined && (typeof entry.field !== "string" || !entry.field || entry.field.length > 256)
      || typeof entry.question !== "string" || !entry.question || entry.question.length > 500
      || !/^sha256:[a-f0-9]{64}$/u.test(entry.request_digest) || !/^sha256:[a-f0-9]{64}$/u.test(entry.context_digest)
      || typeof entry.answer !== "string" || entry.answer.length > 1_000
      || entry.actor !== "local_installation_operator" || typeof entry.recorded_at !== "string" || !Number.isFinite(Date.parse(entry.recorded_at))) {
      throw new Error("READ_WORKLOAD_MEANING_ATTEMPTS_INVALID");
    }
  }
  return structuredClone(value) as ReadMeaningAttempt[];
}

/** Persisted historical audit shape. This codec does not interpret its text or
 * promote old semantic records into the current typed protocol. */
export function normalizeReadMeaningEvidence(value: unknown): ReadMeaningEvidence[] {
  const record = (item: unknown): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item);
  const exact = (item: Record<string, unknown>, keys: string[]) => Object.keys(item).every(key => keys.includes(key));
  const digest = (item: unknown) => typeof item === "string" && /^sha256:[a-f0-9]{64}$/u.test(item);
  const text = (item: unknown, max: number) => typeof item === "string" && !!item.trim() && item.length <= max;
  const fail = () => new Error("READ_WORKLOAD_MEANING_EVIDENCE_INVALID: Current meaning audit association is malformed; it grants no authority.");
  if (!Array.isArray(value) || value.length > 128 || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw fail();
  for (const entry of value) {
    if (!record(entry) || !exact(entry, ["resource", "field", "origin", "context_digest", "requested_use_digest", "reference"])
      || entry.origin !== "HOST-RESOLVED" || !text(entry.resource, 256) || entry.field !== undefined && !text(entry.field, 256)
      || !digest(entry.context_digest) || !digest(entry.requested_use_digest) || !record(entry.reference)) throw fail();
    const r = entry.reference;
    if (!exact(r, ["kind", "source_id", "source_digest", "source_version", "start_line", "end_line", "text"])
      || !["policy_source", "operator_statement", "answered_clarification"].includes(r.kind as string)
      || !text(r.source_id, 256) || !digest(r.source_digest) || !text(r.text, 4_000)
      || !Number.isSafeInteger(r.start_line) || (r.start_line as number) < 1 || !Number.isSafeInteger(r.end_line)
      || (r.end_line as number) < (r.start_line as number)
      || r.source_version !== undefined && (!Number.isSafeInteger(r.source_version) || (r.source_version as number) < 1)
      || r.kind === "policy_source" && r.source_version === undefined) throw fail();
  }
  return structuredClone(value) as ReadMeaningEvidence[];
}

