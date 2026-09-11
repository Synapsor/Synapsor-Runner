import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import xterm from "@xterm/headless";
const { Terminal } = xterm;

export function assertDisabledStatus(status) {
  assert.equal(status.ok, true);
  assert.equal(status.deployment_state, "disabled");
  assert.deepEqual(status.active_boundaries, []);
  assert.equal(status.editing.state, "disabled_draft");
}

export function assertActiveStatus(status, resource) {
  assert.equal(status.ok, true);
  assert.equal(status.deployment_state, "active");
  assert.equal(status.editing.state, "active");
  assert.equal(status.active_boundaries.length, 1);
  assert.deepEqual(status.active_boundaries[0].tables, [resource]);
  assert.equal(status.active_digest, status.candidate_digest);
  assert.equal(status.active_boundaries[0].digest, status.candidate_digest);
}

export function createPackedCliSession({ command, projectRoot, env, evidencePath }) {
  const terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: projectRoot, env, stdio: ["pipe", "pipe", "pipe"],
  });
  const record = { pid: child.pid, project_root: projectRoot, started_at: new Date().toISOString(), checkpoints: [] };
  let output = "", paint = Promise.resolve(), offset = 0;
  const save = () => fs.writeFileSync(evidencePath, JSON.stringify({ ...record, transcript: stripTerminal(output) }, null, 2), { mode: 0o600 });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      Object.assign(record, { code, signal, finished_at: new Date().toISOString() });
      save(); resolve({ code, signal });
    });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    output += String(chunk);
    paint = paint.then(() => new Promise((resolve) => terminal.write(chunk, resolve)));
  });
  save();
  const screen = () => Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(terminal.buffer.active.baseY + row)?.translateToString(true) ?? "").join("\n");
  const transcript = () => stripTerminal(output);
  const wait = async (predicate, label, timeoutMs = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await paint;
      if (predicate()) { record.checkpoints.push({ label, at: new Date().toISOString(), screen: screen() }); save(); return; }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    save(); throw new Error(`Packed CLI did not reach ${label}.\n${screen()}\nRecent transcript:\n${stripTerminal(output.slice(offset)).slice(-6000)}`);
  };
  const waitFor = (pattern, label, timeoutMs) => wait(() => pattern.test(stripTerminal(output.slice(offset))), label, timeoutMs);
  const waitForScreen = (pattern, label, timeoutMs) => wait(() => pattern.test(screen()), label, timeoutMs);
  const send = (keys) => { offset = output.length; child.stdin.write(keys); };
  const choose = async (label) => {
    await wait(() => screen().includes(label), `visible choice ${label}`);
    for (let moves = 0; moves < 16; moves += 1) {
      if (screen().split("\n").some((line) => /^\s*>/.test(line) && line.includes(label))) { send("\r"); return; }
      const before = screen(); send("\u001b[B");
      await wait(() => screen() !== before, `highlight next choice toward ${label}`, 3000);
    }
    throw new Error(`Could not select visible choice ${label}`);
  };
  const waitForExit = async (timeoutMs = 15000) => {
    let timer;
    try { return await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Owned CLI session ${child.pid} did not exit; ${evidencePath}`)), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  const close = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      // Signal only the retained script child, never a PID rediscovered by executable name.
      assert.equal(fs.readlinkSync(`/proc/${child.pid}/cwd`), projectRoot, "Refusing cancellation: owned CLI cwd changed");
      record.cancellation = { method: "retained_child_SIGTERM", cwd_verified: projectRoot, at: new Date().toISOString() };
      save();
      child.kill("SIGTERM");
      await waitForExit(10000);
    } else await exited;
    await paint; terminal.dispose(); save();
  };
  return { child, transcript, screen, waitFor, waitForScreen, send, choose, waitForExit, close };
}

export function stripTerminal(value) {
  return value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}
