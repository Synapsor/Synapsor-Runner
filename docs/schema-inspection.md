# Schema Inspection

`synapsor inspect` reads database metadata so you can choose a narrow reviewed
capability without writing an entire runner config by hand.

From a source checkout, replace `synapsor inspect` with
`corepack pnpm runner inspect`. The global `synapsor` command is only needed
after installing or linking the CLI.

```bash
synapsor inspect \
  --engine auto \
  --database-url-env SYNAPSOR_DATABASE_READ_URL \
  --schema public
```

JSON output:

```bash
synapsor inspect \
  --engine mysql \
  --database-url-env SYNAPSOR_DATABASE_READ_URL \
  --schema app \
  --json
```

## What It Reads

The inspector collects metadata only:

- engine and server version;
- current database user;
- schemas/databases visible to the credential;
- tables and views;
- columns, types, nullability, defaults, and generated status;
- primary keys;
- unique constraints;
- foreign keys;
- index summaries;
- best-effort table writability from object type;
- suggested tenant columns;
- suggested conflict/version columns;
- suggested sensitive or large/binary fields.

It does not sample normal business rows by default.

## Suggestions Are Not Authority

Tenant, conflict, sensitive-field, and default-visible-column suggestions are
heuristics. You must review them before generating or serving a capability.

Suggested tenant column names include:

```text
tenant_id, account_id, organization_id, org_id, workspace_id, customer_id
```

Suggested conflict/version columns include:

```text
updated_at, modified_at, row_version, version, lock_version, etag
```

Likely sensitive fields include names containing:

```text
password, secret, token, api_key, private_key, session, cookie, ssn,
credit_card, card_number, cvv, refresh_token, oauth
```

Binary/blob/vector columns are excluded from generated default visible columns.

## Safety Behavior

- Use a read-only database credential.
- Pass the connection through an environment variable name, not a command-line
  URL.
- Inspection opens read-only transactions where supported.
- Inspection applies statement timeouts.
- Inspection does not issue DDL or DML.
- Errors are sanitized to avoid printing connection strings.

## Next Step

Use the inspection result to create `onboarding-selection.json`, then run:

```bash
synapsor init --spec onboarding-selection.json --non-interactive
```
