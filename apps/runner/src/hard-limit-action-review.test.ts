import { beforeEach, expect, it, vi } from "vitest";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { HardLimitWriterSetupReadback } from "./hard-limit-writer-setup.js";
import type { HardLimitWriterReviewBinding } from "./hard-limit-writer-review-binding.js";

const inspect = vi.hoisted(() => vi.fn());
vi.mock("./semantic-action-deployment.js", () => ({ inspectSemanticActionActivationWriterSetup: inspect }));
import { reviewHardLimitActionWriter } from "./hard-limit-action-review.js";

beforeEach(() => vi.clearAllMocks());
function view(status: "ready" | "refused"): HardLimitWriterSetupReadback {
  return { status, requirements: [{ source: "credits", outcomes: ["credit.change"], engine: "postgres",
    namespace_relation: "pg_catalog.pg_namespace", privilege: "MAINTAIN", additional_powers: [] }],
    checks: [{ source: "credits", outcome: "credit.change", writer_env: "CREDIT_WRITER", writer_role: "credit_writer",
      status, ...(status === "refused" ? { reason_code: "namespace_maintain_missing" } : {}) }] };
}
function session() {
  return { rememberDetails: vi.fn(), showReviewDetails: vi.fn(async (_title: string, _lines: string[]) => {}) };
}
function input(s: ReturnType<typeof session>) {
  return { projectRoot: "/isolated/project", session: s as unknown as BoundaryReviewInteractiveSession } as Parameters<typeof reviewHardLimitActionWriter>[0];
}
it("shows the actual writer requirement and its breadth before allowing activation confirmation", async () => {
  const s = session();
  const writerReviewBinding = Object.freeze({}) as HardLimitWriterReviewBinding;
  inspect.mockResolvedValue({ ...view("ready"), writerReviewBinding });
  expect(await reviewHardLimitActionWriter(input(s))).toEqual({ ready: true, writerReviewBinding });
  expect(s.showReviewDetails).toHaveBeenCalledOnce();
  const lines = s.showReviewDetails.mock.calls[0]![1] as string[];
  expect(lines.some(line => line.includes('GRANT MAINTAIN ON TABLE pg_catalog.pg_namespace TO "credit_writer";'))).toBe(true);
  expect(lines.some(line => line.includes("entire pg_catalog.pg_namespace catalog table"))).toBe(true);
  expect(lines.some(line => line.includes("maintenance and all table lock modes"))).toBe(true);
  expect(lines.some(line => line.includes("no grant executed"))).toBe(true);
});
it("keeps a refused writer disabled and gives the same exact prerequisite", async () => {
  const s = session(); inspect.mockResolvedValue(view("refused"));
  expect(await reviewHardLimitActionWriter(input(s))).toEqual({ ready: false });
  expect(s.showReviewDetails).toHaveBeenCalledOnce();
  expect(s.showReviewDetails.mock.calls[0]![1]).toContain("No Action activation, execution approval, or Source change occurred.");
});
it("does not add a writer screen or consent to an ordinary Action", async () => {
  const s = session(); inspect.mockResolvedValue({ status: "not_required", requirements: [], checks: [] });
  expect(await reviewHardLimitActionWriter(input(s))).toEqual({ ready: true });
  expect(s.rememberDetails).not.toHaveBeenCalled(); expect(s.showReviewDetails).not.toHaveBeenCalled();
});
it("does not reduce a hard-limit native readback without its binding to a readiness boolean", async () => {
  const s = session(); inspect.mockResolvedValue(view("ready"));
  await expect(reviewHardLimitActionWriter(input(s))).rejects.toMatchObject({ code: "SEMANTIC_ACTION_WRITER_REVIEW_CHANGED" });
  expect(s.showReviewDetails).toHaveBeenCalledOnce();
});
