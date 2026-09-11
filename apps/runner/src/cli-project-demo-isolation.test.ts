import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { envWithDemoDefaults } from "./cli-project.js";

afterEach(() => vi.unstubAllEnvs());

describe("reviewed runtime isolation from legacy demo defaults", () => {
  it.each(["production_explore", "action_rules"])("does not infer identity or credentials for %s from example names", surface => {
    for (const name of ["SYNAPSOR_TENANT_ID", "SYNAPSOR_PRINCIPAL", "REFERENCE_POSTGRES_READ_URL", "SYNAPSOR_RUNNER_TOKEN"]) {
      vi.stubEnv(name, undefined);
    }
    const config = { sources: { app_postgres: { read_url_env: "REFERENCE_POSTGRES_READ_URL" } }, [surface]: {} } as unknown as RuntimeConfig;
    const env = envWithDemoDefaults(config, "/owned/project/examples/reference-support-billing-app/synapsor.runner.json");
    expect(env).toBe(process.env);
    expect(env.SYNAPSOR_TENANT_ID).toBeUndefined();
    expect(env.SYNAPSOR_PRINCIPAL).toBeUndefined();
    expect(env.REFERENCE_POSTGRES_READ_URL).toBeUndefined();
    expect(env.SYNAPSOR_RUNNER_TOKEN).toBeUndefined();
    vi.stubEnv("SYNAPSOR_TENANT_ID", "explicit-test-organization");
    expect(envWithDemoDefaults(config, "synapsor.runner.json").SYNAPSOR_TENANT_ID).toBe("explicit-test-organization");
  });

  it("leaves the explicit legacy example path operational without selecting it for an ordinary project", () => {
    vi.stubEnv("SYNAPSOR_TENANT_ID", undefined);
    const legacy = { sources: { app_postgres: { read_url_env: "REFERENCE_POSTGRES_READ_URL" } } } as unknown as RuntimeConfig;
    expect(envWithDemoDefaults(legacy, "synapsor.runner.json").SYNAPSOR_TENANT_ID).toBe("acme");
    expect(envWithDemoDefaults({} as RuntimeConfig, "synapsor.runner.json")).toBe(process.env);
  });
});
