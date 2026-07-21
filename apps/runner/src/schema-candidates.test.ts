import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateContract } from "@synapsor/spec";
import {
  SCHEMA_CANDIDATE_MARKER,
  buildSchemaCandidateBundle,
  generateSchemaCandidateDirectory,
  parseSchemaCandidateSource,
  type SchemaCandidateFormat,
} from "./schema-candidates.js";
import { main } from "./cli.js";

function repoPath(...segments: string[]): string {
  for (const candidate of [process.cwd(), path.resolve(process.cwd(), "../..")]) {
    if (existsSync(path.join(candidate, "pnpm-workspace.yaml"))) {
      return path.join(candidate, ...segments);
    }
  }
  throw new Error("repository root not found");
}

const fixtures: Array<{ format: SchemaCandidateFormat; input: string }> = [
  { format: "prisma", input: repoPath("fixtures/generators/prisma/schema.prisma") },
  { format: "drizzle", input: repoPath("fixtures/generators/drizzle/schema.ts") },
  { format: "openapi", input: repoPath("fixtures/generators/openapi/openapi.yaml") },
];

describe("reviewed schema and API candidate generation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const fixture of fixtures) {
    it(`generates deterministic, authority-free ${fixture.format} candidates`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `synapsor-${fixture.format}-candidates-`));
      const first = path.join(root, "first");
      const second = path.join(root, "second");
      try {
        const firstResult = await generateSchemaCandidateDirectory({
          format: fixture.format,
          inputPath: fixture.input,
          outputDir: first,
        });
        const secondResult = await generateSchemaCandidateDirectory({
          format: fixture.format,
          inputPath: fixture.input,
          outputDir: second,
        });
        expect(firstResult).toMatchObject({
          format: fixture.format,
          activation: "blocked_unreviewed",
          objects: expect.any(Number),
          capabilities: expect.any(Number),
        });
        expect(firstResult.source_digest).toBe(secondResult.source_digest);
        for (const file of firstResult.files) {
          expect(await fs.readFile(path.join(first, file), "utf8")).toBe(
            await fs.readFile(path.join(second, file), "utf8"),
          );
        }

        const contract = JSON.parse(await fs.readFile(path.join(first, "synapsor.candidate.contract.json"), "utf8"));
        expect(validateContract(contract).ok).toBe(true);
        expect(contract).toMatchObject({
          "x-runner-candidate-only": true,
          "x-runner-review-status": "blocked_unreviewed",
          contexts: [expect.objectContaining({
            "x-runner-review-status": "blocked_unreviewed",
          })],
        });
        expect(contract.capabilities.every((capability: Record<string, unknown>) =>
          capability.source === "review_required_source"
          && (capability.subject as Record<string, unknown>).tenant_key === "review_required_tenant"))
          .toBe(true);
        expect(contract.capabilities
          .filter((capability: { kind: string }) => capability.kind === "proposal")
          .every((capability: { proposal: { writeback: { mode: string } } }) =>
            capability.proposal.writeback.mode === "none"))
          .toBe(true);

        const config = JSON.parse(await fs.readFile(path.join(first, "synapsor.candidate.runner.json"), "utf8"));
        expect(config).toMatchObject({ mode: "shadow", sources: {}, capabilities: [] });
        const review = JSON.parse(await fs.readFile(path.join(first, "generation-review.json"), "utf8"));
        expect(review).toMatchObject({
          schema_version: "synapsor.schema-candidates.v1",
          activation: "blocked_unreviewed",
          summary: {
            objects: firstResult.objects,
            capabilities: firstResult.capabilities,
          },
        });
        expect(JSON.parse(await fs.readFile(path.join(first, SCHEMA_CANDIDATE_MARKER), "utf8")))
          .toMatchObject({ owner: "@synapsor/runner", deterministic: true });
        const ajv = new Ajv2020({ strict: false, allErrors: true });
        const reviewSchema = JSON.parse(await fs.readFile(repoPath("schemas/schema-candidate-review.schema.json"), "utf8"));
        const markerSchema = JSON.parse(await fs.readFile(repoPath("schemas/schema-candidates.schema.json"), "utf8"));
        expect(ajv.compile(reviewSchema)(review)).toBe(true);
        expect(ajv.compile(markerSchema)(JSON.parse(
          await fs.readFile(path.join(first, SCHEMA_CANDIDATE_MARKER), "utf8"),
        ))).toBe(true);

        const serialized = (await Promise.all(firstResult.files.map((file) =>
          fs.readFile(path.join(first, file), "utf8")))).join("\n");
        for (const secret of [
          "fixture-secret-must-not-escape",
          "GENERATOR_FIXTURE_DATABASE_URL",
          "server-secret",
          "INV-SECRET-EXAMPLE",
          "card-secret-must-not-escape",
          "secret-business-example",
        ]) {
          expect(serialized).not.toContain(secret);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

  it("parses Drizzle as inert bounded AST and never reads unrelated secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-drizzle-inert-"));
    const marker = path.join(root, "must-not-exist");
    const secretFile = path.join(root, "unrelated-secret");
    const output = path.join(root, "output");
    const input = repoPath("fixtures/generators/drizzle/malicious.ts");
    const previousMarker = process.env.SYNAPSOR_GENERATOR_MARKER;
    const previousSecret = process.env.SYNAPSOR_GENERATOR_UNRELATED_SECRET;
    process.env.SYNAPSOR_GENERATOR_MARKER = marker;
    process.env.SYNAPSOR_GENERATOR_UNRELATED_SECRET = secretFile;
    try {
      await fs.writeFile(secretFile, "unrelated-file-secret", "utf8");
      const readSpy = vi.spyOn(fs, "readFile");
      await generateSchemaCandidateDirectory({ format: "drizzle", inputPath: input, outputDir: output });
      expect(existsSync(marker)).toBe(false);
      expect(readSpy.mock.calls.map(([value]) => path.resolve(String(value)))).toEqual([path.resolve(input)]);
      const serialized = (await fs.readdir(output))
        .map(async (file) => fs.readFile(path.join(output, file), "utf8"));
      expect((await Promise.all(serialized)).join("\n")).not.toContain("unrelated-file-secret");
    } finally {
      if (previousMarker === undefined) delete process.env.SYNAPSOR_GENERATOR_MARKER;
      else process.env.SYNAPSOR_GENERATOR_MARKER = previousMarker;
      if (previousSecret === undefined) delete process.env.SYNAPSOR_GENERATOR_UNRELATED_SECRET;
      else process.env.SYNAPSOR_GENERATOR_UNRELATED_SECRET = previousSecret;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects external OpenAPI references, dynamic Drizzle tables, and oversized inputs", async () => {
    const source = await fs.readFile(repoPath("fixtures/generators/openapi/external-ref.yaml"), "utf8");
    expect(() => parseSchemaCandidateSource("openapi", source, "external-ref.yaml"))
      .toThrow(/External or unsupported OpenAPI reference is forbidden/);
    expect(() => buildSchemaCandidateBundle(parseSchemaCandidateSource(
      "drizzle",
      "const name = process.env.TABLE; export const t = pgTable(name, { id: text('id') });",
      "dynamic.ts",
    ))).toThrow(/requires a static identifier string/);
    expect(() => parseSchemaCandidateSource("prisma", "x".repeat(2 * 1024 * 1024 + 1), "huge.prisma"))
      .toThrow(/exceeds/);
  });

  it("never overwrites source or an unowned directory and requires explicit force", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-schema-overwrite-"));
    const input = fixtures[0]!.input;
    const output = path.join(root, "candidates");
    const unowned = path.join(root, "hand-edited");
    try {
      await generateSchemaCandidateDirectory({ format: "prisma", inputPath: input, outputDir: output });
      await expect(generateSchemaCandidateDirectory({
        format: "prisma",
        inputPath: input,
        outputDir: output,
      })).rejects.toThrow(/already exists/);
      await expect(generateSchemaCandidateDirectory({
        format: "prisma",
        inputPath: input,
        outputDir: output,
        force: true,
      })).resolves.toMatchObject({ overwritten: true });

      await fs.mkdir(unowned);
      await fs.writeFile(path.join(unowned, "contract.json"), "hand edited", "utf8");
      await expect(generateSchemaCandidateDirectory({
        format: "prisma",
        inputPath: input,
        outputDir: unowned,
        force: true,
      })).rejects.toThrow(/refusing to overwrite non-generated/);
      expect(await fs.readFile(path.join(unowned, "contract.json"), "utf8")).toBe("hand edited");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses force replacement through a symlinked output ancestor", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-schema-output-link-"));
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-schema-output-target-"));
    const target = path.join(external, "candidates");
    const link = path.join(root, "linked-parent");
    try {
      await generateSchemaCandidateDirectory({ format: "prisma", inputPath: fixtures[0]!.input, outputDir: target });
      const sentinel = path.join(target, "operator-notes.txt");
      await fs.writeFile(sentinel, "preserve\n", "utf8");
      await fs.symlink(external, link, "dir");

      await expect(generateSchemaCandidateDirectory({
        format: "prisma",
        inputPath: fixtures[0]!.input,
        outputDir: path.join(link, "candidates"),
        force: true,
      })).rejects.toThrow(/symbolic link/);
      expect(await fs.readFile(sentinel, "utf8")).toBe("preserve\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(external, { recursive: true, force: true });
    }
  });

  it("refuses force replacement when the owned output became a Git repository root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-schema-output-repository-"));
    const output = path.join(root, "candidates");
    try {
      await generateSchemaCandidateDirectory({ format: "prisma", inputPath: fixtures[0]!.input, outputDir: output });
      const sentinel = path.join(output, "operator-notes.txt");
      await fs.writeFile(sentinel, "preserve\n", "utf8");
      await fs.mkdir(path.join(output, ".git"));

      await expect(generateSchemaCandidateDirectory({
        format: "prisma",
        inputPath: fixtures[0]!.input,
        outputDir: output,
        force: true,
      })).rejects.toThrow(/Git repository root/);
      expect(await fs.readFile(sentinel, "utf8")).toBe("preserve\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exposes all three focused generators through init", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-schema-cli-"));
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      for (const fixture of fixtures) {
        writes.length = 0;
        const output = path.join(root, fixture.format);
        await expect(main([
          "init",
          `from-${fixture.format}`,
          fixture.input,
          "--output",
          output,
          "--json",
        ])).resolves.toBe(0);
        expect(JSON.parse(writes.join(""))).toMatchObject({
          format: fixture.format,
          output_dir: output,
          activation: "blocked_unreviewed",
        });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
