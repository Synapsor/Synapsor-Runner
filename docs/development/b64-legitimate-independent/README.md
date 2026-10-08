# Independent legitimate-site audit

Source: Main `49798f15c44f5492f81e09f1629680fdc56833ff`; historical inventory: `2857e2e4c0ffab23591e96f76887d523038c5031`.

All **141** unique legitimate annotation IDs were read against current source and actual consumers: **101 legitimate, 25 reclassify typed, 15 retired**. These are source classifications, not runtime defect/test verdicts. The historical inventory remains untouched. A mixed historical span whose English branch disappeared is explicitly retired; retained mechanical branches do not inherit a blanket exception.

- [VERDICT.json](VERDICT.json): every ID, current exact matching expressions/file hash, owner, call chain, reason and outcome.
- [RECLASSIFICATIONS.json](RECLASSIFICATIONS.json): append-only change manifest, including I00371 implemented on Privacy `829649ec` but absent from audited Main.
- [audit-input.json](audit-input.json): original expressions and all current exact line matches; duplicate/common matches are not proof of custody.
- [build-audit.py](build-audit.py): reproduces the authored adjudication records on the pinned checkout.

The 101 legitimate rows fit only redaction/secret detection, exact identifier/code handling, formal grammar, explicit commands, or actual display formatting. Literal metadata search is formal literal retrieval over already authorized records, not words-to-plan inference. In contrast, singular/plural object aliases, inferred approval provenance, English error-cause/retry classification, tool-name safety claims and provider capability guesses move to typed ownership.

## CI boundary

Allow only an independently reviewed **exact AST expression + full containing owner fingerprint**, with this ID/reason/category. Never use a file/range or a source-baseline blanket. Mixed owners need expression-specific entries. Deletions receive no stale allowances. A containing-owner edit invalidates the allowance; changed callers or operand provenance also require re-review (owner hashing alone does not prove call-chain semantics). Mechanical syntax outside these exact reviewed expressions remains unreviewed; this record does not auto-approve all AST candidates in 101 files/ranges.

No product edits, tests, provider requests or database operations were performed for this audit. Paid remains closed. All historical failures and previous independently scoped verdicts remain separate.
