import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPausedExecutionSetup, SemanticWriterPostureError } from "./semantic-execution-setup.js";
import { reviewSemanticSupervisedExecution } from "./verified-action-review.js";
import { enableSemanticSupervisedExecution, previewSemanticSupervisedExecution, verifySemanticExecutionReadPosture } from "./semantic-action-deployment.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { WriterProvisioningPlan } from "./writer-provisioning.js";

vi.mock("./semantic-action-deployment.js", async (original) => ({
  ...await original<typeof import("./semantic-action-deployment.js")>(),
  previewSemanticSupervisedExecution: vi.fn(), enableSemanticSupervisedExecution: vi.fn(),
  verifySemanticExecutionReadPosture: vi.fn(),
}));

describe("guided execution recovery", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(verifySemanticExecutionReadPosture).mockResolvedValue(undefined); });

  function fixture() {
    const session = {
      promptText: vi.fn(async () => ""),
      chooseOption: vi.fn(async () => "pause"),
      confirmActivation: vi.fn(async () => true),
      rememberDetails: vi.fn(), showReviewDetails: vi.fn(),
    } as unknown as BoundaryReviewInteractiveSession;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-execution-review-")); roots.push(root);
    const input = { projectRoot: root, outcome: "inventory.replenish", activeReads: [], session, env: {},
      active: { authority: { rules: [], action_boundary: { digest: `sha256:${"a".repeat(64)}` } } } } as unknown as Parameters<typeof reviewSemanticSupervisedExecution>[0];
    vi.mocked(previewSemanticSupervisedExecution).mockResolvedValue({
      outcome: input.outcome, operation: "insert", target: "inventory.requests", writer_role: "bounded_writer",
      write_url_env: "SYNAPSOR_DATABASE_WRITE_URL", policy: { concurrency: 1, queue_limit: 10, max_attempts: 2,
        rate_limit: { executions: 10, window_seconds: 60 } },
    } as Awaited<ReturnType<typeof previewSemanticSupervisedExecution>>);
    vi.mocked(enableSemanticSupervisedExecution).mockResolvedValue({ outcome: input.outcome, config_path: "/owned/project/runner.json" } as Awaited<ReturnType<typeof enableSemanticSupervisedExecution>>);
    return input;
  }

  it("does not offer execution consent when repaired RLS has made the saved Read contract stale", async () => {
    const input = fixture();
    vi.mocked(verifySemanticExecutionReadPosture).mockRejectedValue(new Error("SEMANTIC_ACTION_READ_REVIEW_REQUIRED: schema metadata changed"));
    const notice = await reviewSemanticSupervisedExecution(input);
    expect(notice).toMatchObject({ tone: "warning", lines: expect.arrayContaining([expect.stringContaining("revalidate")]),
      footer: expect.stringContaining("Revalidate the saved job") });
    expect(input.session.confirmActivation).not.toHaveBeenCalled();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(input.session.chooseOption).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([
      expect.objectContaining({ label: "Show how to revalidate this saved job" }),
    ]), expect.objectContaining({ displayContext: true }));
  });

  it("rechecks a corrected writer in the same conversation, retaining separate execution consent", async () => {
    const input = fixture();
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValueOnce(new Error("Writer lacks UPDATE on inventory.requests.quantity."));
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("retry");
    expect((await reviewSemanticSupervisedExecution(input))?.tone).toBe("success");
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledTimes(2);
    expect(input.session.confirmActivation).toHaveBeenCalledOnce();
    expect(enableSemanticSupervisedExecution).toHaveBeenCalledOnce();
    expect(input.session.chooseOption).toHaveBeenCalledWith("Execution needs a deployment fix", expect.any(Array),
      expect.objectContaining({ context: expect.arrayContaining([expect.stringContaining("EXECUTION_SETUP_CHECK_FAILED")]) }));
  });

  it("does not require an unrelated revoked Read to review execution for a current outcome", async () => {
    const input = fixture();
    input.active.authority.rules = [
      { rule: { outcome: input.outcome }, read_boundary_name: "current", read_boundary_digest: "current_digest" },
      { rule: { outcome: "inventory.other" }, read_boundary_name: "revoked", read_boundary_digest: "revoked_digest" },
    ] as unknown as typeof input.active.authority.rules;
    input.activeReads = [{ pack: { name: "current" }, activation: { digest: "current_digest" }, deployment_profile: "staging" }] as unknown as typeof input.activeReads;
    vi.mocked(input.session.confirmActivation!).mockResolvedValueOnce(false);
    expect(await reviewSemanticSupervisedExecution(input)).toBeUndefined();
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledWith(expect.objectContaining({ outcome: input.outcome, profile: "staging" }));
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
  });

  it("keeps a failed prerequisite inspectable and pauses without activating or retrying implicitly", async () => {
    const input = fixture();
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValue(new Error("Writer credential is not configured."));
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("details").mockResolvedValueOnce("pause");
    const result = await reviewSemanticSupervisedExecution(input);
    expect(result?.footer).toContain("same start command");
    expect(result?.tone).toBe("warning");
    expect(result?.lines.join("\n")).not.toContain("credential");
    expect(await readPausedExecutionSetup(input.projectRoot, input.active.authority.action_boundary.digest)).toMatchObject({
      outcome: input.outcome, problem: { code: "EXECUTION_SETUP_CHECK_FAILED" },
    });
    expect(input.session.showReviewDetails).toHaveBeenCalledOnce();
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledOnce();
    expect(input.session.confirmActivation).not.toHaveBeenCalled();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
  });
  it("uses the configured writer without retyping its variable; checking is separate from enabling", async () => {
    const input = fixture(); input.env = { SYNAPSOR_DATABASE_WRITE_URL: "postgres://secret-do-not-display" };
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("check");
    vi.mocked(input.session.confirmActivation!).mockResolvedValueOnce(false);
    expect(await reviewSemanticSupervisedExecution(input)).toBeUndefined();
    expect(input.session.promptText).not.toHaveBeenCalled();
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledOnce();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(input.session.chooseOption!).mock.calls)).not.toContain("secret-do-not-display");
  });
  it("shows a short verified cause, complete grouped requirements, and no implicit retry on pause", async () => {
    const input = fixture();
    const problem = new SemanticWriterPostureError({ ok: false, fingerprint: `sha256:${"a".repeat(64)}`, expected_fingerprint: null,
      reasons: ["writer_excess_column_privilege", "writer_row_lock_privilege_missing"], allowed_relations: [], writable_relations: [],
      relation_issues: [{ relation: "telecom.subscriptions", issue: "excess", privileges: ["UPDATE (updated_at)"] },
        { relation: "telecom.plan_change_offers", issue: "missing", privileges: ["UPDATE (plan_offer_id)"] }],
      required_relations: [{ relation: "telecom.subscriptions", privileges: ["select", "update"], update_columns: ["plan_code", "version"], rls_required: true }],
    }, "WRITER_URL");
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValue(problem);
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("details").mockResolvedValueOnce("pause");
    const result = await reviewSemanticSupervisedExecution(input);
    expect(result?.title).toBe("Execution setup paused.");
    expect(input.session.chooseOption).toHaveBeenCalledWith("Execution needs a deployment fix", expect.anything(),
      expect.objectContaining({ context: expect.arrayContaining([expect.stringContaining("missing and extra access")]) }));
    const lines = vi.mocked(input.session.showReviewDetails!).mock.calls[0]![1];
    expect(lines).toEqual(expect.arrayContaining(["MISSING ACCESS", "EXTRA ACCESS", "EXACT ADMINISTRATOR HANDOFF"]));
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledOnce();
  });
  it("exports an administrator plan and returns to the same failed review without a database recheck", async () => {
    const input = fixture();
    const plan: WriterProvisioningPlan = { version: 1, engine: "postgres", outcome: input.outcome,
      action_digest: input.active.authority.action_boundary.digest, writer_env: "SYNAPSOR_DATABASE_WRITE_URL",
      suggested_role: "runner_writer_aaaaaaaaaaaa", relations: [] };
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValue(new SemanticWriterPostureError({ ok: false,
      fingerprint: `sha256:${"a".repeat(64)}`, expected_fingerprint: null, allowed_relations: [], writable_relations: [],
      reasons: ["writer_privileged_role"] }, plan.writer_env, plan));
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("export").mockResolvedValueOnce("details").mockResolvedValueOnce("pause");
    const before = structuredClone(input.active);
    expect((await reviewSemanticSupervisedExecution(input))?.tone).toBe("warning");
    const parent = path.join(input.projectRoot, ".synapsor", "writer-handoffs");
    const directory = path.join(parent, fs.readdirSync(parent)[0]!);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "requirements.json"), "utf8"))).toEqual(plan);
    expect(fs.readFileSync(path.join(directory, "grants.sql"), "utf8")).toContain("NOLOGIN");
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledOnce();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(input.active).toEqual(before);
    expect(input.session.chooseOption).toHaveBeenCalledTimes(3);
    expect(vi.mocked(input.session.chooseOption!).mock.calls.every(([title]) => title === "Execution needs a deployment fix")).toBe(true);
  });
});
