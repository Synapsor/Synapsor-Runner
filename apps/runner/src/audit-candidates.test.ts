import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateContract } from "@synapsor/spec";
import {
  AUDIT_CANDIDATE_MARKER,
  buildAuditCandidateBundle,
  generateAuditCandidateDirectory,
} from "./audit-candidates.js";
import { main } from "./cli.js";

const unsafeManifest = {
  tools: [
    {
      name: "execute_sql",
      description: "Run arbitrary SQL. password=manifest-secret",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", default: "DELETE FROM customers" },
          tenant_id: { type: "string", example: "other-tenant" },
          api_key: { type: "string", enum: ["sk-manifest-secret"] },
        },
        required: ["sql", "tenant_id", "api_key"],
      },
    },
    {
      name: "billing.update_invoice",
      description: "Update an invoice directly.",
      inputSchema: {
        type: "object",
        properties: {
          invoice_id: { type: "string", maxLength: 128 },
          amount_cents: { type: "integer", minimum: 0, maximum: 5000 },
          tenant_id: { type: "string" },
        },
        required: ["invoice_id", "amount_cents", "tenant_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: "billing.get_invoice",
      description: "Get one invoice.",
      inputSchema: {
        type: "object",
        properties: { invoice_id: { type: "string" } },
        required: ["invoice_id"],
      },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    },
  ],
};

describe("MCP audit candidate generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits deterministic canonical candidates that are blocked from activation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-audit-candidates-"));
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    try {
      const firstResult = await generateAuditCandidateDirectory({
        manifest: unsafeManifest,
        target: "https://user:pass@example.test/mcp?token=secret",
        outputDir: first,
      });
      const secondResult = await generateAuditCandidateDirectory({
        manifest: unsafeManifest,
        target: "https://user:pass@example.test/mcp?token=secret",
        outputDir: second,
      });
      expect(firstResult.source_digest).toBe(secondResult.source_digest);
      expect(firstResult.candidates).toEqual(secondResult.candidates);

      for (const file of firstResult.files) {
        expect(await fs.readFile(path.join(first, file), "utf8")).toBe(
          await fs.readFile(path.join(second, file), "utf8"),
        );
      }
      const contract = JSON.parse(await fs.readFile(path.join(first, "synapsor.candidate.contract.json"), "utf8"));
      expect(validateContract(contract).ok).toBe(true);
      expect(contract["x-runner-candidate-only"]).toBe(true);
      expect(contract.capabilities.filter((capability: { kind: string }) => capability.kind === "proposal"))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            proposal: expect.objectContaining({
              writeback: { mode: "none" },
            }),
          }),
        ]));
      const config = JSON.parse(await fs.readFile(path.join(first, "synapsor.candidate.runner.json"), "utf8"));
      expect(config).toMatchObject({ mode: "shadow", sources: {} });
      const serialized = (await Promise.all(firstResult.files.map((file) =>
        fs.readFile(path.join(first, file), "utf8")))).join("\n");
      for (const secret of ["manifest-secret", "DELETE FROM customers", "other-tenant", "sk-manifest-secret", "user:pass", "token=secret"]) {
        expect(serialized).not.toContain(secret);
      }
      await expect(main([
        "propose",
        firstResult.candidates.find((candidate) => candidate.kind === "proposal")!.capability,
        "--sample",
        "--config",
        path.join(first, "synapsor.candidate.runner.json"),
        "--store",
        path.join(first, "candidate.db"),
      ])).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("never overwrites source or an unowned directory and requires explicit force", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-audit-overwrite-"));
    const source = path.join(root, "tools.json");
    const output = path.join(root, "candidates");
    const unowned = path.join(root, "hand-edited");
    const sourceText = `${JSON.stringify(unsafeManifest, null, 2)}\n`;
    try {
      await fs.writeFile(source, sourceText, "utf8");
      await generateAuditCandidateDirectory({ manifest: unsafeManifest, target: source, outputDir: output });
      await expect(generateAuditCandidateDirectory({
        manifest: unsafeManifest,
        target: source,
        outputDir: output,
      })).rejects.toThrow(/already exists/);
      await expect(generateAuditCandidateDirectory({
        manifest: unsafeManifest,
        target: source,
        outputDir: output,
        force: true,
      })).resolves.toMatchObject({ overwritten: true });
      expect(await fs.readFile(source, "utf8")).toBe(sourceText);

      await fs.mkdir(unowned);
      await fs.writeFile(path.join(unowned, "contract.json"), "hand edited", "utf8");
      await expect(generateAuditCandidateDirectory({
        manifest: unsafeManifest,
        target: source,
        outputDir: unowned,
        force: true,
      })).rejects.toThrow(/refusing to overwrite non-generated/);
      expect(await fs.readFile(path.join(unowned, "contract.json"), "utf8")).toBe("hand edited");
      expect(JSON.parse(await fs.readFile(path.join(output, AUDIT_CANDIDATE_MARKER), "utf8")))
        .toMatchObject({ activation: "blocked_unreviewed" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exposes candidate generation and stable SARIF through the CLI", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-audit-cli-"));
    const source = path.join(root, "tools.json");
    const output = path.join(root, "review");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await fs.writeFile(source, `${JSON.stringify(unsafeManifest)}\n`, "utf8");
      await expect(main(["audit", "generate", source, "--output", output, "--json"])).resolves.toBe(0);
      const result = JSON.parse(writes.at(-1)!) as { candidates: unknown[]; output_dir: string };
      expect(result.candidates).toHaveLength(3);
      expect(result.output_dir).toBe(output);

      writes.length = 0;
      await expect(main(["audit", "--example", "dangerous-db-mcp", "--format", "sarif"])).resolves.toBe(0);
      const sarif = JSON.parse(writes.join(""));
      expect(sarif).toMatchObject({
        version: "2.1.0",
        runs: [expect.objectContaining({
          tool: { driver: expect.objectContaining({ name: "Synapsor Runner MCP audit" }) },
        })],
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("builds the same canonical bundle without filesystem state", () => {
    const first = buildAuditCandidateBundle(unsafeManifest, "example:unsafe");
    const second = buildAuditCandidateBundle(unsafeManifest, "example:unsafe");
    expect(first.sourceDigest).toBe(second.sourceDigest);
    expect(first.contract).toEqual(second.contract);
    expect(first.marker).toEqual(second.marker);
  });
});
