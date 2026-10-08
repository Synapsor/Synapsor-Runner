import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, assertBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

const digest = canonicalJsonDigest("R2 owned retained Action mode fixture");
const protocol = { version: "synapsor.structured-authoring.v1" as const };
const intent = "Retain the unfinished declared business action.";
const base = { binding: { boundary_name: "r2_retained", generation_lock_fingerprint: digest, schema_fingerprint: digest, role_posture_fingerprint: digest },
  stage: "planning" as const, jobIntent: "Review the declared synthetic task.", provider: "openai" as const, model: "offline-only" };
const checkpoint = (structured: boolean) => actionRuleAuthoringCheckpoint({ intent_digest: canonicalJsonDigest(intent), context_digest: digest,
  components: {}, ...(structured ? { authoring_protocol: protocol } : {}) });
const addition = (structured: boolean) => ({ policy_source_digest: digest, source_ranges: [{ start: 1, end: 1 }], retained_action: { intent, checkpoint: checkpoint(structured) } });
const envelope = (structured: boolean) => buildBoundaryAuthoringResumeState({ ...base,
  ...(structured ? { authoringProtocol: protocol } : {}), pendingActionAddition: addition(structured) });
function substituteRetainedCheckpoint(value: ReturnType<typeof envelope>, structured: boolean) {
  const copy = JSON.parse(JSON.stringify(value));
  copy.pending_action_addition.retained_action.checkpoint = checkpoint(structured);
  const { revision_digest: _digest, ...body } = copy;
  return { ...body, revision_digest: canonicalJsonDigest(body) } as ReturnType<typeof envelope>;
}

describe("R2 B64 retained Action live mode binding", () => {
  it.each([true, false])("rejects mixed retained checkpoint before native save (outer structured: %s)", async structured => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "r2-b64-retained-"));
    const good = envelope(structured);
    let relative = "";
    let before = "";
    try {
      relative = await writeBoundaryAuthoringResumeState(root, good, { expectedRevisionDigest: null });
      before = await fs.readFile(path.join(root, relative), "utf8");
      const mixed = substituteRetainedCheckpoint(good, !structured);
      await expect(writeBoundaryAuthoringResumeState(root, mixed, { expectedRevisionDigest: good.revision_digest }))
        .rejects.toThrow("AUTHORING_PROTOCOL_CHANGE_REQUIRES_NEW_JOB");
      expect(await fs.readFile(path.join(root, relative), "utf8")).toBe(before);
      expect(() => assertBoundaryAuthoringResumeState(mixed)).toThrow("AUTHORING_PROTOCOL_CHANGE_REQUIRES_NEW_JOB");
    } finally {
      const out = process.env.R2_RETAINED_MODE_CAPTURE;
      if (out && relative) {
        const after = await fs.readFile(path.join(root, relative), "utf8");
        await fs.writeFile(path.join(out, `retained-${structured ? "structured" : "legacy"}.json`), JSON.stringify({
          fixture: "Fresh synthetic native checkpoint, no provider/evidence/answers/confirmation seeded", before, after,
          before_text_canonical_digest: canonicalJsonDigest(before), after_text_canonical_digest: canonicalJsonDigest(after), protected_bytes_unchanged: before === after,
        }, null, 2));
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])("retains matching mode without modifying either checkpoint (structured: %s)", structured => {
    const good = envelope(structured);
    const exact = JSON.stringify(good.pending_action_addition!.retained_action.checkpoint);
    expect(() => assertBoundaryAuthoringResumeState(JSON.parse(JSON.stringify(good)))).not.toThrow();
    expect(JSON.stringify(good.pending_action_addition!.retained_action.checkpoint)).toBe(exact);
    expect(good.pending_action_addition!.retained_action.checkpoint!.schema_version)
      .toBe(structured ? "synapsor.action-authoring-checkpoint.v2" : "synapsor.action-authoring-checkpoint.v1");
  });
});
