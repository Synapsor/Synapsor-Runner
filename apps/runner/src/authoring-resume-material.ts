import fs from "node:fs/promises";
import { types } from "node:util";
import { loadRuntimeConfigFromFile, resolveTrustedContext, type RuntimeConfig, type TrustedContext } from "@synapsor-runner/mcp-server";
import { resolveSynapsorProject } from "./project-resolution.js";
import { AuthoringResumeMaterialError } from "./authoring-checkpoint-save-error.js";

export type AuthoringMaterialOwner = Readonly<{ projectRoot: string; jobCreatedAt: string }>;
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
    if (!input.jobCreatedAt || !Number.isFinite(Date.parse(input.jobCreatedAt))) throw new Error();
    owner = Object.freeze({ projectRoot: await fs.realpath(input.projectRoot), jobCreatedAt: input.jobCreatedAt });
  } catch { throw new AuthoringMaterialContextError(codes.unavailable); }
  const captured = { ...input, ...owner };
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
    const definitions: Array<[string | null, NonNullable<RuntimeConfig["trusted_context"]>]> = [
      ...(config.trusted_context ? [[null, config.trusted_context] as [null, NonNullable<RuntimeConfig["trusted_context"]>]] : []),
      ...Object.entries(config.contexts ?? {}),
    ];
    if (!definitions.length && config.cloud?.session !== undefined) return { kind: "unavailable" };
    const resolved: Array<{ name: string | null; context: TrustedContext }> = [];
    for (const [name, definition] of definitions) {
      if (!definition || !definition.provider) return { kind: "unavailable" };
      const session = definition.provider === "http_claims" || definition.provider === "cloud_session"
        ? await input.currentVerifiedSession?.({ projectRoot: input.projectRoot, jobCreatedAt: input.jobCreatedAt,
          contextName: name, provider: definition.provider }) : undefined;
      // Selecting an actual named definition does not invent a capability or invoke
      // the proposal actor fallback. Capability-specific checks below use real entries.
      const selected = name === null ? config : { ...config, trusted_context: definition };
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
    if (before !== after || !currentProject || await fs.realpath(currentProject.config_path) !== configPath)
      return { kind: "unavailable" };
    // Private transient comparison only; this proof is never returned or hashed.
    const proof = JSON.stringify({ configPath, source: before, config, resolved });
    const values = [...new Set(resolved.flatMap(({ context }) => [context.tenant_id, context.principal]).filter(value => value !== ""))];
    if (definitions.length && !values.length) return { kind: "unavailable" };
    return { kind: definitions.length ? "configured" : "unconfigured", proof, values };
  } catch {
    // Never leak config paths, credentials, identities, or resolver exception text.
    return { kind: "unavailable" };
  }
}

/** Call at the actual retention/send/save boundary with the same complete material
 * and owning-schema origin. ONLY the returned immutable JSON may be retained or
 * sent; do not subsequently serialize the caller's mutable value. This checks
 * currentness, not a lease or an ACK. Native writers still own their CAS. */
export async function assertAuthoringMaterial(input: {
  value: unknown; owner: AuthoringMaterialOwner; origin: AuthoringMaterialOrigin; context: AuthoringMaterialContext;
}): Promise<string> {
  const owner = { ...input.owner }, origin = input.origin, context = input.context;
  let material: unknown;
  try { material = snapshotJson(input.value, new WeakSet()); }
  catch { throw new AuthoringMaterialContextError(codes.unavailable); }
  const native = contexts.get(context);
  if (!native || native.resolution.kind === "unavailable") throw new AuthoringMaterialContextError(codes.unavailable);
  let root: string;
  try { root = await fs.realpath(owner.projectRoot); }
  catch { throw new AuthoringMaterialContextError(codes.unavailable); }
  if (root !== native.owner.projectRoot || owner.jobCreatedAt !== native.owner.jobCreatedAt)
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
