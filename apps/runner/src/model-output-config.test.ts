import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readModelAuthorityMetadataMode } from "./model-output-config.js";

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
});
