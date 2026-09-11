import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPausedExecutionSetup, SemanticWriterPostureError } from "./semantic-execution-setup.js";
import { reviewSemanticSupervisedExecution } from "./verified-action-review.js";
import { enableSemanticSupervisedExecution, previewSemanticSupervisedExecution, verifySemanticExecutionReadPosture,
  readSemanticExecutionReviewDefaults, prepareSemanticWriterHandoff, semanticDedicatedWriterEnvironment } from "./semantic-action-deployment.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { WriterProvisioningPlan } from "./writer-provisioning.js";

vi.mock("./semantic-action-deployment.js", async (original) => ({
  ...await original<typeof import("./semantic-action-deployment.js")>(),
  previewSemanticSupervisedExecution: vi.fn(), enableSemanticSupervisedExecution: vi.fn(),
  verifySemanticExecutionReadPosture: vi.fn(),
  readSemanticExecutionReviewDefaults: vi.fn(),
  prepareSemanticWriterHandoff: vi.fn(),
}));

describe("guided execution recovery", () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(verifySemanticExecutionReadPosture).mockResolvedValue(undefined);
    vi.mocked(readSemanticExecutionReviewDefaults).mockResolvedValue(undefined); });

  function fixture() {
    const session = {
      promptText: vi.fn(async () => "SYNAPSOR_DATABASE_WRITE_URL"),
      chooseOption: vi.fn(async (title) => title === "Set up database changes" ? "choose" : "pause"),
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

  it("asks for an explicit writer name when the generic reference is absent, without choosing another credential", async () => {
    const input = fixture();
    input.env = { DATABASE_URL: "private-reader", OTHER_WRITE_URL: "private-other", CHOSEN_WRITE_URL: "private-chosen" };
    vi.mocked(input.session.promptText).mockResolvedValueOnce("  CHOSEN_WRITE_URL  ");
    vi.mocked(input.session.confirmActivation!).mockResolvedValueOnce(false);
    expect(await reviewSemanticSupervisedExecution(input)).toBeUndefined();
    expect(input.session.promptText).toHaveBeenCalledExactlyOnceWith(
      "Write connection variable (Enter defers this outcome)", expect.objectContaining({
        context: expect.arrayContaining([`Outcome: ${input.outcome}`]),
      }));
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ writeUrlEnv: "CHOSEN_WRITE_URL" }));
    expect(verifySemanticExecutionReadPosture).toHaveBeenCalledOnce();
    expect(input.session.chooseOption).toHaveBeenCalledWith("Set up database changes", expect.arrayContaining([
      expect.objectContaining({ label: "Prepare administrator instructions" }),
    ]), expect.objectContaining({ displayContext: true }));
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(input.session.promptText).mock.calls)).not.toMatch(/SYNAPSOR_DATABASE_WRITE_URL|private-/);
  });

  it.each([
    { generic: undefined, answer: "" },
    { generic: "", answer: "  " },
    { generic: "   ", answer: "" },
    { generic: undefined, answer: undefined },
  ])("defers without a credential check, failed-check record or activation when no default is selected (%j)", async ({ generic, answer }) => {
    const input = fixture();
    input.env = { SYNAPSOR_DATABASE_WRITE_URL: generic, OTHER_WRITE_URL: "private-unselected" };
    vi.mocked(input.session.promptText).mockResolvedValueOnce(answer);
    const before = structuredClone(input.active);
    expect(await reviewSemanticSupervisedExecution(input)).toBeUndefined();
    expect(input.session.promptText).toHaveBeenCalledExactlyOnceWith(
      "Write connection variable (Enter defers this outcome)", expect.anything());
    expect(previewSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(verifySemanticExecutionReadPosture).not.toHaveBeenCalled();
    expect(input.session.chooseOption).toHaveBeenCalledOnce();
    expect(input.session.confirmActivation).not.toHaveBeenCalled();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(await readPausedExecutionSetup(input.projectRoot, input.active.authority.action_boundary.digest)).toBeUndefined();
    expect(input.active).toEqual(before);
    expect(fs.readdirSync(input.projectRoot)).toEqual([]);
  });

  it("retains the configured generic reference on Enter and still checks credentials before consent", async () => {
    const input = fixture();
    input.env = { SYNAPSOR_DATABASE_WRITE_URL: "private-configured" };
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("change");
    vi.mocked(input.session.promptText).mockResolvedValueOnce("");
    vi.mocked(input.session.confirmActivation!).mockResolvedValueOnce(false);
    expect(await reviewSemanticSupervisedExecution(input)).toBeUndefined();
    expect(input.session.promptText).toHaveBeenCalledExactlyOnceWith(
      "Write connection variable (Enter uses SYNAPSOR_DATABASE_WRITE_URL)", expect.anything());
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ writeUrlEnv: "SYNAPSOR_DATABASE_WRITE_URL" }));
    expect(verifySemanticExecutionReadPosture).toHaveBeenCalledOnce();
    expect(input.session.confirmActivation).toHaveBeenCalledOnce();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(input.session.promptText).mock.calls)).not.toContain("private-configured");
  });

  it("offers the action-specific repaired connection before a historical shared default, without authorizing it", async () => {
    const input = fixture();
    const dedicated = semanticDedicatedWriterEnvironment(input.outcome);
    input.env = { SYNAPSOR_DATABASE_WRITE_URL: "private-other-action", [dedicated]: "private-repaired" };
    vi.mocked(readSemanticExecutionReviewDefaults).mockResolvedValue({ write_url_env: "SYNAPSOR_DATABASE_WRITE_URL" });
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("check");
    vi.mocked(input.session.confirmActivation!).mockResolvedValueOnce(false);
    expect(await reviewSemanticSupervisedExecution(input)).toBeUndefined();
    expect(input.session.chooseOption).toHaveBeenCalledWith("Check your write connection", expect.anything(),
      expect.objectContaining({ context: expect.arrayContaining([`Connection: ${dedicated} is set (value hidden). Execution authorization comes after verification.`]) }));
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ writeUrlEnv: dedicated }));
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(input.session.chooseOption!).mock.calls)).not.toContain("private-");
  });

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

  it("keeps a rejected reader selection visible and offers dedicated writer repair without consent", async () => {
    const input = fixture();
    input.env = { DATABASE_URL: "private-reader" };
    vi.mocked(input.session.promptText).mockResolvedValueOnce("DATABASE_URL");
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValueOnce(new Error("SEMANTIC_ACTION_WRITER_READER_CONNECTION: The selected write connection is the saved reader."));
    const result = await reviewSemanticSupervisedExecution(input);
    expect(result).toMatchObject({ tone: "warning", lines: expect.arrayContaining([expect.stringContaining("saved read connection")]) });
    expect(input.session.confirmActivation).not.toHaveBeenCalled();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(input.session.chooseOption).toHaveBeenCalledWith("Execution needs a deployment fix", expect.arrayContaining([
      expect.objectContaining({ value: "export", label: "Prepare administrator instructions" }),
      expect.objectContaining({ value: "details" }), expect.objectContaining({ value: "pause" }),
    ]), expect.objectContaining({ displayContext: true }));
    const saved = await readPausedExecutionSetup(input.projectRoot, input.active.authority.action_boundary.digest);
    expect(saved?.problem.code).toBe("SEMANTIC_ACTION_WRITER_READER_CONNECTION");
    expect(JSON.stringify(saved)).not.toContain("private-reader");
  });

  it.each(["retained_worker", "unpinned_worker", "missing_environment"])("uses only the outcome's saved writer and identity as reverified defaults (%s)", async (mode) => {
    const input = fixture();
    input.env = { SYNAPSOR_DATABASE_WRITE_URL: "postgres://unrelated-hidden", SECOND_WRITER_URL: "postgres://reviewed-hidden" };
    if (mode === "missing_environment") delete input.env.SECOND_WRITER_URL;
    vi.mocked(readSemanticExecutionReviewDefaults).mockResolvedValue({ write_url_env: "SECOND_WRITER_URL",
      ...(mode === "unpinned_worker" ? {} : { worker_identity: "reviewed_second_worker" }) });
    vi.mocked(input.session.promptText).mockResolvedValueOnce("");
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce(mode === "missing_environment" ? "choose" : "check");
    vi.mocked(input.session.confirmActivation!).mockResolvedValueOnce(false);
    expect(await reviewSemanticSupervisedExecution(input)).toBeUndefined();
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledWith(expect.objectContaining({
      outcome: input.outcome, writeUrlEnv: "SECOND_WRITER_URL",
      ...(mode === "unpinned_worker" ? {} : { workerIdentity: "reviewed_second_worker" }),
    }));
    if (mode === "unpinned_worker") expect(vi.mocked(previewSemanticSupervisedExecution).mock.calls[0]![0].workerIdentity).toBeUndefined();
    expect(input.session.promptText).toHaveBeenCalledTimes(mode === "missing_environment" ? 1 : 0);
    if (mode === "missing_environment") expect(input.session.promptText).toHaveBeenCalledWith(
      "Write connection variable (Enter uses SECOND_WRITER_URL)", expect.anything());
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(input.session.chooseOption!).mock.calls)).not.toContain("postgres://");
  });

  it("does not bypass a saved custom writer's missing-credential check on Enter", async () => {
    const input = fixture();
    input.env = { SYNAPSOR_DATABASE_WRITE_URL: "private-unrelated" };
    vi.mocked(readSemanticExecutionReviewDefaults).mockResolvedValue({ write_url_env: "SAVED_WRITE_URL" });
    vi.mocked(input.session.promptText).mockResolvedValueOnce("");
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValueOnce(new Error("Writer credential is not configured."));
    expect((await reviewSemanticSupervisedExecution(input))?.tone).toBe("warning");
    expect(input.session.promptText).toHaveBeenCalledExactlyOnceWith(
      "Write connection variable (Enter uses SAVED_WRITE_URL)", expect.objectContaining({
        context: expect.arrayContaining(["The saved reference is a review default only; its current credential and permissions will be checked."]),
      }));
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ writeUrlEnv: "SAVED_WRITE_URL" }));
    expect(verifySemanticExecutionReadPosture).not.toHaveBeenCalled();
    expect(input.session.confirmActivation).not.toHaveBeenCalled();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(await readPausedExecutionSetup(input.projectRoot, input.active.authority.action_boundary.digest)).toMatchObject({ outcome: input.outcome });
  });

  it("does not guess a connection when saved review defaults cannot be validated", async () => {
    const input = fixture();
    vi.mocked(readSemanticExecutionReviewDefaults).mockRejectedValue(new Error("POLICY_AUTHORITY_IDENTITY_MISMATCH"));
    expect((await reviewSemanticSupervisedExecution(input))?.tone).toBe("warning");
    expect(input.session.promptText).not.toHaveBeenCalled();
    expect(previewSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(input.session.confirmActivation).not.toHaveBeenCalled();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
  });

  it("rechecks a corrected writer in the same conversation, retaining separate execution consent", async () => {
    const input = fixture();
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValueOnce(new Error("Writer lacks UPDATE on inventory.requests.quantity."));
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("choose").mockResolvedValueOnce("retry");
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
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("choose").mockResolvedValueOnce("details").mockResolvedValueOnce("pause");
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
  it("names each pending outcome when moving between writer reviews without enabling either", async () => {
    const input = fixture(); input.env = { SYNAPSOR_DATABASE_WRITE_URL: "postgres://secret-do-not-display" };
    for (const outcome of ["inventory.replenish", "inventory.correct_stock"]) {
      expect(await reviewSemanticSupervisedExecution({ ...input, outcome })).toBeUndefined();
      expect(input.session.chooseOption).toHaveBeenLastCalledWith("Check your write connection", expect.arrayContaining([
        expect.objectContaining({ value: "pause", label: "Set up this outcome later" }),
      ]), expect.objectContaining({ displayContext: true, context: expect.arrayContaining([`Outcome: ${outcome}`]) }));
    }
    expect(previewSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(input.session.confirmActivation).not.toHaveBeenCalled();
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
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("choose").mockResolvedValueOnce("details").mockResolvedValueOnce("pause");
    const result = await reviewSemanticSupervisedExecution(input);
    expect(result?.title).toBe("Execution setup paused.");
    expect(input.session.chooseOption).toHaveBeenCalledWith("Execution needs a deployment fix", expect.anything(),
      expect.objectContaining({ context: expect.arrayContaining([expect.stringContaining("missing and extra access")]) }));
    const lines = vi.mocked(input.session.showReviewDetails!).mock.calls[0]![1];
    expect(lines).toEqual(expect.arrayContaining(["MISSING ACCESS", "EXTRA ACCESS", "EXACT ADMINISTRATOR HANDOFF"]));
    expect(lines.every((line) => !line.includes("\n"))).toBe(true);
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledOnce();
  });
  it.each(["posture", "connection_unavailable"])("exports an administrator plan and returns to the same failed review without a writer recheck (%s)", async (mode) => {
    const input = fixture();
    const plan: WriterProvisioningPlan = { version: 1, engine: "postgres", outcome: input.outcome,
      action_digest: input.active.authority.action_boundary.digest, writer_env: "SYNAPSOR_DATABASE_WRITE_URL",
      suggested_role: "runner_writer_aaaaaaaaaaaa", relations: [] };
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValue(new SemanticWriterPostureError({ ok: false,
      fingerprint: `sha256:${"a".repeat(64)}`, expected_fingerprint: null, allowed_relations: [], writable_relations: [],
      reasons: ["writer_privileged_role"] }, plan.writer_env, plan));
    if (mode === "connection_unavailable") {
      vi.mocked(previewSemanticSupervisedExecution).mockRejectedValue(new Error("Writer connection unavailable"));
      vi.mocked(prepareSemanticWriterHandoff).mockResolvedValue({ plan, inspected_connection_env: "DATABASE_URL" } as Awaited<ReturnType<typeof prepareSemanticWriterHandoff>>);
    }
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("choose").mockResolvedValueOnce("export").mockResolvedValueOnce("details").mockResolvedValueOnce("pause");
    const before = structuredClone(input.active);
    expect((await reviewSemanticSupervisedExecution(input))?.tone).toBe("warning");
    const parent = path.join(input.projectRoot, ".synapsor", "writer-handoffs");
    const directory = path.join(parent, fs.readdirSync(parent)[0]!);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "requirements.json"), "utf8"))).toEqual(plan);
    expect(fs.readFileSync(path.join(directory, "grants.sql"), "utf8")).toContain("NOLOGIN");
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledOnce();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(input.active).toEqual(before);
    expect(input.session.chooseOption).toHaveBeenCalledTimes(4);
    expect(vi.mocked(input.session.chooseOption!).mock.calls.slice(1).every(([title]) => title === "Execution needs a deployment fix")).toBe(true);
  });

  it.each(["new", "saved_missing"])("exports complete administrator instructions before a writer exists, then resumes the same decision (%s)", async (mode) => {
    const input = fixture();
    if (mode === "saved_missing") vi.mocked(readSemanticExecutionReviewDefaults).mockResolvedValue({ write_url_env: "SAVED_WRITE_URL" });
    const plan: WriterProvisioningPlan = { version: 1, engine: "postgres", outcome: input.outcome,
      action_digest: input.active.authority.action_boundary.digest, writer_env: "SYNAPSOR_DATABASE_WRITE_URL",
      suggested_role: "runner_writer_aaaaaaaaaaaa", relations: [] };
    vi.mocked(prepareSemanticWriterHandoff).mockResolvedValue({ plan, inspected_connection_env: "DATABASE_URL" } as Awaited<ReturnType<typeof prepareSemanticWriterHandoff>>);
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("export").mockResolvedValueOnce("pause");
    const before = structuredClone(input.active);
    expect(await reviewSemanticSupervisedExecution(input)).toBeUndefined();
    expect(prepareSemanticWriterHandoff).toHaveBeenCalledOnce();
    const parent = path.join(input.projectRoot, ".synapsor", "writer-handoffs");
    const directory = path.join(parent, fs.readdirSync(parent)[0]!);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "requirements.json"), "utf8"))).toEqual(plan);
    expect(fs.readFileSync(path.join(directory, "grants.sql"), "utf8")).toContain("NOLOGIN");
    expect(input.session.showReviewDetails).toHaveBeenCalledWith("Administrator instructions prepared",
      expect.arrayContaining([expect.stringContaining("writer access has NOT been verified")]));
    expect(input.session.promptText).not.toHaveBeenCalled();
    expect(previewSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
    expect(input.active).toEqual(before);
    expect(vi.mocked(input.session.chooseOption!).mock.calls.map(([title]) => title)).toEqual(["Set up database changes", "Set up database changes"]);
  });
});
