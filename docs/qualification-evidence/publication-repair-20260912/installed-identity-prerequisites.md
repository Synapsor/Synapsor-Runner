# Local identity preparation boundary

The prior alternate-principal launch failed before its application schedule:
LOCAL_TEST_RUNTIME_ENV_CONFLICT. It combined environment values for another
principal with the original project's reviewed local-test-runtime.json. That
is a setup mismatch, not a demonstrated foreign-reference or row-scope failure.

Current supported local setup binds a single identity file at exactly
.synapsor/local-test-runtime.json to the canonical project and reviewed identity
contract. loadLocalTestRuntimeIdentity verifies ownership, permissions, exact
bindings and project/authority agreement. withLocalTestRuntimeIdentity requires
inherited values to agree. The managed-client setup in post-activation-ask.ts
reuses an already valid identity without collecting replacement values; the
collector/save operation runs only when no reusable identity exists. There is no
per-client identity path or valid-identity replacement gesture in this prepared
flow. saveLocalTestRuntimeIdentity is an internal fixture/setup API, not a public
operator command to change an existing valid setup.

The new installed fixture will preserve the valid reviewed original identity,
provide its matching values, run doctor, start the real MCP client and perform
an own-scope positive read before application schedules. No identity file is
removed or hand-edited. The harness now supplies private creation permissions,
private /var/tmp and NO_COLOR=1; identity enforcement itself is unchanged.

Alternate principals/insurers sharing one durable allowance remain an unsupported
prerequisite of this prepared installed setup. A copied ledger per context would
prove separate allowances and is not used. Omitting/overwriting the reviewed file,
creating a new identity mode, or using integration-only identity APIs would not
be an installed public-path pass. The existing API-level scoped-context and
connected-worker controls supply separately labeled implementation evidence.
A4 foreign-reference schedules and the installed overall/shared-principal A2
schedule must remain BLOCKED unless a supported reviewed setup is actually
established. A startup conflict alone proves neither issuer rejection nor every
deeper row-scope check. This is a bounded local-fixture limitation, not a claim
that supported production/session integrations cannot represent these contexts.
