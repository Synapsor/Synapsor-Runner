import { afterEach, describe, expect, it } from "vitest";
import {
  envPresenceCheck,
  formatLocalDoctorSetupReport,
  inspectConfiguredSource,
  localDoctorSetupStatus,
  type LocalDoctorReport,
} from "./doctor-domain.js";


function reportWithChecks(checks: LocalDoctorReport["checks"]): LocalDoctorReport {
  return {
    ok: false,
    mode: "read_only",
    config_path: "/project/synapsor.runner.json",
    checks,
    tools: [],
    governance: {
      authority_mode: "local_only",
      evidence_residency: "metadata_only",
      queue_when_unavailable: false,
    },
    isolation: [],
  };
}


describe("doctor setup status", () => {
  const envNames = [
    "SYNAPSOR_TEST_REQUIRED_READ_URL",
    "SYNAPSOR_TEST_PENDING_TENANT",
    "SYNAPSOR_TEST_REQUIRED_JWKS",
  ];

  afterEach(() => {
    for (const envName of envNames) delete process.env[envName];
  });

  it("reports only deferred trusted-context bindings as incomplete", () => {
    const report = reportWithChecks([
      envPresenceCheck(
        "SYNAPSOR_TEST_PENDING_TENANT",
        "Trusted tenant binding is required.",
        "pending",
      ),
    ]);

    expect(localDoctorSetupStatus(report)).toBe("incomplete");
    expect(formatLocalDoctorSetupReport(report)).toContain(
      "SYNAPSOR_TEST_PENDING_TENANT is not set yet.",
    );
  });

  it("fails setup when the primary read credential is missing", () => {
    const report = reportWithChecks([
      envPresenceCheck(
        "SYNAPSOR_TEST_REQUIRED_READ_URL",
        "SYNAPSOR_TEST_REQUIRED_READ_URL is required for source reads.",
      ),
    ]);

    expect(localDoctorSetupStatus(report)).toBe("failed");
    const output = formatLocalDoctorSetupReport(report);
    expect(output).toContain("x SYNAPSOR_TEST_REQUIRED_READ_URL is required for source reads.");
    expect(output).not.toContain("SYNAPSOR_TEST_REQUIRED_READ_URL is not set yet.");
  });

  it("fails setup when required shared-session key material is missing", () => {
    const report = reportWithChecks([
      envPresenceCheck(
        "SYNAPSOR_TEST_REQUIRED_JWKS",
        "SYNAPSOR_TEST_REQUIRED_JWKS is required to resolve the trusted session JWKS endpoint.",
      ),
      envPresenceCheck(
        "SYNAPSOR_TEST_PENDING_TENANT",
        "Trusted tenant binding is required.",
        "pending",
      ),
    ]);

    expect(localDoctorSetupStatus(report)).toBe("failed");
    const output = formatLocalDoctorSetupReport(report);
    expect(output).toContain("x SYNAPSOR_TEST_REQUIRED_JWKS is required");
    expect(output).toContain("SYNAPSOR_TEST_PENDING_TENANT is not set yet.");
  });

  it("fails doctor on an elevated read credential and names a least-privilege recovery", async () => {
    process.env.SYNAPSOR_TEST_REQUIRED_READ_URL = "postgresql://value-is-never-read";
    const checks: LocalDoctorReport["checks"] = [];
    await inspectConfiguredSource({
      config: { capabilities: [] } as never,
      sourceName: "analytics",
      source: { engine: "postgres", read_url_env: "SYNAPSOR_TEST_REQUIRED_READ_URL" } as never,
      checks,
      inspectDatabaseFn: async () => ({
        engine: "postgres",
        server_version: "PostgreSQL 16.4",
        current_user: "postgres",
        role_posture: {
          verified: true,
          superuser: true,
          bypass_rls: true,
          read_only: false,
          writable_relations: ["public.orders"],
          owned_relations: ["public.orders"],
          reasons: [],
        },
        inspected_at: "2026-08-26T00:00:00.000Z",
        schemas: ["public"],
        tables: [],
        warnings: [],
      }),
    });

    expect(checks).toContainEqual(expect.objectContaining({
      name: "source:analytics:read-role-posture",
      ok: false,
      level: "fail",
      message: expect.stringMatching(/postgres.*superuser[\s\S]*BYPASSRLS[\s\S]*Update SYNAPSOR_TEST_REQUIRED_READ_URL/is),
    }));
    expect(checks.find((check) => check.name === "source:analytics:read-connectivity")?.message)
      .toContain("Metadata inspection succeeded");
    expect(checks.map((check) => check.message).join("\n")).not.toContain("postgresql://value-is-never-read");
  });
});
