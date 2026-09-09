import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/use-your-db.sh", import.meta.url));
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("own-database helper routing", () => {
  it("uses current onboarding without changing the caller's project or exposing the URL", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-own-db-routing-"));
    roots.push(root);
    const binary = path.join(root, "runner");
    await fs.writeFile(binary, '#!/usr/bin/env bash\nprintf "%s\\n" "$PWD" "$@"\n', { mode: 0o700 });
    const output = execFileSync("bash", [script, "--env", "TEST_READ_URL", "--engine", "postgres"], {
      cwd: root, encoding: "utf8", env: { ...process.env, SYNAPSOR_BIN: binary, TEST_READ_URL: "private-test-value" },
    });
    expect(output.trim().split("\n")).toEqual([root, "onboard", "db", "--from-env", "TEST_READ_URL", "--engine", "postgres"]);
    expect(output).not.toContain("private-test-value");
    expect(await fs.readdir(root)).toEqual(["runner"]);
  });

  it.each(["--mode", "--config", "--store"])("refuses implicit legacy selection through %s", (flag) => {
    try {
      execFileSync("bash", [script, flag, "unused"], {
        encoding: "utf8", env: { ...process.env, DATABASE_URL: "private-test-value", SYNAPSOR_BIN: "/must-not-run" },
        stdio: "pipe",
      });
      expect.fail("Expected explicit compatibility selection to be required");
    } catch (error) {
      const failure = error as { status: number; stderr: string };
      expect(failure.status).toBe(2);
      expect(failure.stderr).toContain("require --legacy-capabilities");
      expect(failure.stderr).not.toContain("private-test-value");
    }
  });
});
