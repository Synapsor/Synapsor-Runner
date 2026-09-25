import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { StoredApproval, StoredProposal, WorkerQueueItem } from "./domain-types.js";

/** Bind the decoded persisted state that the operator actually reviewed. */
export function localDelayedCancelPreviewDigest(input: {
  proposal: StoredProposal;
  queue: WorkerQueueItem | null;
  approvals: StoredApproval[];
}): `sha256:${string}` {
  return canonicalJsonDigest(JSON.parse(JSON.stringify(input)));
}
