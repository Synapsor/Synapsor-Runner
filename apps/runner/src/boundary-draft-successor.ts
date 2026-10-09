import { withProjectAuthorityMutation, withHeldProjectAuthorityAccess, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { actionRuleModelDraftFromAuthority } from "./action-rule-draft.js";
import { readActionRuleAuthorityDraft, type ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { loadBoundaryReviewContextHeld } from "./boundary-review-context.js";
import { readProjectReadAuthoringHeld } from "./control-policy-read-authoring-project.js";
import type { OperatorAuthorityState } from "./control-policy-operator-repository.js";
import type { ReadAuthoringBindings } from "./control-policy-record.js";
import { AUTHORING_PROGRAM_CAPACITY as limits } from "./authoring-program-capacity.js";
import { MAX_BOUNDARY_ACTION_INTENT_CHARACTERS } from "./boundary-authoring-limits.js";
import { activePolicySource, policyTextSnapshot, type PolicySourceSession } from "./authoring-policy-source.js";
import { publishPrivateAuthoringJson, readPrivateAuthoringJson } from "./boundary-draft-bundle.js";

const VERSION = "synapsor.structured-draft-successor.v1" as const;
const PAGE_VERSION = "synapsor.structured-draft-successor-page.v1" as const;
const DIRECTORY = ".synapsor/boundary-authoring/structured-successor";
const INVENTORY = `${DIRECTORY}/inventory.json`;
type Hash = `sha256:${string}`;
type RecordValue = Record<string, unknown>;
type InertSource = { name: string; text: string; digest: string; version: number };
type StoreIdentity = Pick<ReadAuthoringBindings, "repository_id" | "deployment_id" | "project_id">;
export type StructuredDraftSuccessorProposal = {
  actions: ActionRuleModelDraftV1[];
  read_resources: RecordValue[];
  intents: Array<{ index: number; text: string; proposed_outcome?: string }>;
  sources: InertSource[];
};
export type StructuredDraftSuccessorInventory = StructuredDraftSuccessorProposal & {
  schema_version: typeof VERSION;
  declaration_digest: Hash;
  destination: StoreIdentity & { boundary_name: string; schema_fingerprint: Hash; role_posture_fingerprint: Hash };
  read_candidate_digest: Hash;
  inventory_digest: Hash;
};
type ExpectedPage = { schema_version: typeof PAGE_VERSION; declaration_digest: Hash; number: number;
  declarations: Array<{ outcome: string; digest: Hash }> };
export type StructuredDraftSuccessorInspection =
  | { status: "none" }
  | { status: "invalid"; reason: string }
  | { status: "present"; inventory: StructuredDraftSuccessorInventory; current_binding_matches: boolean;
      pages: Array<{ number: number; outcomes: string[]; matching_current_disabled_outcomes: string[]; pending_outcomes: string[] }>;
      pending_pages: number[]; pending_intent_indexes: number[];
      source_material_state: "untrusted_not_attached"; readiness: false };

/** Retain declarative intent text only. Historical checkpoints, continuations,
 * resume identity, grants, Source acceptance and transport state are discarded. */
export function structuredDraftSuccessorProposal(input: {
  actions: ActionRuleModelDraftV1[]; readResources: RecordValue[]; skeletons: unknown; sources: unknown;
}): StructuredDraftSuccessorProposal {
  if (!input.actions.length || input.actions.length > limits.totalActions
    || new Set(input.actions.map(action => action.outcome)).size !== input.actions.length) invalid("Preserve one complete ordered inventory of unique bounded Actions.");
  const skeletons = input.skeletons === undefined ? [] : input.skeletons;
  if (!Array.isArray(skeletons) || skeletons.length > limits.totalActions) invalid("The complete intent agenda exceeds its supported bound.");
  const outcomes = new Set(input.actions.map(action => action.outcome));
  const intents = skeletons.map((item, index) => {
    const skeleton = object(item);
    if (skeleton.intent_index !== index || typeof skeleton.intent !== "string" || !skeleton.intent.trim()
      || skeleton.intent.length > MAX_BOUNDARY_ACTION_INTENT_CHARACTERS) invalid("Intent indexes and exact bounded text must preserve the complete agenda order.");
    const continuation = skeleton.continuation && typeof skeleton.continuation === "object" && !Array.isArray(skeleton.continuation)
      ? skeleton.continuation as RecordValue : undefined;
    const proposed = continuation?.state === "exact_current_draft" && typeof continuation.outcome === "string"
      && outcomes.has(continuation.outcome) ? continuation.outcome : undefined;
    return { index, text: skeleton.intent, ...(proposed ? { proposed_outcome: proposed } : {}) };
  });
  const sources = input.sources === undefined ? [] : input.sources;
  if (!Array.isArray(sources) || sources.length > 8) invalid("At most eight bounded inert Source texts may be retained.");
  const checkedSources = sources.map(item => {
    const source = object(item); exactKeys(source, ["name", "text", "digest", "version"]);
    if (typeof source.name !== "string" || typeof source.text !== "string" || !Number.isSafeInteger(source.version)) invalid("Source identity is invalid.");
    const checked = policyTextSnapshot(Buffer.from(source.text), source.name, source.version as number);
    if (checked.name !== source.name || checked.digest !== source.digest) invalid("Source text differs from its exact declared digest.");
    return { name: checked.name, text: checked.text, digest: checked.digest, version: checked.version };
  });
  if (new Set(checkedSources.map(source => source.version)).size !== checkedSources.length) invalid("Source versions must be unique.");
  return { actions: structuredClone(input.actions), read_resources: structuredClone(input.readResources), intents, sources: checkedSources };
}

export function structuredDraftSuccessorPage(proposal: StructuredDraftSuccessorProposal, number: number) {
  const total = Math.ceil(proposal.actions.length / limits.structuredChangedActions);
  if (!Number.isSafeInteger(number) || number < 1 || number > total) invalid(`Choose --action-page from 1 to ${total}.`);
  const start = (number - 1) * limits.structuredChangedActions;
  return { number, total, actions: proposal.actions.slice(start, start + limits.structuredChangedActions) };
}

/** This is inspection of current declarations, never a commit acknowledgement,
 * Source proof, intent interpretation, or publication grant. */
export async function readStructuredDraftSuccessorInventory(projectRoot: string): Promise<StructuredDraftSuccessorInspection> {
  return withProjectAuthorityMutation(projectRoot, held => readSuccessorInventoryHeld(held.projectRoot, held));
}
export async function readStructuredDraftSuccessorInventoryHeld(projectRoot: string,
  permit: ProjectAuthorityMutationPermit): Promise<StructuredDraftSuccessorInspection> {
  return withHeldProjectAuthorityAccess(projectRoot, permit, held => readSuccessorInventoryHeld(held.projectRoot, held));
}
async function readSuccessorInventoryHeld(projectRoot: string, permit: ProjectAuthorityMutationPermit): Promise<StructuredDraftSuccessorInspection> {
  try {
    const inventory = await readInventory(projectRoot);
    if (!inventory) return { status: "none" };
    const context = await loadBoundaryReviewContextHeld(projectRoot, permit), authoring = await readProjectReadAuthoringHeld(projectRoot, permit);
    const currentBindingMatches = Boolean(authoring && sameStore(inventory.destination, authoring.bindings)
      && inventory.destination.boundary_name === context.candidate.pack.name
      && inventory.destination.schema_fingerprint === context.lock.schema_fingerprint
      && inventory.destination.role_posture_fingerprint === context.lock.role_posture_fingerprint
      && inventory.read_candidate_digest === context.bundle.candidate_digest);
    const current = await readActionRuleAuthorityDraft(projectRoot, `${inventory.destination.boundary_name}_rules`);
    const digests = currentBindingMatches ? currentDeclarationDigests(current) : new Map<string, Hash>();
    const pages = [];
    for (let number = 1; number <= Math.ceil(inventory.actions.length / limits.structuredChangedActions); number++) {
      const outcomes = structuredDraftSuccessorPage(inventory, number).actions.map(action => action.outcome);
      const expectation = await readPage(projectRoot, inventory, number);
      const matching = outcomes.filter(outcome => expectation?.declarations.some(item => item.outcome === outcome && item.digest === digests.get(outcome)));
      pages.push({ number, outcomes, matching_current_disabled_outcomes: matching, pending_outcomes: outcomes.filter(outcome => !matching.includes(outcome)) });
    }
    const matching = new Set(pages.flatMap(page => page.matching_current_disabled_outcomes));
    return { status: "present", inventory, current_binding_matches: currentBindingMatches, pages,
      pending_pages: pages.filter(page => page.pending_outcomes.length).map(page => page.number),
      pending_intent_indexes: inventory.intents.filter(intent => !intent.proposed_outcome || !matching.has(intent.proposed_outcome)).map(intent => intent.index),
      source_material_state: "untrusted_not_attached", readiness: false };
  } catch (error) {
    if (["POLICY_MUTATION_PERMIT_REQUIRED", "POLICY_MUTATION_PERMIT_INVALID"].includes((error as { code?: string }).code ?? "")) throw error;
    return { status: "invalid", reason: (error as { code?: string }).code ?? "STRUCTURED_DRAFT_SUCCESSOR_INVALID" };
  }
}

/** Fresh attachment applicability only. The caller must use normal current
 * Source review/coverage APIs to assess actual revalidation and readiness. */
export function structuredDraftSuccessorSourceMatches(inventory: StructuredDraftSuccessorInventory,
  currentSources: PolicySourceSession | undefined): Array<{ name: string; digest: string; attached_current: boolean }> {
  const active = activePolicySource(currentSources);
  return inventory.sources.map(source => ({ name: source.name, digest: source.digest,
    attached_current: Boolean(active && active.name === source.name
      && active.text === source.text && active.digest === source.digest) }));
}

export async function assertStructuredDraftSuccessorDestination(input: {
  projectRoot: string; proposal: StructuredDraftSuccessorProposal; originalStore?: ReadAuthoringBindings;
  bindings: ReadAuthoringBindings; state: OperatorAuthorityState; boundaryName: string;
  schemaFingerprint: Hash; rolePostureFingerprint: Hash;
}): Promise<StructuredDraftSuccessorInventory | undefined> {
  const saved = await readInventory(input.projectRoot);
  if (input.state.active.some(entry => ["read", "action", "execution"].includes(entry.policy.type))
    || input.state.drafts.some(entry => entry.policy.type === "execution")) invalid("Successor import requires an independent current disabled setup without active publication or execution.");
  if (!saved) {
    if (input.originalStore && sameStore(input.originalStore, input.bindings)) invalid("Choose an independently initialized disabled destination; the historical control store cannot become its successor.");
    if (input.state.drafts.some(entry => entry.policy.type === "action")
      || await present(path.join(input.projectRoot, ".synapsor/boundary-authoring/resume.json"))) invalid("The independent destination must have no existing Action bundle or unresolved saved job before its first successor page.");
  } else if (saved.declaration_digest !== canonicalJsonDigest(input.proposal)
    || !sameStore(saved.destination, input.bindings) || saved.destination.boundary_name !== input.boundaryName
    || saved.destination.schema_fingerprint !== input.schemaFingerprint
    || saved.destination.role_posture_fingerprint !== input.rolePostureFingerprint) {
    invalid("The immutable successor agenda or current destination changed. Inspect the preserved inventory; no page was overwritten.");
  }
  return saved;
}

/** Called under the existing project writer after current schema/runtime/CAS
 * validation. Complete inventory is durable before any disabled page commit. */
export async function stageStructuredDraftSuccessorPage(input: {
  projectRoot: string; proposal: StructuredDraftSuccessorProposal; number: number;
  existing?: StructuredDraftSuccessorInventory; destination: StructuredDraftSuccessorInventory["destination"];
  readCandidateDigest: Hash; compiled: ActionRuleAuthorityDraftV1;
}): Promise<{ rollback: () => Promise<void>; already_current: boolean }> {
  const created: string[] = [], page = structuredDraftSuccessorPage(input.proposal, input.number);
  const expected = currentDeclarationDigests(input.compiled);
  const declarations = page.actions.map(action => {
    const digest = expected.get(action.outcome); if (!digest) invalid("Normal compilation did not preserve a selected page outcome.");
    return { outcome: action.outcome, digest };
  });
  const declarationDigest = canonicalJsonDigest(input.proposal);
  const core = { schema_version: VERSION, declaration_digest: declarationDigest, destination: input.destination,
    read_candidate_digest: input.readCandidateDigest, ...input.proposal };
  const inventory: StructuredDraftSuccessorInventory = input.existing ?? { ...core, inventory_digest: canonicalJsonDigest(core) };
  if (inventory.read_candidate_digest !== input.readCandidateDigest) invalid("The current Read candidate differs from this preserved successor agenda. Review the changed Read before selecting another page.");
  const expectation: ExpectedPage = { schema_version: PAGE_VERSION, declaration_digest: declarationDigest, number: input.number, declarations };
  const previousPage = await readPage(input.projectRoot, inventory, input.number);
  if (previousPage && canonicalJsonDigest(previousPage) !== canonicalJsonDigest(expectation)) invalid("Selected page compilation differs from its immutable declaration expectation. No existing page or agenda was replaced.");
  const rollback = async () => { for (const relative of created.reverse()) await fs.unlink(path.join(input.projectRoot, relative)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); };
  try {
    if (!input.existing) { await publishPrivateAuthoringJson(input.projectRoot, INVENTORY, inventory, limits.structuredDraftTotalBytes); created.push(INVENTORY); }
    if (!previousPage) { const relative = pagePath(input.number); await publishPrivateAuthoringJson(input.projectRoot, relative, expectation, limits.structuredDraftManifestBytes); created.push(relative); }
  } catch (error) { await rollback(); throw error; }
  const current = currentDeclarationDigests(await readActionRuleAuthorityDraft(input.projectRoot, `${input.destination.boundary_name}_rules`));
  return { rollback, already_current: declarations.every(item => current.get(item.outcome) === item.digest) };
}

function currentDeclarationDigests(loaded: ActionRuleAuthorityDraftV1 | undefined): Map<string, Hash> {
  return new Map(loaded?.authority.rules.map(rule => {
    const review = loaded.reviews.find(item => item.outcome === rule.rule.outcome);
    if (!review) invalid("Current disabled declaration has no exact operator review summary.");
    return [rule.rule.outcome, canonicalJsonDigest(actionRuleModelDraftFromAuthority({ authority: loaded.authority,
      outcome: rule.rule.outcome, review, preserveVerificationFields: true }))];
  }) ?? []);
}
async function readInventory(root: string): Promise<StructuredDraftSuccessorInventory | undefined> {
  if (!await present(path.join(root, INVENTORY))) return undefined;
  const value = object(await readPrivateAuthoringJson(root, INVENTORY, limits.structuredDraftTotalBytes));
  exactKeys(value, ["schema_version", "declaration_digest", "destination", "read_candidate_digest", "actions", "read_resources", "intents", "sources", "inventory_digest"]);
  const { inventory_digest: digest, ...core } = value;
  if (value.schema_version !== VERSION || digest !== canonicalJsonDigest(core) || !Array.isArray(value.actions)
    || !Array.isArray(value.read_resources) || !Array.isArray(value.intents) || !Array.isArray(value.sources)
    || !isHash(value.read_candidate_digest)) invalid("Stored successor inventory is incomplete or has changed.");
  const proposal = { actions: value.actions, read_resources: value.read_resources, intents: value.intents, sources: value.sources };
  const actions = value.actions;
  if (value.declaration_digest !== canonicalJsonDigest(proposal) || value.actions.length < 1 || value.actions.length > limits.totalActions
    || value.intents.length > limits.totalActions || value.sources.length > 8) invalid("Stored successor agenda digest or bounds changed.");
  if (value.actions.some(item => { const action = object(item); return typeof action.outcome !== "string"; })
    || new Set(value.actions.map(item => object(item).outcome)).size !== value.actions.length) invalid("Stored Action membership changed.");
  value.intents.forEach((item, index) => { const intent = object(item); exactKeys(intent, ["index", "text", "proposed_outcome"]);
    if (intent.index !== index || typeof intent.text !== "string" || !intent.text.trim()
      || intent.text.length > MAX_BOUNDARY_ACTION_INTENT_CHARACTERS
      || (intent.proposed_outcome !== undefined && !actions.some(action => object(action).outcome === intent.proposed_outcome))) invalid("Stored complete intent order changed."); });
  structuredDraftSuccessorProposal({ actions: value.actions as ActionRuleModelDraftV1[], readResources: value.read_resources as RecordValue[],
    skeletons: undefined, sources: value.sources });
  const allowedNames = new Set(["inventory.json", ...Array.from({ length: Math.ceil(value.actions.length / limits.structuredChangedActions) }, (_, index) => path.basename(pagePath(index + 1)))]);
  if ((await fs.readdir(path.join(root, DIRECTORY))).some(name => !allowedNames.has(name))) invalid("Successor directory contains an unexpected or interrupted member. Inspect the preserved complete inventory before retrying.");
  const destination = object(value.destination); exactKeys(destination, ["repository_id", "deployment_id", "project_id", "boundary_name", "schema_fingerprint", "role_posture_fingerprint"]);
  if (!isHash(destination.schema_fingerprint) || !isHash(destination.role_posture_fingerprint)
    || ["repository_id", "deployment_id", "project_id", "boundary_name"].some(key => typeof destination[key] !== "string" || !destination[key])) invalid("Stored destination identity is invalid.");
  return value as StructuredDraftSuccessorInventory;
}
async function readPage(root: string, inventory: StructuredDraftSuccessorInventory, number: number): Promise<ExpectedPage | undefined> {
  if (!await present(path.join(root, pagePath(number)))) return undefined;
  const value = object(await readPrivateAuthoringJson(root, pagePath(number), limits.structuredDraftManifestBytes));
  exactKeys(value, ["schema_version", "declaration_digest", "number", "declarations"]);
  const outcomes = structuredDraftSuccessorPage(inventory, number).actions.map(action => action.outcome);
  if (value.schema_version !== PAGE_VERSION || value.declaration_digest !== inventory.declaration_digest || value.number !== number
    || !Array.isArray(value.declarations) || value.declarations.length !== outcomes.length) invalid("Stored page does not match its exact immutable agenda membership.");
  value.declarations.forEach((item, index) => { const declaration = object(item); exactKeys(declaration, ["outcome", "digest"]);
    if (declaration.outcome !== outcomes[index] || !isHash(declaration.digest)) invalid("Stored page order or declaration changed."); });
  return value as ExpectedPage;
}
function pagePath(number: number): string { return `${DIRECTORY}/page-${String(number).padStart(3, "0")}.json`; }
async function present(file: string): Promise<boolean> { return fs.lstat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; }); }
function sameStore(left: StoreIdentity, right: StoreIdentity): boolean { return left.repository_id === right.repository_id && left.deployment_id === right.deployment_id && left.project_id === right.project_id; }
function object(value: unknown): RecordValue { if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Successor declarative records must be objects."); return value as RecordValue; }
function exactKeys(value: RecordValue, allowed: string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) invalid("Successor records contain unsupported authority or state fields."); }
function isHash(value: unknown): value is Hash { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value); }
function invalid(message: string): never { throw Object.assign(new Error(`STRUCTURED_DRAFT_SUCCESSOR_INVALID: ${message}`), { code: "STRUCTURED_DRAFT_SUCCESSOR_INVALID" }); }
