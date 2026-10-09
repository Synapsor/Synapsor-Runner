import { resolveSemanticSupervisedWriterSource, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SemanticSupervisedExecutionPreview } from "./semantic-action-deployment.js";
import type { SemanticReceiptSelection } from "./semantic-receipt-setup.js";

type Source = NonNullable<RuntimeConfig["sources"]>[string];
type ReceiptDestination = NonNullable<Source["receipts"]>;
type SetupInput = {
  source_name: string; source: Source; storage: RuntimeConfig["storage"];
  selection?: SemanticReceiptSelection; selection_state: "current" | "stale" | "proposed";
  support_reason?: "hard_limit_engine_unsupported";
};

const ledgerMeaning = "Runner ledger records acknowledged successes outside the Source transaction. An unknown COMMIT may remain unresolved; missing evidence does not prove rollback or authorize replay.";
const recoveryMeaning = "Exact lost-acknowledgment recovery requires the original operation, scope, effect and Source identity to match, retained receipt evidence, and the existing authorized idempotent reconciliation path. A matching row alone does not authorize adoption or replay.";

function sourceReceiptRequirements(source: Source) {
  return "A dedicated precreated receipt relation in the same Source database and transaction as the guarded effect; verify its schema and the effective writer's SELECT, INSERT and UPDATE on that exact relation."
    + (source.engine === "postgres" ? " PostgreSQL also requires USAGE on its schema." : "");
}

function storageReadback(input: SetupInput, receipts?: ReceiptDestination) {
  if (receipts?.authority === "source_db") return {
    authority: "source_db" as const, source: input.source_name,
    provisioning: receipts.provisioning ?? null, schema: receipts.schema ?? null, table: receipts.table ?? null,
    status: "not_verified_here" as const,
    requirements: sourceReceiptRequirements(input.source),
  };
  return {
    authority: "runner_ledger" as const, status: "not_verified_here" as const,
    configured_sqlite_path: input.storage?.sqlite_path ?? null,
    configured_shared_postgres: input.storage?.shared_postgres ? {
      mode: input.storage.shared_postgres.mode, url_env: input.storage.shared_postgres.url_env,
      schema: input.storage.shared_postgres.schema ?? null,
    } : null,
    requirements: "Uses the existing Runner evidence/job store. These are configured storage references, not a verified effective backend; no Source receipt table is required.",
  };
}

/** Informational projection only: never selection, capability, consent or recovery authority. */
export function semanticReceiptSetupReadback(input: SetupInput) {
  const origin = input.selection ? "reviewed_selection" as const
    : input.source.receipts ? "existing_configuration" as const : "new_setup" as const;
  const receipts = input.selection?.receipts ?? input.source.receipts;
  const recommendation = input.support_reason
    ? "This hard-limit Source profile is unsupported. No receipt mode recommendation establishes support."
    : origin === "new_setup"
      ? "Source database receipts are recommended for new supported production writes and exact lost-acknowledgment recovery. This setup is NOT VERIFIED HERE; verify the Source, writer and receipt capability first."
      : "Retain the existing receipt mode and destination. This setup is NOT VERIFIED HERE; changing modes requires a separate explicit review.";
  return {
    schema_version: "synapsor.semantic-receipt-readback.v1" as const,
    informational_only: true as const,
    support: { status: "not_verified_here" as const, reason: input.support_reason ?? null },
    selection: { origin, state: input.selection ? input.selection_state : "unverified" as const,
      mode: receipts?.authority ?? null, write_url_env: input.selection?.write_url_env ?? input.source.write_url_env ?? null },
    recommendation, storage: storageReadback(input, receipts),
    runner_ledger_meaning: ledgerMeaning, source_db_recovery_meaning: recoveryMeaning,
    source_db_storage_requirements: sourceReceiptRequirements(input.source),
    source_db_choice_detail: origin === "new_setup" && !input.support_reason ? recommendation
      + " Precreated same-transaction receipt storage and separate administrator provisioning are required."
      : "Precreated receipt in the same Source transaction. NOT VERIFIED HERE; separate administrator provisioning and execution verification are required.",
  };
}

/** Consumes the existing execution preview; performs no inspection or mutation.
 * The result describes that preview only and cannot enable execution/recovery. */
export function semanticReceiptExecutionReadback(preview: SemanticSupervisedExecutionPreview) {
  const config = preview.config as RuntimeConfig;
  const source = resolveSemanticSupervisedWriterSource(config, preview.source, preview.policy);
  if (!source) return {
    schema_version: "synapsor.semantic-receipt-readback.v1" as const, informational_only: true as const,
    support: { status: "not_verified_here" as const, reason: "execution_preview_source_unresolved" as const },
    storage: null, meaning: "The execution preview's exact Source binding is unresolved. Storage and receipt capability are NOT VERIFIED HERE.",
  };
  const selected = source?.receipts ?? { authority: "runner_ledger" as const };
  const configuredPolicies = config.supervised_worker?.outcomes?.filter(policy => policy.outcome === preview.outcome) ?? [];
  const policyMatches = configuredPolicies.length === 1
    && canonicalJsonDigest(configuredPolicies[0]) === canonicalJsonDigest(preview.policy);
  const receiptsMatch = selected.authority === preview.receipts.authority
    && (selected.authority !== "source_db" || preview.receipts.authority === "source_db"
      && selected.provisioning === preview.receipts.provisioning
      && selected.schema === preview.receipts.schema && selected.table === preview.receipts.table);
  const writerMatches = preview.verification.writer.ok
    && preview.verification.writer.fingerprint === preview.writer_posture_fingerprint
    && preview.policy.writer_posture_fingerprint === preview.writer_posture_fingerprint
    && preview.policy.write_url_env === preview.write_url_env
    && preview.policy.outcome === preview.outcome
    && preview.policy.action_boundary_digest === preview.action_boundary_digest;
  const verified = Boolean(source && policyMatches && receiptsMatch && writerMatches
    && (preview.receipts.authority === "source_db"
      ? preview.verification.receipt_probe === "passed_rolled_back"
      : preview.verification.receipt_probe === "not_run_runner_ledger"));
  const setupReadback = semanticReceiptSetupReadback({ source_name: preview.source,
    source, storage: config.storage, selection_state: "proposed" });
  return {
    ...setupReadback,
    selection: { origin: "execution_preview" as const, state: "preview_only" as const,
      mode: preview.receipts.authority, write_url_env: preview.write_url_env },
    recommendation: verified
      ? "The existing execution preview verified this writer posture and, for Source database mode, the rolled-back receipt probe. This is not execution consent or a future recovery guarantee."
      : "This execution preview's receipt or writer binding is NOT VERIFIED HERE.",
    storage: { ...setupReadback.storage,
      status: verified && preview.receipts.authority === "source_db"
        ? "verified_by_existing_execution_preview" as const : "not_verified_here" as const },
    support: { status: verified ? "verified_by_existing_execution_preview" as const : "not_verified_here" as const,
      reason: verified ? null : "execution_preview_binding_unproven" as const },
    verification: { writer: verified ? "passed" as const : "unproven" as const,
      source_receipt: verified && preview.receipts.authority === "source_db" ? "passed_rolled_back" as const : "not_verified_here" as const },
    meaning: "Readback of the existing execution preview only. Receipt configuration, execution consent, retention and authorized recovery remain separate.",
  };
}
