import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverProjectEnvFiles,
  readDatabaseUrlFromProjectEnv,
  sessionDatabaseInput,
  validateDatabaseUrl,
} from "./instant-onboarding.js";

describe("instant onboarding database input", () => {
  it("discovers only regular bounded project env files without reading a symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-instant-env-"));
    const outside = path.join(root, "outside");
    await fs.writeFile(outside, "DATABASE_URL=postgresql://reader:secret@localhost/app\n", "utf8");
    await fs.symlink(outside, path.join(root, ".env.local"));
    await fs.writeFile(path.join(root, ".env"), "DATABASE_URL=postgresql://reader:secret@localhost/app\n", "utf8");
    try {
      await expect(discoverProjectEnvFiles(root)).resolves.toEqual([path.join(root, ".env")]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("loads only a supported read URL after the caller selected the env file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-instant-env-read-"));
    const filePath = path.join(root, ".env");
    await fs.writeFile(filePath, [
      "UNRELATED_SECRET=do-not-use",
      "SYNAPSOR_DATABASE_WRITE_URL=postgresql://writer:secret@localhost/app",
      "DATABASE_URL=postgresql://reader:secret@localhost/app",
      "",
    ].join("\n"), "utf8");
    try {
      await expect(readDatabaseUrlFromProjectEnv(filePath)).resolves.toMatchObject({
        environmentVariable: "DATABASE_URL",
        value: "postgresql://reader:secret@localhost/app",
        source: "project_env",
        sourceLabel: ".env",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts supported session URLs and rejects placeholders or non-database protocols", () => {
    expect(sessionDatabaseInput("mysql://reader:secret@localhost/app")).toMatchObject({
      environmentVariable: "DATABASE_URL",
      source: "session_paste",
    });
    expect(() => validateDatabaseUrl("https://example.test/database")).toThrow(/postgres.*mysql/i);
    expect(() => validateDatabaseUrl("postgresql://${USER}:secret@localhost/app")).toThrow(/placeholder/i);
  });
});
