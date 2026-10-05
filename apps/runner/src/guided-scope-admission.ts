import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { rolePostureFingerprint, schemaFingerprintForInspection } from "@synapsor-runner/schema-inspector";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { loadBoundaryResourceReviewCatalog, prepareBoundaryReviewMutationBatch,
  commitBoundaryReviewMutationBatch, type BoundaryResourceReviewRequest } from "./boundary-review-mutation.js";
import { inspectedPostgresScopeCandidates, inspectedPostgresScopeMapping, type InspectedScopeMapping } from "./inspected-scope-mapping.js";
import { interpretPrincipalScopeAnswer } from "./model-principal-scope-review.js";
import { rememberModelAuthoringClarification } from "./model-authoring-conversation.js";

type Choice = { resourceId: string; schema: string; table: string; mapping: InspectedScopeMapping };
type ModelSession = Parameters<typeof interpretPrincipalScopeAnswer>[0]["session"];

/** Metadata-only prerequisite to the existing admitted-catalog mapper. */
export async function reviewGuidedScopeAdmission(input: {
  projectRoot: string;
  inspectionInput: Parameters<typeof inspectDatabase>[0];
  schemaInspector: typeof inspectDatabase;
  session: BoundaryReviewInteractiveSession;
  model: ModelSession;
  interpreter?: typeof interpretPrincipalScopeAnswer;
  egressAcknowledged: boolean;
  jobIntent: string;
  actor: string;
  signal?: AbortSignal;
  progress?: <T>(message: string, operation: () => Promise<T>) => Promise<T>;
}): Promise<{ ready: boolean; changed: boolean; reason?: string }> {
  const catalog = await loadBoundaryResourceReviewCatalog(input.projectRoot);
  const views = catalog.views.filter(view => !view.organization_scope);
  if (!views.length) return { ready: true, changed: false };
  const inspection = await input.schemaInspector(input.inspectionInput);
  if (schemaFingerprintForInspection(inspection) !== catalog.bindings.schema_fingerprint
    || rolePostureFingerprint(inspection) !== catalog.bindings.role_posture_fingerprint) {
    return { ready: false, changed: false, reason: "The database structure or reader permissions changed. Rescan, then resume this saved identity review." };
  }
  const groups = new Map<string, Choice[][]>();
  let unresolved = false;
  for (const view of views) {
    const table = inspection.tables.find(table => `${table.schema}.${table.name}` === view.resource_id);
    if (!table) continue;
    const mappings = inspectedPostgresScopeCandidates(inspection, table.schema, table.name);
    const resource = view.candidate ?? view.generated_candidate;
    const tenant = view.tenant_key.selected, principal = view.principal_key.selected;
    const settings = resource?.rls_session;
    const missing = !tenant && !view.generated_candidate && !view.included;
    const collapsed = Boolean(tenant && principal && (tenant === principal
      || settings?.tenant_setting && settings.tenant_setting === settings.principal_setting));
    const contradicts = Boolean(tenant && principal && mappings.length && !mappings.some(mapping =>
      mapping.tenant.field === tenant && mapping.principal.field === principal
      && (!settings?.tenant_setting || mapping.tenant.setting === settings.tenant_setting)
      && (!settings?.principal_setting || mapping.principal.setting === settings.principal_setting)));
    if (!missing && !collapsed && !contradicts) continue;
    unresolved = true;
    if ((collapsed || contradicts) && !mappings.length) return { ready: false, changed: false,
      reason: `${view.resource_id} has conflicting organization/person bindings, and its current policies do not provide a supported exact correction. Review the source scope and rescan; no per-organization limit or corrected scope is established.` };
    if (!mappings.length) continue;
    const key = JSON.stringify(mappings.map(mapping => [mapping.tenant, mapping.principal]));
    const choices = mappings.map(mapping => ({ resourceId: view.resource_id, schema: table.schema, table: table.name, mapping }));
    groups.set(key, [...(groups.get(key) ?? []), choices]);
  }
  if (!groups.size) return !unresolved || catalog.candidate.pack.resources.length
    ? { ready: true, changed: false }
    : { ready: false, changed: false, reason: "No exact organization/person mapping could be verified from the current database policies. Review the source identity fields and row-access policies, rescan, then resume this saved job. No Read mapping was requested." };
  if (!input.egressAcknowledged) return { ready: false, changed: false, reason: "Review metadata sharing before asking the model about identity fields." };
  const selected: Choice[] = [];
  for (const resources of groups.values()) {
    const options = resources[0]!.map(({ mapping }, index) => ({ id: `candidate_${index + 1}`, kind: "direct" as const,
      value: `${mapping.tenant.field}:${mapping.principal.field}`,
      label: `organization: ${mapping.tenant.field} (${mapping.tenant.setting}); authenticated person: ${mapping.principal.field} (${mapping.principal.setting})` }));
    let answer = input.jobIntent.replace(/\s+/g, " ").trim();
    let resolved = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      input.signal?.throwIfAborted();
      const interpret = () => (input.interpreter ?? interpretPrincipalScopeAnswer)({
        session: input.model, resourceId: resources.map(choices => choices[0]!.resourceId).join(", "), options,
        answer, egressAcknowledged: true, scopeKind: "organization_and_person", signal: input.signal,
      });
      const result = input.progress ? await input.progress("Checking organization and person fields", interpret) : await interpret();
      if (result.state === "resolved") {
        const index = options.findIndex(option => option.id === result.option_id);
        if (index < 0) throw new Error("SCOPE_MAPPING_REFUSED: the model selected an unavailable identity mapping.");
        selected.push(...resources.map(choices => choices[index]!));
        resolved = true;
        break;
      }
      if (result.state === "none") break;
      const reply = await input.session.promptText(result.question, { context: ["IDENTITY MAPPING", ...options.map(option => option.label),
        "Describe which identifies the organization and which identifies the signed-in person. No identity values are needed."] });
      if (!reply?.trim()) break;
      rememberModelAuthoringClarification(input.model.conversation, result.question, reply);
      answer = reply.replace(/\s+/g, " ").trim();
    }
    if (!resolved) return { ready: false, changed: false, reason: "Identity meaning remains unresolved. This job is saved; resume with the organization/person mapping. Nothing was activated." };
  }
  // Revalidate the exact closed proof on every inspection, including after the
  // operator's review. Model labels and stale generated catalogs are not proof.
  const checkedInspector: typeof inspectDatabase = async options => {
    const fresh = await input.schemaInspector(options);
    if (schemaFingerprintForInspection(fresh) !== catalog.bindings.schema_fingerprint
      || rolePostureFingerprint(fresh) !== catalog.bindings.role_posture_fingerprint) {
      throw new Error("SCOPE_MAPPING_STALE: database structure or reader permissions changed. Rescan and review again; nothing was saved.");
    }
    for (const choice of selected) {
      const table = fresh.tables.find(table => table.schema === choice.schema && table.name === choice.table);
      const proof = inspectedPostgresScopeMapping({ inspection: fresh,
        resource: { schema: choice.schema, table: choice.table, fields: table?.columns.filter(column => !column.nullable).map(column => column.name) ?? [] },
        tenantField: choice.mapping.tenant.field, tenantSetting: choice.mapping.tenant.setting,
        principalSetting: choice.mapping.principal.setting });
      if (canonicalJsonDigest(proof ?? null) !== canonicalJsonDigest(choice.mapping)) {
        throw new Error(`SCOPE_MAPPING_STALE: ${choice.resourceId} identity evidence changed or is unavailable. Rescan and review the mapping again; nothing was saved.`);
      }
    }
    return fresh;
  };
  const requests: BoundaryResourceReviewRequest[] = selected.map(choice => ({ resource_id: choice.resourceId,
    tenant_key: choice.mapping.tenant.field, principal_key: choice.mapping.principal.field,
    actor: input.actor, reason: "Operator reviewed inspected organization/person identity mapping before Read admission.",
    decided_at: new Date().toISOString() }));
  const preview = await prepareBoundaryReviewMutationBatch(input.projectRoot, requests, checkedInspector, catalog.bindings);
  const details = selected.map(choice => `${choice.resourceId}: organization ${choice.mapping.tenant.field} <- ${choice.mapping.tenant.setting}; person ${choice.mapping.principal.field} <- ${choice.mapping.principal.setting}`);
  const exact = { title: "EXACT IDENTITY MAPPINGS", lines: [...details, `Review: ${preview.decision_digest}`,
    "Only disabled identity mappings change. Field exposure and runtime authority are unchanged."] };
  input.session.rememberDetails?.(exact.title, exact.lines);
  const accepted = await input.session.confirm("Save these organization/person mappings in the disabled draft?", {
    defaultValue: false, exactDetails: exact, context: ["REVIEW IDENTITY MAPPING", ...details,
      "Confirm these fields have the stated business meanings. Your application supplies identity; the agent cannot choose it.",
      "No records, field exposure or active permissions change. Read and Action review follow separately."] });
  if (!accepted) return { ready: false, changed: false, reason: "Identity mapping left unchanged. Resume this saved job when you are ready to review it." };
  input.signal?.throwIfAborted();
  await checkedInspector(input.inspectionInput);
  input.signal?.throwIfAborted();
  await commitBoundaryReviewMutationBatch(input.projectRoot, preview);
  return { ready: true, changed: true };
}
