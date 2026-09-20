# M6 receipt-default input contract

Current checkpoint: implementation, focused verification and full stable suite complete; all ten offline checks passed; final installation and public verification next. Final installed checks and independent acceptance are not yet established. This report will be finalized after the single candidate is exercised.

The repair carries a text default through the existing prompt interfaces and accepts it only on a submitted empty line. Escape, EOF and Ctrl-C remain cancellation. Receipt-selection review and execution authorization are separate operations, each retaining its existing confirmation.

## Baseline and cause

Canonical baseline `feecc2b7f9aa10c65f28ace812583a63c3b0239d` follows product/tests `4b4f362aa06cfb0e42005a1f853bc2cc6e408e09` and frozen source `b563c88efa34c52e98b3aec74a6e078cfe7d608b`. The unchanged prior installed tree is `7b99cc6fdc37db2ee6d357932d1f04fe714be323893a21c4fe768df6e3f96244`.

The receipt orchestrator supplied the intended default only in English context. `boundarySessionForActionPrompter` forwarded no structured default. The real Action prompter then evaluated `value || options.defaultValue`: a submitted empty string and cancellation both became `undefined`. Receipt setup correctly treated `undefined` as cancellation. A mock returning an empty string had missed this adapter behavior.

The historical public failure independently tested the writer field only. This assignment reproduced blank Enter separately at writer, schema and table on the old installation, with explicit preceding values solely to reach the latter prompts. All three returned without renewal; all 42 table snapshots, configuration and 504 business rows stayed unchanged. Three corresponding native-adapter receipt-orchestration tests failed before the repair and passed after it. These schema/table failures are new observations, not historical claims.

## Input and state contract

| Event | Result |
|---|---|
| Blank or whitespace-only submitted Enter, displayed valid default | Exactly the supplied default, then ordinary validation and exact review |
| Nonempty submitted text | Trimmed input, unchanged grammar/length checks; invalid input does not fall back |
| Escape, EOF, Ctrl-C, input failure | Cancellation; no default substitution |
| Blank without a default | Empty submission for ordinary required/optional validation |
| Final receipt selection declined or cancelled | No renewed selection |
| Enter at execution confirmation | Existing default No |

The Action adapter, direct Boundary adapter and operator conversation adapter carry the same optional string default. Model-authored questions and boolean confirmations do not acquire text defaults. Before exact selection review, the original Action digest, binding digest, epoch and prior revision must still agree with the current preview. The existing locked confirmation/CAS check remains at save. No receipt engine, authority, privacy, accounting, guarded-effect, worker or policy semantics changed.

## Focused evidence

- Product/tests: `8ce338988da92ea37eb6711153965a7ce873440a`.
- Native three-field before run: exit 1, three expected failing assertions; after run: exit 0, three passing assertions.
- Combined focused run: exit 0, 274 passed / 1 opt-in PostgreSQL skipped. Actual terminal events cover defaults, explicit input, invalid nonempty input, Escape at each stage, EOF, Ctrl-C, no-default input, exact-review decline, changed context and competing save. Conservative confirmation controls remain covered.
- Types: exit 0.
- All ten offline checks: exit 0 (trusted core, licenses, human commands, DSL sources, Cursor plugin, MCP configs, local package, bundle freshness, public commands, packed offline with local Spec).
- One stable full suite: exit 0, **6,618 passed / 465 skipped**,319 files passed /21 skipped,1252.05s. Four workers maximum, one minimum,20-second outer test/hook deadlines; product deadlines and assertions unchanged. The prior 6,602/465 run remains historical.
- Explicit real PostgreSQL CONTROL store: receipt-selection persistence 1 passed / 28 filtered skips; review/persistence 6 passed / 416 filtered skips; both exit 0. These selected tests are separate from the installed PostgreSQL business source with SQLite control store.

Each stable source check recorded the same product-source digest before and after: `e27c4807325855fd0619f35a51d13e3d1452e545d387fd015aefc2b1173e6801`. Exact commands and actual exits live beside this report and in the raw root. No provider credentials or calls were used. Only the explicit database gates received the owned test database URL.

## Preservation and scope

New starts derive from the whole genuine published intermediate, archive SHA256 `246f0e50305ca67e593a228f1ce6e53d831bdf4e7f10a4352d329828b5544390`, restored through the existing logical-path isolation and effective-store preflight. Matching prepared and unprovisioned PostgreSQL dumps retain the original 116 candidates, 116 slots and 272 private checks: 504 business rows. Fresh fixture-local passwords are private and never committed.

A preparation attempt encountered the bootstrap PostgreSQL socket before the final server restart. It restored no roles or rows; the corrected TCP readiness check reused the same owned container. Its failed attempt is retained. No product timing changed.

Independent acceptance is **PENDING**. All results here are implementer evidence. Prior J1-DATA, M1/X4 and O1 reported passes retain their scope pending separate independent review. M4 E2/E3 independent gaps remain NOT ESTABLISHED. Original Stage B remains ATTEMPTED / NOT PASSED.

Raw root: `/home/sandesh-tiwari/Desktop/C++/Progress docs tracking/r13-e07-20260911/receipt-default-feecc2b-20260919`.
