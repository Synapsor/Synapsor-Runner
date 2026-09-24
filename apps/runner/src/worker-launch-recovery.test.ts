import { describe, expect, it } from "vitest";
import { workerLaunchLines, type WorkerLaunchAssessment } from "./worker-launch.js";

const base: WorkerLaunchAssessment = {
  config_path: "/owned/synapsor.actions.runner.json", scope: "sample.action",
  local_identity: "environment_or_other_trusted_provider", inputs: [], issues: [], execution_enabled: true,
  execution_binding: "current", receipt: { mode: "source_db", selected_mode: "source_db",
    matches_execution_configuration: true, selection: "current", live_verification: "not_performed" },
  coverage: "selected_semantic_outcome",
};

describe("prospective recovery readiness presentation", () => {
  it("keeps future closure prerequisites separate from executable-worker status", () => {
    const missing = workerLaunchLines({ ...base, recovery_prerequisites: "roles_missing" }).join("\n");
    expect(missing).toContain("execution enabled (still guarded)");
    expect(missing).toContain("may have no authenticated closure route");
    expect(missing).not.toContain("all failures recoverable");

    const unverified = workerLaunchLines({ ...base, recovery_prerequisites: "actor_unverified" }).join("\n");
    expect(unverified).toContain("Closure readiness is unverified");
    expect(unverified).toContain("key filename is not authentication");

    const verified = workerLaunchLines({ ...base, recovery_prerequisites: "actor_verified" }).join("\n");
    expect(verified).toContain("matching control actor authenticated");
    expect(verified).toContain("eligibility is checked for each failed item");
    expect(verified).toContain("receipt evidence remain unverified here");
  });

  it("does not infer recovery coverage from an ambiguous multi-outcome check", () => {
    const lines = workerLaunchLines({ ...base, scope: "all configured outcomes", coverage: "per_item_only",
      recovery_prerequisites: "unassessed" }).join("\n");
    expect(lines).toContain("Recovery prerequisites: unassessed");
    expect(lines).toContain("do not combine credentials across outcomes");
    expect(lines).not.toContain("matching control actor authenticated");
  });
});
