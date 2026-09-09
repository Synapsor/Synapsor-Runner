# Legacy Onboarding Inventory

New projects use the reviewed Read/Action workflow through `start` or
`onboard db`. Interactive and structured drafting share the same authority
system. Adding a business outcome changes the reviewed catalog, not the MCP
tool list. No draft or `--yes` flag grants Read, Action or execution authority.

The older engine is retained for explicit compatibility, recovery and internal
fixtures. It is not a second default. Existing projects, ledgers, receipts and
active authority are not automatically migrated or deleted.

## Feature Disposition

| Older feature | Current four-tool route / disposition |
| --- | --- |
| Named per-table inspect/propose tools | Replaced for new projects by reviewed Read plans and the semantic Action catalog. No per-outcome MCP registration. |
| One-row INSERT/UPDATE, fixed or bounded input values | Supported through typed Action verification, derived effects and exact approval policy. Revalidate scope, conflict, deduplication and private-fact dependencies; a legacy patch alone does not establish these semantics. |
| Predicate-based eligibility and derived multi-field changes | Use current Action Rules with reviewed source facts and relationships. A single outcome may change several allowed fields on one exact row. |
| DELETE | Not currently an effect in the semantic Action Rule envelope. Explicitly deferred; do not disguise deletion as an UPDATE or silently switch to legacy. |
| HTTP/command application-owned handlers and generated handler templates | Retained in the legacy engine; not exposed as semantic Action effects. Porting an application transaction requires an explicit reviewed executor contract and is deferred here. |
| Multi-row or multi-table transactions | Not implied by fixed tools or one outcome. The current semantic effect is bounded to one INSERT or UPDATE row. Broader legacy/code-first features are not silently ported. |
| TypeScript `action validate` / `action watch` | Retained code-first compatibility/development surface. Not the structured semantic draft input or semantic activation path. |
| `init --spec`, old `--answers`, table/patch selectors | Retained only through explicit legacy setup. Their schema is not the new structured business draft schema. |
| Explicit per-capability client installation | Existing-integration compatibility only. Fresh managed authoring installations use one four-tool entry. |
| Existing stores, active artifacts and migration tests | Preserve them. Recovery must not replace an active authority with a regenerated draft or reset accounting/history. |

## Explicit Selection

Use `onboard db --legacy-capabilities` only when intentionally exercising the
older table/patch workflow. Its help and result describe that differing model.
Do not use a successful legacy receipt as proof that an unrelated university,
warehouse or customer-service business rule was enforced.

For current scriptable setup, follow [Guided Onboarding](guided-onboarding.md).
Submission validates a disabled revision; the operator still reviews exact
Read scope and Action effects. Automatic approval is not execution. Writer
verification, separate execution authorization, a running worker and a durable
receipt remain necessary for an actual completed change.
