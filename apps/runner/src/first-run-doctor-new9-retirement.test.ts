import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const subprocess = vi.hoisted(() => ({ error: undefined as Error | undefined, stderr: "", spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawnSync: subprocess.spawn }));
import { doctor } from "./first-run-doctor.js";

afterEach(() => { vi.restoreAllMocks(); });
describe("B64 NEW9 I03573 actual first-run Docker check", () => {
  it.each([
    { stderr: "permission denied on docker socket", code: undefined, exact: false },
    { stderr: "opaque 漢字", code: "EACCES", exact: true },
  ])("does not infer socket/group or daemon cause from stderr ($code)", async ({ stderr, code, exact }) => {
    subprocess.stderr = stderr;
    subprocess.error = code ? Object.assign(new Error("opaque executable failure"), { code }) : undefined;
    subprocess.spawn.mockImplementation((command: string, args: readonly string[] = []) => {
      if (command === "docker" && args[0] === "info") return { status: 1, stderr: subprocess.stderr, stdout: "", error: subprocess.error };
      if (command === "df") return { status: 0, stderr: "", stdout: "Filesystem 1024-blocks Used Available Capacity Mounted\nfixture 100000000 1000 99999000 1% /\n" };
      return { status: 0, stdout: "", stderr: "" };
    });
    const directory = await mkdtemp(join(tmpdir(), "new9-first-doctor-"));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output.push(String(chunk)); return true; });
    await doctor(["--first-run", "--json", "--config", join(directory, "missing.json"), "--store", ":memory:",
      "--client-config", join(directory, "missing-client.json")]);
    const report = JSON.parse(output.join(""));
    const check = report.checks.find((entry: { name: string }) => entry.name === "docker-daemon");
    expect(check.status).toBe("fail");
    expect(check.checked).not.toMatch(/daemon is not reachable/iu);
    expect(check.fix).not.toMatch(/docker socket|docker group|user cannot access/iu);
    expect(check.fix).toContain(exact ? "executable" : "Inspect");
  });
});
