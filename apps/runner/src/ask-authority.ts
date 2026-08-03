import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  AskError,
  askToolSurfaceDigest,
  type AskToolDefinition,
} from "./model-ask.js";

type ActiveBoundaryAuthorityIdentity = {
  name: string;
  digest: `sha256:${string}`;
  deployment_profile?: unknown;
  table_count: number;
};

export type AskDeploymentProfile = "development" | "staging" | "production" | "unknown";
export type AskMode = "authoring" | "runtime";

export type AskAuthority = {
  authority_digest: `sha256:${string}`;
  mode: AskMode;
  tool_surface_digest: `sha256:${string}`;
  runtime_config_digest: `sha256:${string}`;
  active_boundary_digest?: `sha256:${string}`;
  active_boundary_set_digest?: `sha256:${string}`;
  active_boundary_digests?: `sha256:${string}`[];
};

export async function resolveActiveBoundarySummary(
  projectRoot: string,
): Promise<{
  name: string;
  names: string[];
  boundary_count: number;
  table_count: number;
} | undefined> {
  const boundaries = await optionalActiveBoundaries(projectRoot);
  if (!boundaries.length) return undefined;
  const names = boundaries.map((boundary) => boundary.name).sort();
  return {
    name: names.length === 1 ? names[0]! : `${names.length} active boundaries`,
    names,
    boundary_count: names.length,
    table_count: boundaries.reduce((count, boundary) => count + boundary.table_count, 0),
  };
}

export async function resolveAskDeploymentProfile(
  projectRoot: string,
  configured?: AskDeploymentProfile,
): Promise<AskDeploymentProfile> {
  if (configured) return configured;
  const active = (await optionalActiveBoundaries(projectRoot))[0];
  const draft = await readOptionalJson(
    path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json"),
  );
  const profile = active
    ? active.deployment_profile
    : isRecord(draft)
      ? draft.deployment_profile
      : undefined;
  return profile === "development" || profile === "staging" || profile === "production"
    ? profile
    : "unknown";
}

export async function computeAskAuthority(input: {
  tools: AskToolDefinition[];
  configPath: string;
  projectRoot: string;
  profile: AskDeploymentProfile;
  mode: AskMode;
}): Promise<AskAuthority> {
  const activeBoundaries = await optionalActiveBoundaries(input.projectRoot);
  const activeBoundaryDigests = activeBoundaries
    .map((boundary) => boundary.digest)
    .sort();
  const activeBoundaryDigest = activeBoundaryDigests.at(-1);
  const activeBoundarySetDigest = activeBoundaries.length
    ? canonicalJsonDigest({
      schema_version: "synapsor.active-exploration-boundaries.v1",
      boundaries: activeBoundaries
        .map((boundary) => ({ name: boundary.name, digest: boundary.digest }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    })
    : undefined;
  if (input.mode === "authoring" && !activeBoundarySetDigest) {
    throw new AskError(
      "ASK_AUTHORING_AUTHORITY_UNAVAILABLE",
      "Authoring Ask requires an active reviewed Scoped Explore digest.",
      409,
    );
  }
  if (input.mode === "runtime" && activeBoundarySetDigest) {
    throw new AskError(
      "ASK_MODE_CONFLICT",
      "Runtime Ask is unavailable while Scoped Explore is active.",
      409,
    );
  }
  const toolSurfaceDigest = askToolSurfaceDigest(input.tools);
  const runtimeConfig = await readOptionalJson(input.configPath);
  if (!isRecord(runtimeConfig)) {
    throw new AskError(
      "ASK_RUNTIME_CONFIG_UNAVAILABLE",
      "Ask could not bind consent to the active Runner configuration.",
      409,
    );
  }
  const runtimeConfigDigest = canonicalJsonDigest(runtimeConfig);
  return {
    authority_digest: canonicalJsonDigest({
      schema_version: "synapsor.ask-authority.v1",
      deployment_profile: input.profile,
      mode: input.mode,
      tool_surface_digest: toolSurfaceDigest,
      runtime_config_digest: runtimeConfigDigest,
      active_boundary_set_digest: activeBoundarySetDigest ?? null,
      active_boundary_digests: activeBoundaryDigests,
    }),
    mode: input.mode,
    tool_surface_digest: toolSurfaceDigest,
    runtime_config_digest: runtimeConfigDigest,
    ...(activeBoundaryDigest ? { active_boundary_digest: activeBoundaryDigest } : {}),
    ...(activeBoundarySetDigest ? { active_boundary_set_digest: activeBoundarySetDigest } : {}),
    ...(activeBoundaryDigests.length ? { active_boundary_digests: activeBoundaryDigests } : {}),
  };
}

async function optionalActiveBoundaries(
  projectRoot: string,
): Promise<ActiveBoundaryAuthorityIdentity[]> {
  const registry = await readOptionalJson(
    path.join(projectRoot, ".synapsor/exploration-boundaries.active.json"),
  );
  if (registry !== null) {
    if (!isRecord(registry)
      || registry.schema_version !== "synapsor.active-exploration-boundaries.v1"
      || !Array.isArray(registry.boundaries)
      || registry.boundaries.length < 1
      || registry.boundaries.length > 8) {
      throw new AskError("ASK_AUTHORITY_FILE_INVALID", "Ask could not read a valid reviewed authority file.", 409);
    }
    return registry.boundaries.map((boundary, index) =>
      activeBoundaryIdentity(boundary, `active boundary ${index + 1}`));
  }
  const legacy = await readOptionalJson(
    path.join(projectRoot, ".synapsor/exploration-boundary.active.json"),
  );
  return legacy === null ? [] : [activeBoundaryIdentity(legacy, "legacy active boundary")];
}

function activeBoundaryIdentity(
  value: unknown,
  label: string,
): ActiveBoundaryAuthorityIdentity {
  if (!isRecord(value) || !isRecord(value.activation)) {
    throw new AskError("ASK_AUTHORITY_FILE_INVALID", `Ask could not read a valid ${label}.`, 409);
  }
  const digest = value.activation.digest;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new AskError("ASK_AUTHORITY_FILE_INVALID", `Ask could not read a valid ${label}.`, 409);
  }
  const pack = record(value.pack);
  const rawName = typeof pack.name === "string" ? pack.name : "legacy_active";
  const name = /^[a-z][a-z0-9_.-]{0,63}$/.test(rawName) ? rawName : "legacy_active";
  return {
    name,
    digest: digest as `sha256:${string}`,
    deployment_profile: value.deployment_profile,
    table_count: Array.isArray(pack.resources) ? pack.resources.length : 0,
  };
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) {
      throw new AskError(
        "ASK_AUTHORITY_FILE_INVALID",
        "Ask authority must come from bounded regular project files.",
        409,
      );
    }
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof AskError) throw error;
    throw new AskError(
      "ASK_AUTHORITY_FILE_INVALID",
      "Ask could not read a valid reviewed authority file.",
      409,
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
