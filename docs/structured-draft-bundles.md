# Complete local structured draft exchange

`start --export-draft FILE` and `onboard db --export-draft FILE` capture current
disabled Read/Action declarations and unfinished intent context under the
project's existing writer coordinator. Source snapshots contain only exact
name, text, digest and version. Source consent, interpretation, acceptance,
coverage, old session identity and transport state are not imported.

Ordinary JSON exports retain the 512 KiB limit. Larger exports use
`synapsor.boundary-draft-bundle.v1` at `FILE` and a private sibling directory
`FILE.parts`. Export refuses an existing file or parts directory. It writes and
syncs complete private parts first and publishes the complete manifest last.
An interrupted parts directory is inert. Preserve it for inspection after a
process failure; it cannot become a valid draft without its complete manifest.
Directory syncing depends on platform support. The local filesystem and its
cooperative locking must be trustworthy; this is not a cross-host filesystem
or hostile concurrent pathname replacement protocol.

The manifest contains `bundle_id`, canonical `payload_digest`, fixed
`parts_directory`, ordered `parts`, `records`, `part_bytes`, and canonical
`manifest_digest`. Each member declares its exact `file`, zero-based `index`,
raw UTF-8 `bytes`, raw SHA-256 `digest`, and `records` count. Names are exactly
`part-0001.json`, `part-0002.json`, and so on. Each part uses
`synapsor.boundary-draft-part.v1`, the same `bundle_id`, its zero-based `index`,
and ordered typed `records`.

A record is `{kind,index,value}`; property records also have `key`. Kinds are
`property`, `read_resource`, `action`, `skeleton`, and `source`. Properties use
the fixed order `schema_version`, `review_bundle_digest`, `bindings`,
`action_skeleton_candidates`, `read_request_json_schema`,
`action_rule_draft_json_schema`, `action_authoring_catalog`,
`read_authoring_catalog`, `notes`. Then come Read resources, Actions, skeletons,
and Source texts in their original array order. Optional empty skeleton/Source
arrays retain explicit empty property records. Missing, extra, duplicate,
foreign, reordered or mixed-version members stop before compilation. Digests
protect exact serialization integrity; they do not confer policy authority.

Raw member hashes include all bytes, including whitespace. Canonical hashes
use Runner's recursive object-key ordering while preserving array order and
JSON values. `manifest_digest` hashes the manifest without that digest field;
`payload_digest` hashes the complete reassembled typed input. Intentional bundle
editing requires consistent member bytes, hashes, counts and both canonical
digests. Preserve exact current bindings and navigation references for ordinary
same-project submission. A simpler bounded edit may use a new ordinary typed
input with current `schema_version`, `review_bundle_digest`, `bindings`,
`read.resources`, and at most 12 changed `actions`; normal submission retains
other current saved Actions. Never treat an edited reference as current proof.

| Resource | Limit |
| --- | ---: |
| Legacy JSON or each part | 512 KiB |
| Compact indivisible typed record | 256 KiB |
| Manifest | 64 KiB |
| Parts | 16 |
| Typed records | 192 |
| All parts plus manifest | 4 MiB |
| Complete exported Actions/intents | 64 each |
| Added or changed Actions per save | 12 |

The bounds are independent ceilings, not a promise that every combination fits.
Runner refuses an oversized record or complete inventory without narrowing it.
Imports require real project-local parent directories and single-link regular
UTF-8 files; symbolic links, hard links and escaping paths are refused. Export
cannot write inside Runner authority or generated-artifact directories.
Recognizable credentials and private keys are refused; the exchange never reads
database rows, queues or an external response capture as authoring proof.

# Explicit independent disabled successor

After independently initializing a disabled destination with matching current
schema and role posture, copy `FILE` and its optional `FILE.parts` inside it.
Use `--draft FILE --successor --action-page N --dry-run` for validation and add
`--yes` to persist. Pages are one-based, immutable ordered groups of up to 12
Actions. The first destination must have no unresolved saved job, existing
Action bundle, active Read/Action publication, or execution. The old control
store cannot be the destination. This route never increases the change limit.

Before the first disabled page commit, Runner durably preserves the complete
sanitized declarative inventory at
`.synapsor/boundary-authoring/structured-successor/inventory.json`. It retains
every proposal, original Read request, exact intent string and inert Source
snapshot. Fixed `page-001.json` files record selected page declaration
expectations derived from the normal compiler. They are descriptive, untrusted
operator records. The inventory contains no provider/model resume, old operation
identity, acceptance, active grant, approval decision or ready flag.

Inspection compares those expectations with actual current disabled
declarations and reports matching/pending outcomes and intent indexes. Exact
matching is not a commit acknowledgement, Source fidelity or English intent
proof. Unprepared intents remain explicit; Runner never invents outcome links.
Normal current authoring and Source/private review must resolve them. Fresh
attachment applicability compares exact Source name/text/digest against normal
current Source records; only the normal review APIs can assess coverage and
readiness. The imported material's origin remains untrusted.

Repeated pages with exactly matching current declarations leave the repository
epoch unchanged. Changed inventory membership, destination bindings, Read
candidate or compiled page expectations stop without replacing prior work.
Each page rechecks current schema/role and ordinary repository CAS. A definite
revision conflict rolls back only files newly staged by that invocation and
preserves earlier pages and the complete agenda. A crash before the disabled
commit leaves an inspectable pending agenda. A lost commit acknowledgement
retains it and reports disabled publication as unknown; current matching alone
does not prove which operation committed. All authorities remain disabled until
their separate normal human review/publication flows succeed.
