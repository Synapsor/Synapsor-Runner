# HTTP MCP

Use HTTP when an application, server-side agent, container, or remote MCP client
connects to a long-running Synapsor Runner. Prefer stdio when one local desktop
client can launch Runner directly: stdio opens no network socket and needs no
HTTP credential, TLS setup, OAuth flow, or MCP HTTP session.

Runner provides:

- `mcp serve-streamable-http`: standard MCP Streamable HTTP using the official
  MCP SDK. This is the normal HTTP endpoint.
- `mcp serve-http`: a legacy JSON-RPC bridge with `tools/list`, `tools/call`, and
  `resources/read`. It has the same network-channel hardening but no standard
  MCP session and therefore cannot use per-session `http_claims` identity.

## Authentication Concepts

These are separate controls:

| Control | Meaning |
| --- | --- |
| TLS | Encrypts the network channel and authenticates the server certificate. |
| mTLS | Also authenticates a client workload certificate. It supplements Bearer auth in Runner. |
| HTTP Bearer | The HTTP presentation scheme: `Authorization: Bearer <credential>`. It does not imply that the credential is a JWT. |
| Opaque endpoint token | One high-entropy service credential for loopback or an explicitly single-tenant service. It is not user or tenant identity. |
| Signed JWT | A short-lived identity-provider-issued access token whose signature, algorithm, issuer, audience/resource, time, scope, tenant, and principal claims Runner verifies. |
| MCP session ID | Routes requests to initialized MCP state. It is not authentication. |
| Trusted context | The tenant and principal Runner binds after authentication. Model arguments, arbitrary headers, query strings, forwarded headers, and MCP metadata are never trusted context. |

Runner does not issue endpoint tokens, JWTs, refresh tokens, or end-user
passwords. An operator generates and distributes an opaque token out of band.
For a shared deployment, an external identity provider or authorization server
issues JWT access tokens; Runner is only the protected resource that verifies
them.

## Deployment Profiles

### Local loopback with an opaque token

Generate at least 32 random bytes. The same environment variable must be
available to Runner and the authorized local client; the value is never placed
in config JSON or a generated client file.

```bash
export SYNAPSOR_RUNNER_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"

synapsor-runner mcp serve-streamable-http \
  --host 127.0.0.1 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

Equivalent unified command:

```bash
synapsor-runner mcp serve \
  --transport streamable-http \
  --host 127.0.0.1 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

`--dev-no-auth` is accepted only for an explicit loopback development run. It
is refused for wildcard, private-network, and public binds.

### Remote single-tenant service

Declare the service and channel in Runner deployment config. This wiring is not
part of the portable Synapsor contract:

```json
{
  "http_security": {
    "deployment": "single_tenant",
    "channel": "trusted_tls_proxy",
    "static_token": {
      "active_env": "SYNAPSOR_RUNNER_HTTP_TOKEN",
      "previous_env": "SYNAPSOR_RUNNER_HTTP_TOKEN_PREVIOUS"
    },
    "allowed_hosts": ["runner.internal.example"],
    "allowed_origins": ["https://agent-console.example"]
  }
}
```

The supported protected channels are:

1. Runner-owned TLS, selected by supplying certificate and key env references.
2. `trusted_tls_proxy`, where a trusted proxy terminates TLS and a firewall or
   private network prevents direct client access to Runner.
3. `insecure_http_break_glass`, an authenticated but interceptable emergency
   mode. It emits a security warning and is not appropriate for normal use.

A non-loopback listener with no explicit channel refuses to start before it
binds. Break glass never disables authentication.

Trusted TLS proxy:

```bash
synapsor-runner mcp serve-streamable-http \
  --host 0.0.0.0 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --trusted-tls-proxy \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --previous-auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN_PREVIOUS
```

Runner-owned TLS:

```bash
export SYNAPSOR_TLS_CERT_PEM="$(cat ./server.crt)"
export SYNAPSOR_TLS_KEY_PEM="$(cat ./server.key)"

synapsor-runner mcp serve-streamable-http \
  --host 0.0.0.0 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --tls-cert-env SYNAPSOR_TLS_CERT_PEM \
  --tls-key-env SYNAPSOR_TLS_KEY_PEM
```

For mTLS, add a protected client CA bundle:

```bash
export SYNAPSOR_TLS_CA_PEM="$(cat ./client-ca.crt)"

synapsor-runner mcp serve-streamable-http \
  --host 0.0.0.0 \
  --port 8766 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN \
  --tls-cert-env SYNAPSOR_TLS_CERT_PEM \
  --tls-key-env SYNAPSOR_TLS_KEY_PEM \
  --tls-ca-env SYNAPSOR_TLS_CA_PEM \
  --require-client-cert
```

mTLS authenticates a workload certificate in addition to the Bearer credential.
It does not turn a shared opaque token into per-user or per-tenant identity.

### Shared multi-user or multi-tenant service

Use verified signed session identity. A static endpoint token is intentionally
insufficient as trusted tenant/principal authority.

```json
{
  "trusted_context": {
    "provider": "http_claims",
    "values": {
      "tenant_id_key": "tenant_id",
      "principal_key": "sub"
    }
  },
  "session_auth": {
    "provider": "jwt_asymmetric",
    "algorithms": ["ES256"],
    "jwks_url_env": "SYNAPSOR_SESSION_JWKS_URL",
    "issuer": "https://identity.example",
    "audience": "https://runner.example/mcp",
    "tenant_claim": "tenant_id",
    "principal_claim": "sub",
    "clock_skew_seconds": 30
  },
  "http_security": {
    "deployment": "shared",
    "channel": "trusted_tls_proxy",
    "oauth_resource": {
      "resource": "https://runner.example/mcp",
      "authorization_servers": ["https://identity.example"],
      "scopes_supported": ["synapsor:mcp"],
      "required_scopes": ["synapsor:mcp"],
      "resource_name": "Synapsor Runner"
    },
    "allowed_hosts": ["runner.example"],
    "allowed_origins": ["https://agent-console.example"]
  }
}
```

The identity provider publishes the public JWKS URL stored in
`SYNAPSOR_SESSION_JWKS_URL`. The client obtains a short-lived access token from
that provider through the provider-supported OAuth/OIDC flow and sends it in the
Bearer header. Runner then validates, on every request including requests for an
existing MCP session:

- allowed `RS256` or `ES256` algorithm and signature;
- public `kid` selection and bounded JWKS refresh/cache behavior;
- exact issuer and audience/resource;
- expiry, not-before, and configured clock skew;
- configured required scopes;
- bounded scalar tenant and principal claims.

The audience must exactly equal `http_security.oauth_resource.resource`.
Unverified headers such as `X-Tenant-Id` and all `Forwarded`/`X-Forwarded-*`
values never become trusted identity.

Runner exposes RFC 9728 protected-resource metadata at the current MCP path:

```text
/.well-known/oauth-protected-resource/mcp
```

An unauthenticated MCP request receives a `401` Bearer challenge containing the
`resource_metadata` URL. A valid token missing a required scope receives `403`
with `insufficient_scope`. Runner does not implement a proprietary login or
refresh-token service.

## Opaque Token Rotation

Runner accepts one active token and, only when configured, one previous token:

```bash
export SYNAPSOR_RUNNER_HTTP_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
```

1. Move the old active value to the previous secret slot.
2. Have the secret manager inject that old value as
   `SYNAPSOR_RUNNER_HTTP_TOKEN_PREVIOUS`, then put a new random value in the
   active slot.
3. Restart/roll Runner instances and update authorized clients.
4. Remove `previous_env` and its secret after the bounded rollout window.

Runner never accepts an unbounded key history. Existing MCP sessions are pinned
to the exact credential used at initialization, so swapping active and previous
tokens cannot take over another session.

## Origin, Host, CORS, And Request Bounds

- Every present browser `Origin` must exactly match `allowed_origins`; otherwise
  Runner returns `403`. Native MCP clients may omit `Origin`.
- Wildcard CORS and the `null` origin are rejected.
- Every request `Host` must match `allowed_hosts` (or the safe loopback default).
  This is independent of tenant identity and limits DNS-rebinding-style access.
- Forwarded host and identity headers are never trusted automatically.
- Request body, header, connection, request-time, session-count, and idle-session
  limits have bounded defaults and can be tightened under `http_security.limits`.

```json
{
  "http_security": {
    "limits": {
      "max_request_bytes": 65536,
      "max_header_bytes": 8192,
      "max_sessions": 500,
      "session_idle_timeout_seconds": 300,
      "request_timeout_ms": 15000,
      "headers_timeout_ms": 5000,
      "keep_alive_timeout_ms": 5000,
      "max_connections": 1000
    }
  }
}
```

Session and connection limits are per Runner process. Capability rate limits and
ledger state become fleet-wide only when the shared PostgreSQL runtime store is
configured.

## Health, Readiness, And Metrics

`/healthz` is unauthenticated and intentionally minimal:

```json
{
  "ok": true,
  "status": "live",
  "transport": "streamable-http"
}
```

`/readyz` reports bounded dependency status codes without credentials or raw
infrastructure errors. `/metrics` is disabled unless separately configured and
uses its own authorization; the MCP endpoint credential does not implicitly
grant metrics access.

## Legacy JSON-RPC Bridge

```bash
synapsor-runner mcp serve-http \
  --host 127.0.0.1 \
  --port 8765 \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

The bridge has equivalent remote channel, TLS/mTLS, static-token rotation,
Origin/Host, and request-bound enforcement. It rejects `http_claims` because it
does not implement standard MCP sessions. Use Streamable HTTP for a shared
identity deployment and for standard MCP SDK clients.

An authorized bridge request references the environment value at runtime:

```bash
curl -i \
  -H "Authorization: Bearer ${SYNAPSOR_RUNNER_HTTP_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  http://127.0.0.1:8765/mcp
```

## Diagnose Before Serving

```bash
synapsor-runner doctor \
  --config ./synapsor.runner.json \
  --transport streamable-http \
  --host 127.0.0.1 \
  --auth-token-env SYNAPSOR_RUNNER_HTTP_TOKEN
```

For a remote proxy deployment add `--host 0.0.0.0 --trusted-tls-proxy`; for
Runner-owned TLS add the same TLS env-name flags used at startup. Doctor reports
the transport, bind scope, channel, auth/identity mode, issuer/audience/resource,
key readiness, token strength/rotation, Origin/Host policy, limits, rate-limit
scope, and database isolation assurance without printing credential values.

## Model-Facing Boundary

HTTP transport does not change authority. MCP clients receive reviewed semantic
capabilities, never raw SQL, database credentials, endpoint credentials,
approval/apply/reconcile/revert tools, token minting, or token refresh. Keep
least-privilege DB roles and PostgreSQL RLS or tenant-bound credentials under
Runner where practical; transport authentication does not replace database or
operator authorization.
