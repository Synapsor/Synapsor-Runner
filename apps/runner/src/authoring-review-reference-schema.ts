// A finite declaration only; canonical pointer and whole-review validation
// remain authoritative. Small reference enums retain their existing encoding.
const ENUM_BYTES = 65_536;
const MAX_COMPACTION_INPUT_BYTES = 1_048_576;
type Prefix = {terminal: boolean; children: Map<string, Prefix>};
type ReferenceInventory = readonly string[] | {
  encoding: 'pointer_prefix_groups_v1';
  groups: {prefix: string; suffixes: string[]}[];
};

/** Lossless presentation of the finite pointer inventory, not a new pointer
 * grammar. Concatenate a group's prefix with each of its own suffixes. Keep
 * ordered contiguous groups so even overlapping prefixes preserve the exact
 * original list; never combine prefixes and suffixes across groups. Pointer
 * tokens (including ~0/~1) and Unicode are copied without normalization.
 */
export function finiteReviewReferenceInventory(values: readonly string[]): ReferenceInventory {
  const bytes = Buffer.byteLength(JSON.stringify(values));
  if (bytes <= ENUM_BYTES || bytes > MAX_COMPACTION_INPUT_BYTES) return values;
  const groups: {prefix: string; suffixes: string[]}[] = [];
  for (const value of values) {
    const parts = value.split('/');
    const prefix = parts.slice(0, Math.min(4, parts.length - 1)).join('/');
    let group = groups.at(-1);
    if (!group || group.prefix !== prefix) {
      group = {prefix, suffixes: []};
      groups.push(group);
    }
    group.suffixes.push(value.slice(prefix.length));
  }
  const compact = {encoding: 'pointer_prefix_groups_v1' as const, groups};
  return Buffer.byteLength(JSON.stringify(compact)) < bytes ? compact : values;
}

function literal(character: string): string {
  return character.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    .replace(/\n/gu, '\\n').replace(/\r/gu, '\\r').replace(/\t/gu, '\\t')
    .replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029').replace(/\0/gu, '\\u0000');
}

function expression(prefix: Prefix): string {
  const alternatives = [...prefix.children].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([character, child]) => literal(character) + expression(child));
  if (!alternatives.length) return '';
  const branches = alternatives.length === 1 ? alternatives[0]! : `(?:${alternatives.join('|')})`;
  return prefix.terminal ? `(?:${branches})?` : branches;
}

/** Prefix factoring preserves the exact finite string language, rather than
 * opening arbitrary pointers or translating exclusive/inclusive schema unions.
 * Absolute end uses negative lookahead: JS `$` alone also accepts a final LF.
 * The complete ordinary reference inventory remains in the review question.
 */
export function finiteReviewReferenceSchema(values: readonly string[]): Record<string, unknown> {
  if (!values.length) throw new Error('A finite review reference declaration requires a nonempty set.');
  const enumeration = {type: 'string', enum: [...values]};
  const bytes = Buffer.byteLength(JSON.stringify(enumeration));
  // Do not build an unbounded prefix tree for an already oversized input. The
  // ordinary final schema/request guards still refuse; neither bound is raised.
  if (bytes <= ENUM_BYTES || bytes > MAX_COMPACTION_INPUT_BYTES) return enumeration;
  const root: Prefix = {terminal: false, children: new Map()};
  for (const value of values) {
    let current = root;
    for (const character of value) {
      let next = current.children.get(character);
      if (!next) { next = {terminal: false, children: new Map()}; current.children.set(character, next); }
      current = next;
    }
    current.terminal = true;
  }
  return {type: 'string', maxLength: values.reduce((max, value) => Math.max(max, [...value].length), 0),
    pattern: `^(?:${expression(root)})(?![\\s\\S])`};
}
