import fs from "node:fs/promises";
import { types } from "node:util";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readAuthoringBindingsSchema, type ReadAuthoringBindings } from "./control-policy-record.js";
import { loadRuntimeConfigFromFile, resolveTrustedContext, type RuntimeConfig, type TrustedContext } from "@synapsor-runner/mcp-server";
import { resolveSynapsorProject } from "./project-resolution.js";
import { AuthoringResumeMaterialError } from "./authoring-checkpoint-save-error.js";
import { openBoundProjectControlPolicies } from "./control-policy-store.js";
import { OperatorAuthorityRepository } from "./control-policy-operator-repository.js";
import { CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION } from "./auto-boundary.js";

/** Transient host ownership. The Read owner supplies its actual freshly loaded
 * native frame and reacquires it after waits; this is privacy screening, not
 * custody proof, a CAS permit or a durable origin. Each ACK needs a new context. */
export type AuthoringMaterialOwner = Readonly<{ projectRoot: string } & (
  { jobCreatedAt: string; sourceSessionId?: never; readEntry?: never } |
  { sourceSessionId: string; jobCreatedAt?: never; readEntry?: never } |
  { readEntry: Readonly<{ entry_id: string; bindings: ReadAuthoringBindings }>; jobCreatedAt?: never; sourceSessionId?: never }
)>;
/** These are owning-schema origins, not assertions decoded from model output.
 * Business values are NOT exempt: a collision has an ambiguous disposition. */
export type AuthoringMaterialOrigin = "retained_material" | "business_value" | "forbidden_identity";
declare const contextBrand: unique symbol;
export type AuthoringMaterialContext = Readonly<{
  kind: "configured" | "unconfigured" | "unavailable";
  [contextBrand]: true;
}>;
export type AuthoringMaterialContextInput = AuthoringMaterialOwner & {
  /** Host environment only. Only configured names are resolved as identities. */
  env?: NodeJS.ProcessEnv;
  /** Host wiring to the existing verified session owner, never a model/session-JSON adapter. */
  currentVerifiedSession?: (input: AuthoringMaterialOwner & Readonly<{
    contextName: string | null; provider: "http_claims" | "cloud_session";
  }>) => Promise<TrustedContext | undefined>;
};

type Resolution = { kind: AuthoringMaterialContext["kind"]; proof?: string; values?: readonly string[] };
type NativeContext = { owner: AuthoringMaterialOwner; input: AuthoringMaterialContextInput; resolution: Resolution };
const contexts = new WeakMap<object, NativeContext>();
const codes = {
  unavailable: "AUTHORING_MATERIAL_CONTEXT_UNAVAILABLE",
  changed: "AUTHORING_MATERIAL_CONTEXT_CHANGED",
  ambiguous: "AUTHORING_MATERIAL_IDENTITY_AMBIGUOUS",
} as const;
export class AuthoringMaterialContextError extends Error {
  constructor(readonly code: typeof codes[keyof typeof codes]) {
    super(`${code}: Current host identity screening could not approve this material. Preserve the saved job and correct or restore its trusted context before retention or sending.`);
  }
}

/** No context contents, identity values, or value hashes can be serialized.
 * The discriminator alone is never proof: consumers authenticate the object. */
export async function resolveAuthoringMaterialContext(input: AuthoringMaterialContextInput): Promise<AuthoringMaterialContext> {
  let owner: AuthoringMaterialOwner;
  try {
    const root = await fs.realpath(input.projectRoot);
    if (input.readEntry !== undefined) {
      if (input.jobCreatedAt !== undefined || input.sourceSessionId !== undefined
        || !/^bnd_[a-f0-9]{32}$/u.test(input.readEntry.entry_id)
        || Object.keys(input.readEntry).sort().join(",") !== "bindings,entry_id") throw new Error();
      const bindings = readAuthoringBindingsSchema.parse(input.readEntry.bindings);
      if (canonicalJsonDigest(bindings) !== canonicalJsonDigest(input.readEntry.bindings)) throw new Error();
      owner = Object.freeze({ projectRoot: root, readEntry: Object.freeze({ entry_id: input.readEntry.entry_id,
        bindings: Object.freeze(bindings) }) });
    } else if (input.sourceSessionId !== undefined) {
      if (input.jobCreatedAt !== undefined || !/^[a-f0-9-]{36}$/u.test(input.sourceSessionId)) throw new Error();
      owner = Object.freeze({ projectRoot: root, sourceSessionId: input.sourceSessionId });
    } else {
      if (!input.jobCreatedAt || !Number.isFinite(Date.parse(input.jobCreatedAt))) throw new Error();
      owner = Object.freeze({ projectRoot: root, jobCreatedAt: input.jobCreatedAt });
    }
  } catch { throw new AuthoringMaterialContextError(codes.unavailable); }
  const captured: AuthoringMaterialContextInput = { ...owner, env: input.env,
    currentVerifiedSession: input.currentVerifiedSession };
  const resolution = await resolveCurrent(captured);
  const context = Object.freeze(Object.defineProperty({ kind: resolution.kind }, "toJSON", {
    value: () => { throw new AuthoringMaterialContextError(codes.unavailable); }, enumerable: false,
  })) as AuthoringMaterialContext;
  contexts.set(context, { owner, input: captured, resolution });
  return context;
}

async function resolveCurrent(input: AuthoringMaterialContextInput): Promise<Resolution> {
  try {
    const env = input.env ?? process.env;
    const project = await resolveSynapsorProject(input.projectRoot, env);
    if (!project) return { kind: "unavailable" };
    const configPath = await fs.realpath(project.config_path);
    const before = await fs.readFile(configPath, "utf8");
    // Existing configuration owner validates and resolves actual referenced configuration.
    const config = loadRuntimeConfigFromFile(configPath);
    const native = await nativeEnvironmentScreening(input.projectRoot, config, env);
    const definitions: Array<[string | null, NonNullable<RuntimeConfig["trusted_context"]>]> = [
      ...(config.trusted_context ? [[null, native?.definition ?? config.trusted_context] as [null, NonNullable<RuntimeConfig["trusted_context"]>]] : []),
      ...Object.entries(config.contexts ?? {}),
    ];
    if (!definitions.length && config.cloud?.session !== undefined) return { kind: "unavailable" };
    const resolved: Array<{ name: string | null; context: TrustedContext }> = [];
    for (const [name, definition] of definitions) {
      if (!definition || !definition.provider) return { kind: "unavailable" };
      const session = definition.provider === "http_claims" || definition.provider === "cloud_session"
        ? await input.currentVerifiedSession?.({ ...(input.readEntry !== undefined
          ? { projectRoot: input.projectRoot, readEntry: input.readEntry }
          : input.sourceSessionId !== undefined
            ? { projectRoot: input.projectRoot, sourceSessionId: input.sourceSessionId }
            : { projectRoot: input.projectRoot, jobCreatedAt: input.jobCreatedAt! }),
          contextName: name, provider: definition.provider }) : undefined;
      // Selecting an actual named definition does not invent a capability or invoke
      // the proposal actor fallback. Capability-specific checks below use real entries.
      const selected = { ...config, trusted_context: definition };
      const context = resolveTrustedContext(selected, env, undefined, session);
      resolved.push({ name, context });
      for (const capability of config.capabilities ?? []) {
        if ((capability.context ?? null) === name) {
          const actual = resolveTrustedContext(config, env, capability, session);
          // The real capability may bind a reviewed organization. Its optional
          // local proposal actor must not become a configured private principal.
          resolved.push({ name, context: { ...actual, principal: context.principal } });
        }
      }
    }
    for (const capability of config.capabilities ?? []) {
      if (!definitions.some(([name]) => name === (capability.context ?? null))) return { kind: "unavailable" };
    }
    const after = await fs.readFile(configPath, "utf8");
    const currentProject = await resolveSynapsorProject(input.projectRoot, env);
    if (before !== after || !currentProject || await fs.realpath(currentProject.config_path) !== configPath
      || JSON.stringify(native) !== JSON.stringify(await nativeEnvironmentScreening(input.projectRoot, config, env)))
      return { kind: "unavailable" };
    // Private transient comparison only; this proof is never returned or hashed.
    const proof = JSON.stringify({ configPath, source: before, config, native, resolved });
    const values = [...new Set([...resolved.flatMap(({ context }) => [context.tenant_id, context.principal]),
      ...(native?.organizations ?? [])].filter(value => value !== ""))];
    if (definitions.length && !values.length) return { kind: "unavailable" };
    return { kind: definitions.length ? "configured" : "unconfigured", proof, values };
  } catch {
    // Never leak config paths, credentials, identities, or resolver exception text.
    return { kind: "unavailable" };
  }
}

/** Disabled native Read metadata retains configured identity names even when
 * runtime scope needs neither a tenant variable nor per-person restriction.
 * Use the current repository owner, never generation-lock exports or a model
 * projection. This transient selection changes privacy screening only; actual
 * capabilities below still resolve against the unchanged runtime config. */
async function nativeEnvironmentScreening(projectRoot: string, config: RuntimeConfig, env: NodeJS.ProcessEnv) {
  if (config.trusted_context?.provider !== "environment") return undefined;
  const binding = await openBoundProjectControlPolicies(projectRoot, env);
  if (!binding) return undefined;
  try {
    const state = await new OperatorAuthorityRepository(binding).currentReadState();
    const record = state.active.find(({ policy }) => policy.type === "read_authoring");
    if (record?.policy.type !== "read_authoring" || !record.policy.entries.length) throw new Error();
    const authorities = record.policy.entries.map(entry => {
      const candidate = entry.progress.candidate;
      const authority = entry.candidate_lock.trusted_context_authority;
      if (candidate.deployment_profile === "production" || candidate.trusted_context.provider !== "environment"
        || authority?.schema_version !== CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION || authority.provider !== "environment"
        || config.sources?.[candidate.source]?.read_url_env !== entry.candidate_lock.source_env
        || !authority.tenant_env?.trim() || !authority.principal_env?.trim()
        || authority.tenant_env !== candidate.trusted_context.tenant_env
        || authority.principal_env !== candidate.trusted_context.principal_env) throw new Error();
      return authority;
    });
    const authority = authorities[0]!;
    if (authorities.some(item => canonicalJsonDigest(item) !== canonicalJsonDigest(authority))) throw new Error();
    const definition = config.trusted_context;
    const values = definition.values ?? {};
    if ((values.tenant_id_env !== undefined && values.tenant_id_env !== authority.tenant_env)
      || (values.principal_env !== undefined && values.principal_env !== authority.principal_env)
      || (definition.tenant_binding ?? undefined) !== authority.tenant_binding
      || (definition.principal_binding ?? undefined) !== authority.principal_binding) throw new Error();
    return { definition: { ...definition, values: { ...values,
      tenant_id_env: authority.tenant_env, principal_env: authority.principal_env } },
      organizations: record.policy.entries.flatMap(entry => entry.progress.candidate.organization_scope
        ? [entry.progress.candidate.organization_scope.organization_id] : []),
      owner: { repository_id: binding.repository_id, deployment_id: binding.deployment_id,
        project_id: binding.project_id, epoch: state.epoch, revision_id: record.revision.revision_id },
      authoring: record.policy };
  } finally { await binding.close(); }
}

/** Synchronous capture BEFORE reading created_at or awaiting host context.
 * This validates original JSON shape and credentials only. It grants NO identity
 * screening, currentness, retention, display or send approval. Pass its exact
 * parsed projection to assertAuthoringMaterial and retain only that result. */
export function snapshotAuthoringMaterial(value: unknown): string {
  try { return assertCredentials(snapshotJson(value, new WeakSet())); }
  catch (error) {
    if (error instanceof AuthoringResumeMaterialError || error instanceof AuthoringMaterialContextError) throw error;
    throw new AuthoringMaterialContextError(codes.unavailable);
  }
}

/** Call at the actual retention/send/save boundary with the same complete material
 * and owning-schema origin. ONLY the returned immutable JSON may be retained or
 * sent; do not subsequently serialize the caller's mutable value. This checks
 * currentness, not a lease or an ACK. Native writers still own their CAS. */
export async function assertAuthoringMaterial(input: {
  value: unknown; owner: AuthoringMaterialOwner; origin: AuthoringMaterialOrigin; context: AuthoringMaterialContext;
}): Promise<string> {
  // Capture the nested transient frame before any filesystem/session wait.
  const owner = { ...input.owner, ...(input.owner.readEntry ? { readEntry: {
    entry_id: input.owner.readEntry.entry_id, bindings: { ...input.owner.readEntry.bindings },
  } } : {}) }, origin = input.origin, context = input.context;
  let material: unknown;
  try { material = snapshotJson(input.value, new WeakSet()); }
  catch { throw new AuthoringMaterialContextError(codes.unavailable); }
  const native = contexts.get(context);
  if (!native || native.resolution.kind === "unavailable") throw new AuthoringMaterialContextError(codes.unavailable);
  let root: string;
  try { root = await fs.realpath(owner.projectRoot); }
  catch { throw new AuthoringMaterialContextError(codes.unavailable); }
  if (root !== native.owner.projectRoot || owner.jobCreatedAt !== native.owner.jobCreatedAt
    || owner.sourceSessionId !== native.owner.sourceSessionId
    || canonicalJsonDigest(owner.readEntry ?? null) !== canonicalJsonDigest(native.owner.readEntry ?? null))
    throw new AuthoringMaterialContextError(codes.changed);
  if (!["retained_material", "business_value", "forbidden_identity"].includes(origin))
    throw new AuthoringMaterialContextError(codes.unavailable);
  const current = await resolveCurrent(native.input);
  if (current.kind === "unavailable" || current.kind !== native.resolution.kind || current.proof !== native.resolution.proof)
    throw new AuthoringMaterialContextError(codes.changed);
  const serialized = assertCredentials(material);
  for (const scalar of materialScalars(material)) {
    if (origin === "forbidden_identity" && scalar !== "") throw identityBlocked();
    if (current.values?.some(value => typeof scalar === "string" ? scalar.includes(value) : String(scalar) === value)) {
      if (origin === "business_value") throw new AuthoringMaterialContextError(codes.ambiguous);
      throw identityBlocked();
    }
  }
  return serialized;
}

function identityBlocked(): AuthoringResumeMaterialError {
  return new AuthoringResumeMaterialError("BOUNDARY_AUTHORING_RESUME_TRUSTED_IDENTITY_BLOCKED",
    "A current configured identity cannot be retained in authoring material.");
}
function assertCredentials(value: unknown): string {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(value); }
  catch { throw new AuthoringMaterialContextError(codes.unavailable); }
  if (serialized === undefined) throw new AuthoringMaterialContextError(codes.unavailable);
  if (/(?:postgres|mysql):\/\/|https?:\/\/(?!127\.0\.0\.1(?::\d+)?(?:\/|"))|BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]+/iu.test(serialized))
    throw new AuthoringResumeMaterialError("BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED",
      "credentials, endpoint URLs, and private keys cannot be saved in Boundary-authoring state.");
  return serialized;
}
function* materialScalars(value: unknown): Generator<string | number | boolean> {
  if (typeof value === "string" || typeof value === "boolean") yield value;
  else if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new AuthoringMaterialContextError(codes.unavailable);
    yield value;
  }
  else if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) yield* materialScalars(value[i]); }
  else if (value && typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      throw new AuthoringMaterialContextError(codes.unavailable);
    for (const [key, item] of Object.entries(value)) { yield key; yield* materialScalars(item); }
  }
}

/** Validate ORIGINAL shape before projection: cloning first erases prototypes.
 * Descriptors avoid executing accessors; proxies are refused before reflection.
 * The detached JSON containers have no inherited serialization hooks. */
function snapshotJson(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value))
    throw new AuthoringMaterialContextError(codes.unavailable);
  const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    throw new AuthoringMaterialContextError(codes.unavailable);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string")) throw new AuthoringMaterialContextError(codes.unavailable);
  ancestors.add(value);
  try {
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1)
        throw new AuthoringMaterialContextError(codes.unavailable);
      const result: unknown[] = [];
      Object.setPrototypeOf(result, null);
      for (let i = 0; i < length; i++) {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          throw new AuthoringMaterialContextError(codes.unavailable);
        result[i] = snapshotJson(descriptor.value, ancestors);
      }
      return Object.freeze(result);
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key as string]!;
      if (!("value" in descriptor) || !descriptor.enumerable)
        throw new AuthoringMaterialContextError(codes.unavailable);
      result[key as string] = snapshotJson(descriptor.value, ancestors);
    }
    return Object.freeze(result);
  } finally { ancestors.delete(value); }
}
