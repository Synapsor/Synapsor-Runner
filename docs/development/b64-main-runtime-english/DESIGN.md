# Four bounded Main retirement sites

Base d6f0fb8b. Scope I03547/I03548 (mcp-runtime), I03552 (worker-runtime), I03568 (contract-testing). Historical inventory labels remain intact; R1's legitimate-site successor reclassified these four. Main35 remains pending independent acceptance; the separate Privacy lane remains15 typed/0 delete.

Samples are synthetic schema examples only: exact enum first, scalar type/bounds, neutral string placeholder; names/comments never select business values, IDs, reasons or approval claims. Actual operator JSON/input remains authoritative input. No guarantee a placeholder identifies a source row; callers needing a real row must supply exact input.

Doctor authority checks use the actual runtime's resolved capability kinds and exact identifiers, or fixed typed Action interface identifiers. Unknown/mismatched metadata fails. Tool descriptions/names cannot imply approval/SQL/commit authority. Existing credential redaction scans remain separate and unchanged.

Workers preserve structured safe error codes and existing typed retry distinctions. Missing code yields generic failure; diagnostic prose cannot manufacture timeout state. Handler execution already records HANDLER_TIMEOUT from actual transport/process timeout observations.

Live contract tests require an operator declaration for every exact configured Source through repeatable --disposable-source. This declaration is separate from --allow-remote, required additionally for remote hosts. No database name implies permission; no model/test-manifest declaration or stored authority is added. Static behavior is unchanged. Offline controls use static assertions even in live guard mode: no source connection or effect.

All tests use isolated HOME/TMP and bwrap network isolation with one worker. Ordinary unit-fixture cleanup does not delete retained evidence. Actual before/after outcomes will be recorded separately; no self-acceptance.
