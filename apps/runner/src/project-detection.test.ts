import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectProjectContext, formatProjectDetection } from "./project-detection.js";

describe("project context detection", () => {
  it("detects supported project hints without reading dotenv values or executing code", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-detect-"));
    await fs.mkdir(path.join(root, "prisma"), { recursive: true });
    await fs.writeFile(path.join(root, "prisma/schema.prisma"), "this is deliberately not executable", "utf8");
    await fs.writeFile(path.join(root, "drizzle.config.ts"), "throw new Error('must not execute')", "utf8");
    await fs.writeFile(path.join(root, "openapi.yaml"), "openapi: 3.1.0\n", "utf8");
    await fs.writeFile(path.join(root, "schema.sql"), "select 'must not execute';\n", "utf8");
    await fs.mkdir(path.join(root, "migrations"));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { next: "15", "drizzle-orm": "1" } }), "utf8");
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    await fs.writeFile(path.join(root, ".env.example"), [
      "DATABASE_URL=<staging-url>",
      "NOT_A_DATABASE=should-not-appear",
      "PASSWORD=must-not-appear",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(root, ".env"), "MYSQL_URL=mysql://user:super-secret@example.invalid/app\n", "utf8");

    const result = await detectProjectContext(root, { POSTGRES_URL: "postgres://not-persisted" });
    expect(result).toMatchObject({
      root,
      package_manager: "pnpm",
      frameworks: ["node", "nextjs", "drizzle"],
      database_env_names: ["DATABASE_URL", "POSTGRES_URL"],
    });
    expect(result.schema_inputs).toEqual([
      { kind: "prisma", path: "prisma/schema.prisma" },
      { kind: "drizzle", path: "drizzle.config.ts" },
      { kind: "openapi", path: "openapi.yaml" },
      { kind: "sql", path: "schema.sql" },
      { kind: "sql", path: "migrations/" },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/super-secret|mysql:\/\//i);
    expect(formatProjectDetection(result)).toContain(".env values were not read");
  });

  it("ignores symlinked project hints", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-project-symlink-"));
    const external = path.join(root, "external.json");
    await fs.writeFile(external, "{}", "utf8");
    await fs.symlink(external, path.join(root, "openapi.json"));
    expect((await detectProjectContext(root, {})).schema_inputs).toEqual([]);
  });
});
