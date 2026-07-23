# Auto Boundary Churn Fixture

This synthetic staging fixture is the measured Runner 1.6.0 golden path:
PostgreSQL, Next.js, Prisma, Cursor-compatible local MCP, and the local
Workbench.

The database role is SELECT-only, non-owner, non-superuser, and subject to
forced tenant/principal RLS. The data includes reviewed churn cohorts, a
cross-tenant denial case, kept-out fields, and cohorts below the privacy
threshold.

Run the automated acceptance path from the repository root:

```bash
corepack pnpm test:auto-boundary-explore
corepack pnpm test:auto-boundary-explore:packed
```

The packed gate uses only packed public artifacts for the complete journey:
disabled whole-schema draft, digest activation, two Cursor authoring tools,
privacy-suppressed weekly churn analysis, denial and differencing tests,
Protect This Query, production Explore removal, and the surviving named
capability. No source row is mutated.
