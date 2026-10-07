/** Transient lower-bound coverage derived from original operator wording and
 * actual inspected identities. This is not permission, complete English
 * interpretation, or a replacement for native meaning/Source review. Never
 * derive it from a model routing summary. Recompute against current metadata.
 */
export function requestedReadResourceIds(jobIntent: string, availableResourceIds: string[]): string[] {
  return requestedReadResourceAssociations(jobIntent, availableResourceIds).required;
}

export function requestedReadResourceAssociations(jobIntent: string, availableResourceIds: string[]): {
  required: string[]; ambiguous: string[][];
} {
  const readText = readOrientedJobText(jobIntent);
  if (!availableResourceIds.length || !readText) return { required: [], ambiguous: [] };
  const qualified = [...readText.matchAll(/[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)+/gu)].map(match => match[0]);
  const explicit = new Set(availableResourceIds.filter(id => qualified.some(token => token === id || token.startsWith(`${id}.`))));
  // A qualified reference cannot fall back to the same table in another schema.
  const words = normalizedSemanticWords(readText.replace(/[\p{L}\p{N}_]+(?:\.[\p{L}\p{N}_]+)+/gu, " "));
  const candidates = availableResourceIds.map(id => ({ id, words: normalizedSemanticWords(id.split(".").at(-1) ?? id) }))
    .filter(candidate => candidate.words.length && (containsWordSequence(words, candidate.words)
      || candidate.words.filter(token => !RESOURCE_MENTION_STOP_WORDS.has(token)).length > 0
        && containsWordSequence(words, candidate.words.filter(token => !RESOURCE_MENTION_STOP_WORDS.has(token)))));
  const grouped = new Map<string, string[]>();
  for (const candidate of candidates) grouped.set(candidate.words.join(" "), [...(grouped.get(candidate.words.join(" ")) ?? []), candidate.id]);
  const ambiguous = [...grouped.values()].filter(ids => ids.length > 1 && !ids.some(id => explicit.has(id)));
  return { required: availableResourceIds.filter(id => explicit.has(id) || candidates.some(candidate => candidate.id === id
    && grouped.get(candidate.words.join(" "))!.length === 1)), ambiguous };
}

/** A literal, complete identity list is the one upper bound this helper can
 * establish without interpreting business prose. Unrecognized clauses remain
 * unresolved; never turn a partial keyword match into a complete allowlist. */
export function exactOnlyReadResourceIds(text: string, availableResourceIds: readonly string[]): string[] | undefined {
  const match = /^\s*(?:read|show|list)\s+only\s+(.+?)\.?\s*$/iu.exec(text);
  if (!match) return undefined;
  const terms = match[1]!.split(/\s*,\s*|\s+and\s+/iu).filter(Boolean);
  if (!terms.length || terms.some(term => !availableResourceIds.includes(term))) return undefined;
  return [...new Set(terms)];
}

function readOrientedJobText(jobIntent: string): string {
  const fragments = unquotedRequest(jobIntent)
    .split(/(?<=[.!?;])\s+|(?:,\s*|\s+)(?:and|but)\s+(?=(?:(?:do\s+not|don't|never|not)\s+)?(?:read|view|inspect|show|list|include)\b)/iu)
    .flatMap((sentence) => {
      // "Keep the same Read Boundary" names preserved authority, not a
      // request to expose the private verification facts later in the clause.
      // Continue scanning: a subsequent "and show ..." is still a read request.
      const readMatch = [...sentence.matchAll(/\b(?:read|view|inspect|explore|analy[sz]e|understand|answer|report|show|list|summari[sz]e|explain)\b/giu)]
        .find(match => !isPreservedReadBoundaryMention(sentence, match.index)
          && !/\b(?:do\s+not|don't|never)\s+$/iu.test(sentence.slice(0, match.index)));
      if (!readMatch) return [];
      const afterRead = sentence.slice(readMatch.index);
      const actionConnector = /\b(?:and|then)\s+(?:(?:let|allow)\s+(?:the\s+)?(?:agent|model|user|customer|them|it)\s+)?(?:propos(?:e|ing)|update|insert|delete|write|apply|approve|change)\b/iu.exec(afterRead);
      return [actionConnector ? afterRead.slice(0, actionConnector.index) : afterRead];
    });
  return fragments.join(" ");
}

function unquotedRequest(text: string): string {
  const chars = [...text];
  let end: string | undefined;
  return chars.map((char, index) => {
    if (end) { if (char === end) end = undefined; return char === "\n" ? "\n" : " "; }
    const apostrophe = /['’]/u.test(char) && /[\p{L}\p{N}]/u.test(chars[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(chars[index + 1] ?? "");
    if (!apostrophe && /["'“‘`]/u.test(char)) { end = char === "“" ? "”" : char === "‘" ? "’" : char; return " "; }
    return char;
  }).join("");
}

function isPreservedReadBoundaryMention(sentence: string, index: number): boolean {
  if (!/^read\s+(?:boundary|mapping|revision)\b/iu.test(sentence.slice(index))) return false;
  // An explicit exception/addition contradicts preservation; retain the
  // ordinary missing-resource guard rather than assuming unchanged access.
  if (/\b(?:but|except|and)\s+(?:also\s+)?(?:add|include|expose|extend|expand)\b/iu.test(sentence.slice(index))) return false;
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
