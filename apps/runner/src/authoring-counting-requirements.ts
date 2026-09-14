import type { PolicyPassage, PolicyTextSnapshot } from "./authoring-policy-source.js";

const record = (x: unknown): Record<string, any> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : {};
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean).map(w => w.endsWith("s") ? w.slice(0, -1) : w);
export type CountingRequirementBinding = {
  origin: "HOST-SOURCE-ASSOCIATION";
  path: string; source_digest: string; start: number; end: number;
  required_capability: string | null;
  source_excerpt: string;
  ambiguity?: "outcome_reference_unresolved";
  /** Exact applicable counting decision, not a generic instruction to preserve configuration. */
  operator_clarification?: string;
};

/** A bounded association of explicit counting clauses with canonical outcomes.
 * Not semantic equivalence: a recognised outcome-specific requirement still
 * needs either the exact selector or the existing singleton proof. Configuration
 * preservation answers do not redefine what the source says is being counted.
 * No paragraph interpretation supplied by the provider is read here. */
export function countingSourceRequirements(source: PolicyTextSnapshot, draft: unknown, messages: readonly string[]): CountingRequirementBinding[] {
  const d = record(draft), evidence = record(d.runner_evidence);
  const actions: any[] = Array.isArray(d.actions) ? d.actions : [];
  const outcomes = actions.map(a => ({ outcome: a.outcome as string,
    terms: [a.outcome.split(".").at(-1), a.discovery?.title, ...(a.discovery?.aliases ?? [])].filter((x): x is string => typeof x === "string").map(words) }));
  const resolve = (phrase: string): string | null | undefined => {
    const tokens = words(phrase).filter(w => !["approval", "request"].includes(w));
    if (!tokens.length || tokens.every(w => ["action", "outcome", "capability"].includes(w))) return null;
    const matches = outcomes.filter(a => a.terms.some(term => tokens.every(token => term.includes(token))));
    return matches.length === 1 ? matches[0]!.outcome : undefined;
  };
  const bindings: CountingRequirementBinding[] = [];
  for (const [index, line] of source.text.split("\n").entries()) {
    // Restrict source association to an actual limiting clause, not a glossary,
    // examples of actors, or a provider's prose about the current implementation.
    if (!/\b(?:at most|maximum|limit|cap|allowance|no more than)\b/iu.test(line)) continue;
    const phrases = [...line.matchAll(/\bautomatic\s+([a-z][a-z -]*?)(?=\s+(?:overall|per|across|within|in|during|for|shared|with|and|only)\b|[,.;:]|$)/giu)];
    const required = [...new Set(phrases.map(m => resolve(m[1]!)).filter(x => x !== undefined))];
    if (!phrases.length) continue;
    const ambiguous = required.length !== 1 || phrases.some(m => resolve(m[1]!) === undefined);
    const capability = ambiguous ? null : required[0]!;
    let decision: string | undefined;
    for (const message of messages) {
      // This precise change concerns the counting set. A later quota edit or a
      // no-filter implementation correction is not a latest-message-wins override.
      const specific = /\b(?:apply|count)\s+(?:the\s+)?automatic\s+(?:limits|allowances|approvals)\s+only\s+(?:to|for)\s+([a-z][a-z -]*?)(?=[:;,.]|$)/iu.exec(message);
      if (specific && resolve(specific[1]!) === capability) decision = message;
    }
    for (const action of actions) {
      if (capability !== null && action.outcome !== capability) continue;
      const limits = record(evidence.actions)[action.outcome]?.automatic_limits;
      if (!Array.isArray(limits)) continue;
      limits.forEach((limit: any, n: number) => {
        if (limit.kind !== "count") return;
        bindings.push({ origin: "HOST-SOURCE-ASSOCIATION", path: `/runner_evidence/actions/${action.outcome}/automatic_limits/${n}/history_selector/capability`,
          source_digest: source.digest, start: index + 1, end: index + 1, required_capability: capability,
          source_excerpt: line, ...(ambiguous ? { ambiguity: "outcome_reference_unresolved" as const } : {}), ...(decision ? { operator_clarification: decision } : {}) });
      });
    }
  }
  // Existing typed, source-bound interpretations remain obligations even when
  // a reviewer omits a comparison. Never infer a boundary-wide requirement from
  // equal values in the newly submitted report.
  for (const interpretation of evidence.counting_interpretations ?? []) {
    if (interpretation.source_digest !== source.digest) continue;
    for (const check of interpretation.comparisons ?? []) {
      if (bindings.some(b => b.path === check.path && b.start === interpretation.start && b.end === interpretation.end)) continue;
      bindings.push({ origin: "HOST-SOURCE-ASSOCIATION", path: check.path, source_digest: source.digest,
        start: interpretation.start, end: interpretation.end, required_capability: check.required_capability,
        source_excerpt: source.text.split("\n").slice(interpretation.start - 1, interpretation.end).join("\n") });
    }
  }
  return bindings;
}

export function associateCountingRequirements(passage: PolicyPassage, requirements: CountingRequirementBinding[]): CountingRequirementBinding[] {
  const applicable = requirements.filter(r => r.start >= passage.start && r.end <= passage.end);
  const result: CountingRequirementBinding[] = [];
  for (const check of passage.counter_requirements ?? []) {
    const matches = applicable.filter(r => r.path === check.path);
    if (new Set(matches.map(r => r.required_capability)).size > 1) throw new Error(`COUNTING_REQUIREMENT_AMBIGUOUS: ${check.path} has incompatible source requirements. Keep this counting component unresolved.`);
    const required = matches[0];
    if (!required) continue;
    if (required.ambiguity) {
      if (passage.disposition === "conflict") { result.push(required); continue; }
      throw new Error(`COUNTING_REQUIREMENT_AMBIGUOUS: ${check.path} cannot be uniquely associated with the explicit source counting set. Supply a precise source/outcome interpretation; equality is not evidence.`);
    }
    if (required.required_capability !== check.required_capability) {
      throw new Error(`COUNTING_REQUIREMENT_MISMATCH: ${check.path} compares a provider-supplied required value inconsistent with source lines ${required.start}-${required.end}. Use required_capability=${JSON.stringify(required.required_capability)}; equality with the saved selector is not source equivalence. Keep the provider claim separate; use an exact reviewed selector change or the existing applicable domain proof, never an old configuration-preservation answer as a new counting requirement.`);
    }
    if (required.operator_clarification && check.operator_clarification && required.operator_clarification !== check.operator_clarification) {
      throw new Error(`COUNTING_SUPPORT_MISMATCH: ${check.path} cites an older or unrelated implementation decision instead of the applicable counting-set decision. Correct this component's support; do not restate the business policy.`);
    }
    result.push(required);
  }
  return result;
}
