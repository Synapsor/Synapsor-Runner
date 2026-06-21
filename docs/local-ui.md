# Local UI

`synapsor ui` is planned but not implemented in v0.1 yet.

The CLI path is the current supported local flow:

```bash
synapsor inspect --database-url-env SYNAPSOR_DATABASE_READ_URL
synapsor init --spec onboarding-selection.json --non-interactive
synapsor doctor --config synapsor.runner.json
synapsor mcp serve --config synapsor.runner.json --store ./.synapsor/local.db
```

The local UI must not weaken the security boundary when implemented.

Requirements:

- bind to `127.0.0.1` by default;
- use a per-run local session token or equivalent protection;
- never put database URLs or passwords in browser state, HTML, JavaScript
  bundles, logs, or API responses;
- protect approve/reject actions against CSRF;
- expose no raw SQL editor;
- expose no control that widens allowed tables or columns without rerunning a
  reviewed configuration flow;
- escape untrusted database values and identifiers before rendering;
- show proposals, exact diffs, evidence, approval state, receipts, and replay.
