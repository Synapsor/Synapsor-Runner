import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewSemanticSupervisedExecution } from "./verified-action-review.js";
import { enableSemanticSupervisedExecution, previewSemanticSupervisedExecution } from "./semantic-action-deployment.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

vi.mock("./semantic-action-deployment.js", async (original) => ({
  ...await original<typeof import("./semantic-action-deployment.js")>(),
  previewSemanticSupervisedExecution: vi.fn(), enableSemanticSupervisedExecution: vi.fn(),
}));

describe("guided execution recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  function fixture() {
    const session = {
      promptText: vi.fn(async () => ""),
      chooseOption: vi.fn(async () => "pause"),
      confirmActivation: vi.fn(async () => true),
      rememberDetails: vi.fn(), showReviewDetails: vi.fn(),
    } as unknown as BoundaryReviewInteractiveSession;
    const input = { projectRoot: "/owned/project", outcome: "inventory.replenish", activeReads: [], session,
      active: { authority: { rules: [] } } } as unknown as Parameters<typeof reviewSemanticSupervisedExecution>[0];
    vi.mocked(previewSemanticSupervisedExecution).mockResolvedValue({
      outcome: input.outcome, operation: "insert", target: "inventory.requests", writer_role: "bounded_writer",
      write_url_env: "SYNAPSOR_DATABASE_WRITE_URL", policy: { concurrency: 1, queue_limit: 10, max_attempts: 2,
        rate_limit: { executions: 10, window_seconds: 60 } },
    } as Awaited<ReturnType<typeof previewSemanticSupervisedExecution>>);
    vi.mocked(enableSemanticSupervisedExecution).mockResolvedValue({ outcome: input.outcome, config_path: "/owned/project/runner.json" } as Awaited<ReturnType<typeof enableSemanticSupervisedExecution>>);
    return input;
  }

  it("rechecks a corrected writer in the same conversation, retaining separate execution consent", async () => {
    const input = fixture();
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValueOnce(new Error("Writer lacks UPDATE on inventory.requests.quantity."));
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("retry");
    expect((await reviewSemanticSupervisedExecution(input))?.tone).toBe("success");
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledTimes(2);
    expect(input.session.confirmActivation).toHaveBeenCalledOnce();
    expect(enableSemanticSupervisedExecution).toHaveBeenCalledOnce();
    expect(input.session.chooseOption).toHaveBeenCalledWith("Execution needs a deployment fix", expect.any(Array),
      expect.objectContaining({ context: expect.arrayContaining([expect.stringContaining("UPDATE on inventory.requests.quantity")]) }));
  });

  it("keeps a failed prerequisite inspectable and pauses without activating or retrying implicitly", async () => {
    const input = fixture();
    vi.mocked(previewSemanticSupervisedExecution).mockRejectedValue(new Error("Writer credential is not configured."));
    vi.mocked(input.session.chooseOption!).mockResolvedValueOnce("details").mockResolvedValueOnce("pause");
    const result = await reviewSemanticSupervisedExecution(input);
    expect(result?.footer).toContain("same start command");
    expect(input.session.showReviewDetails).toHaveBeenCalledOnce();
    expect(previewSemanticSupervisedExecution).toHaveBeenCalledOnce();
    expect(input.session.confirmActivation).not.toHaveBeenCalled();
    expect(enableSemanticSupervisedExecution).not.toHaveBeenCalled();
  });
});
