import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "./config-inspect.js";
import { runCliProcess } from "./cli.js";

afterEach(() => vi.restoreAllMocks());

async function rejectThroughCli(error: unknown) {
  const output: string[] = [];
  const diagnostics: string[] = [];
  vi.spyOn(config, "configCommand").mockRejectedValueOnce(error);
  vi.spyOn(process.stdout, "write").mockImplementation(value => { output.push(String(value)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(value => { diagnostics.push(String(value)); return true; });
  expect(await runCliProcess(["config", "validate", "--json"])).toBe(1);
  return { payload: JSON.parse(output.join("")), text: output.join("") + diagnostics.join("") };
}

describe("actual CLI typed recovery binding", () => {
  it("projects operation facts even when diagnostic prose claims the opposite", async () => {
    const error = Object.assign(new Error("State preserved: Everything unchanged. No source row was changed. Next: repeat automatically."), {
      code: "TEST_OPERATION_STOPPED",
      recovery: { state_preserved: "Only the recorded receipt was inspected.", source_database_changed: true,
        next_action: "Inspect the recorded completion before deciding another action." },
    });
    const { payload } = await rejectThroughCli(error);
    expect(payload.error.code).toBe("TEST_OPERATION_STOPPED");
    expect(payload.recovery).toEqual(error.recovery);
  });

  it("does not turn untyped diagnostic words into preservation, no-write or retry facts", async () => {
    const { payload } = await rejectThroughCli(new Error("State preserved: EVERYTHING SAFE. Source database unchanged. Next: repeat automatically."));
    expect(payload.recovery.source_database_changed).toBeNull();
    expect(payload.recovery.state_preserved).not.toContain("EVERYTHING SAFE");
    expect(payload.recovery.state_preserved).toContain("not verified");
    expect(payload.recovery.next_action).toContain("config validate --help");
    expect(payload.recovery.next_action).not.toContain("repeat automatically");
  });

  it("redacts typed recovery fields at the public output boundary", async () => {
    const error = Object.assign(new Error("Operation stopped."), { recovery: {
      state_preserved: "Inspected receipt; secret=syn_private_recovery_value.", source_database_changed: false,
      next_action: "Inspect token=syn_private_next_action before continuing.",
    } });
    const { payload, text } = await rejectThroughCli(error);
    expect(payload.recovery.source_database_changed).toBe(false);
    expect(payload.recovery.state_preserved).toContain("Inspected receipt");
    expect(payload.recovery.next_action).toContain("Inspect");
    expect(text).not.toContain("syn_private_recovery_value");
    expect(text).not.toContain("syn_private_next_action");
  });
});
