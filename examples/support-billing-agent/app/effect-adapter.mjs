import fs from "node:fs";

if (process.env.SYNAPSOR_EFFECT_MODE !== "propose_only") {
  throw new Error("reference effect adapter requires SYNAPSOR_EFFECT_MODE=propose_only");
}
if (process.env.DATABASE_URL || process.env.SYNAPSOR_DATABASE_WRITE_URL) {
  throw new Error("reference effect adapter must not receive database credentials");
}
const fixturePath = process.env.SYNAPSOR_EFFECT_FIXTURE_PATH;
if (!fixturePath) throw new Error("SYNAPSOR_EFFECT_FIXTURE_PATH is required");
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const expected = fixture.expected;

process.stdout.write(`${JSON.stringify({
  schema_version: "synapsor.effect-result.v1",
  fixture_id: fixture.fixture_id,
  capability_calls: expected.capability_calls.map((name) => ({ name })),
  trusted_context: expected.trusted_context,
  proposal: expected.proposal,
  observed_fields: Object.keys(expected.proposal.diff ?? {}).sort(),
  evidence: { mode: "fixture", new_source_reads: false },
  source_database_changed: false,
})}\n`);
