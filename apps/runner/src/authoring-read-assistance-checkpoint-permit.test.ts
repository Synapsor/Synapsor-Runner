import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createReadAssistanceCheckpointHost, type ReadAssistanceCheckpointAccess } from "./authoring-read-assistance-checkpoint-host.js";
import { createReadRevisionCheckpointHost } from "./authoring-read-revision-checkpoint-host.js";
import { readBoundaryRevisionCheckpoint } from "./read-boundary-revision-checkpoint.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-checkpoint-real-permit-"));
  await fs.chmod(root, 0o700); roots.push(root);
  const prepared = await prepareReviewedReadScope(root, { resources: ["work.items"], field: "label",
    review: { allow_reviewed_fields: ["label"] } });
  const before = await loadBoundaryReviewContext(root);
  let held: ProjectAuthorityMutationPermit | undefined, seen: ProjectAuthorityMutationPermit | undefined;
  let resolved = 0;
  const unexpected = () => { throw new Error("UNEXPECTED_MUTATION_BEFORE_ACCEPTED_MAPPING"); };
  const access: ReadAssistanceCheckpointAccess = {
    mutate: operation => withProjectAuthorityMutation(root, async permit => {
      held = permit;
      try { return await operation(permit); } finally { held = undefined; }
    }),
    scopeDigest: () => canonicalJsonDigest("current Read operation"),
    contextDigest: async permit => { expect(permit).toBe(held); return canonicalJsonDigest("current Source context"); },
    currentCandidate: async (permit?: ProjectAuthorityMutationPermit) => {
      seen = permit;
      // The real native reader acquires its protected scope. Omitting the held
      // permit causes POLICY_MUTATION_BUSY before it can return this candidate.
      const current = await loadBoundaryReviewContext(root, permit);
      expect(permit).toBe(held); resolved++;
      return current.bundle;
    },
    readCheckpoint: () => undefined, readHandoffs: () => [], readQuestions: () => [],
    readRecovery: () => undefined, readConversation: () => undefined,
    readReviewedRelationshipAnswer: () => undefined,
    install: unexpected, storeAnalysis: async () => unexpected(), appendSourceMessage: async () => unexpected(),
    save: async () => unexpected(), checkpointFailure: () => new Error("EXPECTED_PENDING_WITHOUT_ACCEPTED_MAPPING"),
  };
  const host = createReadAssistanceCheckpointHost({ access });
  const revisionHost = createReadRevisionCheckpointHost({ access: {
    mutate: access.mutate, scopeDigest: access.scopeDigest, contextDigest: access.contextDigest, currentCandidate: access.currentCandidate,
    readRevision: () => ({instruction:"Review current label visibility",provenance:"operator",privacy_only:true}),
    readInstruction: () => "Review current label visibility", readHandoffs: access.readHandoffs, readRecovery: access.readRecovery,
    readConversation: access.readConversation, install: unexpected, appendSourceMessage: access.appendSourceMessage,
    save: access.save, checkpointFailure: access.checkpointFailure,
  } });
  return { root, before, candidate: prepared.context.candidate, host, revisionHost, resolved: () => resolved, held: () => held, seen: () => seen };
}
it("forwards the actual held authority permit through the Read checkpoint's native candidate reader", async () => {
  const f = await fixture();
  await expect(f.host.persist(undefined, f.candidate)).rejects.toThrow("EXPECTED_PENDING_WITHOUT_ACCEPTED_MAPPING");
  expect(f.resolved()).toBe(1); expect(f.seen()).toBeDefined(); expect(f.held()).toBeUndefined();
  expect(await loadBoundaryReviewContext(f.root)).toEqual(f.before);
});
it("keeps the candidate-currentness fence after the native reader reuses the exact held permit", async () => {
  const f = await fixture(), changed = structuredClone(f.candidate);
  changed.budgets.max_rows = changed.budgets.max_rows + 1;
  await expect(f.host.persist(undefined, changed)).rejects.toThrow("READ_WORKLOAD_ASSISTANCE_CHECKPOINT_STALE");
  expect(f.resolved()).toBe(1); expect(f.held()).toBeUndefined();
  expect(await loadBoundaryReviewContext(f.root)).toEqual(f.before);
});

it("forwards the actual held authority permit through the Read revision checkpoint's native candidate reader", async () => {
  const f = await fixture();
  const checkpoint = readBoundaryRevisionCheckpoint({ input_digest: canonicalJsonDigest("declared edit input"),
    boundary_digest: canonicalJsonDigest(f.candidate), catalog_digest: canonicalJsonDigest("declared catalog"),
    tool_digest: canonicalJsonDigest("declared tool"), stage: "dispatching", dispatch_question: "Review current label visibility",
    state: {call_count:1,correction_used:false,prerequisite_review_failed:false,issue:"",clarification_count:0,clarification_answers:[],private_decisions:[]} });
  // This is a prospective dispatch shape, not a fabricated provider response.
  // Stop before install/save after proving the real native protected read.
  await expect(f.revisionHost.persist(checkpoint,f.candidate)).rejects.toThrow("UNEXPECTED_MUTATION_BEFORE_ACCEPTED_MAPPING");
  expect(f.resolved()).toBe(1);expect(f.seen()).toBeDefined();expect(f.held()).toBeUndefined();
  expect(await loadBoundaryReviewContext(f.root)).toEqual(f.before);
});
