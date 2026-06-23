# Shadow Mode

Shadow mode lets you evaluate autonomy before allowing writes.

The model can create proposals and evidence, but the source database is never
mutated. A human continues doing the real work in the application. You can then
record what the human actually did and compare it to the agent proposal.

Run a shadow config:

```json
{
  "mode": "shadow"
}
```

List shadow proposals:

```bash
npx -y -p @synapsor/runner@alpha synapsor shadow list --store ./.synapsor/local.db
```

Record the human action:

```bash
cat > human-action.json <<'JSON'
{
  "late_fee_cents": 0,
  "waiver_reason": "customer requested review"
}
JSON

npx -y -p @synapsor/runner@alpha synapsor shadow record-human-action wrp_123 \
  --store ./.synapsor/local.db \
  --patch human-action.json \
  --actor human_operator \
  --notes "matched support lead decision"
```

Compare:

```bash
npx -y -p @synapsor/runner@alpha synapsor shadow compare wrp_123 --store ./.synapsor/local.db
```

Report:

```bash
npx -y -p @synapsor/runner@alpha synapsor shadow report --store ./.synapsor/local.db
```

The report counts:

- total shadow proposals;
- proposals with human actions;
- exact matches;
- partial matches;
- mismatches;
- proposals with no human action yet.

Use this path to move gradually:

```text
read-only -> shadow proposals -> human-reviewed commits -> policy-approved commits later
```

This goal does not add policy auto-approval.
