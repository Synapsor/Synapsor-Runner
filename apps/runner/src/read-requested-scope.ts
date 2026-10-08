/** Transient evidence from the complete operator request and current inspected
 * identities. Requirements are a lower bound, never permission or a claim that
 * arbitrary prose has been completely interpreted. Names nominate candidates. */
export type ExactReadRequestBinding = { description: string; resource_ids: string[] };

export type RequestedReadAssociations = {
  required: string[];
  candidates: string[][];
  ambiguous: string[][];
};

export function requestedReadResourceIds(jobIntent: string, availableResourceIds: string[]): string[] {
  return requestedReadResourceAssociations(jobIntent, availableResourceIds).required;
}

export function requestedReadResourceAssociations(jobIntent: string, availableResourceIds: string[]): RequestedReadAssociations {
  const text = readOrientedJobText(jobIntent);
  const qualified = qualifiedReferences(text);
  const required = availableResourceIds.filter(id => qualified.some(token => token === id || token.startsWith(`${id}.`)));
  const words = requestWords(text);
  const candidates = candidateGroups(words, availableResourceIds.map(id => ({ id })), new Set());
  return { required, candidates, ambiguous: candidates.filter(group => group.length > 1) };
}

/** Definitions must come from current host-resolved meaning evidence. Catalog
 * labels and basenames have identical candidate-only status. Neither a model
 * selecting a candidate nor a unique catalog spelling establishes association. */
export function resolveRequestedReadScope(input: {
  original: string;
  resources: readonly { id: string; label?: string }[];
  definitions: readonly { resource: string; phrases: readonly string[] }[];
  statements: readonly string[];
  /** Current native reviewed/resumable workload associations, never model claims. */
  exactRequests?: readonly ExactReadRequestBinding[];
}): RequestedReadAssociations & { excluded: string[]; conflicts: string[]; unresolved: boolean } {
  const ids = input.resources.map(resource => resource.id);
  const fragments = readOrientedJobFragments(input.original, true);
  const establishedRoots = new Set<string>();
  let conflictingRequests = false;
  const unmatched = fragments.filter(fragment => {
    const bindings = (input.exactRequests ?? []).filter(binding => exactRequestText(binding.description) === exactRequestText(fragment));
    const alternatives = distinctGroups(bindings.map(binding => binding.resource_ids));
    if (alternatives.length > 1) conflictingRequests = true;
    if (alternatives.length !== 1 || !alternatives[0]!.length || alternatives[0]!.some(id => !ids.includes(id))) return true;
    alternatives[0]!.forEach(id => establishedRoots.add(id));
    return false;
  });
  const text = unmatched.map(unquotedRequest).join("; ");
  const base = requestedReadResourceAssociations(input.original, ids);
  const words = requestWords(text);
  const definitionsByPhrase = new Map<string, string[]>();
  for (const definition of input.definitions) {
    if (!ids.includes(definition.resource)) continue;
    for (const phrase of definition.phrases) {
      const phraseWords = normalizedSemanticWords(phrase);
      if (!containsWordSequence(words, phraseWords)) continue;
      const key = phraseWords.join(" ");
      definitionsByPhrase.set(key, [...new Set([...(definitionsByPhrase.get(key) ?? []), definition.resource])]);
    }
  }
  const required = new Set([...base.required, ...establishedRoots]);
  const covered = new Set<number>();
  const conflictingDefinitions: string[][] = [];
  for (const [phrase, targets] of definitionsByPhrase) {
    if (targets.length !== 1) { conflictingDefinitions.push(targets); continue; }
    required.add(targets[0]!);
    for (const start of sequencePositions(words, phrase.split(" "))) {
      phrase.split(" ").forEach((_word, offset) => covered.add(start + offset));
    }
  }
  const candidates = distinctGroups([...candidateGroups(words, input.resources, covered), ...conflictingDefinitions]);
  const excluded = new Set<string>();
  for (const source of [input.original, ...input.statements]) for (const clause of requestClauses(source)) {
    const target = negativeTarget(clause);
    if (!target) continue;
    for (const id of ids) if (target === id) excluded.add(id);
    const negativeWords = normalizedSemanticWords(target);
    // Whole-root evidence only. A field restriction is not a root exclusion.
    for (const definition of input.definitions) if (ids.includes(definition.resource)
      && definition.phrases.some(phrase => {
        const phraseWords = normalizedSemanticWords(phrase);
        return phraseWords.length > 0 && phraseWords.length === negativeWords.length
          && phraseWords.every((word, index) => word === negativeWords[index]);
      })) excluded.add(definition.resource);
  }
  // An established clause cannot erase a separate unsupported positive clause.
  // This remains bounded syntax evidence, not general English entailment.
  const unresolved = conflictingRequests || unmatched.some(fragment => {
    const masked = unquotedRequest(fragment);
    const references = qualifiedReferences(masked), localWords = requestWords(masked);
    return references.some(token => !ids.some(id => token === id || token.startsWith(`${id}.`)))
      || references.length === 0 && candidateGroups(localWords, input.resources, new Set()).length === 0
        && !input.definitions.some(definition => ids.includes(definition.resource)
          && definition.phrases.some(phrase => containsWordSequence(localWords, normalizedSemanticWords(phrase))));
  });
  return { required: [...required], excluded: [...excluded], candidates,
    ambiguous: candidates.filter(group => group.length > 1), conflicts: [...required].filter(id => excluded.has(id)),
    unresolved };
}

function qualifiedReferences(text: string): string[] {
  return [...text.matchAll(/[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)+/gu)].map(match => match[0]);
}
function requestWords(text: string): string[] {
  return normalizedSemanticWords(text.replace(/[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)+/gu, " "));
}
function sequencePositions(words: string[], needle: string[]): number[] {
  if (!needle.length) return [];
  return words.flatMap((_word, index) => needle.every((word, offset) => word === words[index + offset]) ? [index] : []);
}
function distinctGroups(groups: string[][]): string[][] {
  return groups.map(group => [...new Set(group)]).filter((group, index, all) =>
    all.findIndex(other => other.length === group.length && other.every(id => group.includes(id))) === index);
}
function candidateGroups(words: string[], resources: readonly { id: string; label?: string }[], covered: Set<number>): string[][] {
  const occurrences: { start: number; end: number; ids: string[] }[] = [];
  for (const resource of resources) {
    const name = normalizedSemanticWords(resource.id.split(".").at(-1) ?? resource.id);
    const phrases = [name, name.filter(word => !RESOURCE_MENTION_STOP_WORDS.has(word)),
      ...(resource.label ? [normalizedSemanticWords(resource.label)] : [])];
    for (const phrase of phrases) for (const start of sequencePositions(words, phrase)) {
      if (phrase.every((_word, offset) => covered.has(start + offset))) continue;
      occurrences.push({ start, end: start + phrase.length, ids: [resource.id] });
    }
  }
  // Overlapping label/basename occurrences are one unresolved association,
  // including a unique basename competing with a different resource's label.
  const groups: typeof occurrences = [];
  for (const occurrence of occurrences.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = groups.at(-1);
    if (previous && occurrence.start < previous.end) {
      previous.end = Math.max(previous.end, occurrence.end); previous.ids.push(...occurrence.ids);
    } else groups.push({ ...occurrence, ids: [...occurrence.ids] });
  }
  return distinctGroups(groups.map(group => group.ids));
}

function requestClauses(text: string): string[] {
  return unquotedRequest(text).split(/[;\n]|(?<=[.!?])\s+|(?:,\s*|\s+)(?:and|but)\s+(?=(?:do\s+not|don['’]t|never|not)\b)/iu);
}
function negativeTarget(clause: string): string | undefined {
  const negative = /^\s*(?:do\s+not|don['’]t|never)\s+(?:read|show|list|include|expose)\s+(.+?)\.?\s*$/iu.exec(clause)
    ?? /^\s*(?:exclude|not)\s+(.+?)\.?\s*$/iu.exec(clause)
    ?? /^\s*(.+?)\s+(?:is|are)\s+(?:excluded|not\s+requested)\.?\s*$/iu.exec(clause);
  return negative?.[1]?.trim();
}

/** A literal, complete identity list is the one upper bound this helper can
 * establish without interpreting business prose. Unrecognized clauses remain
 * unresolved; never turn a partial keyword match into a complete allowlist. */
export function exactOnlyReadResourceIds(text: string, availableResourceIds: readonly string[]): string[] | undefined {
  const match = /^\s*(?:read|show|list)\s+only\s+(.+?)\.?\s*$/iu.exec(unquotedRequest(text));
  if (!match) return undefined;
  const terms = match[1]!.split(/\s*,\s*|\s+and\s+/iu).map(term => term.trim()).filter(Boolean);
  if (!terms.length || terms.some(term => !availableResourceIds.includes(term))) return undefined;
  return [...new Set(terms)];
}

function readOrientedJobText(jobIntent: string): string {
  return readOrientedJobFragments(jobIntent).join(" ");
}

/** Detect instructions on an offset-preserving masked view, then optionally
 * retain their exact original clauses for native reviewed-request comparison.
 * Quoted business literals are data; quoted historical Read verbs stay inert. */
function readOrientedJobFragments(jobIntent: string, retainQuotedText = false): string[] {
  const masked = unquotedRequest(jobIntent);
  const fragments: string[] = [];
  const clauses = splitTextRanges(masked, /[;\n]|(?<=[.!?])\s+|(?:,\s*|\s+)(?:and|but)\s+(?=(?:do\s+not|don['’]t|never|not)\b)/giu);
  for (const [clauseStart, clauseEnd] of clauses) {
    const clause = masked.slice(clauseStart, clauseEnd);
    if (negativeTarget(clause)) continue;
    for (const [start, end] of splitTextRanges(clause, /(?<=[.!?;])\s+|(?:,\s*|\s+)(?:and|but)\s+(?=(?:(?:do\s+not|don['’]t|never|not)\s+)?(?:read(?!\s+(?:boundary|mapping|revision)\b)|view|inspect|show|list)\b)/giu)) {
      const sentence = clause.slice(start, end);
      const readMatch = [...sentence.matchAll(/\b(?:read|view|inspect|explore|analy[sz]e|understand|answer|report|show|list|summari[sz]e|explain)\b/giu)]
        .find(match => !isPreservedReadBoundaryMention(sentence, match.index)
          && !/\b(?:do\s+not|don['’]t|never)\s+$/iu.test(sentence.slice(0, match.index)));
      if (!readMatch) continue;
      const afterRead = sentence.slice(readMatch.index);
      const actionConnector = /\b(?:and|then)\s+(?:(?:let|allow)\s+(?:the\s+)?(?:agent|model|user|customer|them|it)\s+)?(?:propos(?:e|ing)|update|insert|delete|write|apply|approve|change)\b/iu.exec(afterRead);
      const offset = clauseStart + start + readMatch.index!;
      const length = actionConnector ? actionConnector.index : afterRead.length;
      fragments.push((retainQuotedText ? jobIntent : masked).slice(offset, offset + length));
    }
  }
  return fragments;
}

function splitTextRanges(text: string, separator: RegExp): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let start = 0;
  for (const match of text.matchAll(separator)) {
    ranges.push([start, match.index!]);
    start = match.index! + match[0].length;
  }
  ranges.push([start, text.length]);
  return ranges;
}

function unquotedRequest(text: string): string {
  const chars = [...text];
  let result = "";
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index]!;
    const apostrophe = /['’]/u.test(char) && /[\p{L}\p{N}]/u.test(chars[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(chars[index + 1] ?? "");
    if (apostrophe || !/["'“‘`]/u.test(char)) { result += char; continue; }
    const end = char === "“" ? "”" : char === "‘" ? "’" : char;
    const close = chars.indexOf(end, index + 1);
    const content = chars.slice(index + 1, close === -1 ? chars.length : close).join("");
    // Quoted literal identities in a current Read instruction retain identity;
    // historical quoted instructions remain opaque, not executable requests.
    result += " " + (close !== -1 && /^[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)+$/u.test(content.trim())
      ? content : " ".repeat(content.length)) + (close === -1 ? "" : " ");
    index = close === -1 ? chars.length : close;
  }
  return result;
}

function isPreservedReadBoundaryMention(sentence: string, index: number): boolean {
  if (!/^read\s+(?:boundary|mapping|revision)\b/iu.test(sentence.slice(index))) return false;
  // A Read-directed exception contradicts preservation. A generic "and add"
  // after a retained Read noun is not itself a new Read instruction; typed
  // Action routing owns that addition. Subsequent actual Read verbs are still
  // scanned independently. Retain the
  // ordinary missing-resource guard rather than assuming unchanged access.
  if (/\b(?:but|except)\s+(?:also\s+)?(?:add|include|expose|extend|expand)\b/iu.test(sentence.slice(index))
    || /\band\s+(?:also\s+)?(?:include|expose|extend|expand)\b/iu.test(sentence.slice(index))) return false;
  return /\b(?:keep|reuse|retain|preserve|leave)\s+(?:(?:the|our|this|same|existing|current|unchanged|saved|reviewed)\s+|saved\s+job\s+and\s+)*$/iu
    .test(sentence.slice(0, index));
}

function normalizedSemanticWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map(singularSemanticWord);
}

function singularSemanticWord(value: string): string {
  if (!/^[a-z]+$/u.test(value) || value.length < 4) return value;
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (/(?:ches|shes|sses|xes|zes)$/u.test(value)) return value.slice(0, -2);
  if (value.endsWith("s") && !/(?:ss|us|is)$/u.test(value)) return value.slice(0, -1);
  return value;
}

function containsWordSequence(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false;
  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((word, offset) => haystack[index + offset] === word)) return true;
  }
  return false;
}

const RESOURCE_MENTION_STOP_WORDS = new Set([
  "application",
  "current",
  "daily",
  "data",
  "detail",
  "entry",
  "event",
  "history",
  "information",
  "item",
  "main",
  "public",
  "recent",
  "record",
  "row",
  "system",
  "table",
]);

/** A native reviewed request is reusable only as the same complete Read clause;
 * do not infer synonyms, truncate a new constraint, or use a model summary. */
function exactRequestText(text: string): string {
  return text.trim().replace(/[.;]+$/u, "");
}
