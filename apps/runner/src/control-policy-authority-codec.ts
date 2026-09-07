import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import type { ControlPolicyKey, ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { MAX_ACTIVE_EXPLORATION_BOUNDARIES, assertStoredExplorationPolicy, explorationBoundaryCandidateDigest,
  type ActivatedExplorationBoundary, type ExplorationBoundaryDraft, type GenerationLock } from "./auto-boundary.js";
import { parseStoredActionRuleAuthority, type ActionRuleAuthorityActivationV1,
  type ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import type { ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import { OPERATOR_POLICY_RECORD_VERSION, OPERATOR_READ_SELECTION_KEY, OPERATOR_READ_AUTHORING_KEY, OPERATOR_EXECUTION_POLICY_KEY,
  storedOperatorPolicyRecord } from "./control-policy-record.js";
import { operatorExecutionDocument, parseOperatorExecutionPolicy,
  type StoredOperatorExecutionPolicy } from "./control-policy-execution.js";
export { encodeOperatorExecutionPolicy } from "./control-policy-execution.js";
import { readAuthoringDocument, parseReadAuthoringDocument, type StoredReadAuthoring } from "./control-policy-read-authoring.js";

const VERSION = OPERATOR_POLICY_RECORD_VERSION;
const name = z.string().min(1).max(256);
const readSelection = z.object({ schema_version: z.literal(VERSION), type: z.literal("read_selection"),
  selected_name: name.nullable() }).strict();
const readDocument = z.object({ schema_version: z.literal(VERSION), type: z.literal("read"),
  boundary: z.record(z.unknown()), generation_lock: z.record(z.unknown()) }).strict();
const actionDocument = z.object({ schema_version: z.literal(VERSION), type: z.literal("action"),
  authority: z.record(z.unknown()) }).strict();
const document = z.discriminatedUnion("type", [readSelection, readDocument, actionDocument, operatorExecutionDocument, readAuthoringDocument]);
const operator = { level: "operator" } as const;
export const OPERATOR_READ_SELECTION = OPERATOR_READ_SELECTION_KEY;
export const OPERATOR_READ_AUTHORING = OPERATOR_READ_AUTHORING_KEY;
export const OPERATOR_EXECUTION_POLICY = OPERATOR_EXECUTION_POLICY_KEY;

type ReadPolicy = { type: "read"; boundary: ExplorationBoundaryDraft | ActivatedExplorationBoundary; generation_lock: GenerationLock };
type ActionPolicy = { type: "action"; authority: ActionRuleAuthorityDraftV1 | ActionRuleAuthorityActivationV1 };
export type StoredOperatorAuthority = ReadPolicy | ActionPolicy | StoredOperatorExecutionPolicy | StoredReadAuthoring | { type: "read_selection"; selected_name: string | null };
type ValidationContext = { runtimeConfig?: RuntimeConfig };

/** Encodes exact validated authority. Actor/time, disabled state, generation
 * provenance and content identity survive independently of authority digests. */
export function encodeOperatorAuthority(input: StoredOperatorAuthority, context: ValidationContext = {}): ControlPolicyRevision {
  const content = { schema_version: VERSION, ...structuredClone(input) };
  const parsed = parseDocument(content, context);
  return storedOperatorPolicyRecord(keyFor(parsed), authorityDigest(parsed), content);
}

export function decodeOperatorAuthority(revision: ControlPolicyRevision, context: ValidationContext = {}): StoredOperatorAuthority {
  if (revision.content_digest !== canonicalJsonDigest(revision.content)
    || revision.revision_id !== `policy:${revision.content_digest.slice(7)}`) fail("POLICY_CONTENT_MISMATCH");
  const parsed = parseDocument(revision.content, context);
  if (canonicalJsonDigest(keyFor(parsed)) !== canonicalJsonDigest({ scope: revision.scope, kind: revision.kind, name: revision.name })
    || authorityDigest(parsed) !== revision.authority_digest) fail("POLICY_AUTHORITY_IDENTITY_MISMATCH");
  return parsed;
}

/** Validates exact operator authority before transfer. Parent and delegation
 * records require their own codecs; unsupported records are never ignored. */
export function validateOperatorPolicySnapshot(snapshot: ControlPolicyMigrationSnapshot, context: ValidationContext = {}): void {
  const revisions = new Map<string, { revision: ControlPolicyRevision; policy: StoredOperatorAuthority }>();
  for (const revision of snapshot.revisions) {
    if (revisions.has(revision.revision_id)) fail("POLICY_DUPLICATE_REVISION");
    revisions.set(revision.revision_id, { revision, policy: decodeOperatorAuthority(revision, context) });
  }
  let selected: string | null | undefined;
  let authoring: StoredReadAuthoring | undefined;
  const drafts = new Map<string, ReadPolicy>();
  const reads = new Set<string>();
  const readBindings = new Set<string>();
  let actions = 0;
  for (const [state, pointers] of [["active", snapshot.active], ["draft", snapshot.drafts]] as const) {
    const seen = new Set<string>();
    for (const pointer of pointers) {
      const key = { scope: pointer.scope, kind: pointer.kind, name: pointer.name };
      const encodedKey = canonicalJsonDigest(key);
      if (seen.has(encodedKey)) fail("POLICY_DUPLICATE_POINTER");
      seen.add(encodedKey);
      if (pointer.scope.level !== "operator") fail("POLICY_AUTHORITY_IDENTITY_MISMATCH");
      if (!["read", "action"].includes(pointer.kind) && encodedKey !== canonicalJsonDigest(OPERATOR_READ_SELECTION)
        && encodedKey !== canonicalJsonDigest(OPERATOR_READ_AUTHORING)
        && encodedKey !== canonicalJsonDigest(OPERATOR_EXECUTION_POLICY)) {
        fail("POLICY_AUTHORITY_KIND_UNSUPPORTED");
      }
      if (pointer.revision_id === null) continue;
      const entry = revisions.get(pointer.revision_id);
      if (!entry || canonicalJsonDigest(keyFor(entry.policy)) !== encodedKey) fail("POLICY_POINTER_MISMATCH");
      const policy = entry.policy;
      if (policy.type === "read_selection") {
        if (state !== "active") fail("POLICY_SELECTION_STATE_INVALID");
        selected = policy.selected_name;
      } else if (policy.type === "read_authoring") {
        if (state !== "active") fail("POLICY_AUTHORING_POINTER_INVALID");
        authoring = policy;
      } else if (policy.type === "execution") {
        // The active pointer selects the reviewed configuration, which can
        // explicitly keep execution disabled. A draft is never enforced.
      } else {
        const isActive = policy.type === "read" ? typeof policy.boundary.activation === "object" : policy.authority.state === "active";
        if (isActive !== (state === "active")) fail("POLICY_ACTIVATION_STATE_MISMATCH");
        if (state === "draft" && policy.type === "read") drafts.set(policy.boundary.pack.name, policy);
        if (state === "active") {
          if (policy.type === "read") {
            reads.add(policy.boundary.pack.name);
            readBindings.add(canonicalJsonDigest({ source: policy.boundary.source, profile: policy.boundary.deployment_profile,
              trusted_context: policy.boundary.trusted_context, organization_scope: policy.boundary.organization_scope ?? null }));
          }
          else actions++;
        }
      }
    }
  }
  if (readBindings.size > 1) fail("POLICY_ACTIVE_READ_BINDINGS_MISMATCH");
  if (authoring) {
    if (drafts.size !== authoring.entries.length) fail("POLICY_AUTHORING_DRAFT_MISMATCH");
    for (const entry of authoring.entries) {
      const draft = drafts.get(entry.progress.candidate.pack.name);
      if (!draft || canonicalJsonDigest(draft.boundary) !== canonicalJsonDigest(entry.progress.candidate)
        || canonicalJsonDigest(draft.generation_lock) !== canonicalJsonDigest(entry.candidate_lock)) {
        fail("POLICY_AUTHORING_DRAFT_MISMATCH");
      }
    }
  }
  if (reads.size > MAX_ACTIVE_EXPLORATION_BOUNDARIES || actions > 1 || selected === undefined
    || (reads.size === 0 ? selected !== null : selected === null || !reads.has(selected))) fail("POLICY_ACTIVE_SELECTION_INVALID");
  // A stale Action dependency remains stale. Migration must not rebind its
  // compiled rule to a newer Read revision or silently re-enable a revoked Read.
}

function parseDocument(value: unknown, context: ValidationContext): StoredOperatorAuthority {
  const parsed = document.parse(value);
  if (parsed.type === "read_selection") return { type: parsed.type, selected_name: parsed.selected_name };
  if (parsed.type === "read_authoring") return parseReadAuthoringDocument(parsed);
  if (parsed.type === "execution") {
    return parseOperatorExecutionPolicy(parsed, context.runtimeConfig);
  }
  if (parsed.type === "action") {
    const authority = parseStoredActionRuleAuthority(parsed.authority);
    if (canonicalJsonDigest(authority) !== canonicalJsonDigest(parsed.authority)) fail("POLICY_NORMALIZATION_REQUIRED");
    return { type: parsed.type, authority };
  }
  const boundary = parsed.boundary as unknown as ReadPolicy["boundary"];
  const lock = parsed.generation_lock as unknown as GenerationLock;
  assertStoredExplorationPolicy(boundary, lock);
  return { type: parsed.type, boundary: structuredClone(boundary), generation_lock: structuredClone(lock) };
}

function keyFor(policy: StoredOperatorAuthority): ControlPolicyKey {
  if (policy.type === "read_authoring") return OPERATOR_READ_AUTHORING;
  if (policy.type === "execution") return OPERATOR_EXECUTION_POLICY;
  return policy.type === "read_selection" ? OPERATOR_READ_SELECTION : { scope: operator, kind: policy.type,
    name: policy.type === "read" ? policy.boundary.pack.name : policy.authority.authority.name };
}

function authorityDigest(policy: StoredOperatorAuthority): string {
  if (policy.type === "read_selection" || policy.type === "read_authoring" || policy.type === "execution") return canonicalJsonDigest(policy);
  if (policy.type === "action") return policy.authority.digest;
  return policy.boundary.activation === "disabled_unreviewed"
    ? explorationBoundaryCandidateDigest(policy.boundary)
    : (policy.boundary as ActivatedExplorationBoundary).activation.digest;
}

function fail(code: string): never {
  throw Object.assign(new Error(`${code}: saved operator authority cannot be transferred unchanged.`), { code });
}
