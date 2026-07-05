## Summary

What changed?

## Safety Boundary

- [ ] No model-facing raw SQL, write credentials, approval, commit, apply, or writeback tools were added.
- [ ] Tenant/scope, allowed-column, conflict/version, idempotency, receipt, replay, and store-lease semantics are unchanged or covered by tests.
- [ ] App-owned handler changes preserve tenant/version/idempotency re-check guidance.

## Tests

```bash
# paste commands run
```

## Docs

- [ ] README/docs/examples were updated when user-facing behavior changed.
- [ ] No secrets, database URLs, tokens, or generated `.synapsor/` stores are included.
