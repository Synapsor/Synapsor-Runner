# Database-Enforced Tenant And Principal Scope

Runner always binds tenant and principal from trusted server-side context, not
from model arguments. Choose the database enforcement mode deliberately:

| Diagnostic mode | What enforces scope | Protects against | Does not protect against |
| --- | --- | --- | --- |
| `application_scope` | Runner's fixed, parameterized predicates with one least-privilege credential | A model trying to widen tenant or principal arguments | A defect in Runner's predicate construction |
| `postgres_rls` | Runner predicates plus PostgreSQL row-level security | Omitted/wrong Runner predicates and pooled-session context leakage | A fully compromised process that can choose trusted settings while holding a broad credential |
| `tenant_bound` | Runner predicates plus a credential or process that cannot access other tenants | Query mistakes and a process that never receives organization-wide database authority | Incorrect grants or isolation in the credential/deployment itself |

These modes are defense in depth, not substitutes for least-privilege roles,
restricted views, application authorization, or staging-first validation.
HTTP endpoint authentication is another independent layer: it establishes who
may call Runner and, for signed shared sessions, which trusted tenant/principal
claims are bound. It does not turn `application_scope` into database-enforced
isolation. See [HTTP MCP](http-mcp.md).

## Default: Application-Level Scope

Existing source configs remain compatible. An omitted `database_scope`, or:

```json
{
  "database_scope": { "mode": "application" },
  "credential_scope": { "mode": "shared" }
}
```

means Runner adds reviewed tenant and optional principal predicates to every
supported read and write using one environment-bound credential. This stops
the model from selecting another tenant, because scope is not a tool argument.
It is still application-level isolation: a defect in Runner's SQL construction
could cross that boundary. Keep database permissions, restricted views, and
RLS where available.

## Trusted-Context Provenance

The tenant value is part of the security boundary. Runner accepts it through
these reviewed paths:

| Deployment | Trusted-context source | Diagnostic binding |
| --- | --- | --- |
| Local stdio or one explicitly single-tenant process | Operator-controlled environment or local development binding | `process_bound` |
| Shared Streamable HTTP | Verified signed JWT claims configured with `http_claims` and `session_auth` | `verified_http_session` |
| Cloud embedding | A verified per-session binding supplied by the embedding control plane | `verified_external_session` |

Runner does not treat a tool argument, query parameter, arbitrary MCP `_meta`
value, `X-Tenant-*` header, or unverified forwarded header as tenant or
principal authority. A shared HTTP catalog cannot mix claims-bound capabilities
with environment-bound capabilities.

For shared production HTTP, prefer asymmetric JWT verification so Runner holds
only public verification material. HS256 remains useful for local development
and controlled deployments but gives Runner access to the signing secret.
Also declare `http_security.deployment: shared`, an exact HTTPS
audience/protected resource, a direct-TLS or trusted-proxy channel, and exact
Host/Origin policy. A static endpoint token cannot supply shared tenant or
principal identity.

Run `doctor --json` or `tools preview --json` to inspect the effective
per-source assurance mode and trusted-context binding. Server startup prints
the same non-secret summary. An `application_scope` source used with verified
HTTP sessions is deliberately reported with a warning: authentication makes
the tenant value trustworthy, but it does not add an independent database
boundary.

## PostgreSQL RLS Mode

Add fixed setting names to a PostgreSQL source:

```json
{
  "sources": {
    "billing_postgres": {
      "engine": "postgres",
      "read_url_env": "BILLING_POSTGRES_READ_URL",
      "write_url_env": "BILLING_POSTGRES_WRITE_URL",
      "database_scope": {
        "mode": "postgres_rls",
        "tenant_setting": "synapsor.tenant_id",
        "principal_setting": "synapsor.principal"
      },
      "credential_scope": { "mode": "shared" }
    }
  }
}
```

For each scoped transaction, Runner binds both values with parameterized
transaction-local `set_config(..., true)`. Reads, evidence, aggregates,
bounded-set selection, guarded writes, reconciliation, compensation, and
verification therefore use the same trusted context. Transaction-local values
are cleared on commit or rollback and are not reused on the next pooled
checkout.

Runner refuses hardened serving or writeback when the role or target cannot be
attested. Required properties include:

- RLS and `FORCE ROW LEVEL SECURITY` are enabled;
- the effective role is not a superuser, table owner, or `BYPASSRLS` role;
- applicable policies are permissive only where the reviewed access requires
  them;
- every applicable operation policy references both configured settings;
- `SELECT`/`DELETE` have a suitable `USING` expression;
- `INSERT` has a suitable `WITH CHECK` expression;
- `UPDATE` has both `USING` and `WITH CHECK`.

### Example PostgreSQL policy

Use a non-owner read role and a separate non-owner write role. Adapt names and
grants to your schema:

Runner does not silently create or widen these policies. Review and apply the
SQL as a database owner, then run doctor using the steady-state non-owner role.

```sql
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices FORCE ROW LEVEL SECURITY;

CREATE POLICY invoices_reader_scope
ON public.invoices
FOR SELECT
TO runner_reader
USING (
  tenant_id = current_setting('synapsor.tenant_id', true)
  AND assigned_to = current_setting('synapsor.principal', true)
);

CREATE POLICY invoices_writer_select_scope
ON public.invoices
FOR SELECT
TO runner_writer
USING (
  tenant_id = current_setting('synapsor.tenant_id', true)
  AND assigned_to = current_setting('synapsor.principal', true)
);

CREATE POLICY invoices_writer_insert_scope
ON public.invoices
FOR INSERT
TO runner_writer
WITH CHECK (
  tenant_id = current_setting('synapsor.tenant_id', true)
  AND assigned_to = current_setting('synapsor.principal', true)
);

CREATE POLICY invoices_writer_update_scope
ON public.invoices
FOR UPDATE
TO runner_writer
USING (
  tenant_id = current_setting('synapsor.tenant_id', true)
  AND assigned_to = current_setting('synapsor.principal', true)
)
WITH CHECK (
  tenant_id = current_setting('synapsor.tenant_id', true)
  AND assigned_to = current_setting('synapsor.principal', true)
);

CREATE POLICY invoices_writer_delete_scope
ON public.invoices
FOR DELETE
TO runner_writer
USING (
  tenant_id = current_setting('synapsor.tenant_id', true)
  AND assigned_to = current_setting('synapsor.principal', true)
);
```

Grant only the operations and columns needed by the reviewed capabilities.
Policy expressions are not a replacement for grants.

Run the normal metadata checks before serving:

```bash
synapsor-runner doctor --config ./synapsor.runner.json
```

On a disposable or explicitly approved live target, also prove that a known
row disappears under a different tenant and under a different principal:

```bash
synapsor-runner doctor --config ./synapsor.runner.json --check-rls
```

`--check-rls` reads only through the configured read role. It does not mutate
the source. Startup and per-connection checks still fail closed when the
required role or policy properties are absent.

PostgreSQL RLS catches a missing application predicate. It does not make a
fully compromised Runner process safe if that process can choose arbitrary
trusted setting values while holding a credential that spans tenants. Use a
tenant-bound credential or isolated deployment for that threat model.

## Tenant-Bound Credentials

Contracts contain a resolver identifier, never a connection string:

```json
{
  "credential_scope": {
    "mode": "tenant_resolver",
    "resolver": "production_tenant_credentials"
  }
}
```

An embedding application supplies the matching resolver:

```ts
import {
  startRunnerStreamableHttp,
  type TenantCredentialResolver
} from "@synapsor/runner/runtime";

const credentialResolver: TenantCredentialResolver = {
  id: "production_tenant_credentials",
  async resolve({ source_name, access, tenant_id, principal }) {
    const lease = await credentialBroker.issue({
      source: source_name,
      access,
      tenant: tenant_id,
      principal
    });

    return {
      connection_url: lease.connectionUrl,
      credential_id: lease.id,
      expires_at: lease.expiresAt
    };
  }
};

await startRunnerStreamableHttp({
  configPath: "./synapsor.runner.json",
  credentialResolver
});
```

The resolver receives only verified trusted context. Runner partitions pools
by source, access type, tenant, principal, and credential identity; an expired
or rotated lease is closed before reuse. Resolution failures are fail-closed,
and connection URLs are not logged or stored in contracts.

The stock CLI does not load arbitrary executable resolver modules. For direct
CLI operation, run one Runner process per tenant with a tenant-bound credential
in the normal `read_url_env`/`write_url_env` variables and keep
`credential_scope.mode` as `shared`. This gives the process no cross-tenant
credential to misuse.

## MySQL

MySQL does not provide a native equivalent to PostgreSQL RLS. Runner therefore
does not label session variables or application predicates as independent
database enforcement.

Use one or more of:

- tenant-bound read/write credentials;
- restricted tenant-aware views or stored procedures owned and reviewed by
  your application;
- separate schemas or databases;
- one isolated Runner deployment per tenant.

Runner's trusted-context predicates still narrow model behavior, but a shared
MySQL credential remains application-level scope unless the database grants,
views, or deployment physically prevent cross-tenant access.

## Verification

The repository's disposable PostgreSQL proof covers:

```bash
corepack pnpm test:database-scope
```

It verifies an intentionally unscoped query is still denied by RLS, correct
tenant/principal access succeeds, cross-scope access fails, `WITH CHECK`
prevents row moves, pooled scope does not leak, guarded writeback and
compensation remain scoped, and unsafe roles/policies fail doctor.
