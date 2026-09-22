import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rolePostureFingerprint, schemaFingerprintForInspection } from "@synapsor-runner/schema-inspector";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { PolicySourceInspection } from "./action-rule-source-evidence.js";
import type { authoringReceiptConfiguration } from "./authoring-receipt-configuration.js";

/** Exclusion from the exact selected Read graph, not database-wide privacy or
 * proof of receipt provisioning/production. Unknown views, destinations, source
 * aliases and incomplete inspected mappings yield no proof. No private name or
 * receipt content is returned. The ordinary prepared-draft/configuration checks
 * bind this derived summary again at save and reuse. */
export function receiptReadExclusion(read: ExplorationBoundaryDraft,
  configuration: Awaited<ReturnType<typeof authoringReceiptConfiguration>> | undefined,
  source: PolicySourceInspection | undefined) {
  if (!configuration || configuration.status !== "current" || !configuration.modes.length
    || !source || source.inspection.engine !== "postgres" || source.generationLock.engine !== "postgres"
    || canonicalJsonDigest(source.generationLock) !== read.generation_lock_fingerprint
    || schemaFingerprintForInspection(source.inspection) !== source.generationLock.schema_fingerprint
    || rolePostureFingerprint(source.inspection) !== source.generationLock.role_posture_fingerprint
    || read.role_posture_fingerprint !== source.generationLock.role_posture_fingerprint) return null;
  if (!configuration.modes.every(mode => mode.source === read.source && mode.authority === "source_db")
    || !('source_receipt_destinations' in configuration)) return null;
  const destinations = configuration.source_receipt_destinations;
  if (!destinations || destinations.length !== configuration.modes.length
    || !destinations.every(d => d.source === read.source && /^sha256:[a-f0-9]{64}$/u.test(d.relation_digest ?? ""))
    || new Set(destinations.map(d => d.source)).size !== destinations.length) return null;
  const resources = read.pack.resources;
  if (!resources.length || new Set(resources.map(r => r.id)).size !== resources.length) return null;
  for (const resource of resources) {
    const tables = source.inspection.tables.filter(t => t.schema === resource.schema && t.name === resource.table);
    if (tables.length !== 1 || tables[0]!.type !== "table"
      || resource.relationships?.some(r => !resources.some(target => target.id === r.target_resource))) return null;
  }
  const excluded = destinations.every(destination => resources.every(resource =>
    canonicalJsonDigest({ schema: resource.schema, table: resource.table }) !== destination.relation_digest));
  return { origin: "HOST-CONFIGURATION-AND-READ" as const, scope: "selected_read_graph" as const,
    excluded, selected_read_digest: canonicalJsonDigest(read), configuration_digest: configuration.digest,
    generation_lock_fingerprint: read.generation_lock_fingerprint,
    schema_fingerprint: source.generationLock.schema_fingerprint,
    graph_digest: canonicalJsonDigest(resources), destination_binding_digest: canonicalJsonDigest(destinations),
    resource_count: resources.length, destination_count: destinations.length,
    meaning: "Only whether the exact configured source receipt destinations are excluded from this complete selected Read graph of inspected base tables. Views/unresolved mappings supply no proof. This does not attest database-wide privacy, another interface, provisioning, execution permission, a performed receipt or independent readback. A false value is not exclusion; a missing record is unknown." };
}

/** Phase contract for the exact selected candidate; no historical observations are imported. */
export function reviewEvidencePhases(candidateActionDigest: string | null, read: ExplorationBoundaryDraft, actions?: unknown[]) {
  return {
          candidate_action_digest: candidateActionDigest,
          // Bind the phase label to the complete host-prepared candidate. The
          // save/recheck path independently prepares this evidence again.
          candidate_action_binding_digest: candidateActionDigest && actions
            ? canonicalJsonDigest({ candidate_action_digest: candidateActionDigest, actions }) : null,
          selected_read_digest: canonicalJsonDigest(read),
          response_contract: "complete_replacement",
          compiled_capability: "The candidate's supported behavior, not deployment or a performed operation.",
          configuration: "receipt_configuration.status=current establishes the existing bound configuration only. Its reviewed_intent has separate candidate/source applicability; stale intent does not erase the current configuration or historical infrastructure. Neither establishes provisioning or observations.",
          execution_authorization: "saved_execution_review is only an applicable record for this exact candidate. Null means none supplied for this revision, not that an older revision never had authorization or executed. Non-null does not establish a performed operation.",
          historical_observations: "No operation-bound historical receipts or independent readbacks are supplied in this review. Do not assert their absence, invent them, or attribute an old achievement to the edited candidate. Existing history is retained outside this review.",
          pending: "Keep applicable deployment renewal and after-execution observation duties pending. They do not require a post-edit receipt before publication. A missing business capability, wrong receipt mode or privacy conflict still blocks BUSINESS review.",
        };
}
