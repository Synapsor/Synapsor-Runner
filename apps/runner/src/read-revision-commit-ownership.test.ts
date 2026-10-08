import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { applyModelReadBoundaryExposureRevision, prepareModelReadBoundaryExposureRevision } from "./boundary-commands.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

it("a protected disabled Read revision does not invent a workload or its grouped confirmation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-revision-commit-owner-")); roots.push(root);
  const f = await prepareReviewedReadScope(root);
  const revision = { changes: [], policy_changes: [{ resource: "work.items",
    settings: { field_metadata: [{ field: "label", label: "Customer item label" }] } }] };
  const input = { projectRoot: root, schemaInspector: async () => f.inspection, context: f.context, revision };
  const preview = await prepareModelReadBoundaryExposureRevision(input);
  const saved = await applyModelReadBoundaryExposureRevision({ ...input, preview });
  expect(saved.context.bundle.candidate_digest).toBe(saved.committed.candidate_digest);
  expect(saved.context.candidate.pack.resources[0]!.field_metadata?.label?.label).toBe("Customer item label");
  expect(saved.committed.authority_activated).toBe(false);
  expect(saved.committed.source_database_changed).toBe(false);
  // Structural save consent is not an answer to a Read scope question. This
  // invocation supplied no workload, model completion or grouped confirmation.
  expect(saved.committed).not.toHaveProperty("review");
  expect(saved).not.toHaveProperty("workload");
  await expect(fs.access(path.join(root, ".synapsor/read-workloads"))).rejects.toMatchObject({ code: "ENOENT" });
});
