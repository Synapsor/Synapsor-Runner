import {
  assertValidRunnerCapabilityConfig,
} from "@synapsor-runner/config";
import type {
  StoredProposal,
} from "@synapsor-runner/proposal-store";
import {
  canonicalJsonDigest,
  parseFreshnessAuthority,
  parseFreshnessProof,
  protocolVersions,
  type ChangeSet,
  type FreshnessAuthorityV1,
  type FreshnessDependencyV1,
  type FreshnessProofV1,
} from "@synapsor-runner/protocol";
import mysql from "mysql2/promise";
import type {
  RuntimeSourceConfig,
  RuntimeCapabilityConfig,
  RuntimeConfig,
  TrustedContext,
  DbRowReader,
  TenantCredentialResolver,
  CapturedFreshnessEvidence,
  CapturedFreshnessAuthority,
  ProposalFreshnessEvaluation,
  FreshnessProofCheck,
} from "./runtime-types.js";
import {
  isSetCapability,
} from "./capability-authority.js";
import {
  queryFingerprintFor,
} from "./read-planning.js";
import {
  resolveRuntimeConfig,
} from "./runtime-config.js";
import {
  McpRuntimeError,
  errorMessage,
  errorStringProperty,
} from "./runtime-errors.js";
import {
  conflictGuardScalar,
  scalar,
  stableId,
} from "./safe-values.js";
import {
  createMcpRuntimeSharedResources,
} from "./source-runtime.js";

export async function captureProposalFreshnessAuthority(input: {
  config: RuntimeConfig;
  capability: RuntimeCapabilityConfig;
  args: Record<string, unknown>;
  context: TrustedContext;
  source: RuntimeSourceConfig;
  readRow: DbRowReader;
  env: NodeJS.ProcessEnv;
  proposalId: string;
  createdAt: string;
  targetMemberCount: number;
}): Promise<CapturedFreshnessAuthority | undefined> {
  const policy = input.config.proposal_freshness?.[input.capability.name];
  if (!policy) return undefined;
  const operation = input.capability.operation?.kind ?? "update";
  const targetMode: FreshnessAuthorityV1["target"]["mode"] = operation === "insert"
    ? "not_applicable"
    : isSetCapability(input.capability)
      ? "frozen_set"
      : "exact_guard";
  const captured: Array<{ descriptor: FreshnessDependencyV1; evidence: CapturedFreshnessEvidence }> = [];
  for (const configured of policy.dependencies ?? []) {
    const capability = (input.config.capabilities ?? []).find((item) => item.name === configured.capability);
    if (!capability || capability.kind !== "read") {
      throw new McpRuntimeError("FRESHNESS_DEPENDENCY_INVALID", `Reviewed freshness dependency ${configured.id} is unavailable.`);
    }
    const identity = scalar(input.args[configured.identity_from_arg]);
    if (identity === null) {
      throw new McpRuntimeError("FRESHNESS_DEPENDENCY_IDENTITY_MISSING", `Freshness dependency ${configured.id} requires its reviewed scalar identity.`);
    }
    const readCapability: RuntimeCapabilityConfig = {
      ...capability,
      conflict_guard: { column: configured.version_column },
    };
    const current = await input.readRow({
      sourceName: capability.source,
      source: input.source,
      capability: readCapability,
      args: { [capability.lookup.id_from_arg]: identity },
      context: input.context,
      env: input.env,
      transaction_mode: "read_only",
    });
    if (current.rowCount !== 1) {
      throw new McpRuntimeError("FRESHNESS_DEPENDENCY_UNRESOLVED", `Freshness dependency ${configured.id} did not resolve to one authorized row.`);
    }
    const primaryValue = scalar(current.row[capability.target.primary_key]);
    const versionValue = scalar(current.row[configured.version_column]);
    if (primaryValue === null || versionValue === null) {
      throw new McpRuntimeError("FRESHNESS_DEPENDENCY_VERSION_MISSING", `Freshness dependency ${configured.id} lacks an exact primary-key or version value.`);
    }
    const bundleId = stableId("evf", {
      proposal_id: input.proposalId,
      dependency_id: configured.id,
      primary_key: primaryValue,
      created_at: input.createdAt,
    });
    const queryFingerprint = queryFingerprintFor(readCapability, input.context);
    const unsigned = {
      id: configured.id,
      capability: configured.capability,
      source_id: capability.source,
      engine: input.source.engine,
      target: {
        schema: capability.target.schema,
        table: capability.target.table,
        primary_key: { column: capability.target.primary_key, value: primaryValue },
        tenant_column: capability.target.tenant_key ?? "__single_tenant_dev",
        ...(capability.target.principal_scope_key ? { principal_column: capability.target.principal_scope_key } : {}),
      },
      expected_version: { column: configured.version_column, value: conflictGuardScalar(versionValue) },
      evidence: {
        bundle_id: bundleId,
        query_fingerprint: queryFingerprint,
      },
    };
    const descriptor = {
      ...unsigned,
      descriptor_digest: canonicalJsonDigest(unsigned),
    } satisfies FreshnessDependencyV1;
    captured.push({
      descriptor,
      evidence: {
        dependency_id: configured.id,
        bundle_id: bundleId,
        query_fingerprint: queryFingerprint,
        capability,
        primary_key: descriptor.target.primary_key,
        version_column: configured.version_column,
      },
    });
  }
  captured.sort((left, right) =>
    left.descriptor.source_id.localeCompare(right.descriptor.source_id)
      || left.descriptor.target.schema.localeCompare(right.descriptor.target.schema)
      || left.descriptor.target.table.localeCompare(right.descriptor.target.table)
      || JSON.stringify(left.descriptor.target.primary_key.value).localeCompare(JSON.stringify(right.descriptor.target.primary_key.value))
      || left.descriptor.id.localeCompare(right.descriptor.id));
  const unsigned = {
    schema_version: protocolVersions.freshnessAuthority,
    required: true as const,
    target: { mode: targetMode, member_count: input.targetMemberCount },
    dependencies: captured.map((item) => item.descriptor),
  };
  const authority = parseFreshnessAuthority({
    ...unsigned,
    dependency_set_digest: canonicalJsonDigest(unsigned),
  });
  return {
    authority,
    evidence: captured.map((item) => item.evidence),
  };
}

export async function evaluateProposalFreshness(input: {
  config: RuntimeConfig;
  proposal: StoredProposal;
  env?: NodeJS.ProcessEnv;
  readRow?: DbRowReader;
  credentialResolver?: TenantCredentialResolver;
  clock?: () => number;
  proofValidityMs?: number;
}): Promise<ProposalFreshnessEvaluation> {
  const config = resolveRuntimeConfig(input.config);
  assertValidRunnerCapabilityConfig(config);
  const authority = freshnessAuthorityFromChangeSet(input.proposal.change_set);
  if (!authority) {
    return {
      required: false,
      status: "not_required",
      safe_code: "FRESHNESS_NOT_REQUIRED",
      target_count: 0,
      supporting_count: 0,
    };
  }
  const env = input.env ?? process.env;
  const resources = createMcpRuntimeSharedResources(config, env, input.readRow, input.clock, input.credentialResolver);
  const checkedAtMs = (input.clock ?? Date.now)();
  const checks: FreshnessProofCheck[] = [];
  let forcedResult: FreshnessProofV1["result"] | undefined;
  let forcedCode: string | undefined;
  try {
    const capability = (config.capabilities ?? []).find((item) => item.name === input.proposal.action);
    const source = capability ? config.sources?.[capability.source] : undefined;
    if (!capability || capability.kind !== "proposal" || !source) {
      forcedResult = "invalid";
      forcedCode = "FRESHNESS_PROPOSAL_AUTHORITY_INVALID";
    } else if (!proposalAuthorityMatchesCapability(input.proposal, capability)) {
      forcedResult = "invalid";
      forcedCode = "FRESHNESS_PROPOSAL_AUTHORITY_MISMATCH";
    } else {
      const context = proposalTrustedContext(config, capability, input.proposal);
      const targetChecks = await evaluateTargetFreshness({
        proposal: input.proposal,
        authority,
        capability,
        source,
        context,
        env,
        readRow: resources.readRow,
      });
      checks.push(...targetChecks);
      for (const dependency of authority.dependencies) {
        const validationCode = validateResolvedFreshnessDependency(config, capability, dependency);
        if (validationCode) {
          checks.push({
            id: dependency.id,
            kind: "supporting",
            status: "invalid",
            safe_code: validationCode,
          });
          continue;
        }
        const supporting = (config.capabilities ?? []).find((item) => item.name === dependency.capability)!;
        checks.push(await evaluateSupportingFreshness({
          dependency,
          capability: supporting,
          source,
          context,
          env,
          readRow: resources.readRow,
        }));
      }
    }
  } catch (error) {
    const classified = classifyFreshnessReadError(error);
    forcedResult = classified.result;
    forcedCode = classified.safe_code;
  } finally {
    await resources.close();
  }
  const status = forcedResult ?? freshnessResultForChecks(checks);
  const safeCode = forcedCode ?? freshnessSafeCode(status, checks);
  const targetCount = checks.filter((check) => check.kind === "target").length;
  const supportingCount = checks.filter((check) => check.kind === "supporting").length;
  const adapters = freshnessSourceAdapters(input.proposal, authority);
  const unsigned = {
    schema_version: protocolVersions.freshnessProof,
    proposal_id: input.proposal.proposal_id,
    proposal_hash: input.proposal.proposal_hash as `sha256:${string}`,
    proposal_version: input.proposal.proposal_version,
    dependency_set_digest: authority.dependency_set_digest,
    checked_at: new Date(checkedAtMs).toISOString(),
    valid_until: new Date(checkedAtMs + Math.max(1_000, Math.min(input.proofValidityMs ?? 30_000, 300_000))).toISOString(),
    source_adapters: adapters,
    result: status,
    safe_code: safeCode,
    target_count: targetCount,
    supporting_count: supportingCount,
    checks,
  };
  const proof = parseFreshnessProof({
    ...unsigned,
    proof_digest: canonicalJsonDigest(unsigned),
  });
  return {
    required: true,
    status,
    safe_code: safeCode,
    target_count: targetCount,
    supporting_count: supportingCount,
    proof,
  };
}

export function freshnessAuthorityFromChangeSet(changeSet: ChangeSet): FreshnessAuthorityV1 | undefined {
  if (!("freshness" in changeSet) || changeSet.freshness === undefined) return undefined;
  return parseFreshnessAuthority(changeSet.freshness);
}

export function proposalAuthorityMatchesCapability(proposal: StoredProposal, capability: RuntimeCapabilityConfig): boolean {
  const changeSet = proposal.change_set;
  if (proposal.proposal_hash !== changeSet.integrity.proposal_hash || proposal.proposal_version !== changeSet.proposal_version) return false;
  if (changeSet.source.source_id !== capability.source
    || changeSet.source.schema !== capability.target.schema
    || changeSet.source.table !== capability.target.table
    || changeSet.source.primary_key.column !== capability.target.primary_key) return false;
  if (changeSet.contract && (
    !capability.contract_provenance
    || changeSet.contract.digest !== capability.contract_provenance.digest
    || changeSet.contract.version !== capability.contract_provenance.version
  )) return false;
  return true;
}

export function proposalTrustedContext(
  config: RuntimeConfig,
  capability: RuntimeCapabilityConfig,
  proposal: StoredProposal,
): TrustedContext {
  const contextConfig = (capability.context ? config.contexts?.[capability.context] : undefined) ?? config.trusted_context;
  const provider = contextConfig?.provider ?? (proposal.change_set.principal.source === "cloud_session" ? "cloud_session" : "environment");
  return {
    tenant_id: proposal.tenant_id,
    principal: proposal.principal ?? proposal.change_set.principal.id,
    provenance: provider,
  };
}

export async function evaluateTargetFreshness(input: {
  proposal: StoredProposal;
  authority: FreshnessAuthorityV1;
  capability: RuntimeCapabilityConfig;
  source: RuntimeSourceConfig;
  context: TrustedContext;
  env: NodeJS.ProcessEnv;
  readRow: DbRowReader;
}): Promise<FreshnessProofCheck[]> {
  if (input.authority.target.mode === "not_applicable") return [];
  if (input.authority.target.mode === "frozen_set") {
    const changeSet = input.proposal.change_set;
    if (changeSet.schema_version !== protocolVersions.changeSetV3) {
      return [{ id: "target", kind: "target", status: "invalid", safe_code: "FRESHNESS_TARGET_SET_INVALID" }];
    }
    const current = await input.readRow({
      sourceName: input.capability.source,
      source: input.source,
      capability: input.capability,
      args: {},
      context: input.context,
      env: input.env,
      transaction_mode: "read_only",
    });
    const rows = current.rows ?? (current.rowCount === 1 ? [current.row] : []);
    const byIdentity = new Map(rows.map((row) => [JSON.stringify(scalar(row[input.capability.target.primary_key])), row]));
    return changeSet.frozen_set.members.map((member) => {
      const expected = member.expected_version;
      const row = byIdentity.get(JSON.stringify(member.primary_key.value));
      const observed = expected && row ? conflictGuardScalar(scalar(row[expected.column])) : undefined;
      const fresh = Boolean(expected && row && versionsEqual(observed, expected.value));
      return {
        id: `target:${canonicalJsonDigest(member.primary_key).slice(7, 23)}`,
        kind: "target" as const,
        status: fresh ? "fresh" as const : "stale" as const,
        safe_code: fresh ? "FRESHNESS_TARGET_FRESH" : "FRESHNESS_TARGET_STALE",
        ...(expected ? { expected_version_digest: versionMetadataDigest(expected.column, expected.value) } : {}),
        ...(expected && observed !== undefined ? { observed_version_digest: versionMetadataDigest(expected.column, observed) } : {}),
      };
    });
  }
  const changeSet = input.proposal.change_set;
  if (changeSet.schema_version === protocolVersions.changeSetV3 || changeSet.schema_version === protocolVersions.compensationChangeSet) {
    return [{ id: "target", kind: "target", status: "invalid", safe_code: "FRESHNESS_TARGET_AUTHORITY_INVALID" }];
  }
  const expected = changeSet.guards.expected_version;
  if (!expected || expected.column === "__row_hash" || changeSet.source.primary_key.value === undefined) {
    return [{ id: "target", kind: "target", status: "invalid", safe_code: "FRESHNESS_EXACT_TARGET_GUARD_REQUIRED" }];
  }
  const readCapability: RuntimeCapabilityConfig = {
    ...input.capability,
    conflict_guard: { column: expected.column },
  };
  const current = await input.readRow({
    sourceName: input.capability.source,
    source: input.source,
    capability: readCapability,
    args: { [input.capability.lookup.id_from_arg]: changeSet.source.primary_key.value },
    context: input.context,
    env: input.env,
    transaction_mode: "read_only",
  });
  const observed = current.rowCount === 1 ? conflictGuardScalar(scalar(current.row[expected.column])) : undefined;
  const fresh = current.rowCount === 1 && observed !== undefined && versionsEqual(observed, expected.value);
  return [{
    id: "target",
    kind: "target",
    status: fresh ? "fresh" : "stale",
    safe_code: fresh ? "FRESHNESS_TARGET_FRESH" : "FRESHNESS_TARGET_STALE",
    expected_version_digest: versionMetadataDigest(expected.column, expected.value),
    ...(observed !== undefined ? { observed_version_digest: versionMetadataDigest(expected.column, observed) } : {}),
  }];
}

export function validateResolvedFreshnessDependency(
  config: RuntimeConfig,
  proposalCapability: RuntimeCapabilityConfig,
  dependency: FreshnessDependencyV1,
): string | undefined {
  const policy = config.proposal_freshness?.[proposalCapability.name];
  const declared = policy?.dependencies?.find((item) => item.id === dependency.id);
  const capability = (config.capabilities ?? []).find((item) => item.name === dependency.capability);
  const source = config.sources?.[dependency.source_id];
  if (!declared || declared.capability !== dependency.capability || declared.version_column !== dependency.expected_version.column) return "FRESHNESS_DEPENDENCY_AUTHORITY_MISMATCH";
  if (!capability || capability.kind !== "read" || !source) return "FRESHNESS_DEPENDENCY_AUTHORITY_INVALID";
  if (capability.source !== proposalCapability.source || dependency.source_id !== capability.source || dependency.engine !== source.engine) return "FRESHNESS_CROSS_SOURCE_UNSUPPORTED";
  if (capability.target.schema !== dependency.target.schema
    || capability.target.table !== dependency.target.table
    || capability.target.primary_key !== dependency.target.primary_key.column
    || (capability.target.tenant_key ?? "__single_tenant_dev") !== dependency.target.tenant_column
    || capability.target.principal_scope_key !== dependency.target.principal_column) return "FRESHNESS_DEPENDENCY_TARGET_MISMATCH";
  return undefined;
}

export async function evaluateSupportingFreshness(input: {
  dependency: FreshnessDependencyV1;
  capability: RuntimeCapabilityConfig;
  source: RuntimeSourceConfig;
  context: TrustedContext;
  env: NodeJS.ProcessEnv;
  readRow: DbRowReader;
}): Promise<FreshnessProofCheck> {
  const readCapability: RuntimeCapabilityConfig = {
    ...input.capability,
    conflict_guard: { column: input.dependency.expected_version.column },
  };
  try {
    const current = await input.readRow({
      sourceName: input.dependency.source_id,
      source: input.source,
      capability: readCapability,
      args: { [input.capability.lookup.id_from_arg]: input.dependency.target.primary_key.value },
      context: input.context,
      env: input.env,
      transaction_mode: "read_only",
    });
    const observed = current.rowCount === 1
      ? conflictGuardScalar(scalar(current.row[input.dependency.expected_version.column]))
      : undefined;
    const fresh = current.rowCount === 1 && observed !== undefined && versionsEqual(observed, input.dependency.expected_version.value);
    return {
      id: input.dependency.id,
      kind: "supporting",
      status: fresh ? "fresh" : "stale",
      safe_code: fresh ? "FRESHNESS_DEPENDENCY_FRESH" : "FRESHNESS_DEPENDENCY_STALE",
      expected_version_digest: versionMetadataDigest(input.dependency.expected_version.column, input.dependency.expected_version.value),
      ...(observed !== undefined ? { observed_version_digest: versionMetadataDigest(input.dependency.expected_version.column, observed) } : {}),
    };
  } catch (error) {
    const classified = classifyFreshnessReadError(error);
    return {
      id: input.dependency.id,
      kind: "supporting",
      status: classified.result,
      safe_code: classified.safe_code,
    };
  }
}

export function freshnessResultForChecks(checks: FreshnessProofCheck[]): FreshnessProofV1["result"] {
  if (checks.some((check) => check.status === "invalid")) return "invalid";
  if (checks.some((check) => check.status === "unsupported")) return "unsupported";
  if (checks.some((check) => check.status === "unavailable")) return "unavailable";
  if (checks.some((check) => check.status === "stale")) return "stale";
  return "fresh";
}

export function freshnessSafeCode(status: FreshnessProofV1["result"], checks: FreshnessProofCheck[]): string {
  if (status === "fresh") return "FRESHNESS_FRESH";
  if (status === "stale" && checks.some((check) => check.kind === "target" && check.status === "stale")) return "FRESHNESS_TARGET_STALE";
  if (status === "stale") return "FRESHNESS_DEPENDENCY_STALE";
  if (status === "unavailable") return "FRESHNESS_TEMPORARILY_UNAVAILABLE";
  if (status === "unsupported") return "FRESHNESS_TOPOLOGY_UNSUPPORTED";
  return "FRESHNESS_AUTHORITY_INVALID";
}

export function classifyFreshnessReadError(error: unknown): {
  result: "unavailable" | "invalid" | "unsupported";
  safe_code: string;
} {
  const code = error instanceof McpRuntimeError ? error.code : errorStringProperty(error, "code") ?? "";
  if (/(TIMEOUT|POOL|CONNECTION|ECONN|ETIMEDOUT|TOO_MANY|UNAVAILABLE|SATURAT)/i.test(`${code} ${errorMessage(error)}`)) {
    return { result: "unavailable", safe_code: "FRESHNESS_TEMPORARILY_UNAVAILABLE" };
  }
  if (/(UNSUPPORTED|CROSS_SOURCE)/i.test(code)) {
    return { result: "unsupported", safe_code: "FRESHNESS_TOPOLOGY_UNSUPPORTED" };
  }
  return { result: "invalid", safe_code: "FRESHNESS_CHECK_FAILED" };
}

export function freshnessSourceAdapters(
  proposal: StoredProposal,
  authority: FreshnessAuthorityV1,
): FreshnessProofV1["source_adapters"] {
  const entries = new Map<string, FreshnessProofV1["source_adapters"][number]>();
  const targetEngine = proposal.source_kind === "external_mysql" ? "mysql" : "postgres";
  entries.set(`${proposal.source_id}:${targetEngine}`, { source_id: proposal.source_id, engine: targetEngine });
  for (const dependency of authority.dependencies) {
    entries.set(`${dependency.source_id}:${dependency.engine}`, { source_id: dependency.source_id, engine: dependency.engine });
  }
  return [...entries.values()].sort((left, right) => left.source_id.localeCompare(right.source_id) || left.engine.localeCompare(right.engine));
}

export function versionsEqual(left: unknown, right: unknown): boolean {
  return canonicalJsonDigest({ value: conflictGuardScalar(scalar(left)) })
    === canonicalJsonDigest({ value: conflictGuardScalar(scalar(right)) });
}

export function versionMetadataDigest(column: string, value: unknown): `sha256:${string}` {
  return canonicalJsonDigest({ column, value: conflictGuardScalar(scalar(value)) });
}
