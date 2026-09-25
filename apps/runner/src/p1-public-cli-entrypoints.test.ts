import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const privateHome = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-p1-cli-"));

afterAll(() => fs.rmSync(privateHome, { recursive: true, force: true }));

function publicCli(args: string[]) {
  return spawnSync(path.join(repositoryRoot, "bin/synapsor-runner"), args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      PATH: process.env.PATH,
      HOME: privateHome,
      XDG_CONFIG_HOME: privateHome,
      NO_COLOR: "1",
    },
  });
}

describe("P1 public commands through the executable CLI entry point", () => {
  it("routes policy approver to its interactive administration boundary", () => {
    const result = publicCli(["policy", "approver"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("POLICY_APPROVER_INTERACTIVE_ADMIN_REQUIRED");
  });

  it("routes delayed cancellation and refuses a non-exact local request", () => {
    const result = publicCli(["worker", "cancel", "latest", "--local-installation-operator",
      "--reason", "A reviewed local reason"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LOCAL_DELAYED_CANCEL_EXACT_REQUEST_REQUIRED");
  });

  it("routes delayed-mode Action review to its own argument boundary", () => {
    const result = publicCli(["action", "review", "--unsupported"]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown option for action review: --unsupported");
  });
});
