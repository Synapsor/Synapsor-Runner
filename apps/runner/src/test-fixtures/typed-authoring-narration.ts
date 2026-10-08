/** Derive the complete non-authorizing acknowledgement only from the outgoing
 * model-visible request. No fixture can borrow hidden host state. */
export function typedNarrationReply(body: unknown): string {
  const strings = (value: unknown): string[] => typeof value === "string" ? [value]
    : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const line = strings(body).flatMap(value => value.split("\n"))
    .find(line => line.startsWith("Typed narration record: "));
  if (!line) throw new Error("The model did not receive a typed narration record.");
  const record = JSON.parse(line.slice("Typed narration record: ".length));
  return JSON.stringify({ kind: "validated_record", record_digest: record.record_digest,
    fact_indexes: record.facts.map((fact: { index: number }) => fact.index) });
}
