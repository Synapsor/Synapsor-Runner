import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { CountingRequirementBinding, PolicyPassage, PolicyTextSnapshot, CountingDecision } from "./authoring-policy-source.js";

const record = (x: unknown): Record<string, any> => x && typeof x === "object" && !Array.isArray(x) ? x as Record<string, any> : {};
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean).map(w => w.endsWith("s") ? w.slice(0, -1) : w);


export const countingConfigurationDigest = (limit: Record<string, any>) => canonicalJsonDigest({
  id: limit.id, kind: limit.kind, scope: limit.scope, maximum: limit.maximum,
  window_seconds: limit.window_seconds, capability: limit.capability ?? null,
});
/** Configuration inventory is independent of every source wording heuristic. */
export function configuredCountingLimits(draft: unknown): Array<{ path: string; limit: Record<string, any>; digest: string }> {
  const d = record(draft), evidence = record(record(d.runner_evidence).actions);
  const result: Array<{ path: string; limit: Record<string, any>; digest: string }> = [];
  for (const action of Array.isArray(d.actions) ? d.actions : []) {
    const limits = action.approval?.shared_limits ?? [];
    const actual = evidence[action.outcome]?.automatic_limits;
    for (const [index, limit] of limits.entries()) {
      if (limit.kind !== "count") continue;
      if (!Array.isArray(actual) || !actual[index] || actual[index].kind !== "count"
        || ["id", "scope", "maximum", "window_seconds", "capability"].some(key => actual[index][key] !== limit[key])) {
        throw new Error("COUNTING_CONFIGURATION_INCOMPLETE: Current configured limit evidence is unavailable or mismatched. Rebuild exact draft evidence; missing evidence is not no obligation.");
      }
    }
  }
  for (const [outcome, action] of Object.entries(evidence)) {
    for (const [index, limit] of (action.automatic_limits ?? []).entries()) {
      if (limit.kind !== "count") continue;
      result.push({ path: `/runner_evidence/actions/${outcome}/automatic_limits/${index}/history_selector/capability`,
        limit, digest: countingConfigurationDigest(limit) });
    }
  }
  return result;
}
export function applicableCountingDecisions(source: PolicyTextSnapshot, draft: unknown, messages: readonly string[], decisions: CountingDecision[] = []): CountingDecision[] {
  const inventory = configuredCountingLimits(draft);
  return decisions.filter(d => d.origin === "OPERATOR-COUNTING-REVIEW" && d.source_digest === source.digest
    && d.operator_history_digest === canonicalJsonDigest(messages)
    && inventory.some(limit => limit.path === d.path && limit.digest === d.configuration_digest)
    && (d.required_capability === null || (record(draft).actions ?? []).some((a: any) => a.outcome === d.required_capability)));
}

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
          source_digest: source.digest, start: index + 1, end: index + 1,
          source_excerpt: line, ...(ambiguous ? { state: "ambiguous" as const, ambiguity: "outcome_reference_unresolved" as const } : { state: "established" as const, required_capability: capability }), ...(decision ? { operator_clarification: decision } : {}) });
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
        state: "established", start: interpretation.start, end: interpretation.end, required_capability: check.required_capability,
        source_excerpt: source.text.split("\n").slice(interpretation.start - 1, interpretation.end).join("\n") });
    }
  }
  // A counter-specific citation needs an exact accepted support record even
  // when the source requirement already establishes literal selector equality.
  for (const binding of bindings) {
    binding.accepted_support = [...new Set([
      ...(binding.operator_clarification ? [binding.operator_clarification] : []),
      ...(evidence.counting_interpretations ?? []).filter((i: any) => i.source_digest === source.digest
        && i.operator_history_digest === canonicalJsonDigest(messages) && messages.includes(i.operator_support?.answer)
        && i.start === binding.start && i.end === binding.end
        && i.comparisons?.some((c: any) => c.path === binding.path && c.required_capability === binding.required_capability))
        .map((i: any) => i.operator_support.answer),
    ])];
  }
  // Exact operator reviews fill genuinely unestablished interpretations only.
  // They cannot override an established contrary source requirement.
  const decisions = applicableCountingDecisions(source, draft, messages, evidence.counting_decisions ?? []);
  for (const configured of configuredCountingLimits(draft)) {
    const matches = bindings.filter(b => b.path === configured.path);
    for (const b of matches) b.configuration_digest = configured.digest;
    if (matches.some(m => m.state === "established")) continue;
    const selected = decisions.filter(d => d.path === configured.path);
    const unique = [...new Set(selected.map(d => d.required_capability))];
    if (matches.length && unique.length !== 1) continue;
    for (const match of matches) bindings.splice(bindings.indexOf(match), 1);
    bindings.push({ origin: "HOST-SOURCE-ASSOCIATION", path: configured.path, source_digest: source.digest,
      start: 1, end: source.lines, source_excerpt: source.text, configuration_digest: configured.digest,
      ...(unique.length === 1 ? { state: "established" as const, required_capability: unique[0]!, operator_review: structuredClone(selected[0]!) }
        : { state: unique.length > 1 ? "ambiguous" as const : "unknown" as const }) });
  }
  return bindings;
}

export function associateCountingRequirements(passage: PolicyPassage, requirements: CountingRequirementBinding[]): CountingRequirementBinding[] {
  const applicable = requirements.filter(r => (r.start >= passage.start && r.end <= passage.end) || r.state !== "established" || r.configuration_digest && r.start === 1);
  const result: CountingRequirementBinding[] = [];
  for (const check of passage.counter_requirements ?? []) {
    const matches = applicable.filter(r => r.path === check.path);
    if (new Set(matches.map(r => r.required_capability)).size > 1) throw new Error(`COUNTING_REQUIREMENT_AMBIGUOUS: ${check.path} has incompatible source requirements. Keep this counting component unresolved.`);
    const required = matches[0];
    if (!required || required.state === "unknown") {
      if (passage.disposition !== "implemented") continue;
      throw new Error(`COUNTING_REQUIREMENT_UNESTABLISHED: ${check.path} has no positively established counting set. Preserve it as needs_decision; review which automatic approvals consume this allowance through the attached-rules counting review. Supplied equality is not evidence.`);
    }
    if (required.state === "ambiguous") {
      if (passage.disposition === "conflict") { result.push(required); continue; }
      throw new Error(`COUNTING_REQUIREMENT_AMBIGUOUS: ${check.path} cannot be uniquely associated with the explicit source counting set. Supply a precise source/outcome interpretation; equality is not evidence.`);
    }
    if (required.required_capability !== check.required_capability) {
      throw new Error(`COUNTING_REQUIREMENT_MISMATCH: ${check.path} compares a provider-supplied required value inconsistent with source lines ${required.start}-${required.end}. Use required_capability=${JSON.stringify(required.required_capability)}; equality with the saved selector is not source equivalence. Keep the provider claim separate; use an exact reviewed selector change or the existing applicable domain proof, never an old configuration-preservation answer as a new counting requirement.`);
    }
    if (check.operator_clarification && !required.operator_clarification
      && !required.accepted_support?.includes(check.operator_clarification)) {
      throw new Error(`COUNTING_SUPPORT_MISMATCH: ${check.path} cites a message with no exact accepted support association. ${required.operator_review
        ? "This counting requirement is supported by the explicit host-recorded operator counting review."
        : "This counting requirement is established by its source clause; no accepted counter-specific message is linked."} Omit the unbound counter citation and retain the source/host requirement comparison; keep any paragraph citation separate. No policy change or new owner answer is required.`);
    }
    if (required.operator_clarification && check.operator_clarification && required.operator_clarification !== check.operator_clarification) {
      throw new Error(`COUNTING_SUPPORT_MISMATCH: ${check.path} has no checked provenance link from the submitted implementation citation to its applicable counting-set decision. Reference the existing exact counting decision: ${JSON.stringify(required.operator_clarification)}. Correct this component's citation only; no new owner answer or policy edit is required.`);
    }
    result.push(required);
  }
  return result;
}
