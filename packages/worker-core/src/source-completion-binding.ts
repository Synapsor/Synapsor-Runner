import { canonicalJsonDigest, parseSourceCompletionBinding, type SourceCompletionBinding, type WritebackJob } from "@synapsor-runner/protocol";
import type { RunnerConfig } from "./index.js";

/** Native admitted runtime context, never a public completion claim. Unsupported
 * destinations/configuration remain without positive recovery proof. This does
 * not change the deliberately narrower existing rollback binding. */
export function sourceCompletionBinding(job: WritebackJob, config: RunnerConfig): SourceCompletionBinding | undefined {
  const admission = config.sourceCompletionAdmission;
  if (!admission || job.engine !== "postgres" || config.engine !== "postgres" || config.sourceId !== job.source_id
    || config.receipts?.authority !== "source_db" || config.receipts.provisioning !== "precreated"
    || !config.receipts.schema || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.receipts.schema)
    || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.receipts.table ?? "synapsor_writeback_receipts")) return undefined;
  try {
    const u = new URL(config.databaseUrl);
    // pg resolves falsy URL users/ports from ambient PGUSER/PGPORT. Positive
    // recovery proof requires an explicit destination; ordinary execution is
    // unchanged when a legacy URL cannot provide this binding.
    if (!["postgres:", "postgresql:"].includes(u.protocol) || u.hash || !u.hostname || !u.username || !u.port || u.pathname.length < 2) return undefined;
    // One explicit Unix socket host is supported. Other URL option overrides
    // cannot supply an unambiguous safe destination binding for this version.
    const options = [...u.searchParams.entries()];
    if (options.length && (options.length !== 1 || options[0]![0] !== "host" || !options[0]![1].startsWith("/"))) return undefined;
    if (config.databaseScope && (String(job.target.tenant_guard?.value) !== config.databaseScope.tenantId
      || (job.target.principal_scope && String(job.target.principal_scope.value) !== config.databaseScope.principal))) return undefined;
    const destination = { engine: "postgres", source: job.source_id, host: options.length ? options[0]![1] : u.hostname.toLowerCase(),
      port: u.port, database: decodeURIComponent(u.pathname.slice(1)), role: decodeURIComponent(u.username),
      receipts: { schema: config.receipts.schema, table: config.receipts.table ?? "synapsor_writeback_receipts" },
      trusted_scope: config.databaseScope ?? null };
    const body = { schema_version: "synapsor.source-completion-binding.v1" as const, job_digest: canonicalJsonDigest(job),
      source_binding_digest: canonicalJsonDigest(destination), execution_binding_digest: admission.execution_binding_digest,
      writer_reference: admission.writer_reference };
    return parseSourceCompletionBinding({ ...body, digest: canonicalJsonDigest(body) });
  } catch { return undefined; }
}
