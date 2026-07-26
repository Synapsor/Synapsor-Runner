import type {
  ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import type {
  RuntimeCapabilityConfig,
  RuntimeConfig,
  TrustedContext,
} from "./runtime-types.js";
import {
  isSetSelectionCapability,
  localCapabilities,
  readColumns,
} from "./capability-authority.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  resolveTrustedContext,
} from "./trusted-context.js";

export async function readLocalResource(
  store: ProposalRuntimeStore,
  uri: string,
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  trustedContext?: TrustedContext,
): Promise<Record<string, unknown>> {
  const parsed = new URL(uri);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const collection = parsed.hostname;
  const id = parts[0];
  if (!id) throw new McpRuntimeError("RESOURCE_ID_MISSING", `Resource id missing in ${uri}.`);
  if (collection === "proposals") {
    const proposal = await store.getProposal(id);
    if (!proposal) throw localResourceNotFound();
    assertLocalResourceAccess(config, env, trustedContext, {
      tenant_id: proposal.tenant_id,
      principal: proposal.principal ?? proposal.change_set.principal.id,
      capability: proposal.capability ?? proposal.action,
    });
    return { proposal, events: await store.events(id), receipts: await store.receipts(id) };
  }
  if (collection === "evidence") {
    const evidence = await store.getEvidenceBundle(id);
    if (!evidence) throw localResourceNotFound();
    assertLocalResourceAccess(config, env, trustedContext, {
      tenant_id: evidence.tenant_id,
      principal: evidence.principal,
      capability: evidence.capability,
    });
    return evidence;
  }
  if (collection === "replay") {
    const proposalId = id.startsWith("replay_") ? id.slice("replay_".length) : id;
    const proposal = await store.getProposal(proposalId);
    if (!proposal) throw localResourceNotFound();
    assertLocalResourceAccess(config, env, trustedContext, {
      tenant_id: proposal.tenant_id,
      principal: proposal.principal ?? proposal.change_set.principal.id,
      capability: proposal.capability ?? proposal.action,
    });
    return await store.replay(proposalId);
  }
  throw localResourceNotFound();
}

export function assertLocalResourceAccess(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  trustedContext: TrustedContext | undefined,
  owner: { tenant_id: string; principal?: string; capability?: string },
): void {
  if (!owner.tenant_id || !owner.principal || !owner.capability) throw localResourceNotFound();
  const capability = localCapabilities(config).find((item) => item.name === owner.capability);
  if (!capability) throw localResourceNotFound();
  const context = resolveTrustedContext(config, env, capability, trustedContext);
  if (context.tenant_id !== owner.tenant_id || context.principal !== owner.principal) {
    throw localResourceNotFound();
  }
}

export function localResourceNotFound(): McpRuntimeError {
  return new McpRuntimeError("RESOURCE_NOT_FOUND", "Synapsor resource not found.");
}

export async function resourceResult(uri: string, reader: (uri: string) => Promise<Record<string, unknown>>) {
  const payload = await reader(uri);
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function selectTemplate(capability: RuntimeCapabilityConfig): string {
  if (capability.kind === "aggregate_read") {
    const aggregate = capability.aggregate;
    const expression = aggregate?.function === "count" && aggregate.count_mode === "rows" ? "COUNT(*)" : `${aggregate?.function?.toUpperCase() ?? "AGGREGATE"}(${aggregate?.column ?? "<fixed column>"})`;
    const terms = (aggregate?.selection?.all ?? []).map((term) => `${term.column} = <fixed>`);
    if (capability.target.tenant_key) terms.push(`${capability.target.tenant_key} = <trusted tenant>`);
    if (capability.target.principal_scope_key) terms.push(`${capability.target.principal_scope_key} = <trusted principal>`);
    return `SELECT ${expression}, COUNT(*) AS group_size FROM ${capability.target.schema}.${capability.target.table}${terms.length ? ` WHERE ${terms.join(" AND ")}` : ""}`;
  }
  if (isSetSelectionCapability(capability)) {
    const terms = (capability.operation?.selection?.all ?? []).map((term) => `${term.column} = <fixed>`);
    if (capability.target.tenant_key) terms.push(`${capability.target.tenant_key} = <trusted tenant>`);
    if (capability.target.principal_scope_key) terms.push(`${capability.target.principal_scope_key} = <trusted principal>`);
    return `SELECT ${readColumns(capability).join(", ")} FROM ${capability.target.schema}.${capability.target.table} WHERE ${terms.join(" AND ")} ORDER BY ${capability.target.primary_key} ASC LIMIT ${(capability.operation?.max_rows ?? 0) + 1}`;
  }
  const terms = [`${capability.target.primary_key} = ?`];
  if (capability.target.tenant_key) terms.push(`${capability.target.tenant_key} = ?`);
  if (capability.target.principal_scope_key) terms.push(`${capability.target.principal_scope_key} = ?`);
  const where = terms.join(" AND ");
  return `SELECT ${readColumns(capability).join(", ")} FROM ${capability.target.schema}.${capability.target.table} WHERE ${where} LIMIT ${capability.max_rows ?? 1}`;
}
