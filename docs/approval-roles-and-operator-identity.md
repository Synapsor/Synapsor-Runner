# Approval Roles And Verified Operator Identity

This guide explains how a role written in a Synapsor capability becomes a
verified human approval. The short version is:

```text
Contract says who may approve
  -> identity provider says who the operator is and which groups they hold
  -> Runner verifies a fresh token and exact role
  -> ledger records the exact decision without storing the bearer token
  -> a separate verified operator authorizes apply
```

Approval and apply are outside the model-facing MCP tool surface. An agent
cannot supply an operator token, select its own role, approve a proposal, or
commit a write.

## What `APPROVAL ROLE` Means

This public DSL:

```sql
CREATE CAPABILITY membership.freeze_membership
  ...
  APPROVAL ROLE membership_reviewer
  ...
;
```

means that an operator approving this capability's proposal must have the exact
role string `membership_reviewer` in a verified identity.

`membership_reviewer` is an author-chosen Synapsor contract role. It is not:

- a PostgreSQL role;
- an operating-system user or group;
- an MCP or model role;
- an API key or secret;
- permission to apply the write.

The contract fixes the required role. The model cannot put a different role in
a tool argument.

## The Complete Identity Chain

1. A contract author writes `APPROVAL ROLE membership_reviewer`.
2. An identity administrator maps real people to an IdP group. For example,
   members of `example-membership-reviewers` receive
   `membership_reviewer` in the token's `groups` claim.
3. Runner's `operator_identity` configuration fixes the token source, allowed
   algorithm, public-key source, issuer, audience, subject claim, roles claim,
   and apply roles.
4. For every approval, Runner reads a fresh token from environment, a protected
   token file, or stdin.
5. Runner verifies the asymmetric algorithm, signature and JWKS key, issuer,
   audience, `exp`, and `nbf`. It then reads a safe subject and the configured
   roles claim.
6. Runner requires an exact role match. `membership_reviewer_backup` does not
   satisfy `membership_reviewer`.
7. The approval is bound to the immutable proposal ID, version, and hash, the
   action `approve`, the verified subject, and the decision time.
8. Runner stores the verified identity metadata and an attested decision proof.
   It never stores the bearer token.
9. Apply is a second operator decision. A fresh verified identity must satisfy
   `operator_identity.apply_roles`; approval does not imply commit authority.

At apply time Runner also verifies the stored approval proof against the exact
proposal. A changed proposal ID, version, hash, role, subject, decision, or
attestation fails before source mutation.

## Development-Only Identity

For one-user local development, `dev_env` preserves the lightweight workflow:

```json
{
  "operator_identity": {
    "provider": "dev_env",
    "actor_env": "SYNAPSOR_OPERATOR_ID",
    "roles_env": "SYNAPSOR_OPERATOR_ROLES",
    "apply_roles": ["writeback_operator"]
  }
}
```

```bash
export SYNAPSOR_OPERATOR_ID="local-reviewer"
export SYNAPSOR_OPERATOR_ROLES="membership_reviewer,writeback_operator"

synapsor-runner proposals approve latest \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes
```

`dev_env` is explicitly unverified. Environment text is trusted as entered. Do
not use it for a shared Runner, production, or a decision that must prove who
approved it. Use `jwt_oidc` or `signed_key` there.

## Production-Style OIDC Configuration

The following block is parsed and used by the packed OIDC integration test.
The simulated issuer uses the same shape, but this is not Okta, Entra, Auth0,
or any other vendor certification.

<!-- synapsor-oidc-operator-config:start -->
```json
{
  "provider": "jwt_oidc",
  "apply_roles": ["writeback_operator"],
  "token_env": "SYNAPSOR_OPERATOR_TOKEN",
  "roles_claim": "groups",
  "subject_claim": "sub",
  "attestation_secret_env": "SYNAPSOR_OPERATOR_ATTESTATION_SECRET",
  "algorithms": ["RS256"],
  "jwks_url_env": "SYNAPSOR_OPERATOR_JWKS_URL",
  "issuer": "https://identity.example.test/oidc",
  "audience": "synapsor-operators",
  "clock_skew_seconds": 0,
  "jwks_cache_seconds": 60,
  "jwks_cooldown_seconds": 1,
  "fetch_timeout_ms": 2000,
  "max_response_bytes": 8192
}
```
<!-- synapsor-oidc-operator-config:end -->

Place that object at `operator_identity` in `synapsor.runner.json`. The
configuration uses environment-variable names, not their secret values.

The IdP mapping for this example is:

| IdP group | JWT `groups` value | Synapsor purpose |
| --- | --- | --- |
| `example-membership-reviewers` | `membership_reviewer` | Satisfies the capability's exact `APPROVAL ROLE`. |
| `example-writeback-operators` | `writeback_operator` | Satisfies the independent `apply_roles` gate. |

Configure this mapping in the IdP. Runner does not infer it from database roles
or group names.

### What Each Setting Does

| Setting | Meaning |
| --- | --- |
| `algorithms` | Exact asymmetric algorithms Runner accepts. OIDC operator identity supports `RS256` and `ES256`; do not infer this from the token header. |
| `jwks_url_env` | Environment variable containing the IdP's public JWKS URL. Remote URLs must use HTTPS; HTTP is accepted only on loopback for development. |
| `issuer` / `audience` | Values Runner requires in `iss` and `aud`. |
| `subject_claim` | Verified top-level claim used as the operator identity. |
| `roles_claim` | Verified top-level claim containing exact Synapsor role strings. |
| `token_env` | Environment variable holding the short-lived operator bearer token for this command. |
| `attestation_secret_env` | Environment variable holding at least 32 bytes of Runner-side key material used to attest the redacted stored decision. |
| `apply_roles` | Roles accepted for the separate apply decision. |

The attestation secret is not the OIDC token and not an IdP client secret.
Runner uses it locally to make the stored, token-free identity proof
tamper-evident. Every trusted process that verifies the same ledger needs the
same protected value. Keep it out of source control, MCP configuration, logs,
and model context.

## Run The Local OIDC/JWKS Fixture

The npm package includes a synthetic localhost-only issuer. It generates
ephemeral RS256 private keys in memory, serves only public keys at `/jwks`, and
mints fixed test identities. It must never be used as a real identity provider.

In terminal 1:

```bash
export SYNAPSOR_EXAMPLE_OIDC_PORT=9411
node ./node_modules/@synapsor/runner/examples/operator-oidc/issuer.mjs
```

It prints one JSON object describing:

```text
JWKS:    http://127.0.0.1:9411/jwks
Issuer:  https://identity.example.test/oidc
Audience: synapsor-operators
```

The server holds the private keys only in memory. Stop it after the walkthrough.

In terminal 2, from a Synapsor project that has one pending
`membership_reviewer` proposal:

```bash
export SYNAPSOR_OPERATOR_JWKS_URL="http://127.0.0.1:9411/jwks"
export SYNAPSOR_OPERATOR_ATTESTATION_SECRET="$(openssl rand -base64 32)"

export SYNAPSOR_OPERATOR_TOKEN="$(
  curl -fsS http://127.0.0.1:9411/token/reviewer |
    node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).access_token'
)"

synapsor-runner proposals approve latest \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --yes \
  --json

unset SYNAPSOR_OPERATOR_TOKEN
```

The token is supplied through the environment and is not a command-line
argument. For a real deployment, inject a short-lived token through a protected
process environment, protected token file, or stdin. Never commit it.

The fixture's apply identity uses a rotated key. Keep the old and new public
keys overlapped during rotation:

```bash
curl -fsS -X POST http://127.0.0.1:9411/rotate

export SYNAPSOR_OPERATOR_TOKEN="$(
  curl -fsS http://127.0.0.1:9411/token/applier |
    node -pe 'JSON.parse(require("node:fs").readFileSync(0,"utf8")).access_token'
)"

synapsor-runner apply latest \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --json

unset SYNAPSOR_OPERATOR_TOKEN
```

This second token has `writeback_operator`, not
`membership_reviewer`. It authorizes apply only after Runner verifies the
stored approval and all guarded-write prerequisites.

### Token File Or Stdin

Configure exactly one token source.

For a protected token file, replace `token_env` with:

```json
{
  "token_file_env": "SYNAPSOR_OPERATOR_TOKEN_FILE"
}
```

Set the environment variable to a mode-`0600` file outside the repository.
Delete the file after the decision.

For stdin, replace `token_env` with:

```json
{
  "token_stdin": true
}
```

Use `--yes` so confirmation does not compete for stdin:

```bash
printf '%s\n' "$SHORT_LIVED_OPERATOR_TOKEN" |
  synapsor-runner proposals approve "$PROPOSAL_ID" \
    --config ./synapsor.runner.json \
    --store ./.synapsor/local.db \
    --yes
```

Do not pass a token as a CLI argument.

## What The Ledger Stores

Inspect the full lifecycle without copying an opaque ID:

```bash
synapsor-runner replay show latest \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --json
```

The approval record has this shape:

```json
{
  "proposal_version": 1,
  "proposal_hash": "sha256:...",
  "approver": "reviewer@example.test",
  "status": "approved",
  "identity": {
    "provider": "jwt_oidc",
    "verified": true,
    "subject": "reviewer@example.test",
    "roles": ["membership_reviewer"],
    "key_id": "fitflow-key-1",
    "algorithm": "RS256",
    "issuer": "https://identity.example.test/oidc",
    "decision": {
      "schema_version": "synapsor.operator-decision.v1",
      "action": "approve",
      "proposal_id": "wrp_...",
      "proposal_version": 1,
      "proposal_hash": "sha256:...",
      "subject": "reviewer@example.test",
      "issued_at": "..."
    },
    "decision_hash": "sha256:...",
    "signature": "...",
    "integrity_hash": "sha256:..."
  }
}
```

`signature` is Runner's HMAC attestation over the redacted verified identity
and exact decision. It is not the original OIDC JWT signature. The bearer token
is absent.

The replay also contains a `writeback_authorized` event for the independently
verified apply identity and the normal guarded-write receipt.

## JWKS Caching And Key Rotation

For a long-running Runner process, remote JWKS keys are held in memory for
`jwks_cache_seconds` (default 600 seconds). An unknown `kid` may trigger a
bounded refresh after `jwks_cooldown_seconds` (default 30 seconds). Fetches have
a timeout and maximum response size, reject redirects, and accept public keys
only. A one-shot CLI command starts with an empty in-memory cache.

During rotation:

1. Publish the new public key while retaining the old key.
2. Wait at least the configured cache lifetime plus expected clock skew.
3. Start issuing tokens with the new `kid`.
4. Keep the overlap long enough for long-running processes to refresh.
5. Remove the old key only after old tokens and caches have expired.

Runner's verifier tests exercise an in-process unknown-`kid` refresh. The packed
approval integration uses the old key for approval, publishes an overlapping
new key, and uses the new key for the independent apply decision.

## Fail-Closed Troubleshooting

| Failure | What Runner does | Remediation |
| --- | --- | --- |
| Missing or similar role | Refuses the decision; proposal stays pending. | Map the exact contract role into the configured roles claim. Do not rename the role at runtime. |
| Wrong issuer or audience | Rejects JWT verification. | Match the exact IdP issuer and application audience. |
| Unknown `kid` | Refreshes only within the bounded JWKS policy, then rejects if no public key matches. | Publish overlapping keys and wait for the cooldown/cache policy. |
| Invalid signature | Rejects the token. | Obtain a fresh token from the configured issuer; do not bypass verification. |
| Expired or not-yet-valid token | Rejects the token. | Fix clock synchronization and obtain a currently valid token. Keep clock skew narrow. |
| Unsafe subject or malformed roles | Refuses identity resolution. | Emit a safe top-level string subject and an array or delimited string of safe role names. |
| JWKS endpoint unavailable | Fails closed when a required key cannot be resolved. | Restore HTTPS/network/DNS service or use a reviewed public-key source. Do not fall back to `dev_env`. |
| Missing or short attestation secret | Refuses to record the decision. | Supply at least 32 bytes of protected Runner-side key material. |
| Stored identity proof changed | Apply fails before source mutation. | Investigate ledger integrity. Create a new proposal and approval; do not edit the proof. |
| Approver lacks an apply role | Apply is refused even after approval. | Use a separately verified operator whose token has one configured `apply_roles` value. |

Database availability, database roles, and MCP arguments never substitute for a
verified operator identity. Keep database least privilege and RLS beneath this
operator decision boundary.
