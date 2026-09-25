import fs from "node:fs/promises";
import path from "node:path";
import type { LocalProposalState, ProposalRuntimeStore } from "@synapsor-runner/proposal-store";
import type { ActionRuleAuthorityActivationV1, ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { readLedgerRuntimeConfig } from "./cli-project.js";
import { createProjectRuntimeStore } from "./control-policy-store.js";
import { SEMANTIC_ACTION_RUNTIME_CONFIG } from "./semantic-action-deployment.js";
import { cliCommandName } from "./cli-command-meta.js";

const PAGE_LIMIT = 200;
const pendingStates: LocalProposalState[] = ["pending_review", "approved", "pending_worker", "reconciliation_required"];
type Impact = { checked_at: string; complete: boolean; pending: number; awaiting_review: number; approved_or_running: number;
  reconciliation: number; examples: string[]; unqueued: number; queued: number; other_queue_state: number; queue_unknown: number };

/** Bounded operator-only inventory. No customer rows, tool egress or proposal mutation. */
export async function inspectActionRevisionImpact(input: {
  store: Pick<ProposalRuntimeStore, "listProposals" | "getWorkerQueueItem">;
  previousDigest: string;
}): Promise<Impact> {
  if (!input.store.listProposals) throw new Error("PENDING_REQUEST_INSPECTION_UNAVAILABLE");
  const result: Impact = { checked_at: new Date().toISOString(), complete: true, pending: 0,
    awaiting_review: 0, approved_or_running: 0, reconciliation: 0, examples: [],
    unqueued: 0, queued: 0, other_queue_state: 0, queue_unknown: 0 };
  const observed = new Map<string, LocalProposalState>();
  for (const state of pendingStates) {
    const rows = await input.store.listProposals({ state, limit: PAGE_LIMIT + 1 });
    if (rows.length > PAGE_LIMIT) result.complete = false;
    for (const proposal of rows.slice(0, PAGE_LIMIT)) {
      const change = proposal.change_set;
      if (!("semantic_authority" in change) || change.semantic_authority?.proof.action_boundary_digest !== input.previousDigest) continue;
      // A request can transition while the bounded pages are being read.
      observed.set(proposal.proposal_id, state);
    }
  }
  result.pending = observed.size;
  for (const [id, state] of observed) {
    if (state === "pending_review") result.awaiting_review++;
    else if (state === "reconciliation_required") result.reconciliation++;
    else result.approved_or_running++;
    if (result.examples.length < 12) result.examples.push(id);
    if (!input.store.getWorkerQueueItem) {
      result.queue_unknown++;
      continue;
    }
    // Approval alone does not establish queue admission or whether work was dispatched.
    const queue = await input.store.getWorkerQueueItem(id);
    if (queue && queue.proposal_id !== id) result.queue_unknown++;
    else if (!queue && (state === "pending_review" || state === "approved")) result.unqueued++;
    else if (queue && (state === "approved" || state === "pending_worker")
      && (queue.status === "queued" || queue.status === "retry_wait")) result.queued++;
    else result.other_queue_state++;
  }
  return result;
}

export function actionRevisionImpactLines(impact?: Impact): string[] {
  return [impact
    ? `Existing requests: ${impact.complete ? "" : "at least "}${impact.pending} tied to the previous rules (${impact.awaiting_review} awaiting review, ${impact.approved_or_running} approved or in progress, ${impact.reconciliation} needing a receipt check).`
    : "Existing requests: not checked. Inspect the request queue before replacing rules if work may be in progress.",
  "Earlier requests and approvals are not rewritten. No request is rejected or cancelled by this review.",
  ...(impact?.unqueued ? [`${impact.unqueued} awaiting review or approved without a worker queue item. To retire one before re-submitting, review its details, then use ${cliCommandName()} proposals reject <reference> --reason "<reviewed reason>" --yes --config ./${SEMANTIC_ACTION_RUNTIME_CONFIG}.`] : []),
  ...(impact?.queued ? [`${impact.queued} queued or waiting to retry. If a separately authorized worker-control actor is configured, that actor may use ${cliCommandName()} worker cancel <reference> --yes --config ./${SEMANTIC_ACTION_RUNTIME_CONFIG} before the next lease. This preview does not establish that actor.`] : []),
  ...(impact?.other_queue_state ? [`${impact.other_queue_state} with dispatched, terminal, uncertain or inconsistent queue state; inspect request details and receipts before choosing a recovery.`] : []),
  ...(impact?.queue_unknown ? [`For ${impact.queue_unknown} requests, queue state could not be established; inspect request details and receipts before choosing a recovery.`] : []),
  "Any later decision rechecks the request state and required operator authorization; the snapshot is not permission to act.",
  "A change already dispatched may finish under its admitted rules. Check its receipt before retrying; replacement never undoes a completed database change.",
  `From the project directory, inspect each request with ${cliCommandName()} proposals show <reference> --details --config ./${SEMANTIC_ACTION_RUNTIME_CONFIG}.`,
  ...(impact ? [`Queue snapshot: ${impact.checked_at}. ${impact.complete ? "The queue can change after this check." : "Bounded preview; inspect the request queue for the remaining entries."}`,
    ...(impact.examples.length ? [`Request references: ${impact.examples.join(", ")}.`] : [])] : []),
  ];
}

export async function reviewActionRevisionImpact(input: {
  projectRoot: string; active?: ActionRuleAuthorityActivationV1; draft?: ActionRuleAuthorityDraftV1; env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  if (!input.active || !input.draft || input.active.authority.action_boundary.digest === input.draft.authority.action_boundary.digest) return [];
  let store: ProposalRuntimeStore | undefined;
  try {
    const configPath = path.join(input.projectRoot, SEMANTIC_ACTION_RUNTIME_CONFIG);
    const config = await readLedgerRuntimeConfig(configPath, { env: input.env });
    const env = input.env ?? process.env;
    const storePath = env.SYNAPSOR_LOCAL_STORE ? path.resolve(env.SYNAPSOR_LOCAL_STORE)
      : path.resolve(input.projectRoot, config.storage?.sqlite_path ?? ".synapsor/local.db");
    // A missing ledger is not evidence that no requests exist. Never create one for review.
    if (!config.storage?.shared_postgres) await fs.stat(storePath);
    store = await createProjectRuntimeStore({ projectRoot: input.projectRoot, config, storePath, env: input.env });
    return actionRevisionImpactLines(await inspectActionRevisionImpact({ store, previousDigest: input.active.authority.action_boundary.digest }));
  } catch {
    return actionRevisionImpactLines();
  } finally {
    try { await store?.close(); } catch { /* Review must not strand the pending authority decision on disconnect. */ }
  }
}
