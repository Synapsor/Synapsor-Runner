import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPausedExecutionSetup, executionSetupProblem, readPausedExecutionSetup,
  savePausedExecutionSetup, SemanticWriterPostureError } from "./semantic-execution-setup.js";

const roots: string[] = [];
const digest = `sha256:${"a".repeat(64)}`;
const otherDigest = `sha256:${"b".repeat(64)}`;
async function root() {
  const result = await fs.mkdtemp(path.join(os.tmpdir(), "runner-execution-diagnostic-"));
  roots.push(result);
  return result;
}
const problem = { code: "CHECK_FAILED", summary: "The writer needs repair.", details: ["Missing a private row lock."] };
afterEach(async () => { for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });

describe("non-authoritative execution setup diagnostics", () => {
  it("retains the exact revision/outcome on pause and never clears another outcome's blocker", async () => {
    const dir = await root();
    await savePausedExecutionSetup(dir, { action_digest: digest, outcome: "telecom.plan_change", problem });
    expect((await fs.stat(path.join(dir, ".synapsor/execution-setup-paused.json"))).mode & 0o777).toBe(0o600);
    expect(await readPausedExecutionSetup(dir, otherDigest)).toBeUndefined();
    await clearPausedExecutionSetup(dir, digest, "telecom.preferences");
    await clearPausedExecutionSetup(dir, otherDigest, "telecom.plan_change");
    expect(await readPausedExecutionSetup(dir, digest)).toMatchObject({ action_digest: digest, outcome: "telecom.plan_change", problem });
    await clearPausedExecutionSetup(dir, digest, "telecom.plan_change");
    expect(await readPausedExecutionSetup(dir, digest)).toBeUndefined();
  });

  it("redacts secrets and terminal controls both on save and when displaying a modified local diagnostic", async () => {
    const dir = await root();
    const unsafe = { code: "CHECK_FAILED", summary: "password=private-pass\u001b[2J", details: ["api_key=private-key\rhidden"] };
    await savePausedExecutionSetup(dir, { action_digest: digest, outcome: "plan", problem: unsafe });
    const filename = path.join(dir, ".synapsor/execution-setup-paused.json");
    expect(await fs.readFile(filename, "utf8")).not.toMatch(/private-pass|private-key|\\u001b/);
    const record = JSON.parse(await fs.readFile(filename, "utf8"));
    record.problem = unsafe;
    await fs.writeFile(filename, JSON.stringify(record));
    expect(JSON.stringify(await readPausedExecutionSetup(dir, digest))).not.toMatch(/private-pass|private-key|\\u001b|\\r/);
  });

  it("bounds diagnostic reads and rejects malformed records without pretending setup succeeded", async () => {
    const dir = await root();
    await savePausedExecutionSetup(dir, { action_digest: digest, outcome: "plan", problem });
    const filename = path.join(dir, ".synapsor/execution-setup-paused.json");
    await fs.writeFile(filename, " ".repeat(2_000_001));
    await expect(readPausedExecutionSetup(dir, digest)).rejects.toThrow("EXECUTION_SETUP_RECORD_TOO_LARGE");
    await fs.writeFile(filename, JSON.stringify({ version: 1, enabled: true }));
    await expect(readPausedExecutionSetup(dir, digest)).rejects.toThrow();
  });

  it("does not replace saved recovery with an oversized diagnostic", async () => {
    const dir = await root();
    await savePausedExecutionSetup(dir, { action_digest: digest, outcome: "plan", problem });
    await expect(savePausedExecutionSetup(dir, { action_digest: digest, outcome: "plan", problem: {
      ...problem, details: Array.from({ length: 110 }, () => "x".repeat(20000)),
    } })).rejects.toThrow("EXECUTION_SETUP_RECORD_TOO_LARGE");
    expect((await readPausedExecutionSetup(dir, digest))?.problem).toEqual(problem);
  });

  it("keeps missing and extra access separate from the exact reviewed administrator requirements", () => {
    const error = new SemanticWriterPostureError({ ok: false, fingerprint: `sha256:${"a".repeat(64)}`, expected_fingerprint: null,
      allowed_relations: ["telecom.offers", "telecom.subscriptions"], writable_relations: ["telecom.subscriptions"],
      reasons: ["writer_row_lock_privilege_missing", "writer_excess_column_privilege"],
      relation_issues: [
        { relation: "telecom.offers", issue: "missing", privileges: ["UPDATE (offer_id) for private row locking"] },
        { relation: "telecom.subscriptions", issue: "excess", privileges: ["UPDATE (updated_at)"] },
      ], required_relations: [
        { relation: "telecom.offers", privileges: ["select"], update_columns: [], lock_column: "offer_id", rls_required: true },
        { relation: "telecom.subscriptions", privileges: ["select", "update"], update_columns: ["plan", "version"], lock_column: "subscription_id", rls_required: true },
      ],
    }, "WRITE_URL");
    const diagnostic = executionSetupProblem(error);
    expect(diagnostic.summary).toContain("missing and extra access");
    expect(diagnostic.details).toContain("EXACT ADMINISTRATOR HANDOFF");
    expect(diagnostic.details.join("\n")).toContain("UPDATE (plan, version)");
    expect(diagnostic.details.join("\n")).not.toContain("UPDATE (subscription_id) is required");
    expect(diagnostic.details.join("\n")).toContain("UPDATE (offer_id) is required");
    expect(diagnostic.details.join("\n")).not.toContain(".?");
  });

  it("does not invent a connectivity cause for an unclassified failure", () => {
    expect(executionSetupProblem(new Error("Unexpected result"))).toMatchObject({ code: "EXECUTION_SETUP_CHECK_FAILED",
      summary: expect.stringContaining("could not finish") });
    expect(executionSetupProblem(new Error("SEMANTIC_ACTION_WRITER_URL_MISSING: absent"))).toMatchObject({
      summary: expect.stringContaining("not configured"),
    });
  });
});
