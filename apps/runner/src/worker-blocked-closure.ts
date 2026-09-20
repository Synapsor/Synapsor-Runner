import { createProjectRuntimeStore } from "./control-policy-store.js";
import { Pool } from "pg";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { sourceRollbackBinding } from "@synapsor-runner/worker-core";
import { ProposalStore, blockedClosureDecisionReason, type BlockedClosureAssessment, type BlockedClosureSourceObservation } from "@synapsor-runner/proposal-store";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { optionalArg, positional } from "./cli-options.js";
import { assertGovernedLocalRuntimeStore, runtimeStoreBridgeRequired, argsWithRuntimeStoreBridge,
  withSharedPostgresRuntimeStoreBridge, withSharedPostgresRuntimeStoreReadBridge } from "./store-shared.js";
import { withRuntimeConfigAdmission, runnerConfigPath, resolvedRuntimeStorePath, openLocalStoreAt, confirmDangerousAction, operatorIdentityForDecision } from "./cli-project.js";
import { cliCommandName } from "./cli-command-meta.js";

const ident = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;

/** Read-only contradiction check, outside the control-store writer lock. Receipt
 * absence supplements producer finality; it never creates finality evidence. */
export async function inspectBlockedClosureSource(input: {
  assessment: BlockedClosureAssessment; job: { source_id: string; idempotency_key: string };
  producer: Record<string, unknown>; env?: NodeJS.ProcessEnv;
}): Promise<BlockedClosureSourceObservation> {
  const a = input.assessment;
  const unavailable: BlockedClosureSourceObservation = { assessment_digest: a.assessment_digest,
    source_binding_digest: a.source_binding_digest ?? "", state: "unavailable" };
  const reference = input.producer.writer_reference, ns = input.producer.receipt_namespace as { schema?: unknown; table?: unknown } | undefined;
  if (typeof reference !== "string" || !ident.test(reference) || !ns || typeof ns.schema !== "string" || typeof ns.table !== "string"
    || !ident.test(ns.schema) || !ident.test(ns.table)) return unavailable;
  const url = (input.env ?? process.env)[reference];
  if (!url) return unavailable;
  const binding = sourceRollbackBinding({ databaseUrl: url, engine: "postgres", sourceId: input.job.source_id,
    receipts: { authority: "source_db", provisioning: "precreated", schema: ns.schema, table: ns.table } });
  if (!binding || binding !== a.source_binding_digest) return { ...unavailable, source_binding_digest: binding ?? "" };
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000, statement_timeout: 3000, query_timeout: 4000 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      // A filtered view, RLS table or shadow relation cannot prove complete absence.
      const relation = await client.query(`SELECT c.relkind, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`, [ns.schema, ns.table]);
      if (relation.rows.length !== 1 || relation.rows[0].relkind !== "r" || relation.rows[0].relrowsecurity) return unavailable;
      const result = await client.query(`SELECT job_id, proposal_id, status FROM ${quote(ns.schema)}.${quote(ns.table)} WHERE idempotency_key=$1 LIMIT 2`, [input.job.idempotency_key]);
      return { ...unavailable, state: result.rows.length ? "present" : "absent" };
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
  } catch { return unavailable; }
  finally { await pool.end().catch(() => undefined); }
}

export function blockedClosureLines(a: BlockedClosureAssessment): string[] {
  return ["CLOSE BLOCKED WORK — administrative resolution only", `Request: ${a.proposal_id}`,
    `Recorded failure: ${a.recorded_error ?? "unavailable"}`, `Closure: ${a.status} (${a.code})`,
    `Effect: ${a.status === "available" || a.status === "closed" ? "producer-proven whole-transaction rollback" : "not established for closure"}`,
    ...(a.receipt_hash ? [`Failed receipt: ${a.receipt_hash}`, `Producer event: ${a.producer_event_id}`] : []),
    `Assessment: ${a.assessment_digest}`, "Result: worker discarded/closed; original proposal and failed receipt stay failed.",
    "Old work will never retry. Closing does not undo a source change.",
    "The approval remains counted until its normal window expires; no refund.",
    "A fresh Explore reference and request are separate, subject to current rules and approval.",
    a.status === "available" ? "Default: cancel. Confirm only this exact assessment." :
      "Next: inspect worker dead-letter show and the exact source outcome; do not retry uncertain work."];
}

/** Each bridge phase finishes before source I/O or operator confirmation. */
async function withStore<T>(args: string[], config: RuntimeConfig, write: boolean, operation: (store: ProposalStore) => Promise<T>): Promise<T> {
  if (runtimeStoreBridgeRequired(args, config)) {
    const bridge = write ? withSharedPostgresRuntimeStoreBridge : withSharedPostgresRuntimeStoreReadBridge;
    return bridge(args, config, "worker close-blocked", p => withStore(argsWithRuntimeStoreBridge(args, p), config, write, operation));
  }
  const configPath = runnerConfigPath(args), storePath = resolvedRuntimeStorePath(args, configPath, config.storage?.sqlite_path);
  await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath, readOnly: !write });
  const store = await openLocalStoreAt(storePath);
  try {
    await assertGovernedLocalRuntimeStore({ args, config, configPath, storePath, store, readOnly: !write });
    return await operation(store);
  } finally { store.close(); }
}

export async function workerCloseBlocked(args: string[]): Promise<number> {
  const proposalId = positional(args, 0), configPath = runnerConfigPath(args);
  if (!proposalId) throw new Error("worker close-blocked requires <proposal_id>; preview is read-only by default");
  const preview = await withRuntimeConfigAdmission(configPath, async config => {
    const state = await withStore(args, config, false, async store => {
      const assessment = store.assessBlockedWorkerClosure(proposalId);
      return { assessment, proposal: store.getProposal(proposalId), job: store.listWritebackJobs({ proposal_id: proposalId })[0]?.normalized_job,
        producer: store.events(proposalId).find(e => e.event_id === assessment.producer_event_id)?.payload,
        closedSource: store.events(proposalId).find(e => e.event_id === assessment.closure_event_id)?.payload.source as BlockedClosureSourceObservation | undefined,
        authDigest: canonicalJsonDigest(config.operator_identity ?? null) };
    });
    const source = state.assessment.status === "source_check_required" && state.job && state.producer
      ? await inspectBlockedClosureSource({ assessment: state.assessment, job: state.job, producer: state.producer }) : state.closedSource;
    const assessment = source ? await withStore(args, config, false, async store => store.assessBlockedWorkerClosure(proposalId, source)) : state.assessment;
    return { ...state, assessment, source };
  });
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(preview.assessment, null, 2)}\n` : `${blockedClosureLines(preview.assessment).join("\n")}\n`);
  if (!args.includes("--confirm")) return ["available", "closed"].includes(preview.assessment.status) ? 0 : 2;
  if (!["available", "closed"].includes(preview.assessment.status)) return 2;
  const reason = optionalArg(args, "--reason")?.trim();
  if (!reason || reason.length > 240) throw new Error("worker close-blocked --confirm requires --reason (1–240 characters)");
  const exact = optionalArg(args, "--assessment");
  if (exact !== preview.assessment.assessment_digest) {
    throw new Error("BLOCKED_CLOSURE_CONFIRMATION_MISMATCH: preview again and supply its exact --assessment digest");
  }
  await confirmDangerousAction(args, "Close only this proven-no-effect item? Default: cancel.");
  const result = await withRuntimeConfigAdmission(configPath, async (config, projectRoot) => {
    if (canonicalJsonDigest(config.operator_identity ?? null) !== preview.authDigest) throw new Error("BLOCKED_CLOSURE_OPERATOR_CONFIGURATION_CHANGED");
    if (!preview.proposal) throw new Error("BLOCKED_CLOSURE_RECORDS_UNAVAILABLE");
    // Signature/JWT resolution can involve I/O; finish it before taking a writer lock.
    const identity = await operatorIdentityForDecision({ args, config, configPath, proposal: preview.proposal, action: "worker_discard",
      reason: blockedClosureDecisionReason(preview.assessment.assessment_digest, reason) });
    if (!identity.verified) throw new Error("BLOCKED_CLOSURE_VERIFIED_OPERATOR_REQUIRED");
    const store = await createProjectRuntimeStore({ projectRoot, config,
      storePath: resolvedRuntimeStorePath(args, configPath, config.storage?.sqlite_path) });
    try {
      if (!store.closeBlockedWorkerItem) throw new Error("BLOCKED_CLOSURE_STORE_UNSUPPORTED");
      return await store.closeBlockedWorkerItem({ proposalId, assessment_digest: preview.assessment.assessment_digest,
        source: preview.source ?? { assessment_digest: preview.assessment.assessment_digest, source_binding_digest: "", state: "unavailable" }, identity, reason });
    } finally { await store.close(); }
  });
  process.stdout.write(args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` :
    `Closed ${proposalId}. Original failure and approval remain recorded. No replacement was approved.\nInspect: ${cliCommandName()} worker dead-letter show ${proposalId} --config ${configPath}\n`);
  return 0;
}
