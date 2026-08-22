import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfigFile } from "./config-domain.js";

describe("Runner config file validation", () => {
  it("reports a warning once when raw and resolved config validation agree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-warning-"));
    const configPath = path.join(root, "synapsor.runner.json");
    try {
      await fs.writeFile(configPath, `${JSON.stringify({
        version: 1,
        mode: "read_only",
        storage: { sqlite_path: "./.synapsor/local.db" },
        sources: {
          local_postgres: {
            engine: "postgres",
            read_url_env: "DATABASE_URL",
            read_only: true,
            statement_timeout_ms: 3000,
          },
        },
        trusted_context: {
          provider: "environment",
          values: {
            tenant_id_env: "SYNAPSOR_TENANT_ID",
            principal_env: "SYNAPSOR_PRINCIPAL",
          },
        },
        capabilities: [],
        strict: true,
      }, null, 2)}\n`, "utf8");

      const result = await validateConfigFile(configPath);

      expect(result).toMatchObject({ ok: true, errors: [] });
      expect(result.warnings.filter((warning) =>
        warning.code === "READ_ONLY_CONFIG_HAS_NO_ACTIVE_CAPABILITIES"))
        .toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
