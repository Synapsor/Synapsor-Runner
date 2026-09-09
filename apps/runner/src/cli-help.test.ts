import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { usage } from "./cli-help.js";

describe("current Boundary onboarding help", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["worker", "worker run"])("shows explicit semantic worker mode and Action config in %j help", (command) => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    usage(command.split(" "));
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(text).toContain("worker run --supervised --yes --config ./synapsor.actions.runner.json");
    expect(text).toContain("worker run --supervised --once --yes --config ./synapsor.actions.runner.json");
    expect(text).toContain("Without --supervised, worker run uses the legacy queue");
    expect(text).toContain("exact config path printed by execution setup");
    expect(text).toContain("trusted identity");
    expect(text).toContain("successful execution receipt");
  });

  it("documents the current saved Action worker handoff separately from legacy capability examples", async () => {
    const text = await fs.readFile(new URL("../../../docs/supervised-automatic-apply.md", import.meta.url), "utf8");
    expect(text).toContain("worker run --supervised --yes --config ./synapsor.actions.runner.json");
    expect(text).toContain("worker run --supervised --once --yes --config ./synapsor.actions.runner.json");
    expect(text).toContain("exact config path printed by execution setup");
    expect(text).toContain("Without `--supervised`, `worker run` uses the legacy queue");
    expect(text).toContain("Legacy capability examples");
    expect(text).toContain("trusted identity");
  });

  it("distinguishes configured production Read from optional legacy Protect", async () => {
    const text = await fs.readFile(new URL("../../../docs/guided-onboarding.md", import.meta.url), "utf8");
    const mentalModel = text.split("## The One-Minute Mental Model")[1]!.split("\n## ")[0]!.replace(/\s+/gu, " ");
    expect(mentalModel).toContain("four-tool MCP surface in development and configured production deployments");
    expect(mentalModel).toContain("Production Read does not require Protect or named per-capability tools");
    expect(mentalModel).toContain("legacy compatibility workflow");
    expect(mentalModel).toContain("not a prerequisite for current Read");
  });

  it("keeps multiline legacy selectors explicit in the current onboarding guides", async () => {
    for (const file of ["guided-onboarding.md", "getting-started-own-database.md"]) {
      const text = await fs.readFile(new URL(`../../../docs/${file}`, import.meta.url), "utf8");
      const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/gu)].map((match) => match[1]!.replace(/\\\r?\n\s*/gu, " "));
      for (const command of blocks.flatMap((block) => block.split("\n"))) {
        if (/\b(?:start|onboard db)\b/u.test(command) && /--(?:table|answers|spec|mode)\b/u.test(command)) {
          expect(command, `${file}: ${command}`).toContain("--legacy-capabilities");
        }
      }
    }
  });

  it.each(["", "start", "onboard"])("advertises one current four-tool route in %j help", (command) => {
    const args = command ? [command] : [];
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    usage(args);
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    for (const name of ["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"]) expect(text).toContain(name);
    expect(text).toContain("--export-draft"); expect(text).toContain("--draft");
    expect(text).not.toContain("scriptable one-command artifact generator");
    expect(text).not.toMatch(/no-arg legacy worker|With no flags, start the legacy|Canonical non-interactive read-only setup/u);
    if (args.length) {
      expect(text).toContain("--legacy-capabilities");
      expect(text.replace(/\s+/gu, " ")).toContain("Headless semantic activation is not implemented");
      expect(text).toContain("--yes");
      const oldSelectorCommands = text.split("\n").filter((line) => /^\s+synapsor-runner (?:start|onboard db) /u.test(line) && /--(?:table|answers|spec|mode)\b/u.test(line));
      expect(oldSelectorCommands.every((line) => line.includes("--legacy-capabilities"))).toBe(true);
    }
  });

  it.each(["init", "action"])("labels %s capability/code-first commands as legacy rather than semantic activation", (command) => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    usage([command]);
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(text).toMatch(/legacy|Legacy/u);
    expect(text).toContain("current");
    if (command === "action") {
      expect(text).toContain("Headless semantic activation is not implemented");
      expect(text).toContain("Verified Action Boundary");
      expect(text).toContain("no provider");
      expect(text).not.toContain("Open action review for the legacy capability control plane");
    }
  });

  it.each(["boundary", "mcp install", "mcp serve"])("keeps the local four-tool Read route independent of Action activation in %s help", (command) => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    usage(command.split(" "));
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join("").replace(/\s+/gu, " ");
    expect(text).toContain("four fixed tools");
    for (const name of ["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"]) expect(text).toContain(name);
    expect(text).toContain("Read activation does not require Action activation");
    expect(text).toContain("inactive Actions grant no change authority");
    expect(text).not.toMatch(/--authoring installs exactly app\.describe_data and app\.explore_data|Both routes expose only app\.describe_data and app\.explore_data|Re-run after Protect activates a named capability/u);
    if (command === "mcp install") {
      expect(text).toContain("boundary review --project-root . --access");
      expect(text).toContain("then re-run mcp install");
      expect(text).toContain("Protect and named-capability installation are explicit legacy compatibility");
      expect(text).toContain("not prerequisites for current Read");
      expect(text).toContain("current generation lock and database role");
    }
    if (command === "mcp serve") {
      expect(text).toContain("production_explore config serves the two Read tools");
      expect(text).toContain("asymmetric JWT tenant/principal claims");
      expect(text).toContain("stale generation locks");
      expect(text).toContain("SELECT-only and non-owner");
    }
  });

  it("labels nearby named-capability client instructions as legacy", () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    usage(["mcp", "client-config"]);
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join("").replace(/\s+/gu, " ");
    expect(text).toContain("If no reviewed local Read Boundary is active");
    expect(text).toContain("propose-first instructions for explicit legacy named-capability configurations");
  });
});
