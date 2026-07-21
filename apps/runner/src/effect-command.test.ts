import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runEffectCommandAdapter } from "./effect-command.js";

describe("effect command adapter", () => {
  it("runs without ambient credentials and imports one provider-neutral result", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-effect-adapter-"));
    const fixturePath = path.join(directory, "fixture.json");
    const adapterPath = path.join(directory, "adapter.mjs");
    await fs.writeFile(fixturePath, "{}\n", "utf8");
    await fs.writeFile(adapterPath, `
if (process.env.DATABASE_URL || process.env.SYNAPSOR_DATABASE_WRITE_URL || process.env.API_TOKEN) process.exit(9);
if (process.env.SYNAPSOR_EFFECT_MODE !== "propose_only") process.exit(10);
console.log(JSON.stringify({
  schema_version: "synapsor.effect-result.v1",
  fixture_id: "eff_test",
  capability_calls: [{ name: "billing.inspect_invoice" }],
  trusted_context: { tenant_id: "acme", principal: "agent" },
  proposal: { result_category: "unable_to_propose", policy: { decision: "not_applicable" } },
  observed_fields: [],
  evidence: { mode: "fixture", new_source_reads: false },
  source_database_changed: false
}));
`, "utf8");
    const result = await runEffectCommandAdapter({
      command: process.execPath,
      args: [adapterPath],
      fixturePath,
      cwd: directory,
      env: {
        ...process.env,
        DATABASE_URL: "postgres://must-not-reach-adapter",
        SYNAPSOR_DATABASE_WRITE_URL: "postgres://must-not-reach-adapter",
        API_TOKEN: "must-not-reach-adapter",
      },
    });
    expect(result).toMatchObject({ fixture_id: "eff_test", source_database_changed: false });
  });

  it("fails closed on malformed output and bounded timeouts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-effect-adapter-fail-"));
    const fixturePath = path.join(directory, "fixture.json");
    await fs.writeFile(fixturePath, "{}\n", "utf8");
    await expect(runEffectCommandAdapter({
      command: process.execPath,
      args: ["-e", "console.log('not-json')"],
      fixturePath,
    })).rejects.toThrow(/exactly one valid JSON/i);
    vi.useFakeTimers();
    const pending = runEffectCommandAdapter({
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 10000)"],
      fixturePath,
      timeoutMs: 100,
    });
    const rejected = expect(pending).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    vi.useRealTimers();
  });
});
