import { expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { normalizeReadMeaningAttempts, normalizeReadMeaningEvidence } from "./read-meaning-evidence.js";

it.each(["I'm not sure", "  未知という名前の状態です。 🧭\t", "The display value is Unknown."])(
  "historical audit preserves exact raw text without recognizing English uncertainty: %s", raw => {
    const record = { resource: "service.cases", field: "state", question: "What does this state represent?",
      request_digest: d("exact historical question"), context_digest: d("exact historical context"), answer: raw,
      actor: "local_installation_operator", recorded_at: "2026-10-08T06:32:23Z" };
    const copy = normalizeReadMeaningAttempts([record]);
    expect(copy).toEqual([record]); expect(copy[0]).not.toBe(record);
    expect(copy[0]).not.toHaveProperty("confirmation");
    expect(() => normalizeReadMeaningAttempts([{ ...record, confirmed: true }])).toThrow("MEANING_ATTEMPTS_INVALID");
    expect(() => normalizeReadMeaningAttempts(Array(5).fill(record))).toThrow("MEANING_ATTEMPTS_INVALID");
  });

it("historical evidence codec validates exact record shape without reinterpreting or granting its text", () => {
  const raw = "A historical operator definition stays historical.";
  const record = { resource: "service.cases", field: "state", origin: "HOST-RESOLVED", context_digest: d("context"), requested_use_digest: d("use"),
    reference: { kind: "policy_source", source_id: "original-policy", source_digest: d(raw), source_version: 1, start_line: 3, end_line: 3, text: raw } };
  expect(normalizeReadMeaningEvidence([record])).toEqual([record]);
  expect(() => normalizeReadMeaningEvidence([{ ...record, authority: "all" }])).toThrow("MEANING_EVIDENCE_INVALID");
  expect(() => normalizeReadMeaningEvidence([{ ...record, reference: { ...record.reference, source_digest: "changed" } }])).toThrow("MEANING_EVIDENCE_INVALID");
  expect(() => normalizeReadMeaningEvidence([{ ...record, reference: { ...record.reference, source_version: undefined } }])).toThrow("MEANING_EVIDENCE_INVALID");
});
