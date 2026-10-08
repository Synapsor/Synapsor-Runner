# Authoring language decision guard

Run `corepack pnpm check:authoring-language`. CI, the main test command and the
release gate invoke the strict check. The Node controls execute independently
of a built Runner or provider; no Source connection is used.

The scanner deliberately does **not** decide English meaning. It inventories
regexes, text normalization/search, literal vocabularies/comparisons and their
controlling code across Runner and shared packages. These are review candidates,
not a count of English decisions. The canonical B64 inventory remains the
250 typed + 66 deletion tasks, plus explicit reclassifications from the
independent audit of 141 historical legitimate groups.

An allowance names one exact source fingerprint, canonical annotation, category,
reason, independent reviewer and evidence. The fingerprint includes the path,
printed outer declaration, expression and occurrence. Moving a predicate,
changing its receiver or changing the operation it controls invalidates review.
A TypeScript symbol-consumer closure also binds callers, aliases and local module imports; changing display into authority use requires another review. Ordinary numeric branches alone are not language candidates. Formatting/comments alone do not. There are no file globs, accepted English
baselines, count ceilings or automatic allowlist regeneration. Removing an
expression leaves a stale allowance that must be removed explicitly.

Permitted categories: redaction/secret detection, exact identifiers/codes,
formal grammar, explicit commands and display formatting. A title or claimed
category alone is not proof; independent review traces the effect and consumers.
Review metadata is checked for completeness, not authenticated by this local
script. Code review remains necessary for changes to the scanner and allowlist.
Static syntax analysis cannot prove the absence of arbitrary obfuscated or
external language interpretation.

The first allowlist is intentionally empty pending the independent audit and exact-allowance review.
Therefore the repository check currently fails closed. This is **not** a green
B64 gate or a claim that every syntactic candidate is English logic. The audit
must produce exact legitimate entries; retirement lanes must close all real
decisions. No known English decision may be whitelisted to make CI pass.
Use `node scripts/check-authoring-language.mjs --report /owned/path/report.json`
for a diagnostic report; this retains the same failing exit status.
