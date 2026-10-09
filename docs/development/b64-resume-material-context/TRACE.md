# WS2 host-only Resume material context — read-only proposal

Source: Main `38fc21d5`; I03537. No product changes or runtime claims.
Owner D4 allows host-only current identity context bound to root/job, from trusted configuration/session owners, never private-row queries or persisted values. Missing context and ambiguous collisions must not mean safe.

## Actual chain

- `boundary-authoring-resume.ts:1489–1532` scans all string leaves AND object keys. Credentials/URL/private-key checks precede English tenant/principal assignment detection and lexical exemptions. This is not an exact-known-value guard today.
- Builder `:306` validates previous state `:350`, then material `:464`; schema/integrity assertion `:708` invokes material `:854`. Builder is called by BC `:3976`, rescan revalidation `:680`, and program rebuild `:1645`.
- Native writer `:471` asserts before acquisition, then compares saved revision under Held access, checks append-only history/analysis, writes, and exact-reads ACK. Every private comparison/readback reaches the same assertion via `readResumeHeld:606`.
- Entry read `:591`, Held read `:599`, currentness `:526/:533`, early envelope `:582`, clear `:651`, revalidate `:672`, and version-review projection `:295` also reach it. None accepts trusted identity values/context.
- External current read calls: BC `3790,6352,6397,9153`; typed-parameter-source `72`; boundary-review-mutation `305`; post-activation-ask `317`; guided-start `467,572,1488`.
- External Held reads: saved-execution-requirements `25`; action-rule-intent-skeleton `66`; action-rule-withdrawal `56`; saved-action-job-review `100,188`; authoring-saved-review `60`; authoring-generation-context `54`; authoring-read-scope-activation `42`.
- External writer calls are BC `4021,4288,11523,11692,11727,11754`. Early-envelope entry is authoring-saved-setup-entry `8`.
- Separate LIVE retention route: `authoring-policy-source-ui.ts:19` screens a raw answer before Source CAS, called from its chat hook `:42` and BC `4179,4230,6856,8825`. Resume-only migration would miss this route.

## Existing trusted source and concrete limitation

`configured-trusted-context.ts:resolveConfiguredTrustedContextAuthority` checks actual project/runtime configuration against the selected source, but returns env/claim/binding NAMES, not private values. `packages/mcp-server/src/trusted-context.ts:resolveTrustedContext` owns actual environment/static-dev/verified HTTP/cloud-session resolution and organization/principal checks. It requires actual config/env, optional real capability, and a verified session for HTTP/cloud; do not synthesize a capability or session to make it succeed. Its optional local proposal actor fallback is not proof of a private principal for authoring.

BC currently has `process.env` and selected structural boundary; its interactive session is UI/model interaction, not a verified database identity session. None of the Resume callers universally supplies runtime config/capability/session. In particular early-envelope loading runs before selection/config hydration, and cold HTTP authoring has no authenticated runtime session. A list assembled solely from candidate env names, or a caught resolver error converted to `[]`, would be a privacy bypass. A session value observed earlier but absent now cannot be reconstructed from old Resume text/history.

## Recommended minimal seam (proposal, not implemented)

New pure owner `authoring-resume-material.ts` should separate credential/typed-forbidden-slot checks from exact known-value screening. Host resolver creates an opaque IN-MEMORY context; do not export a raw `{knownValues: string[]}` constructor to model/transport adapters. Proposed API shape:

```ts
type MaterialOwner = Readonly<{ projectRoot: string; jobCreatedAt: string }>;
type MaterialOrigins = /* finite typed origin projection from owning schemas */ unknown;
type IdentityScreeningContext = /* opaque host-created, nonserializable */ unknown;
function assertAuthoringMaterial(input: {
  value: unknown; owner: MaterialOwner; origins: MaterialOrigins;
  context: IdentityScreeningContext;
}): void;
```

The host resolver port should return a native host-issued union: `configured` (actual resolved known values retained privately), `unconfigured` (actual selected config has no runtime identity configuration, with its current host provenance), or `unavailable` (configured binding cannot currently resolve, including missing env/verified session). `unconfigured` is not a caller/model claim or a catch-all for an error, and cannot assert that arbitrary unknown literals are safe. Main/R2 must adjudicate which affected operations can proceed on this honest native absence. The host resolver port must distinguish usable native results from `unavailable` with a safe typed reason; absence is not a resolved empty list. Its concrete config/session adapter needs Main agreement before implementation. Root must be canonical host root and job identity the actual existing `created_at` (fresh job identity captured once); neither comes from model material. Context revalidation compares actual current configuration/session/environment resolution before retention/egress/save; identity values and their hashes are never serialized or logged. Project mutex alone does not freeze process environment or HTTP session lifecycle.

Main hooks: mandatory host context at native read/write/currentness and builder/early presentation boundaries, forwarded unchanged through compare/readback under actual Held access. Pure schema/digest parsing may be separate, but a schema-only decoded value is not `ready`, material-safe, or eligible for display/egress. Before hydration, early envelope can classify format only; missing required privacy context must stop affected retention/send with a typed correction route. The extra Source append caller requires the same context and typed raw-answer origin. No old-format upgrade, digest rewrite, normalization, or record migration.

Typed origin projection must come from field/record owners, not caller assertions or English. Exact byte values match case-sensitively in raw retained strings and matching scalar values; never normalize identity strings or infer from tenant/principal words. Short value overlap remains ambiguous unless an existing trusted typed owner establishes a distinct permitted business origin; otherwise block affected material safely. No quoted-text exemption. Structural IDs/hashes are not blanket exemptions for leaked identities; origin policy requires explicit review.

## Required failing-before / after controls

1. Current configured `acme-corp` / `person-123` is blocked without an English prefix in conversation, raw answer, B35/history, Source append, and native write/read; original exact words/counters preserved, no partial save.
2. Descriptive scope prose with no known private value does not invoke English interpretation; retain credential/private-key/endpoint negatives.
3. Short identity `2` overlapping a declared count is typed ambiguous and blocks affected retention; no quota-heading/quote exemption.
4. Missing config/session, wrong root/job, stale config/session/env and forged/model-supplied context refuse, never `[]` safe.
5. Genuine config/environment resolution and genuine verified session use exact values only; no row queries, broad environment scans, private values in failure projection or serialized context.
6. Entry/Held native load/save/readback all use the same current host context; Source append shares it; stale CAS/unknown saved outcome/history invariants unchanged.

Decision required before production replacement: which existing host session supplies verified HTTP/cloud identities on cold authoring, and the exact admissibility of host-proven `unconfigured` fresh setup versus required-but-unavailable identity context. Existing code does not supply a universal native seam. This is a bounded integration requirement, not grounds to keep or expand English exemptions.

## Implemented component, integration not claimed

`authoring-resume-material.ts` exports `resolveAuthoringMaterialContext({projectRoot,jobCreatedAt,env?,currentVerifiedSession?})` and async `assertAuthoringMaterial({value,owner,origin,context})`. The opaque context is authenticated by private WeakMap membership; serialization refuses. Configuration comes from actual project discovery and validated runtime config, including named contexts; existing trusted resolver owns values. Every screen re-resolves current config/session/environment and compares private transient material without hashing or persistence. Arguments/material are captured before awaits. Origins are `retained_material`, `business_value`, `forbidden_identity`; business collisions refuse as ambiguous, never exempt. Context errors are a separate native class; identity/credential refusals retain `AuthoringResumeMaterialError`.

Current real configuration semantics matter: local read-only config without its required provider is invalid/unavailable. The positive genuinely-unconfigured control is an actual valid cloud config with no root/named identity definition or session; it is not evidence that a missing local configuration is safe. HTTP tests cover the host callback contract only, not authentication. Native Resume/Source hooks, owning-schema origin classification, current real verified-session wiring and end-to-end retention/egress remain Main/R2 integration work. No existing English guard is removed by this isolated component.

Result: old guard 0P/2F (bare configured literal/key); final new component 34P/0F, scoped types 0; earlier successor 3P/21F and 23P/1F were preserved invalid fixture configurations (missing source/capabilities/provider prerequisites), corrected through actual config validator; no provider/DB/native Resume save was exercised. Evidence: `/var/tmp/synapsor-b64-real-readback-owned/evidence/material-{before,after,after2,after3,after4,final,final2}.json`, `material-fixture-diagnosis.log`, `material-types-final2.log`.

Serialization successor: R2 class-toJSON bypass and missing immutable result reproduced on c264 (0P/2F); original descriptor/prototype/accessor/proxy validation now precedes snapshot construction, and `assertAuthoringMaterial` returns `Promise<string>` containing ONLY the exact screened JSON. Main must retain/send that immutable returned JSON, never reserialize the original object. Private detached JSON containers have null prototypes and are frozen; custom/sparse/non-JSON shapes refuse, no getters/toJSON invoked. Existing safety expectations preserved; positive tests now assert exact returned JSON rather than void. Final39P/0F, scoped types0; evidence `material-serialization-{before,after}.json` / `material-serialization-types.log`. Native integration still open.
