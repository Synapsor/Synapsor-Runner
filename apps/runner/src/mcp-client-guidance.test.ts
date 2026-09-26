import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpConfigure } from "./mcp-runtime.js";

// Isolate config generation from authority/store loading. These fixtures only
// select the existing guidance branches; no runtime or source is started.
vi.mock("./cli-project.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./cli-project.js")>();
  const readConfig = async (configPath: string) => configPath.endsWith("production.json")
    ? { mode: "read_only", capabilities: [], production_explore: { enabled: true } }
    : { mode: "review", capabilities: [] };
  return { ...original, readLedgerRuntimeConfig: readConfig, readRuntimeConfig: readConfig };
});

afterEach(() => vi.restoreAllMocks());

describe("generated client result-evidence guidance", () => {
  it.each([
    { client: "cursor", surface: "compatibility", transport: "stdio", aliasMode: "canonical" },
    { client: "claude-code", surface: "compatibility", transport: "stdio", aliasMode: "canonical" },
    { client: "vscode", surface: "compatibility", transport: "stdio", aliasMode: "canonical" },
    { client: "openai-agents", surface: "compatibility", transport: "streamable-http", aliasMode: "openai" },
    { client: "generic-stdio", surface: "production", transport: "streamable-http", aliasMode: "canonical" },
  ])("delivers scoped reporting guidance for $client/$surface", async ({ client, surface, transport, aliasMode }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-client-evidence-guidance-"));
    const configPath = path.join(root, `${surface}.json`);
    const originalConfig = "{}\n";
    await fs.writeFile(configPath, originalConfig);
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const args = ["--client", client, "--config", configPath, "--store", path.join(root, "unused.db"),
        "--transport", transport, "--include-instructions"];
      expect(await mcpConfigure(args)).toBe(0);
      const snippet = JSON.parse(output);
      expect(snippet.agent_instructions).toMatchObject({ target_client: client, alias_mode: aliasMode });
      const guidance = snippet.agent_instructions.recommended_system_prompt;
      expect(guidance).toMatch(/^Report supported observations and scope returned counts and completeness to the result's query or catalog page\./);
      expect(guidance).toContain("Business rows do not establish Runner request, approval or queue status.");
      expect(guidance).toContain("Reference issuance alone does not establish eligibility, approval, intent or a stable snapshot.");
      expect(guidance).toContain("Never use a fresh request_change as a harmless status probe.");
      expect(guidance).toContain(surface === "production" ? "Use app.describe_data only to discover" : "propose-first pattern");
      expect(await fs.readFile(configPath, "utf8")).toBe(originalConfig);
      expect(await fs.readdir(root)).toEqual([`${surface}.json`]);

      output = "";
      expect(await mcpConfigure(args.filter(arg => arg !== "--include-instructions"))).toBe(0);
      expect(JSON.parse(output)).not.toHaveProperty("agent_instructions");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
