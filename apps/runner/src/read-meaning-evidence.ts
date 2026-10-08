import { canonicalJsonDigest } from "@synapsor-runner/protocol";

export type ReadMeaningTarget = { resource: string; field?: string };
export type ReadMeaningCatalog = { resources: Array<{ id: string; fields: Array<{ id: string }> }> };
export type ReadMeaningStatement = {
  text: string;
  origin: "policy_source" | "operator_statement";
  source_digest: string;
  source_id: string;
  source_version?: number;
};
/** Audit provenance only. It proves exact current association, not English
 * entailment, permission, database values, or completeness of a business review. */
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

export function readMeaningReferences(target: ReadMeaningTarget, catalog: ReadMeaningCatalog): string[] {
  const resource = catalog.resources.find(item => item.id === target.resource);
  if (!resource || target.field !== undefined && !resource.fields.some(item => item.id === target.field)) return [];
  const table = resource.id.split(".").at(-1)!;
  const uniqueTable = catalog.resources.filter(item => item.id.split(".").at(-1) === table).length === 1;
  const uniqueField = target.field !== undefined && catalog.resources.filter(item => item.fields.some(field => field.id === target.field)).length === 1;
  return [target.field === undefined ? resource.id : `${resource.id}.${target.field}`,
    ...(uniqueTable ? [target.field === undefined ? table : `${table}.${target.field}`] : []),
    ...(uniqueField ? [target.field!] : [])];
}

/** Conservative explicit statement recognition, not a general prose parser.
 * Unknown phrasing stays unresolved. Exact tokens prevent a private/prefixed or
 * ambiguous other-resource identifier from inheriting a meaning. */
function explicitReadStatements(clause: string, target: ReadMeaningTarget, catalog: ReadMeaningCatalog): Array<{ kind: "definition" | "transition"; meaning: string }> {
  const references = readMeaningReferences(target, catalog), claims: Array<{ kind: "definition" | "transition"; meaning: string }> = [];
  for (const token of clause.matchAll(/[\p{L}\p{N}_.:-]+/gu)) {
    if (!references.includes(token[0])) continue;
    const before = clause.slice(0, token.index), after = clause.slice(token.index! + token[0].length);
    if (/\b(?:caller|input|parameter)\s+(?:[\p{L}\p{N}_]+\s+){0,2}$/iu.test(before)) continue;
    const definition = target.field === undefined ? /^(?:means|represents|is|contains)$/iu : /^(?:means|represents|records|stores|is)$/iu;
    const verb = after.match(target.field === undefined ? /^\s+(\w+)\s+(\S.{3,})/u
      : /^\s+(?:(?:field|column)\s+)?(\w+)\s+(\S.{3,})/u);
    if (verb && definition.test(verb[1]!) && !/^(?:(?:one|any)\s+of|(?:enum|allowed|permitted|valid|unknown|unclear|unresolved|unestablished)\b|not\s+(?:known|established|understood)|[([])/iu.test(verb[2]!)) {
      claims.push({ kind: "definition", meaning: verb[2]!.trim().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ").toLowerCase() });
    }
    if (target.field !== undefined && /\bset\s+$/iu.test(before)
      && /^\s+(?:to\s+)?[\p{L}\p{N}_-]+(?:\s|$)/u.test(after.trimEnd())) claims.push({ kind: "transition", meaning: after.trim() });
  }
  return claims;
}
export function isExplicitReadMeaningStatement(clause: string, target: ReadMeaningTarget, catalog: ReadMeaningCatalog): boolean {
  return explicitReadStatements(clause, target, catalog).length > 0;
}
/** Keep Source text/provenance intact; recognize only existing sentence
 * boundaries or a following exact qualified catalog identity. */
function readMeaningClauses(text: string, catalog: ReadMeaningCatalog): string[] {
  const qualifiedIds = new Set(catalog.resources.flatMap(resource => [resource.id,
    ...resource.fields.map(field => `${resource.id}.${field.id}`)]));
  const clauses: string[] = [];
  let start = 0;
  for (const boundary of text.matchAll(/;|(?<=[.!?])\s+/gu)) {
    const next = boundary.index! + boundary[0].length;
    const tail = text.slice(next);
    const token = /^[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)+/u.exec(tail)?.[0];
    if (boundary[0] !== ";" && !/^[A-Z]/u.test(tail) && (!token || !qualifiedIds.has(token))) continue;
    clauses.push(text.slice(start, boundary.index));
    start = next;
  }
  clauses.push(text.slice(start));
  return clauses;
}
/** Exact definition phrases from already host-resolved current evidence. These
 * are attributable naming aliases, not inferred synonyms or access decisions. */
export function readResourceDefinitionPhrases(evidence: ReadMeaningEvidence, catalog: ReadMeaningCatalog): string[] {
  if (evidence.field !== undefined) return [];
  return readMeaningClauses(evidence.reference.text, catalog)
    .flatMap(clause => explicitReadStatements(clause, { resource: evidence.resource }, catalog))
    .filter(claim => claim.kind === "definition").map(claim => claim.meaning);
}
export class ReadMeaningConflictError extends Error {
  constructor(readonly evidence: ReadMeaningEvidence[]) {
    super("READ_WORKLOAD_MEANING_CONFLICT: Current explicit statements differ; no reviewed precedence was established. Keep them visible and ask for a new attributed interpretation.");
  }
}

/** Only explicit nonanswers, never an arbitrary classifier of human knowledge.
 * A real explanation containing a status called Unknown is not a nonanswer. */
export function isUnknownReadMeaning(answer: string): boolean {
  return /^(?:(?:i|we)\s+(?:do\s+not|don['’]t|cannot|can['’]t)\s+(?:know|tell|explain)(?:\s+(?:yet|what\b.*|how\b.*|the\b.*|this\b.*))?|(?:i(?:['’]m| am)|we are)\s+(?:not sure|unsure)|(?:unknown|not sure|unsure|unresolved|not known|no idea))[.!?\s]*$/iu.test(answer.trim());
}
export type ReadMeaningAttempt = ReadMeaningTarget & {
  question: string; request_digest: `sha256:${string}`; context_digest: `sha256:${string}`;
  answer: string; actor: "local_installation_operator"; recorded_at: string;
};
export function normalizeReadMeaningAttempts(value: unknown): ReadMeaningAttempt[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("READ_WORKLOAD_MEANING_ATTEMPTS_INVALID");
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).some(key => !["resource", "field", "question", "request_digest", "context_digest", "answer", "actor", "recorded_at"].includes(key))
      || typeof entry.resource !== "string" || !entry.resource || entry.resource.length > 256
      || entry.field !== undefined && (typeof entry.field !== "string" || !entry.field || entry.field.length > 256)
      || typeof entry.question !== "string" || !entry.question || entry.question.length > 500
      || !/^sha256:[a-f0-9]{64}$/u.test(entry.request_digest) || !/^sha256:[a-f0-9]{64}$/u.test(entry.context_digest)
      || typeof entry.answer !== "string" || entry.answer.length > 1_000 || !isUnknownReadMeaning(entry.answer)
      || entry.actor !== "local_installation_operator" || typeof entry.recorded_at !== "string" || !Number.isFinite(Date.parse(entry.recorded_at))) {
      throw new Error("READ_WORKLOAD_MEANING_ATTEMPTS_INVALID");
    }
  }
  return structuredClone(value) as ReadMeaningAttempt[];
}

export function findReadMeaningEvidence(input: {
  target: ReadMeaningTarget;
  catalog: ReadMeaningCatalog;
  statements: readonly ReadMeaningStatement[];
  answers: readonly (ReadMeaningTarget & { question: string; answer: string })[];
  context_digest: `sha256:${string}`;
  requested_use_digest: `sha256:${string}`;
}): ReadMeaningEvidence | undefined {
  if (!readMeaningReferences(input.target, input.catalog).length) return;
  const exactAnswers = input.answers.filter(answer => answer.resource === input.target.resource && answer.field === input.target.field);
  if (exactAnswers.length > 1 && new Set(exactAnswers.map(answer => answer.answer)).size > 1) {
    throw new Error("READ_WORKLOAD_MEANING_CONFLICT: Competing attributed answers remain unresolved. Review the exact current decision; no model claim replaced it.");
  }
  const answer = exactAnswers.at(-1);
  if (answer) return { ...input.target, origin: "HOST-RESOLVED", context_digest: input.context_digest,
    requested_use_digest: input.requested_use_digest, reference: { kind: "answered_clarification",
      source_id: canonicalJsonDigest({ target: input.target, question: answer.question }), source_digest: canonicalJsonDigest(answer.answer),
      start_line: 1, end_line: answer.answer.split(/\r?\n/u).length, text: answer.answer } };
  const candidates: Array<{ evidence: ReadMeaningEvidence; kind: "definition" | "transition"; meaning: string }> = [];
  // A newly received answer is available before the outer conversation has
  // copied it into statements. Only explicit field references within an answer
  // for this resource may supply an additional association; a resource answer
  // is never inherited wholesale by its fields.
  const statements: Array<Omit<ReadMeaningStatement, "origin"> & { origin: ReadMeaningEvidence["reference"]["kind"] }> = [
    ...input.statements,
    ...input.answers.filter(answer => answer.resource === input.target.resource).map(answer => ({
      text: answer.answer, origin: "answered_clarification" as const,
      source_id: canonicalJsonDigest({ target: { resource: answer.resource, ...(answer.field ? { field: answer.field } : {}) }, question: answer.question }),
      source_digest: canonicalJsonDigest(answer.answer),
    })),
  ];
  for (const statement of statements) {
    for (const [index, line] of statement.text.split(/\r?\n/u).entries()) {
      const claims = readMeaningClauses(line, input.catalog).flatMap(clause => explicitReadStatements(clause, input.target, input.catalog));
      for (const claim of claims) candidates.push({ ...claim, evidence: { ...input.target, origin: "HOST-RESOLVED",
        context_digest: input.context_digest, requested_use_digest: input.requested_use_digest, reference: { kind: statement.origin,
          source_id: statement.source_id, source_digest: statement.source_digest,
          ...(statement.source_version !== undefined ? { source_version: statement.source_version } : {}),
          start_line: index + 1, end_line: index + 1, text: line } } });
    }
  }
  const definitions = candidates.filter(candidate => candidate.kind === "definition");
  if (new Set(definitions.map(candidate => candidate.meaning)).size > 1) throw new ReadMeaningConflictError(definitions.map(candidate => candidate.evidence));
  // Different explicitly named operations may use the same field for different
  // transitions. Retain the Source-wide binding, without claiming all enum or
  // guard semantics have been interpreted by this finite naming check.
  return (definitions[0] ?? candidates[0])?.evidence;
}

/** Persisted audit shape. Applicability is always recomputed by the producer
 * against current Source and decisions; stored audit JSON is never authority. */
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

/** Exact positive read instructions are dependencies even if a malformed model
 * plan omits them. This does not parse arbitrary policy meaning or add fields;
 * ambiguity remains for ordinary clarification/whole-program review. */
export function explicitReadTaskTargets(text: string, catalog: ReadMeaningCatalog): ReadMeaningTarget[] {
  const found = new Map<string, ReadMeaningTarget>();
  // Mask quotations before splitting instructions, so a later quoted clause
  // cannot escape its quotation context. Original evidence is never rewritten.
  const characters = [...text];
  let quoteEnd: string | undefined;
  const unquoted = characters.map((character, index) => {
    if (quoteEnd) {
      if (character === quoteEnd) quoteEnd = undefined;
      return character === "\n" ? "\n" : " ";
    }
    const apostrophe = /['’]/u.test(character) && /[\p{L}\p{N}]/u.test(characters[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(characters[index + 1] ?? "");
    if (!apostrophe && /["'“‘`]/u.test(character)) {
      quoteEnd = character === "“" ? "”" : character === "‘" ? "’" : character;
      return " ";
    }
    return character;
  }).join("");
  const clauses = unquoted.split(/[;\n]|(?<=[.!?])\s+|(?:,\s*|\s+)(?:and|but)\s+(?=(?:(?:do\s+not|don't|never|not)\s+)?(?:read|show|display|include|return)\b)/iu);
  for (const resource of catalog.resources) for (const field of resource.fields) {
    const target = { resource: resource.id, field: field.id };
    const references = readMeaningReferences(target, catalog);
    for (const clause of clauses) {
      for (const token of clause.matchAll(/[\p{L}\p{N}_.:-]+/gu)) {
        // A sentence-ending period is punctuation, not part of the field.
        // Strip it only when the remaining complete token is an exact reference.
        if (!references.includes(token[0]) && !(token[0].endsWith(".") && references.includes(token[0].slice(0, -1)))) continue;
        const before = clause.slice(0, token.index);
        // Recognize a finite positive instruction, not the meaning of its
        // requested-use phrase. The exact catalog token remains authoritative;
        // no model-selected plan or generated label can erase that dependency.
        const instruction = before.match(/(?<![\p{L}\p{N}_.:-])\b(?:read|show|display|include|return)\s+(?:(?:(?:me|the|current)\s+){0,2}|(?:[\p{L}\p{N}_-]+\s+){1,12}(?:in|from|of|on|at)\s+)$/iu);
        if (!instruction) continue;
        const prefix = before.slice(0, instruction.index);
        // "Show asset display name" contains the noun phrase "display name",
        // not a second imperative naming another resource's bare `name` field.
        // A qualified catalog reference remains explicit even in a longer task.
        const reference = token[0].replace(/\.$/u, "");
        if (reference === field.id && /\b(?:read|show|display|include|return)\b/iu.test(prefix)) continue;
        // A separate execution prohibition or another field's negative is not
        // a withdrawal of this positive Read instruction.
        if (/\b(?:not|never|no|cannot|avoid|without|don['’]t|can['’]t)(?:\s+(?:ever|again|currently|also|yet|safely|need\s+to|permission\s+to))?\s*$/iu.test(prefix)
          || /(?:^|[^\p{L}\p{N}_-])(?:not|never|no|cannot|without|avoid)(?![\p{L}\p{N}_-])/iu.test(instruction[0])) continue;
        const surrounding = before + clause.slice(token.index! + token[0].length);
        if (/(?<![\p{L}\p{N}_.-])(?:if|unless|when|example|hypothetical)(?![\p{L}\p{N}_.-])/iu.test(surrounding)) continue;
        found.set(JSON.stringify(target), target);
      }
    }
  }
  return [...found.values()];
}
