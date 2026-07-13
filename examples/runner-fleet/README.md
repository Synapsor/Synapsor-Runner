# Two-Runner Fleet Fixture

This synthetic fixture starts Postgres, MySQL, and two stateless Streamable
HTTP Runner services. Both Runners share one bounded Postgres runtime ledger.
The committed passwords and HS256 key are disposable local-demo values. Never
reuse them outside this fixture.

From the repository root:

```bash
corepack pnpm install
docker compose --profile fleet -f examples/runner-fleet/docker-compose.yml up --build -d --wait
docker compose --profile fleet -f examples/runner-fleet/docker-compose.yml ps
```

Check both instances:

```bash
curl --fail http://127.0.0.1:8871/healthz
curl --fail http://127.0.0.1:8871/readyz
curl --fail http://127.0.0.1:8872/readyz
```

The MCP endpoint requires a claim-bearing development JWT. Generate one for
the fixture only:

```bash
node examples/runner-fleet/mint-dev-token.mjs acme local-agent
```

The production path should use `jwt_asymmetric` with an explicit RS256/ES256
allowlist and a trusted JWKS URL or public PEM. See
[Running A Runner Fleet](../../docs/running-a-runner-fleet.md).

Run the stronger automated verification instead of treating a green Compose
status as proof:

```bash
corepack pnpm test:fleet
```

That test launches two source-tree Runners, uses asymmetric claim-bound
sessions and concurrent signed reviewers, starts competing workers, kills
workers before, during, and after writeback, and verifies readiness,
dead-letter recovery, idempotency, pool pressure, backup/restore, and
archive-before-retention. It deletes all fixture volumes when complete.

Clean up the visual Compose fixture with:

```bash
docker compose --profile fleet -f examples/runner-fleet/docker-compose.yml down -v --remove-orphans
```
