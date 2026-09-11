import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertActiveStatus, assertDisabledStatus, createPackedCliSession } from "./packed-first-run-cli-harness.mjs";

function terminalFixture(source) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "packed-cli-harness-test-"));
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const evidencePath = path.join(projectRoot, "terminal.json");
  const session = createPackedCliSession({
    command: quote(process.execPath) + " -e " + quote(source), projectRoot,
    env: { ...process.env, TERM: "xterm-256color" }, evidencePath,
  });
  return { session, projectRoot, evidencePath };
}

describe("packed first-run actual terminal harness", () => {
  it("does not mistake a replaced editor for the current visible screen", async () => {
    const { session, projectRoot } = terminalFixture(`
      process.stdin.setRawMode(true);
      process.stdout.write('EDIT ACCESS\\r\\n\\x1b[2J\\x1b[HREVIEW COLUMNS');
      process.stdin.on('data', data => {
        if (String(data) === 'q') process.exit(0);
        process.stdout.write('\\x1b[2J\\x1b[HEDIT ACCESS');
      });
    `);
    try {
      await session.waitFor(/EDIT ACCESS/, "historical editor output");
      await session.waitForScreen(/REVIEW COLUMNS/, "current column editor");
      await expect(session.waitForScreen(/EDIT ACCESS/, "stale editor must not satisfy", 100)).rejects.toThrow();
      session.send("r");
      await session.waitForScreen(/EDIT ACCESS/, "current parent editor");
      session.send("q");
      expect(await session.waitForExit()).toEqual({ code: 0, signal: null });
    } finally { await session.close(); fs.rmSync(projectRoot, { recursive: true }); }
  });
  it("closes its retained PTY child after a failed navigation without global PID discovery", async () => {
    const { session, projectRoot, evidencePath } = terminalFixture(`
      process.stdin.setRawMode(true);
      process.stdout.write('OWNED WAITING');
      process.stdin.resume();
    `);
    try {
      await session.waitForScreen(/OWNED WAITING/, "owned child waiting");
      await session.close();
      const record = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
      expect(record.cancellation.cwd_verified).toBe(projectRoot);
      expect(record.finished_at).toBeTruthy();
      expect(session.child.exitCode !== null || session.child.signalCode !== null).toBe(true);
    } finally { await session.close(); fs.rmSync(projectRoot, { recursive: true }); }
  });
});

describe("packed first-run public authority assertions", () => {
  it("loads in plain Node ESM, not just the Vitest module transformer", () => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", "import " + JSON.stringify(new URL("./packed-first-run-cli-harness.mjs", import.meta.url).href)], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
  const disabled = { ok: true, deployment_state: "disabled", active_boundaries: [], editing: { state: "disabled_draft" } };
  const active = { ok: true, deployment_state: "active", editing: { state: "active" }, active_boundaries: [{ tables: ["public.invoices"], digest: "exact" }], active_digest: "exact", candidate_digest: "exact" };
  it("accepts metadata-only disabled authoring without requiring concrete identity", () => {
    expect(() => assertDisabledStatus(disabled)).not.toThrow();
  });
  it("refuses an unexpected activation during identity-free drafting", () => {
    expect(() => assertDisabledStatus(active)).toThrow();
  });
  it("requires persisted exact active authority, not just a drafted table", () => {
    expect(() => assertActiveStatus(active, "public.invoices")).not.toThrow();
    expect(() => assertActiveStatus(disabled, "public.invoices")).toThrow();
    expect(() => assertActiveStatus({ ...active, active_digest: "stale" }, "public.invoices")).toThrow();
    expect(() => assertActiveStatus(active, "public.orders")).toThrow();
    expect(() => assertActiveStatus({ ...active, active_boundaries: [...active.active_boundaries, ...active.active_boundaries] }, "public.invoices")).toThrow();
  });
});
