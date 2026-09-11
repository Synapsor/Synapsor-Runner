import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";

export function assertReadPrerequisiteRetained(previous: ExplorationBoundaryDraft, next: ExplorationBoundaryDraft): void {
  if (previous.read_prerequisite && canonicalJsonDigest(previous.read_prerequisite) !== canonicalJsonDigest(next.read_prerequisite ?? null)) {
    throw new Error("READ_PREREQUISITE_REVISION_REQUIRED: This edit would change or remove the existing private access condition. Keep it unchanged while editing fields or rules; no saved or active authority was changed.");
  }
}
