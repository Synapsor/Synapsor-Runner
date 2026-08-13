# Database Server Compatibility

Synapsor Runner detects the source database product and server version before it
drafts reviewed authority. The detected exact version and a stable grammar
capability profile are stored in the disabled draft, generation lock, and exact
activated boundary. Unsupported servers fail before review or query execution;
supported older servers receive only grammar that they can execute.

This page distinguishes two claims:

- **Supported line** means Runner has an explicit capability profile and refuses
  anything outside it.
- **Release-gate image** means the 1.7.0 automated matrix started that exact
  server, drafted and activated authority, and ran real local/HTTP Explore calls.

Technical compatibility does not extend a database vendor's maintenance or
security-support lifecycle. PostgreSQL 13 and MySQL 5.7 are useful compatibility
targets for existing installations, but new deployments should use a currently
maintained server release and current patch level.

## Supported Source Lines

| Source server | Runner tier | Reviewed Explore behavior |
| --- | --- | --- |
| PostgreSQL 13 through 18 | Full | Complete reviewed grammar is available. |
| PostgreSQL 12 or older | Unsupported | Draft, activation, Doctor, and Explore fail with the detected version and the PostgreSQL 13-18 requirement. |
| PostgreSQL 19 or newer | Not yet claimed | A future major is refused until that line passes the compatibility gate for a Runner release. |
| MySQL 8.0.16 and newer 8.x | Full | Complete reviewed grammar is available. Only enforced `CHECK` constraints may provide categorical vocabulary. |
| MySQL 8.0.11 through 8.0.15 | Compatible, limited grammar | Core reviewed analytics and automatic numeric bands work; parsed but unenforced `CHECK` clauses are excluded from categorical authority. |
| MySQL 5.7 | Compatible, limited grammar | Core reviewed analytics work; automatic bands and `CHECK`-dependent categorical authority are omitted. |
| Pre-GA MySQL 8.0.0 through 8.0.10 | Unsupported | Runner supports the generally available 8.0 line beginning at 8.0.11, not development milestones. |
| PostgreSQL or MySQL alpha, beta, RC, development, or snapshot builds | Unsupported | A prerelease never inherits the authority of its eventual stable release. Use a stable release from a supported line. |
| MySQL older than 5.7 | Unsupported | Authority is refused before it can be activated or served. |
| MySQL 9 or newer | Not yet claimed | A future major is refused until its semantics pass the compatibility gate. |
| MariaDB or another MySQL-compatible product | Not claimed | Runner refuses it instead of assuming MySQL semantics from a compatible wire protocol. |

The **application source** can be PostgreSQL or MySQL. Production HTTP Explore
uses a separate PostgreSQL control store for atomic budgets and audit metadata,
even when the application source is MySQL. This source compatibility matrix does
not turn the production control store into MySQL.

## MySQL Limited Compatibility Tiers

MySQL 5.7 lacks window functions and common table expressions, and its `CHECK`
syntax is neither enforced nor exposed as reliable constraint evidence. Runner
therefore changes authoring, not query semantics:

MySQL 8.0 did not enforce `CHECK` constraints until 8.0.16. Runner therefore
keeps 8.0.11-8.0.15 useful without pretending those clauses are authority:

| Capability | MySQL 5.7 | MySQL 8.0.11-8.0.15 |
| --- | --- | --- |
| Direct, derived, principal, and shared-reference scope | Available and enforced normally. | Available and enforced normally. |
| Rows, counts, distinct counts, sum, average, standard deviation, and variance | Available for reviewed fields. | Available for reviewed fields. |
| Calendar buckets and reviewed relative UTC windows | Available. | Available. |
| Fixed reviewer-authored numeric bands | Available; fixed parameterized `CASE`. | Available; fixed parameterized `CASE`. |
| Reviewed post-suppression running totals, rank, lag change, moving average, and share | Available in Runner after bounded groups return. | Available in Runner after bounded groups return. |
| Automatic quantile/equal-width bands | Unavailable; omitted from review, discovery, and activated authority. | Available; 8.0.11 has the required CTE/window support. |
| Native MySQL `ENUM` dimensions | Available as bounded categorical vocabulary. | Available as bounded categorical vocabulary. |
| `VARCHAR`/text vocabulary inferred from `CHECK` | Unavailable. | Unavailable until 8.0.16 because the server does not enforce it. |

On every tier, PostgreSQL `CHECK` constraints marked `NOT VALID` and MySQL
constraints marked `NOT ENFORCED` are excluded from categorical authority.
They may not describe existing rows, so treating them as proof would make the
boundary claim stronger evidence than the database actually supplies.

That exclusion means the constraint does not populate a field's reviewed enum
vocabulary or constrain the values Runner attributes to database proof. On a
full profile, a separately reviewed low-risk text field may still be groupable
under the normal bounded-group and suppression policy; that authority does not
come from the invalid constraint. Limited profiles deliberately require a native
bounded `ENUM` before offering text grouping or categorical filtering.

On either limited tier, an unbounded text field may remain selectable for a
reviewed row read, but it is not categorically groupable or filterable without
a native bounded `ENUM`. Runner does not query or import `CHECK` clauses as
vocabulary evidence on a release that does not enforce them.

The model never receives a feature and then discovers a raw SQL failure. The
capability profile is applied while the human boundary is authored; only the
resulting reviewed grammar enters the activated pack and the two MCP tool
descriptions. Local stdio and production Streamable HTTP use that same pack.

## Version Locks And Rescan

The generation lock and reviewed boundary record all three:

- the exact server string, useful for support and audit; and
- the resolved `full` or `compatible_limited` tier; and
- a stable authority profile: PostgreSQL major version, MySQL `5.7`, MySQL
  `8.0-pre-check`, or MySQL `8.x`.

A patch upgrade that leaves the capability profile unchanged does not create a
false drift event. A PostgreSQL major change, a MySQL 5.7-to-8.x upgrade, the
8.0.15-to-8.0.16 `CHECK`-authority transition, or an engine change does change
the authority profile. Runner refuses stale authority and requires the
normal reconciling rescan and human activation:

```bash
synapsor-runner start --from-env DATABASE_URL --cli --rescan
```

Rescan preserves decisions whose reviewed inputs remain valid. A downgrade to
MySQL 5.7 removes unsupported automatic-band policy; a downgrade below 8.0.16
removes `CHECK`-derived categorical authority. Both happen only in the disabled
candidate and require review. Runner never silently translates policy into
another query. An upgrade may make options available, but never auto-enables or
auto-activates them.

Boundaries created before these fields existed are not silently grandfathered.
Their next query refuses with reconciling-rescan guidance. Rescan records the
detected version, tier, and authority line in a disabled candidate while
preserving unrelated reviewed policy; serving resumes only after explicit
review and activation.

## What Operators See

- `inspect` prints the exact detected version and `FULL`,
  `COMPATIBLE - LIMITED GRAMMAR`, or `UNSUPPORTED`.
- `doctor` and `doctor --preflight` emit a named
  `source:<source>:server-version` pass, warning, or failure.
- CLI and Workbench boundary overviews show the exact release captured by the
  boundary lock and label it as the reviewed source release, not the current live
  patch. `inspect` and Doctor report the live detected release. Both limited
  MySQL profiles are visibly marked, and the review surfaces name only the
  unavailable options before a reviewer can select them.
- The rescan report names a changed server authority and any removed grammar.
- Runtime returns `EXPLORE_SERVER_VERSION_UNSUPPORTED` or a stale-lock refusal
  before source SQL when live authority no longer matches the lock.

## 1.7.0 Live Matrix

The release gate `pnpm test:database-version-compatibility` starts disposable
servers and verifies exact version detection, capability authoring, generation
locks, activated-boundary serialization, local MCP, scoped queries, and real
RS256-authenticated production HTTP for representative oldest/limited lines.
The exact images exercised were:

| Engine | Exact release-gate version | Result |
| --- | --- | --- |
| PostgreSQL | 12.22 | Refused below the supported floor. |
| PostgreSQL | 13.23 | Full tier; local grammar and production HTTP passed. |
| PostgreSQL | 14.23 | Full tier passed. |
| PostgreSQL | 15.18 | Full tier passed. |
| PostgreSQL | 16.14 | Full tier passed. |
| PostgreSQL | 17.10 | Full tier passed; also supplied the isolated test control store. |
| PostgreSQL | 18.4 | Full tier passed. |
| MySQL | 5.7.44 | Limited tier; local grammar and production HTTP passed, and unavailable grammar was absent/refused. |
| MySQL | 8.0.11 | Limited pre-`CHECK` tier passed; automatic bands remained available. |
| MySQL | 8.0.15 | Limited pre-`CHECK` tier passed; unenforced constraints did not become vocabulary authority. |
| MySQL | 8.0.16 | Full tier passed at the `CHECK`-enforcement boundary. |
| MySQL | 8.0.46 | Full tier passed. |
| MySQL | 8.1.0 | Full tier passed. |
| MySQL | 8.2.0 | Full tier passed. |
| MySQL | 8.3.0 | Full tier passed. |
| MySQL | 8.4.9 | Full tier passed. |

The matrix covers native enums, contributor-safe dispersion, calendar buckets,
relative windows, fixed bands, post-suppression running metrics, automatic bands
where supported, tenant/principal isolation, strict plan schemas, and the exact
two-tool MCP surface. Separate release gates cover relationship depths through
three, child counts, Workbench, schema-width scaling, complete HTTP auth
rejection, shared accounting, and packed-package execution on PostgreSQL and
MySQL.

Use the matrix as a regression gate, not as permission to run an unmaintained
database indefinitely. Vendor security updates, managed-service policies, and
extensions remain the operator's responsibility.
