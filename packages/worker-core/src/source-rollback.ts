import { canonicalJsonDigest } from "@synapsor-runner/protocol";

/** Trusted adapter observation, never supplied by a model or CLI argument. */
export type SourceRollbackEvidence = {
  producer: "synapsor.postgres.source_db.rollback.v1";
  outcome: "rollback_acknowledged";
  job_digest: `sha256:${string}`;
  source_binding_digest: `sha256:${string}`;
  observed_at: string;
};

/** Deliberately narrow local PostgreSQL destination/receipt binding. Credentials
 * are excluded. Unqualified receipt namespaces and URL option overrides are not
 * supported for closure; ordinary execution behavior is unchanged. */
export function sourceRollbackBinding(input: {
  databaseUrl: string; engine: string; sourceId: string;
  receipts?: { authority: string; provisioning?: string; schema?: string; table?: string };
}): `sha256:${string}` | undefined {
  if (input.engine !== "postgres" || input.receipts?.authority !== "source_db"
    || input.receipts.provisioning !== "precreated" || !input.receipts.schema) return undefined;
  try {
    const u = new URL(input.databaseUrl);
    if (!["postgres:", "postgresql:"].includes(u.protocol) || u.search || u.hash || !u.hostname || u.pathname.length < 2) return undefined;
    return canonicalJsonDigest({ source: input.sourceId, engine: "postgres", host: u.hostname.toLowerCase(),
      port: u.port || "5432", database: decodeURIComponent(u.pathname.slice(1)),
      receipts: { schema: input.receipts.schema, table: input.receipts.table ?? "synapsor_writeback_receipts" } });
  } catch { return undefined; }
}
