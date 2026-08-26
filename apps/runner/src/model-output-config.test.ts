import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readModelAuthorityMetadataMode,
  updateModelAuthorityMetadataMode,
} from "./model-output-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("model output config preference", () => {
  it("reads the exact preference without validating unrelated capability syntax", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-model-output-"));
    roots.push(root);
    const configPath = path.join(root, "synapsor.runner.json");
    await fs.writeFile(configPath, JSON.stringify({
      mode: "legacy-value-that-is-not-runtime-valid",
      model_output: { authority_metadata: "exact" },
    }));

    await expect(readModelAuthorityMetadataMode(configPath)).resolves.toBe("exact");
  });

  it("fails safe to semantic for absent, malformed, or unknown preferences", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-model-output-"));
    roots.push(root);
    const missing = path.join(root, "missing.json");
    const malformed = path.join(root, "malformed.json");
    const unknown = path.join(root, "unknown.json");
    await fs.writeFile(malformed, "{");
    await fs.writeFile(unknown, JSON.stringify({
      model_output: { authority_metadata: "unsupported" },
    }));

    await expect(readModelAuthorityMetadataMode(missing)).resolves.toBe("semantic");
    await expect(readModelAuthorityMetadataMode(malformed)).resolves.toBe("semantic");
    await expect(readModelAuthorityMetadataMode(unknown)).resolves.toBe("semantic");
  });

  it("updates only model presentation and preserves config permissions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-model-output-"));
    roots.push(root);
    const configPath = path.join(root, "synapsor.runner.json");
    const config = {
      version: 1,
      mode: "read_only",
      storage: { sqlite_path: "./.synapsor/local.db" },
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          read_only: true,
        },
      },
      trusted_context: { provider: "environment" },
      capabilities: [],
      strict: true,
      result_format: 2,
    };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o640 });

    await expect(updateModelAuthorityMetadataMode({
      configPath,
      mode: "exact",
    })).resolves.toEqual({ authority_metadata: "exact", changed: true });
    expect((await fs.stat(configPath)).mode & 0o777).toBe(0o640);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual({
      ...config,
      model_output: { authority_metadata: "exact" },
    });
    await expect(updateModelAuthorityMetadataMode({
      configPath,
      mode: "exact",
    })).resolves.toEqual({ authority_metadata: "exact", changed: false });
  });
});
