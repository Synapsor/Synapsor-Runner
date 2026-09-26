import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const executable = path.join(root, "bin/synapsor-runner");
const fixtureChild = path.join(root, "apps/runner/src/test-fixtures/cli-output-child.ts");
const childEnv = { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" };
const ownedDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(ownedDirectories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-cli-output-"));
  ownedDirectories.push(directory);
  return directory;
}

function childStatus(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function slowCapture(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const consumer = new Writable({
    highWaterMark: 1024,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      // Delay only the test consumer, causing real child-pipe backpressure.
      setTimeout(callback, 4);
    },
  });
  readable.pipe(consumer);
  return new Promise((resolve, reject) => {
    consumer.once("error", reject);
    consumer.once("finish", () => resolve(Buffer.concat(chunks)));
  });
}

async function captureCli(args: string[], cwd: string, mode: "file" | "slow-pipe") {
  const stdoutPath = path.join(cwd, "stdout.json");
  const stderrPath = path.join(cwd, "stderr.txt");
  const stdoutFd = mode === "file" ? fs.openSync(stdoutPath, "w") : undefined;
  const stderrFd = mode === "file" ? fs.openSync(stderrPath, "w") : undefined;
  try {
    const child = spawn(executable, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", stdoutFd ?? "pipe", stderrFd ?? "pipe"],
    });
    const status = childStatus(child);
    const stdout = child.stdout ? slowCapture(child.stdout) : undefined;
    const stderr = child.stderr ? slowCapture(child.stderr) : undefined;
    const result = await status;
    return {
      ...result,
      stdout: stdout ? await stdout : await fsp.readFile(stdoutPath),
      stderr: stderr ? await stderr : await fsp.readFile(stderrPath),
    };
  } finally {
    if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
  }
}

async function recipeFixture(directory: string, records: number) {
  const recipe = {
    id: "synthetic.cli_output",
    title: "DERIVED secret-free output fixture",
    summary: "Local finite output regression",
    expected_table_type: "table",
    required_columns: ["id"],
    recommended_primary_key: "id",
    recommended_tenant_key: "tenant_id",
    recommended_conflict_column: "version",
    visible_columns: ["id"],
    allowed_write_columns: [],
    semantic_tools: ["app.describe_data"],
    notes: Array.from({ length: records }, (_, index) => `${index}: ${"café 漢字 🧪 ".repeat(96)}record-end`),
    spec: { namespace: "synthetic", table: "items", primary_key: "id" },
  };
  recipe.notes.push("TAIL-🧪-終わり");
  const fixturePath = path.join(directory, "fixture.recipe.json");
  await fsp.writeFile(fixturePath, JSON.stringify(recipe));
  return { fixturePath, recipe, expected: Buffer.from(`${JSON.stringify(recipe, null, 2)}\n`) };
}

describe("finite CLI output completion", () => {
  for (const mode of ["file", "slow-pipe"] as const) {
    for (const [size, records] of [["below 64 KiB", 4], ["well above 64 KiB", 768]] as const) {
      it(`delivers exact Unicode JSON ${size} to ${mode}`, async () => {
        const directory = await temporaryDirectory();
        const { fixturePath, recipe, expected } = await recipeFixture(directory, records);
        expect(expected.length < 65_536).toBe(records === 4);
        const output = await captureCli(["recipes", "show", fixturePath, "--json"], directory, mode);
        expect(output.code).toBe(0);
        expect(output.signal).toBeNull();
        expect(output.stderr.length).toBe(0);
        expect(output.stdout.equals(expected)).toBe(true);
        const parsed = JSON.parse(output.stdout.toString("utf8"));
        expect(parsed.notes).toEqual(recipe.notes);
        expect(parsed.notes.at(-1)).toBe("TAIL-🧪-終わり");
      });
    }
  }

  it.runIf(process.platform !== "win32")("flushes large structured errors and stderr while preserving their exit", async () => {
    const directory = await temporaryDirectory();
    const missingRecipe = `${"missing_".repeat(11_000)}TAIL_UNICODE_漢字_🧪`;
    const output = await captureCli(["recipes", "show", missingRecipe, "--json"], directory, "slow-pipe");
    expect(output.code).toBe(1);
    const parsed = JSON.parse(output.stdout.toString("utf8"));
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toContain(missingRecipe);
    expect(output.stdout.length).toBeGreaterThan(65_536);
    expect(output.stderr.toString("utf8")).toContain(missingRecipe);
    expect(output.stderr.toString("utf8")).toContain(`${missingRecipe}.json'\n`);
  });

  it("preserves command-rejection exit 2 and stdout/stderr separation", async () => {
    const directory = await temporaryDirectory();
    const output = await captureCli(["definitely-not-a-command"], directory, "slow-pipe");
    expect(output.code).toBe(2);
    expect(output.stdout.length).toBe(0);
    expect(output.stderr.toString("utf8")).toContain("Unknown command:");
  });

  it("reports premature stdout closure as a failed write without hanging", async () => {
    const directory = await temporaryDirectory();
    const { fixturePath } = await recipeFixture(directory, 768);
    const child = spawn(executable, ["recipes", "show", fixturePath, "--json"], {
      cwd: directory, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    const status = childStatus(child);
    const stderr = slowCapture(child.stderr!);
    child.stdout!.once("data", () => child.stdout!.destroy());
    expect((await status).code).toBe(1);
    expect((await stderr).toString("utf8")).toContain("CLI output write failed on stdout (EPIPE)");
  });

  it("keeps a failed stderr exit nonzero when its consumer closes", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", fixtureChild, "stderr"], {
      cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    const status = childStatus(child);
    const stdout = slowCapture(child.stdout!);
    child.stderr!.once("data", () => child.stderr!.destroy());
    expect((await status).code).toBe(7);
    expect((await stdout).length).toBe(0);
  });

  it.runIf(process.platform === "linux")("reports a real ENOSPC stdout write failure", async () => {
    const directory = await temporaryDirectory();
    const { fixturePath } = await recipeFixture(directory, 768);
    const fd = fs.openSync("/dev/full", "w");
    try {
      const child = spawn(executable, ["recipes", "show", fixturePath, "--json"], {
        cwd: directory, env: childEnv, stdio: ["ignore", fd, "pipe"],
      });
      const status = childStatus(child);
      const stderr = slowCapture(child.stderr!);
      expect((await status).code).toBe(1);
      expect((await stderr).toString("utf8")).toContain("CLI output write failed on stdout (ENOSPC)");
    } finally {
      fs.closeSync(fd);
    }
  });

  it.runIf(process.platform === "linux")("lets pending command work finish after an early write error", async () => {
    const directory = await temporaryDirectory();
    const marker = path.join(directory, "command-completed.txt");
    const fd = fs.openSync("/dev/full", "w");
    try {
      const child = spawn(process.execPath, ["--import", "tsx", fixtureChild, "pending-write-error", marker], {
        cwd: root, env: childEnv, stdio: ["ignore", fd, "pipe"],
      });
      const status = childStatus(child);
      const stderr = slowCapture(child.stderr!);
      expect((await status).code).toBe(1);
      expect(await fsp.readFile(marker, "utf8")).toBe("pending command completed\n");
      expect((await stderr).toString("utf8")).toContain("CLI output write failed on stdout (ENOSPC)");
    } finally {
      fs.closeSync(fd);
    }
  });

  it("retains the actual long-lived MCP protocol until its caller cancels it", async () => {
    const directory = await temporaryDirectory();
    const configPath = path.join(directory, "compatibility.runner.json");
    // Explicit legacy compatibility fixture; catalog calls never connect to its
    // synthetic unreachable database endpoint or claim a successful source effect.
    await fsp.writeFile(configPath, JSON.stringify({
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: path.join(directory, "ledger.db") },
      sources: {
        synthetic_postgres: { engine: "postgres", read_url_env: "SYNAPSOR_OUTPUT_FIXTURE_READ_URL", read_only: true },
      },
      trusted_context: {
        provider: "environment",
        values: { tenant_id_env: "SYNAPSOR_OUTPUT_FIXTURE_TENANT", principal_env: "SYNAPSOR_OUTPUT_FIXTURE_PRINCIPAL" },
      },
      capabilities: [{
        name: "synthetic.inspect_item", kind: "read", source: "synthetic_postgres",
        target: { schema: "public", table: "items", primary_key: "id", tenant_key: "tenant_id" },
        args: { item_id: { type: "string", required: true, max_length: 128 } },
        lookup: { id_from_arg: "item_id" }, visible_columns: ["id"], evidence: "required", max_rows: 1,
      }],
    }));
    const child = spawn(executable, ["mcp", "serve", "--config", configPath], {
      cwd: directory,
      env: { ...childEnv,
        SYNAPSOR_OUTPUT_FIXTURE_READ_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
        SYNAPSOR_OUTPUT_FIXTURE_TENANT: "synthetic-tenant",
        SYNAPSOR_OUTPUT_FIXTURE_PRINCIPAL: "synthetic-principal",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const status = childStatus(child);
    const stderr = slowCapture(child.stderr!);
    let pending = "";
    const replies = new Map<number, (reply: { result?: { tools?: { name: string }[] }; error?: unknown }) => void>();
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      pending += chunk;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        const reply = JSON.parse(line);
        replies.get(reply.id)?.(reply);
      }
    });
    const request = (id: number, method: string, params?: unknown) => {
      const reply = new Promise<{ result?: { tools?: { name: string }[] }; error?: unknown }>((resolve) => replies.set(id, resolve));
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
      return Promise.race([reply, status.then(async (stopped) => {
        throw new Error(`MCP fixture exited (${stopped.code ?? stopped.signal}): ${(await stderr).toString("utf8")}`);
      })]);
    };
    try {
      expect((await request(1, "initialize", {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "DERIVED-output-test", version: "1" },
      })).error).toBeUndefined();
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      const reply = await request(2, "tools/list");
      expect(reply.error).toBeUndefined();
      expect(reply.result?.tools?.map((tool) => tool.name)).toEqual([
        "synthetic.inspect_item",
      ]);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
    } finally {
      child.kill("SIGTERM");
      const stopped = await status;
      // serveStdio already handles SIGTERM by closing its transport and returning.
      expect(stopped).toEqual({ code: 0, signal: null });
      expect((await stderr).toString("utf8")).not.toContain("CLI output write failed");
    }
  });

  for (const stream of ["stdout", "stderr"]) {
    it(`flushes ${stream} and terminates despite a stray handle`, async () => {
      const child = spawn(process.execPath, ["--import", "tsx", fixtureChild, stream], {
        cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
      });
      const status = childStatus(child);
      const stdout = slowCapture(child.stdout!);
      const stderr = slowCapture(child.stderr!);
      expect((await status).code).toBe(stream === "stderr" ? 7 : 0);
      const expected = Buffer.from(`${"DERIVED café 漢字 🧪\n".repeat(32_768)}TAIL-終わり\n`);
      expect((stream === "stdout" ? await stdout : await stderr).equals(expected)).toBe(true);
      expect((stream === "stdout" ? await stderr : await stdout).length).toBe(0);
    });
  }

  it("preserves intentional NDJSON frames exactly through a slow pipe", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", fixtureChild, "ndjson"], {
      cwd: root, env: childEnv, stdio: ["ignore", "pipe", "pipe"],
    });
    const status = childStatus(child);
    const stdout = slowCapture(child.stdout!);
    const stderr = slowCapture(child.stderr!);
    expect((await status).code).toBe(0);
    const bytes = await stdout;
    const expected = Buffer.from(Array.from({ length: 768 }, (_, index) =>
      `${JSON.stringify({ index, value: "café 漢字 🧪 ".repeat(96) })}\n`).join("")
      + `${JSON.stringify({ tail: "TAIL-終わり" })}\n`);
    expect(bytes.equals(expected)).toBe(true);
    const records = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(records.length).toBe(769);
    expect(records.at(-1)).toEqual({ tail: "TAIL-終わり" });
    expect((await stderr).length).toBe(0);
  });
});
