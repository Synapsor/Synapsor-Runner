# Governed Read recognition in Ask

Base d9f86355. This is the necessary candidate4 Ask/studio dependency, separate
from B59 scope semantics and B57's broader assessment. No new command, format,
permission or activation route is introduced.

`optionalActiveBoundaries` in ask-authority.ts is shared by deployment-profile,
current Ask consent/authority, and active/pending Read summaries. It previously
read only legacy JSON exports. The native governed fixture confirms Read through
the public local activation host; without legacy files, Ask nevertheless reports
unknown profile and refuses before provider egress. A stale legacy export can also
survive native governed revocation and incorrectly identify the old Ask authority.

The fix uses existing `openBoundProjectControlPolicies` and
`loadActivatedExplorationBoundaries(projectRoot, binding)` before the legacy path.
These validate the actual repository binding and native active Read records.
A bound but empty governed Read set stays empty; an unavailable/invalid repository
fails closed. There is no file fallback in either situation. Repository handles
close in finally. Projects with no governed binding retain the existing legacy
parser; existing consent digest fields and revalidation are unchanged.

Tests use a declared synthetic metadata inspection and the normal governed
bootstrap/review/activation paths, with explicit default-No local operator consent.
There is no external source DB or provider. The four-tool gateway is a controlled
existing dependency port, never a fabricated authority record; the positive
no-query provider is one prepared in-process response. No test claims a source
effect, complete MCP transport, paid behavior, or installed application acceptance.

Failing-before captures establish unknown profile, pre-egress Try Ask refusal and
stale-export revocation behavior. Focused controls cover active summary/digest,
disabled draft refusal, revoked authority, missing repository, consent-time
revocation, ordinary egress decline and no-query Ask. The first positive fixture
omitted gateway.mode, correctly triggering native currentness refusal; that raw
failure remains preserved. Original API, tool allowlist, profile restrictions,
egress consent, currentness and all authority owners remain native.
