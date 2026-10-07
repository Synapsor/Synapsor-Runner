import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AuthoringInterruptedRecoveryPreview, AuthoringManualRecoveryPreview,
  AuthoringTransportOperation, AuthoringTransportState } from "./authoring-generation-recovery.js";
import { assertRecoveryResponse, recoveryViewBinding, type AuthoringRecoveryView,
  type AuthoringRecoveryResponse } from "./authoring-recovery-interaction.js";

type Digest = `sha256:${string}`;
export type AuthoringRecoveryInspection = {
  resume: Digest; digest: Digest; recovery: AuthoringTransportState | undefined;
  business: readonly string[]; retained: readonly string[];
};
export type AuthoringRecoveryHostAccess = {
  inspect(): Promise<AuthoringRecoveryInspection>;
  unresolved(state: AuthoringTransportState | undefined): readonly AuthoringTransportOperation[];
  prepareInterrupted(resume: Digest, operation?: string): Promise<AuthoringInterruptedRecoveryPreview>;
  prepareManual(resume: Digest): Promise<AuthoringManualRecoveryPreview>;
  hasRemainingOwner(inspection: AuthoringRecoveryInspection, preview: AuthoringInterruptedRecoveryPreview): boolean | Promise<boolean>;
  /** Recheck inspected state inside the real mutation lease, then use native
   * preview/CAS recording. Never hold a permit across an interaction. */
  recordInterrupted(preview: AuthoringInterruptedRecoveryPreview,
    mode: "linked_generation" | "local_review", inspection: Digest): Promise<void>;
  recordManual(preview: AuthoringManualRecoveryPreview, inspection: Digest): Promise<void>;
};

export function createAuthoringRecoveryHost(input: {
  access: AuthoringRecoveryHostAccess;
  interact(view: AuthoringRecoveryView): Promise<AuthoringRecoveryResponse>;
}) {
  const { access } = input;
  const current = async (snapshot: AuthoringRecoveryInspection) => {
    const next = await access.inspect();
    if (next.resume !== snapshot.resume || next.digest !== snapshot.digest
      || canonicalJsonDigest(next.recovery ?? null) !== canonicalJsonDigest(snapshot.recovery ?? null))
      throw new Error("AUTHORING_RECOVERY_CONTEXT_CHANGED: Saved work changed during recovery review. Reopen its current state; no stale decision was recorded.");
  };
  const interact = async (snapshot: AuthoringRecoveryInspection, view: AuthoringRecoveryView) => {
    const response = await input.interact(view);
    assertRecoveryResponse(view, response);
    await current(snapshot);
    return response;
  };
  const context = (snapshot: AuthoringRecoveryInspection) => [
    ...snapshot.business,
    "The earlier result remains uncertain. Runner will not accept its late output or mark it completed.",
    "Original attempts, possible charges, saved answers and limits remain recorded. This review sends no provider request and grants no publication or execution authority.",
  ];
  return {
    async review(kind: "interrupted" | "manual"): Promise<"pending" | "recorded"> {
      const snapshot = await access.inspect();
      let selected: string | undefined;
      if (kind === "interrupted") {
        const unresolved = access.unresolved(snapshot.recovery);
        if (!unresolved.length) {
          await interact(snapshot, { kind:"details",
            binding:recoveryViewBinding({purpose:"saved_work_only",inspection:snapshot.digest,resume:snapshot.resume}),
            title:"Review current saved work", lines:context(snapshot),
            details:["No selectable unfinished operation remains for another recovery permission.",
              "Reopen current saved-work review. An exhausted or unavailable continuation grants no new allowance; a separate job requires its ordinary reviews.",...snapshot.retained] });
          return "pending";
        }
        if (unresolved.length > 1) {
          const view: AuthoringRecoveryView = { kind: "select",
            binding: recoveryViewBinding({ inspection: snapshot.digest, resume: snapshot.resume,
              state: snapshot.recovery, operations: unresolved.map(op => op.id) }),
            title: "REVIEW RETAINED UNFINISHED STEPS", lines: context(snapshot), details: [],
            options: [...unresolved.map((op, index) => ({ value: op.id,
              label: `Inspect unfinished recorded step ${index + 1}`,
              detail: `Exact operation: ${op.id}; current state: ${op.state}` })),
              { value: "pause", label: "Keep all steps pending" }] };
          const response = await interact(snapshot, view);
          if (response.kind !== "choice" || !response.value || response.value === "pause") return "pending";
          selected = response.value;
        }
        const preview = await access.prepareInterrupted(snapshot.resume, selected);
        await current(snapshot);
        const ownsAllowance = await access.hasRemainingOwner(snapshot, preview);
        await current(snapshot);
        const canContinue = preview.unresolved_operation_count === 1 && preview.remaining_attempts > 0 && ownsAllowance;
        const binding = recoveryViewBinding({ inspection: snapshot.digest, resume: snapshot.resume, preview });
        const details = [`Saved job revision: ${snapshot.resume}`, `Current inspected state: ${snapshot.digest}`,
          `Interrupted operation: ${preview.operation_id}; attempt: ${preview.attempt_id}`,
          `Remaining attempts in this generation chain: ${preview.remaining_attempts}`,
          ...(!ownsAllowance ? ["No remaining saved provider allowance owns this exact step. Current saved-work review remains available; it grants no new episode."] : []),
          ...(!preview.remaining_attempts ? ["This unfinished generation has no remaining same-step attempt. Inspect or review current saved work; starting a separate job is a distinct task with its own required reviews."] : []),
          "The original response and local save outcome are not acknowledged by this review.", ...snapshot.retained];
        let mode: "linked_generation" | "local_review";
        while (true) {
          const view: AuthoringRecoveryView = { kind: "mode", binding,
            title: "REVIEW INTERRUPTED BUSINESS STEP", lines: context(snapshot), details,
            options: [{ value: "details", label: "Inspect saved work and the interrupted step" },
              ...(canContinue ? [{ value: "continue", label: "Continue this unfinished step within its remaining limits" }] : []),
              { value: "review", label: "Retain the interruption and review current saved work" },
              { value: "pause", label: "Keep the step pending" }] };
          const response = await interact(snapshot, view);
          if (response.kind !== "choice" || !response.value || response.value === "pause") return "pending";
          if (response.value === "details") {
            await interact(snapshot, { ...view, kind: "details", title: "Interrupted step and exact saved state" });
            continue;
          }
          mode = response.value === "continue" ? "linked_generation" : "local_review";
          break;
        }
        const response = await interact(snapshot, { kind: "confirm",
          binding: recoveryViewBinding({ purpose: "interrupted_recovery_decision", binding, mode }),
          title: "Stop accepting the interrupted result and record recovery of this exact unfinished step?",
          lines: [...context(snapshot), mode === "linked_generation"
            ? "Ordinary continuation reconstructs a linked request from current saved work using the same owning allowance. It does not replay accepted callbacks or ended output."
            : "Local review grants no provider continuation. Reopen current saved-work review; an unavailable or exhausted allowance remains unavailable."],
          details, defaultValue: false });
        if (response.kind !== "decision" || response.accepted !== true) return "pending";
        await access.recordInterrupted(preview, mode, snapshot.digest);
        return "recorded";
      }
      const preview = await access.prepareManual(snapshot.resume);
      await current(snapshot);
      const response = await interact(snapshot, { kind: "confirm",
        binding: recoveryViewBinding({ purpose: "manual_replacement_decision", inspection: snapshot.digest, resume: snapshot.resume, preview }),
        title: "The provider outcome is unknown and the request may have been charged. Runner has not accepted a response from this attempt. Preserve the saved work and permit one replacement generation?",
        lines: [...context(snapshot),
          "One exact replacement uses the same operation and remaining allowance. It may incur an additional charge; normal funding and currentness checks still apply.",
          "If the ended request cannot be reconstructed identically, use Review the interrupted business step for a separate explicit linked-continuation decision. This permission does not convert automatically."],
        details: [`Operation: ${preview.operation_id}; attempt: ${preview.attempt_id}`,
          `Saved job revision: ${snapshot.resume}`, ...snapshot.retained], defaultValue: false });
      if (response.kind !== "decision" || response.accepted !== true) return "pending";
      await access.recordManual(preview, snapshot.digest);
      return "recorded";
    },
  };
}
