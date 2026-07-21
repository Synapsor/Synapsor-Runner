import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { lspCompletionsForSource, lspDiagnosticsForDocument, lspDiagnosticsForSource, lspFormatEdits, lspHoverForSource } from "./language-server.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const children = new Set<ReturnType<typeof spawn>>();

afterEach(() => {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
});

describe("Synapsor contract language server", () => {
  it("offers only aggregate-safe clauses after AGGREGATE READ", () => {
    const source = `CREATE CAPABILITY billing.total\n  AGGREGATE READ SUM balance_cents\n`;
    const labels = lspCompletionsForSource(source, 2).map((item) => item.label);
    expect(labels).toContain("MIN GROUP SIZE");
    expect(labels).not.toContain("PATCH");
    expect(labels).not.toContain("AUTO APPROVE WHEN");
    expect(lspHoverForSource("  AGGREGATE READ SUM balance_cents", 0, 8)).toMatchObject({ contents: { kind: "markdown" } });
  });
  it("uses the DSL validator for location-aware diagnostics", () => {
    const source = sourceWithSelection("risk_level = 'high' AND");
    expect(lspDiagnosticsForSource(source)).toContainEqual(expect.objectContaining({
      code: "SELECT_WHERE_SYNTAX",
      severity: 1,
      source: "synapsor",
    }));
    expect(lspDiagnosticsForSource(sourceWithSelection("description = 'salt AND pepper'"))).toEqual([]);
  });

  it("provides block-aware completion, safety hover, and parser-backed formatting", () => {
    const source = sourceWithSelection("risk_level = 'high'");
    const line = source.split(/\r?\n/).findIndex((value) => value.includes("SELECT WHERE"));
    expect(lspCompletionsForSource(source, line).map((item) => item.label)).toContain("MAX ROWS");
    expect(JSON.stringify(lspHoverForSource(source, line, 3))).toContain("model-controlled predicates are rejected");
    expect(lspFormatEdits(source.replace("  MAX ROWS", "MAX ROWS"))[0]?.newText).toContain("MAX ROWS 25");
  });

  it("diagnoses restricted TypeScript Safe Actions without compiling or activating them", async () => {
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-safe-action-lsp-"));
    try {
      const sourcePath = path.join(project, "synapsor", "actions", "refund.ts");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.copyFile(path.join(root, "packages/spec/examples/guarded-writeback.contract.json"), path.join(project, "synapsor.contract.json"));
      await fs.writeFile(path.join(project, "synapsor.runner.json"), JSON.stringify({
        version: 1,
        mode: "review",
        contracts: ["./synapsor.contract.json"],
        sources: { local_postgres: { engine: "postgres", read_url_env: "READ_URL", write_url_env: "WRITE_URL" } },
      }));
      const valid = safeActionSource();
      const uri = pathToFileURL(sourcePath).href;
      expect(await lspDiagnosticsForDocument(uri, valid)).toEqual([]);
      const trustedArg = valid.replace(
        'invoice_id: { type: "string", required: true, max_length: 128 },',
        'invoice_id: { type: "string", required: true, max_length: 128 }, tenant_id: { type: "string", required: true, max_length: 64 },',
      );
      expect(await lspDiagnosticsForDocument(uri, trustedArg)).toContainEqual(expect.objectContaining({
        code: "SAFE_ACTION_TRUSTED_ARG_FORBIDDEN",
        severity: 1,
        source: "synapsor-safe-action",
      }));
      expect(await lspDiagnosticsForDocument(uri, valid.replace("patch: {", "patch: buildPatch({"))).toContainEqual(expect.objectContaining({
        code: "SAFE_ACTION_TYPESCRIPT_PARSE",
        source: "synapsor-safe-action",
      }));
      await expect(fs.access(path.join(project, ".synapsor"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });

  it("serves initialize, diagnostics, completion, hover, formatting, shutdown, and exit over stdio", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "apps/runner/src/cli.ts", "language-server", "--stdio"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    children.add(child);
    const client = protocolClient(child);
    client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: null, capabilities: {} } });
    const initialized = await client.waitFor((message) => message.id === 1);
    expect(initialized.result.serverInfo.name).toBe("Synapsor Contract Language Server");
    client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const uri = "file:///tmp/contract.synapsor.sql";
    client.send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "synapsor", version: 1, text: sourceWithSelection("risk_level = 'high' AND") } } });
    const diagnostics = await client.waitFor((message) => message.method === "textDocument/publishDiagnostics");
    expect(diagnostics.params.diagnostics).toContainEqual(expect.objectContaining({ code: "SELECT_WHERE_SYNTAX" }));
    client.send({ jsonrpc: "2.0", id: 2, method: "textDocument/completion", params: { textDocument: { uri }, position: { line: 21, character: 2 } } });
    expect((await client.waitFor((message) => message.id === 2)).result.map((item: { label: string }) => item.label)).toContain("MAX ROWS");
    client.send({ jsonrpc: "2.0", id: 3, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 21, character: 3 } } });
    expect(JSON.stringify((await client.waitFor((message) => message.id === 3)).result)).toContain("SELECT WHERE");
    client.send({ jsonrpc: "2.0", id: 4, method: "textDocument/formatting", params: { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } } });
    expect(Array.isArray((await client.waitFor((message) => message.id === 4)).result)).toBe(true);
    client.send({ jsonrpc: "2.0", id: 5, method: "shutdown", params: null });
    await client.waitFor((message) => message.id === 5);
    client.send({ jsonrpc: "2.0", method: "exit", params: null });
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    children.delete(child);
    expect(exitCode).toBe(0);
    expect(client.stderr()).toBe("");
  }, 15_000);
});

function protocolClient(child: ReturnType<typeof spawn>): {
  send(message: Record<string, unknown>): void;
  waitFor(predicate: (message: any) => boolean): Promise<any>;
  stderr(): string;
} {
  let buffer = Buffer.alloc(0);
  let stderr = "";
  const messages: any[] = [];
  const waiters: Array<{ predicate: (message: any) => boolean; resolve: (message: any) => void }> = [];
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout?.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) break;
      const header = buffer.subarray(0, boundary).toString("ascii");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match?.[1]) throw new Error(`missing Content-Length: ${header}`);
      const length = Number(match[1]);
      const bodyStart = boundary + 4;
      if (buffer.length < bodyStart + length) break;
      const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
      buffer = buffer.subarray(bodyStart + length);
      const waiter = waiters.find((candidate) => candidate.predicate(message));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      } else {
        messages.push(message);
      }
    }
  });
  return {
    send(message) {
      const body = Buffer.from(JSON.stringify(message));
      child.stdin?.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin?.write(body);
    },
    waitFor(predicate) {
      const existing = messages.find(predicate);
      if (existing) {
        messages.splice(messages.indexOf(existing), 1);
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for LSP message; stderr=${stderr}`)), 7_500);
        waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message); } });
      });
    },
    stderr: () => stderr,
  };
}

function sourceWithSelection(selection: string): string {
  return `CREATE AGENT CONTEXT health_operator
  BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED
  BIND principal FROM ENVIRONMENT SYNAPSOR_PRINCIPAL REQUIRED
  TENANT BINDING tenant_id
  PRINCIPAL BINDING principal
END

CREATE CAPABILITY health.flag_cases
  DESCRIPTION 'Flag reviewed high-risk cases.'
  RETURNS HINT 'Returns a proposal only.'
  USING CONTEXT health_operator
  SOURCE local_postgres
  ON public.cases
  PRIMARY KEY id
  TENANT KEY tenant_id
  CONFLICT GUARD version
  ARG reason STRING REQUIRED MAX LENGTH 128
  ALLOW READ id, tenant_id, risk_level, description, risk_score, needs_review, version
  KEEP OUT ssn
  REQUIRE EVIDENCE
  PROPOSE ACTION flag UPDATE SET
  SELECT WHERE ${selection}
  MAX ROWS 25
  MAX TOTAL risk_score BEFORE 1000
  ALLOW WRITE needs_review
  PATCH needs_review = TRUE
  ADVANCE VERSION version USING INTEGER INCREMENT
  APPROVAL ROLE health_reviewer
  WRITEBACK DIRECT SQL
END
`;
}

function safeActionSource(): string {
  return `import { defineCapability } from "@synapsor/runner/authoring";
export default defineCapability({
  name: "billing.propose_refund", description: "Propose one bounded refund.", kind: "proposal",
  context: "local_operator", source: "local_postgres", subject: { resource: "billing_invoices" },
  args: { invoice_id: { type: "string", required: true, max_length: 128 }, reason: { type: "string", required: true, max_length: 500 } },
  lookup: { id_from_arg: "invoice_id" },
  visible_fields: ["id", "tenant_id", "late_fee_cents", "waiver_reason", "updated_at"],
  kept_out_fields: ["internal_risk_score", "card_token"], evidence: { required: true, query_audit: true }, max_rows: 1,
  proposal: { action: "refund", operation: { kind: "update" }, allowed_fields: ["late_fee_cents", "waiver_reason"],
    patch: { late_fee_cents: { fixed: 0 }, waiver_reason: { from_arg: "reason" } }, conflict_guard: { column: "updated_at" },
    approval: { mode: "human", required_role: "billing_reviewer" }, writeback: { mode: "direct_sql" } },
});
`;
}
