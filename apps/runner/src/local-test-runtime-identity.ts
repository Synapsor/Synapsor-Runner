import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { withProjectRuntimeAdmission } from "./project-runtime-admission.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

export const LOCAL_TEST_RUNTIME_IDENTITY_VERSION = "synapsor.local-test-runtime-identity.v1";
export const DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH = ".synapsor/local-test-runtime.json";

export function localRuntimeSelectionOption(args: string[], flag: "--local-client" | "--local-test-runtime"): string | undefined {
  const indices = args.flatMap((value, index) => value === flag || value.startsWith(`${flag}=`) ? [index] : []);
  if (!indices.length) return undefined;
  const index = indices[0]!;
  if (indices.length !== 1 || args[index] !== flag || !args[index + 1] || args[index + 1]!.startsWith("--")) {
    throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_INVALID: supply exactly one explicit reviewed local identity reference; no fallback is allowed.");
  }
  return args[index + 1];
}

export function localClientRuntimePath(reference: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}\.[a-f0-9]{64}$/u.test(reference)) {
    throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_INVALID: select an exact reviewed local client reference.");
  }
  return `.synapsor/local-test-runtime.${reference}.json`;
}

export function localClientReference(runtimePath: string): string | undefined {
  const match = /^\.synapsor\/local-test-runtime\.(.+)\.json$/u.exec(runtimePath);
  if (!match) return undefined;
  localClientRuntimePath(match[1]!);
  return match[1];
}

export type LocalTestRuntimeBinding = {
  role: "tenant" | "principal";
  environment: string;
};

type LocalTestRuntimeIdentity = {
  schema_version: typeof LOCAL_TEST_RUNTIME_IDENTITY_VERSION;
  project_binding: `sha256:${string}`;
  bindings: LocalTestRuntimeBinding[];
  values: Record<string, string>;
  created_at: string;
};

function validEnvironmentName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/u.test(value);
}

function reservedEnvironmentName(value: string): boolean {
  return value === "DATABASE_URL"
    || value === "SYNAPSOR_DATABASE_READ_URL"
    || value === "SYNAPSOR_DATABASE_WRITE_URL"
    || /(?:^|_)(?:READ|WRITE|WRITER)_DATABASE_URL$/u.test(value)
    || /^(?:OPENAI|ANTHROPIC|OPENROUTER)_API_KEY$/u.test(value)
    || /^(?:NODE_OPTIONS|NODE_PATH|NODE_ENV|PATH|HOME|SHELL|PWD|USER|LOGNAME|TERM)$/u.test(value)
    || /^(?:LD_|DYLD_|AWS_)/u.test(value)
    || /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASS|PRIVATE_KEY|CREDENTIALS|URL)$/u.test(value);
}

function validValue(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= 1024 && !/[\x00-\x1f\x7f]/u.test(value);
}

function exactBindings(bindings: LocalTestRuntimeBinding[]): LocalTestRuntimeBinding[] {
  if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > 2) {
    throw new Error("LOCAL_TEST_RUNTIME_BINDINGS_INVALID: local test runtime needs one or two reviewed environment bindings.");
  }
  const normalized = bindings.map((binding) => ({ role: binding.role, environment: binding.environment }));
  if (normalized.some((binding) => (binding.role !== "tenant" && binding.role !== "principal") || !validEnvironmentName(binding.environment))
    || new Set(normalized.map((binding) => `${binding.role}:${binding.environment}`)).size !== normalized.length
    || new Set(normalized.map((binding) => binding.role)).size !== normalized.length
    || new Set(normalized.map((binding) => binding.environment)).size !== normalized.length) {
    throw new Error("LOCAL_TEST_RUNTIME_BINDINGS_INVALID: local test runtime may use each reviewed tenant/principal environment binding once.");
  }
  const reserved = normalized.find((binding) => reservedEnvironmentName(binding.environment));
  if (reserved) {
    throw new Error(`LOCAL_TEST_RUNTIME_BINDING_FORBIDDEN: ${reserved.environment} is a credential or process-control environment name, not a local test identity binding.`);
  }
  return normalized.sort((left, right) => left.role.localeCompare(right.role));
}

function boundaryIdentityContract(boundaries: Awaited<ReturnType<typeof loadActivatedExplorationBoundaries>>) {
  return boundaries.map((boundary) => ({
    source: boundary.source,
    deployment_profile: boundary.deployment_profile,
    trusted_context: boundary.trusted_context,
    organization_scope: boundary.organization_scope ?? null,
    resource_scope: boundary.pack.resources.map((resource) => ({
      schema: resource.schema,
      table: resource.table,
      tenant_key: resource.tenant_key ?? null,
      tenant_scope: resource.tenant_scope ?? null,
      principal_key: resource.principal_key ?? null,
      principal_scope: resource.principal_scope ?? null,
      shared_reference_scope: resource.shared_reference_scope ?? null,
      rls_session: resource.rls_session ?? null,
    })).sort((left, right) => `${left.schema}.${left.table}`.localeCompare(`${right.schema}.${right.table}`)),
  })).sort((left, right) => canonicalJsonDigest(left).localeCompare(canonicalJsonDigest(right)));
}

export async function localTestRuntimeIdentityContract(projectRoot: string): Promise<{ project_binding: `sha256:${string}`; bindings: LocalTestRuntimeBinding[] }> {
  const root = await fs.realpath(projectRoot);
  const boundaries = await loadActivatedExplorationBoundaries(root);
  if (!boundaries.length || boundaries.some((boundary) => boundary.activation.state !== "active"
    || (boundary.deployment_profile !== "development" && boundary.deployment_profile !== "staging")
    || boundary.trusted_context.provider !== "environment")) {
    throw new Error("LOCAL_TEST_RUNTIME_NOT_ALLOWED: local test identity requires active development/staging Read authority using reviewed environment bindings. Production or HTTP-claim authority cannot use this file.");
  }
  const values = new Map<string, LocalTestRuntimeBinding>();
  for (const boundary of boundaries) {
    if (boundary.trusted_context.tenant_env) values.set(`tenant:${boundary.trusted_context.tenant_env}`, {
      role: "tenant", environment: boundary.trusted_context.tenant_env,
    });
    if (boundary.trusted_context.principal_env) values.set(`principal:${boundary.trusted_context.principal_env}`, {
      role: "principal", environment: boundary.trusted_context.principal_env,
    });
  }
  const bindings = exactBindings([...values.values()]);
  return { bindings, project_binding: canonicalJsonDigest({ project_root: root, identity_contract: boundaryIdentityContract(boundaries) }) };
}

function valuesForBindings(bindings: LocalTestRuntimeBinding[], values: Record<string, string>): Record<string, string> {
  const names = new Set(bindings.map((binding) => binding.environment));
  if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).some((name) => !names.has(name))) {
    throw new Error("LOCAL_TEST_RUNTIME_VALUES_INVALID: local test runtime contains an unreviewed identity binding.");
  }
  const result: Record<string, string> = {};
  for (const binding of bindings) {
    const value = values[binding.environment];
    if (!validValue(value)) {
      throw new Error(`LOCAL_TEST_RUNTIME_VALUES_INVALID: local test ${binding.role} identity is missing or invalid.`);
    }
    result[binding.environment] = value.trim();
  }
  return result;
}

function containedRuntimePath(projectRoot: string, runtimePath = DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH): string {
  const root = path.resolve(projectRoot);
  const destination = path.resolve(root, runtimePath);
  const expected = path.resolve(root, DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH);
  if (destination !== expected && (!localClientReference(runtimePath) || destination !== path.join(root, runtimePath))) {
    throw new Error("LOCAL_TEST_RUNTIME_PATH_INVALID: local test runtime must use the generated project runtime reference.");
  }
  return destination;
}

async function runtimeDirectory(projectRoot: string, create: boolean, runtimePath?: string): Promise<{ root: string; directory: string; destination: string } | undefined> {
  const root = await fs.realpath(projectRoot);
  const destination = containedRuntimePath(root, runtimePath);
  const directory = path.dirname(destination);
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const state = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!state) {
    if (!create) return undefined;
    throw new Error("LOCAL_TEST_RUNTIME_PATH_INVALID: local test runtime directory must be a real project-owned directory.");
  }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error("LOCAL_TEST_RUNTIME_PATH_INVALID: local test runtime directory must be a real project-owned directory.");
  }
  const currentUid = process.getuid?.();
  if (process.platform !== "win32" && (state.mode & 0o022) !== 0) {
    throw new Error("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID: local test runtime directory must not be writable by group or other users.");
  }
  if (process.platform !== "win32" && currentUid !== undefined && state.uid !== currentUid) {
    throw new Error("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID: local test runtime directory must be owned by the current user.");
  }
  return { root, directory, destination };
}

export async function saveLocalTestRuntimeIdentity(input: {
  projectRoot: string;
  bindings: LocalTestRuntimeBinding[];
  values: Record<string, string>;
  now?: string;
  runtimePath?: string;
  profileName?: string;
  expectedProjectBinding?: string;
}): Promise<{ path: string; bindings: LocalTestRuntimeBinding[]; reference?: string }> {
  if (input.profileName !== undefined) {
    if (!/^[a-z][a-z0-9-]{0,31}$/u.test(input.profileName) || input.runtimePath !== undefined || !input.expectedProjectBinding) {
      throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_INVALID: a named client needs a reviewed label and exact current identity contract.");
    }
    return withProjectRuntimeAdmission(input.projectRoot, root => withProjectAuthorityMutation(root,
      () => persistLocalTestRuntimeIdentity({ ...input, projectRoot: root })));
  }
  return persistLocalTestRuntimeIdentity(input);
}

async function persistLocalTestRuntimeIdentity(input: Parameters<typeof saveLocalTestRuntimeIdentity>[0]): ReturnType<typeof saveLocalTestRuntimeIdentity> {
  const authority = await localTestRuntimeIdentityContract(input.projectRoot);
  if (input.expectedProjectBinding !== undefined && input.expectedProjectBinding !== authority.project_binding) {
    throw new Error("LOCAL_TEST_RUNTIME_BINDING_CHANGED: identity authority changed after review; review again before saving.");
  }
  const requested = exactBindings(input.bindings);
  if (canonicalJsonDigest(requested) !== canonicalJsonDigest(authority.bindings)) {
    throw new Error("LOCAL_TEST_RUNTIME_BINDING_CHANGED: local test identity does not exactly match current reviewed environment bindings.");
  }
  const identity: LocalTestRuntimeIdentity = {
    schema_version: LOCAL_TEST_RUNTIME_IDENTITY_VERSION,
    project_binding: authority.project_binding,
    bindings: requested,
    values: valuesForBindings(requested, input.values),
    created_at: input.now ?? new Date().toISOString(),
  };
  const reference = input.profileName === undefined ? undefined : `${input.profileName}.${canonicalJsonDigest(identity).slice(7)}`;
  const runtimePath = reference ? localClientRuntimePath(reference) : input.runtimePath;
  // Named revisions can only be created from reviewed values, never overwritten
  // by supplying their path to the legacy default saver.
  if (!reference && runtimePath !== undefined && path.resolve(input.projectRoot, runtimePath) !== path.resolve(input.projectRoot, DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH)) {
    throw new Error("LOCAL_TEST_RUNTIME_PATH_INVALID: use named client review to create a new fixed revision.");
  }
  const runtime = await runtimeDirectory(input.projectRoot, true, runtimePath);
  if (!runtime) throw new Error("LOCAL_TEST_RUNTIME_PATH_INVALID: local test runtime directory is unavailable.");
  const { destination } = runtime;
  const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (reference) {
      if (await fs.lstat(`${destination}.retired`).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
        throw new Error("LOCAL_TEST_RUNTIME_RETIRED: this exact local reference is retired.");
      }
      // Exclusive creation prevents a concurrent save from replacing a reviewed
      // revision. The temporary hard link is removed before returning its ref.
      await fs.link(temporary, destination);
      await fs.unlink(temporary);
    } else await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
  return { path: destination, bindings: requested, ...(reference ? { reference } : {}) };
}

export async function loadLocalTestRuntimeIdentity(input: {
  projectRoot: string;
  runtimePath?: string;
}): Promise<Record<string, string> | undefined> {
  if (input.runtimePath !== undefined) containedRuntimePath(input.projectRoot, input.runtimePath);
  const reference = input.runtimePath ? localClientReference(input.runtimePath) : undefined;
  const runtime = await runtimeDirectory(input.projectRoot, false, input.runtimePath);
  const missing = () => {
    if (reference) throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_MISSING: the selected reviewed local identity is missing; no default fallback is allowed.");
    return undefined;
  };
  if (!runtime) return missing();
  const { destination } = runtime;
  if (reference && await fs.lstat(`${destination}.retired`).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) {
    throw new Error("LOCAL_TEST_RUNTIME_RETIRED: this local identity reference is retired for future launches. Stop existing clients explicitly.");
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return missing();
    throw new Error("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID: local test identity file must be a regular owner-only file.");
  }
  let raw: string;
  try {
    const stat = await handle.stat();
    const currentUid = process.getuid?.();
    if (stat.size > 8_192 || !stat.isFile() || stat.nlink !== 1
      || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (currentUid !== undefined && stat.uid !== currentUid)))) {
      throw new Error("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID: local test identity file must be a regular owner-only file.");
    }
    const bytes = Buffer.alloc(8_193);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset > 8_192) {
      throw new Error("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID: local test identity file must be a regular owner-only file.");
    }
    raw = bytes.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("LOCAL_TEST_RUNTIME_INVALID: local test identity file is not valid JSON."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("LOCAL_TEST_RUNTIME_INVALID: local test identity file must be an object.");
  const value = parsed as Record<string, unknown>;
  if (reference && !reference.endsWith(`.${canonicalJsonDigest(value).slice(7)}`)) {
    throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_CHANGED: the selected identity no longer matches its exact reviewed revision.");
  }
  if (Object.keys(value).some((key) => !["schema_version", "project_binding", "bindings", "values", "created_at"].includes(key))
    || value.schema_version !== LOCAL_TEST_RUNTIME_IDENTITY_VERSION || typeof value.project_binding !== "string"
    || !Array.isArray(value.bindings) || !value.values || typeof value.values !== "object" || Array.isArray(value.values)
    || typeof value.created_at !== "string") {
    throw new Error("LOCAL_TEST_RUNTIME_INVALID: local test identity file has an unsupported shape.");
  }
  const bindings = exactBindings(value.bindings as LocalTestRuntimeBinding[]);
  const authority = await localTestRuntimeIdentityContract(input.projectRoot);
  if (value.project_binding !== authority.project_binding || canonicalJsonDigest(bindings) !== canonicalJsonDigest(authority.bindings)) {
    throw new Error("LOCAL_TEST_RUNTIME_BINDING_CHANGED: local test identity no longer matches the current reviewed project or authority.");
  }
  return valuesForBindings(bindings, value.values as Record<string, string>);
}

/** Lists reference labels only; values stay in the private identity documents. */
export async function listLocalTestRuntimeProfiles(projectRoot: string): Promise<Array<{ reference: string; retired: boolean }>> {
  const runtime = await runtimeDirectory(projectRoot, false);
  if (!runtime) return [];
  const files = await fs.readdir(runtime.directory);
  return files.filter(name => /^local-test-runtime\.[a-z][a-z0-9-]{0,31}\.[a-f0-9]{64}\.json$/u.test(name))
    .sort().map(name => ({ reference: localClientReference(`.synapsor/${name}`)!, retired: files.includes(`${name}.retired`) }));
}

/** Future-launch retirement only. A running process keeps its cached context. */
export async function retireLocalTestRuntimeProfile(projectRoot: string, reference: string): Promise<void> {
  const runtimePath = localClientRuntimePath(reference);
  await withProjectRuntimeAdmission(projectRoot, root => withProjectAuthorityMutation(root, async () => {
    const runtime = await runtimeDirectory(root, false, runtimePath);
    if (!runtime) throw new Error("LOCAL_TEST_RUNTIME_REFERENCE_MISSING: selected reference is missing.");
    const stat = await fs.lstat(runtime.destination);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || (uid !== undefined && stat.uid !== uid)))) {
      throw new Error("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID: selected identity must be a regular private file.");
    }
    let file: Awaited<ReturnType<typeof fs.open>>;
    try { file = await fs.open(`${runtime.destination}.retired`, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
    try { await file.writeFile("Retired for future launches; existing clients must be stopped explicitly.\n"); await file.sync(); }
    finally { await file.close(); }
  }));
}

export async function withLocalTestRuntimeIdentity<T>(input: {
  projectRoot: string;
  runtimePath?: string;
}, operation: () => Promise<T>): Promise<T> {
  const values = await loadLocalTestRuntimeIdentity(input);
  if (!values) return operation();
  const previous = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
  const conflict = [...previous].find(([name, value]) => value !== undefined && value !== values[name]);
  if (conflict) {
    throw new Error(`LOCAL_TEST_RUNTIME_ENV_CONFLICT: inherited ${conflict[0]} does not match the reviewed local test identity.`);
  }
  try {
    Object.assign(process.env, values);
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
