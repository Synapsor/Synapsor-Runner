# Exact allowance map (source-only)

The independently inspected 101 legitimate annotations at `49798f15` have byte-identical owning source files at scanner/source pin `934ad542`. The supplied scan is sealed by SHA256 in the mapping record.

`ALLOWLIST.json` accepts **365 exact fingerprints across 100 annotation IDs**, not 365 semantic rules. Each fingerprint was matched to the actual printed AST expression, expression hash and full outer-owner hash, then checked against the original reviewed expression anchor and call-chain purpose. Duplicate regex/test and nested method-chain nodes explain the multiple entries. No predicate-consumer or lookup-vocabulary declaration is accepted wholesale.

`ALLOWLIST-MAPPING.json` accounts for all 101 IDs. I00404 is a historical declaration anchor (`const words = identifier`) with no language candidate of its own; its actual transformations are separately mapped by I00405–I00413. One indexed write `output[key]` under I02088 is deliberately not approved by this expression-only packet; it is ordinary projection syntax, not an independently reviewed vocabulary lookup. The other **39,859** scanner candidates remain unapproved. None of the 25 reclassified or 15 retired rows receives an allowance.

## Bounded detector improvements for Main to consider

- `typeof x === "string"` (or another exact JavaScript primitive tag) is formal type grammar, not an English decision. Recognize this AST shape, not arbitrary string comparison.
- A literal array used only as an output/prompt value is not automatically a word vocabulary. Trace whether it is actually used for membership, lookup, lexical matching or routing before seeding predicate-consumer closure; keep uncertain uses flagged.
- An indexed assignment such as `output[key] = value` is not itself a dictionary lookup decision. Separate write targets from reads. Retain unknown-key reads and vocabulary-to-outcome dispatch.
- Exact typed enum/code comparisons can be distinguished where runtime codec provenance exists. A TypeScript union, cast, property name or brand alone is insufficient to prove that a free-text input was validated.
- `Map.get`/`Set.has` on exact record IDs is mechanically different from word dictionaries, but any exemption needs the actual validated operand and consumer boundary. No per-method/file exemption.
- Consumer closure currently seeds from every literal comparison/array and therefore fans out into whole application owners. Narrow seed kinds by the above structural facts first; do not remove the consumer binding for actual or uncertain lexical predicates. An owner hash is useful only with reviewed consumers/operands.

These are recommendations, not approved scanner behavior or a mass classification of residual nodes. Existing tests must continue to catch moved predicates, aliases, dynamic regexes, dictionaries and new consumers.

The first mapper process was safely stopped before writing an artifact because it repeatedly printed large outer owners; caching printed nodes fixed that reviewer-tool performance issue. No product/provider/test operation ran. The completed map was inspected in full before this acceptance record.
