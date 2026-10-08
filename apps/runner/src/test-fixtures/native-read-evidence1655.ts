/** Independent reviewer fixture: records are produced through the public Read
 * host in distinct child processes. The existing responder consumes only its
 * actual request catalog/answer references and declared operator facts. No
 * completed mapping, question, confirmation or authority is seeded here. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BoundaryAuthoringResumeState } from "../boundary-authoring-resume.js";
import type { PolicySourceSession } from "../authoring-policy-source.js";
import { loadBoundaryReviewContext } from "../boundary-review-context.js";
import { listReadWorkloadAnalyses } from "../read-workloads.js";
import { readWorkloadCatalog } from "../read-workload-model.js";
import { inputProcessRuntime, runAuthoringProcess } from "./source-input-process-driver.js";

export type NativeReadEvidenceProcess1655 = {
  pid: number; state: string; code: number;
  counts: { requests: number; readRequests: number; narrations: number; prompts: number;
    confirmations: number; pendingViews: number; acceptedReturns: number };
  resume: BoundaryAuthoringResumeState; sources: PolicySourceSession;
  frames: Array<{ body: unknown; reply?: unknown }>; transcript: string;
};

export async function nativeReadEvidence1655() {
  const cwd = fileURLToPath(new URL("../../../../", import.meta.url));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-independent-current-read-"));
  const runtime = await inputProcessRuntime(cwd, root, path.join(root, "captures"));
  const projectRoot = path.join(root, "program");
  const pending = await runAuthoringProcess<NativeReadEvidenceProcess1655>(runtime,
    "source-read-process.ts", projectRoot, "start", "confirmed");
  const pendingContext = await loadBoundaryReviewContext(projectRoot);
  const pendingWorkloads = await listReadWorkloadAnalyses({ projectRoot, generatedBoundary: pendingContext.candidate });
  const mapped = await runAuthoringProcess<NativeReadEvidenceProcess1655>(runtime,
    "source-read-process.ts", projectRoot, "restart", "returned");
  const context = await loadBoundaryReviewContext(projectRoot);
  const workloads = await listReadWorkloadAnalyses({ projectRoot, generatedBoundary: context.candidate });
  return { root, projectRoot, pending, pendingContext, pendingWorkloads, mapped, context, workloads,
    catalog: readWorkloadCatalog(context.candidate) };
}
