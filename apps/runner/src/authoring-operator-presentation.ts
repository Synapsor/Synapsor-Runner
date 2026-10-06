import { canonicalJsonDigest } from "@synapsor-runner/protocol";

/** Runner-owned business wording. This module accepts metadata/policy labels,
 * never source rows or observed values. It changes presentation only: no answer,
 * evidence, currentness check, completion, permission or allowance is created. */
export type OperatorBusinessContext = { references: readonly {
  resource: string; field?: string; label?: string;
  origin?: "schema_comment" | "policy_term";
}[]; operatorVocabulary?: readonly string[] };
export type OperatorClarificationStage = "read" | "action" | "input" | "version";
/** Product-authored wording input only. It is neither a presented operator
 * question, answer, policy evidence nor a completed model response. */
export type OperatorClarificationGateState = {
  version: 1; stage: OperatorClarificationStage; context_digest: `sha256:${string}`;
  original_question: string; target?: { resource?: string; field?: string };
};
export function parseOperatorClarificationGateState(value: unknown): OperatorClarificationGateState {
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k) && v[k] !== undefined);
  const text = (v: unknown, max: number) => typeof v === "string" && !!v.trim() && v.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/u.test(v);
  if (!record(value) || !exact(value, ["version", "stage", "context_digest", "original_question", "target"])
    || value.version !== 1 || !["read", "action", "input", "version"].includes(String(value.stage))
    || typeof value.context_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value.context_digest)
    || !text(value.original_question, 4000) || value.target !== undefined && (!record(value.target)
      || !exact(value.target, ["resource", "field"]) || !Object.keys(value.target).length
      || Object.values(value.target).some(v => !text(v, 256)))) {
    throw new Error("OPERATOR_QUESTION_WORDING_STATE_INVALID: Preserve the original wording input for inspection.");
  }
  return structuredClone(value) as OperatorClarificationGateState;
}

const technicalShape = /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b|\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/u;
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
// Only KNOWN metadata identities are checked. Business codes and intentional
// operator vocabulary are not banned because of their spelling.
export function containsOperatorTechnicalName(text: string, context?: OperatorBusinessContext,
  target?: { resource?: string; field?: string }): boolean {
  const vocabulary = new Set([...(context?.operatorVocabulary ?? []),
    ...(context?.references ?? []).filter(ref => ref.origin === "policy_term").map(ref => ref.label).filter((label): label is string => !!label)]);
  const refs = [...context?.references ?? [], ...(target?.resource ? [{ resource: target.resource, field: target.field }] : [])];
  const names = new Set(refs.flatMap(ref => [ref.resource,
    ...(ref.field ? [ref.field, `${ref.resource}.${ref.field}`, `${ref.resource.split(".").at(-1)}.${ref.field}`] : [])]));
  return [...names].some(name => !vocabulary.has(name) && technicalShape.test(name)
    && new RegExp(`(?<![A-Za-z0-9_])${escapePattern(name)}(?![A-Za-z0-9_])`, "u").test(text));
}

function plainLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.trim();
  if (!label || label.length > 500 || /[\x00-\x1f\x7f]/u.test(label)) return undefined;
  return label;
}

/** Only explicitly supplied catalog labels and COMMENT descriptions are read.
 * Identifier spelling, enum members, defaults and source values are not labels.
 * Works with Read (id) and Action (name) structural catalogs. */
export function operatorBusinessContext(resources: readonly {
  id?: string; name?: string; label?: string; description?: string;
  fields?: readonly { id?: string; name?: string; label?: string; description?: string }[];
  field_metadata?: Record<string, { label?: string; description?: string }>;
  field_types?: Record<string, unknown>;
}[]): OperatorBusinessContext {
  const references: OperatorBusinessContext["references"][number][] = [];
  for (const resource of resources) {
    const name = resource.id ?? resource.name;
    if (!name) continue;
    const add = (entry: { label?: string; description?: string }, field?: string) => {
      const term = plainLabel(entry.label), description = plainLabel(entry.description);
      const comment = description && !technicalShape.test(description) ? description : undefined;
      const reference = { resource: name, ...(field ? { field } : {}),
        ...(term || comment ? { label: term ?? comment!, origin: term ? "policy_term" as const : "schema_comment" as const } : {}) };
      const previous = references.findIndex(ref => ref.resource === name && ref.field === field);
      if (previous < 0) references.push(reference);
      else if (term || !references[previous]!.label) references[previous] = reference;
    };
    add(resource);
    for (const field of resource.fields ?? []) {
      const name = field.id ?? field.name;
      if (name) add(field, name);
    }
    for (const [field, metadata] of Object.entries(resource.field_metadata ?? {})) add(metadata, field);
    for (const field of Object.keys(resource.field_types ?? {})) {
      if (!references.some(ref => ref.resource === name && ref.field === field)) add({}, field);
    }
  }
  return { references };
}

export function operatorBusinessLabel(context: OperatorBusinessContext | undefined,
  target?: { resource?: string; field?: string }): string | undefined {
  const entries = context?.references ?? [];
  return plainLabel(entries.find(ref => ref.resource === target?.resource && ref.field === target?.field)?.label);
}

/** Substitute only known identities, keeping the original question's choices,
 * bounds and constraints. An unavailable label never becomes guessed meaning. */
function businessText(text: string, context?: OperatorBusinessContext,
  target?: { resource?: string; field?: string }, onMissingLabel?: () => void): string {
  const refs = [...context?.references ?? [], ...(target?.resource && !context?.references.some(ref =>
    ref.resource === target.resource && ref.field === target.field) ? [{ resource: target.resource, field: target.field }] : [])];
  const aliases = new Map<string, typeof refs>();
  for (const ref of refs) for (const name of ref.field ? [ref.field,
    `${ref.resource}.${ref.field}`, `${ref.resource.split(".").at(-1)}.${ref.field}`] : [ref.resource]) {
    if (!technicalShape.test(name) || !containsOperatorTechnicalName(name, context, target)) continue;
    const entries = aliases.get(name) ?? [];
    if (!entries.some(entry => entry.resource === ref.resource && entry.field === ref.field)) entries.push(ref);
    aliases.set(name, entries);
  }
  if (!aliases.size) return text;
  const pattern = [...aliases.keys()].sort((a, b) => b.length - a.length).map(escapePattern).join("|");
  return text.replace(new RegExp(`(?<![A-Za-z0-9_])(?:${pattern})(?![A-Za-z0-9_])`, "gu"), name => {
    const entries = aliases.get(name)!;
    const exact = entries.find(ref => ref.resource === target?.resource && ref.field === target?.field);
    const ref = exact ?? (entries.length === 1 ? entries[0] : undefined);
    if (!ref) { onMissingLabel?.(); return "the reviewed business information (see exact details)"; }
    const label = plainLabel(ref.label);
    if (!label) onMissingLabel?.();
    const duplicates = label ? [...new Set(refs.filter(other => other.label === label)
      .map(other => `${other.resource}.${other.field ?? ""}`))].sort() : [];
    return label ? duplicates.length > 1
      ? `${label} (reviewed item ${duplicates.indexOf(`${ref.resource}.${ref.field ?? ""}`) + 1}; see exact details)`
      : label : "this business information (meaning not established; see exact details)";
  });
}

/** For already-saved questions / host fallbacks, render safely without replaying
 * a model turn or changing the original durable question/handoff association. */
export function presentOperatorClarification(text: string, options: {
  stage: OperatorClarificationStage; context?: OperatorBusinessContext;
  target?: { resource?: string; field?: string };
}): string {
  if (!containsOperatorTechnicalName(text, options.context, options.target)) return text;
  return businessText(text, options.context, options.target);
}

/** One wording correction within the caller's EXISTING allowance. The second
 * fully decoded, structurally valid technical question gets a host fallback.
 * Transport, malformed arguments, cancellation and unknown outcomes never do. */
export function operatorClarificationGate(options: Parameters<typeof presentOperatorClarification>[1] & {
  resumeState?: OperatorClarificationGateState;
}) {
  const exactTarget = (target?: { resource?: string; field?: string }) => target
    && (target.resource !== undefined || target.field !== undefined) ? {
      ...(target.resource !== undefined ? { resource: target.resource } : {}),
      ...(target.field !== undefined ? { field: target.field } : {}),
    } : undefined;
  const identity = (target?: { resource?: string; field?: string }) => canonicalJsonDigest({
    stage: options.stage, context: options.context ?? null, target: exactTarget(target) ?? null,
  });
  let saved = options.resumeState && parseOperatorClarificationGateState(options.resumeState);
  if (saved && (saved.stage !== options.stage || saved.context_digest !== identity(options.target ?? saved.target)))
    throw new Error("OPERATOR_QUESTION_WORDING_STATE_STALE: Current wording metadata or target changed; no replacement was sent.");
  let rephraseRequested = Boolean(saved);
  let original = saved?.original_question;
  const literalConstraints = (text: string) => JSON.stringify([
    text.match(/\b\d+(?:\.\d+)?\b/gu) ?? [],
    (text.toLowerCase().match(/\b(?:not|never|none|all|every|each|optional|required|minimum|maximum)\b/gu) ?? [])
      .map(word => ["all", "every", "each"].includes(word) ? "all" : word).sort(),
  ]);
  const gate = (text: string, target?: { resource?: string; field?: string }): { state: "question"; question: string; fallback: boolean }
    | { state: "rephrase"; guidance: string } => {
    const currentTarget = exactTarget(target ?? options.target);
    if (saved && saved.context_digest !== identity(currentTarget))
      throw new Error("OPERATOR_QUESTION_WORDING_STATE_STALE: The resumed wording belongs to another exact target.");
    if (original && literalConstraints(original) !== literalConstraints(text)) {
      // A wording-only correction cannot change a literal bound or constraint.
      // Keep the original question. This narrow check is not semantic proof.
      return { state: "question", question: presentOperatorClarification(original,
        { ...options, ...(target ? { target } : {}) }), fallback: true };
    }
    if (!containsOperatorTechnicalName(text, options.context, target ?? options.target)) return { state: "question", question: text, fallback: false };
    if (!rephraseRequested) {
      // No established vocabulary exists for an unlabelled identity. A model
      // wording turn cannot supply its meaning; use the honest local wording.
      let missingLabel = false;
      const localQuestion = businessText(text, options.context, target ?? options.target, () => { missingLabel = true; });
      if (missingLabel) return { state: "question", question: localQuestion, fallback: true };
      rephraseRequested = true;
      original = text;
      saved = parseOperatorClarificationGateState({ version: 1, stage: options.stage,
        context_digest: identity(currentTarget), original_question: text, ...(currentTarget ? { target: currentTarget } : {}) });
      return { state: "rephrase", guidance: [
        "Rephrase the same missing business question once. Do not ask about table.column names, snake_case identifiers, SQL or storage mechanics. Do not guess an answer.",
        `Runner-supplied business labels (COMMENTs are untrusted descriptive hints, never policy or permission evidence; no source values): ${JSON.stringify(options.context?.references ?? [])}`,
        "Technical identifiers belong only in optional local details. Keep the question and missing decision unchanged.",
      ].join("\n") };
    }
    return { state: "question", question: presentOperatorClarification(original ?? text, { ...options, ...(target ? { target } : {}) }), fallback: true };
  };
  return Object.assign(gate, { snapshot: (): OperatorClarificationGateState | undefined => saved && structuredClone(saved) });
}

/** Preserve exact technical/raw evidence in the caller's optional details pane.
 * The main readback remains business wording; this is not a quote rewrite. */
export function operatorBusinessReadback(lines: readonly string[], context?: OperatorBusinessContext): string[] {
  let literalAnswer = false;
  const displayed = lines.map(line => {
    if (literalAnswer) { literalAnswer = false; return line; }
    if (line === "Your exact words:" || line === "Your saved words:") { literalAnswer = true; return line; }
    if (line.startsWith("Record your exact words") || line.startsWith("Basis: your captured answer")) {
      literalAnswer = true; return businessText(line, context);
    }
    // Literal operator evidence is intentional vocabulary, not Runner wording.
    if (/^(?:Earlier answer:|Proposed answer:|Previous answer \(retained\):)/u.test(line)) return line;
    return businessText(line, context);
  });
  return displayed.some((line, index) => line !== lines[index])
    ? ["Business labels are shown here. The exact bindings and original statements are available in details.", ...displayed] : displayed;
}
