# Authoring language decision guard

Run `corepack pnpm check:authoring-language`. CI, the main test command and the
release gate invoke the strict check. The Node controls execute independently
of a built Runner or provider; no Source connection is used.

The scanner deliberately does **not** decide English meaning. It inventories
regexes, text normalization/search, literal vocabularies/comparisons, nonnumeric dictionary lookups and their
controlling code across Runner and shared packages. These are review candidates,
not a count of English decisions. The canonical B64 inventory remains the
250 typed + 66 deletion tasks, plus explicit reclassifications from the
independent audit of 141 historical legitimate groups.

An allowance names one exact source fingerprint, canonical annotation, category,
reason, independent reviewer and evidence. The fingerprint includes the path,
printed outer declaration, expression and occurrence. Moving a predicate,
changing its receiver or changing the operation it controls invalidates review.
A TypeScript symbol-consumer closure also binds callers, aliases and local module imports; changing display into authority use requires another review. Ordinary numeric branches and plain data objects alone are not language candidates; a nonnumeric lookup binds the actual dictionary declaration as well as its consumer. Formatting/comments alone do not. There are no file globs, accepted English
baselines, count ceilings or automatic allowlist regeneration. Removing an
expression leaves a stale allowance that must be removed explicitly.

Permitted categories: redaction/secret detection, exact identifiers/codes,
formal grammar, explicit commands and display formatting. A title or claimed
category alone is not proof; independent review traces the effect and consumers.
Review metadata is checked for completeness, not authenticated by this local
script. Code review remains necessary for changes to the scanner and allowlist.
Static syntax analysis cannot prove the absence of arbitrary obfuscated or
external language interpretation.

The first allowlist contains 365 independently reviewed exact fingerprints
mapped from 100 of the 101 legitimate audit IDs (one ID is only a declaration
anchor). See the independent mapping record under
`docs/development/b64-legitimate-independent`. None of the 25 reclassified or
15 retired IDs receives an allowance. Consumer/declaration ranges are not
blanket-approved. The guard core passed all 21 controls under independent review
at d169d640; practical allowance coverage remains a separate open task.

The repository check still fails closed on unmatched candidates. This is not a
green B64 gate or a claim that every unmatched syntactic candidate is English
logic. Bounded detector refinements and exact legitimate review must distinguish
formal code from the remaining language decisions. No decision may be permitted
merely to make CI pass. Use
`node scripts/check-authoring-language.mjs --report /owned/path/report.json`
for diagnostics; the report option retains the same failing exit status.
