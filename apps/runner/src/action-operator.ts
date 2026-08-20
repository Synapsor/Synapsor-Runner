import path from "node:path";
import type {
  ApprovalProgress,
  LocalProposalState,
  ProposalEvent,
  ProposalReplayRecord,
  ProposalSearchFilters,
  StoredProposal,
  StoredWritebackReceipt,
} from "@synapsor-runner/proposal-store";
import { applyProposal } from "./guarded-apply.js";
import {
  openLocalStore,
  optionalRuntimeConfig,
  resolveProposalIdFromStore,
} from "./cli-project.js";
import type { TrustedOperatorDecisionOverride } from "./operator-authority.js";
import { proposalsApprove, proposalsReject } from "./proposal-ledger.js";
import {
  argsWithRuntimeStoreBridge,
  maybeSharedPostgresRuntimeStoreRead,
  runtimeStoreBridgeRequired,
  withSharedPostgresRuntimeStoreBridge,
} from "./store-shared.js";

export type ActionProposalSummary = {
  proposal_id: string;
  proposal_hash: string;
  capability: string;
  state: LocalProposalState;
  business_object: string;
  object_id: string;
  writeback_mode: string;
  source_database_mutated: boolean;
  created_at: string;
  updated_at: string;
};

export type ActionProposalDetail = {
  proposal: StoredProposal;
  approval_progress: ApprovalProgress;
  freshness_status: string;
  events: ProposalEvent[];
  receipts: StoredWritebackReceipt[];
  evidence_item_count: number;
};

export type ActionOperatorIdentityPosture = {
  provider: "dev_env" | "signed_key" | "jwt_oidc";
  apply_roles: string[];
};

export type ActionOperatorDecision = TrustedOperatorDecisionOverride & {
  reason: string;
  expected_proposal_hash: string;
};

export type ActionOperatorService = {
  identityPosture(): Promise<ActionOperatorIdentityPosture>;
  list(filters?: ProposalSearchFilters): Promise<ActionProposalSummary[]>;
  detail(proposalId: string): Promise<ActionProposalDetail>;
  approve(proposalId: string, decision: ActionOperatorDecision): Promise<ActionProposalDetail>;
  reject(proposalId: string, decision: ActionOperatorDecision): Promise<ActionProposalDetail>;
  apply(proposalId: string, decision: ActionOperatorDecision): Promise<{ code: number; detail: ActionProposalDetail }>;
  replay(proposalId: string, expectedProposalHash: string): Promise<ProposalReplayRecord>;
};

export function createActionOperatorService(input: {
  configPath: string;
  storePath: string;
}): ActionOperatorService {
  const configPath = path.resolve(input.configPath);
  const storePath = input.storePath === ":memory:" ? input.storePath : path.resolve(input.storePath);
  const baseArgs = ["--config", configPath, "--store", storePath];

  const detail = (proposalId: string) => readActionProposalDetail(baseArgs, proposalId);
  return {
    async identityPosture() {
      const config = await optionalRuntimeConfig(configPath);
      return {
        provider: config?.operator_identity?.provider ?? "dev_env",
        apply_roles: [...(config?.operator_identity?.apply_roles ?? [])],
      };
    },
    async list(filters = {}) {
      return readActionProposalSummaries(baseArgs, filters);
    },
    detail,
    async approve(proposalId, decision) {
      const code = await proposalsApprove([proposalId, ...baseArgs, "--yes"], {
        quiet: true,
        decision,
        expectedProposalHash: decision.expected_proposal_hash,
      });
      if (code !== 0) {
        throw new Error(`ACTION_PROPOSAL_APPROVAL_REFUSED: freshness or approval authority returned status ${code}.`);
      }
      return detail(proposalId);
    },
    async reject(proposalId, decision) {
      const code = await proposalsReject([proposalId, ...baseArgs, "--yes"], {
        quiet: true,
        decision,
        expectedProposalHash: decision.expected_proposal_hash,
      });
      if (code !== 0) throw new Error(`ACTION_PROPOSAL_REJECTION_REFUSED: operator decision returned status ${code}.`);
      return detail(proposalId);
    },
    async apply(proposalId, decision) {
      const code = await applyProposal(baseArgs, proposalId, {
        quiet: true,
        decision,
        expectedProposalHash: decision.expected_proposal_hash,
      });
      return { code, detail: await detail(proposalId) };
    },
    async replay(proposalId, expectedProposalHash) {
      return createActionProposalReplay(baseArgs, proposalId, expectedProposalHash);
    },
  };
}

async function createActionProposalReplay(
  args: string[],
  proposalId: string,
  expectedProposalHash: string,
): Promise<ProposalReplayRecord> {
  const configPath = path.resolve(args[args.indexOf("--config") + 1]!);
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      `action proposal replay ${proposalId}`,
      (bridgeStorePath) => createActionProposalReplay(
        argsWithRuntimeStoreBridge(args, bridgeStorePath),
        proposalId,
        expectedProposalHash,
      ),
    );
  }
  const store = await openLocalStore(args);
  try {
    const resolved = resolveProposalIdFromStore(proposalId, store);
    const proposal = store.getProposal(resolved);
    if (!proposal) throw new Error(`proposal not found: ${resolved}`);
    if (proposal.proposal_hash !== expectedProposalHash) {
      throw new Error("PROPOSAL_CHANGED: reload the proposal before creating its replay record.");
    }
    return store.replay(resolved);
  } finally {
    store.close();
  }
}

async function readActionProposalSummaries(
  args: string[],
  filters: ProposalSearchFilters,
): Promise<ActionProposalSummary[]> {
  return withActionProposalStoreRead(args, "action proposal inbox", (store) =>
    store.listProposals({ ...filters, limit: filters.limit ?? 200 }).map((proposal) => ({
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      capability: proposal.capability ?? proposal.action,
      state: proposal.state,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
      writeback_mode: proposal.change_set.writeback.mode,
      source_database_mutated: proposal.source_database_mutated,
      created_at: proposal.created_at,
      updated_at: proposal.updated_at,
    })),
  );
}

async function readActionProposalDetail(args: string[], proposalId: string): Promise<ActionProposalDetail> {
  return withActionProposalStoreRead(args, "action proposal detail", (store) => {
    const resolved = resolveProposalIdFromStore(proposalId, store);
    const proposal = store.getProposal(resolved);
    if (!proposal) throw new Error(`proposal not found: ${resolved}`);
    const freshness = store.latestFreshnessProof(resolved);
    const evidence = store.getEvidenceBundle(proposal.change_set.evidence.bundle_id);
    return {
      proposal,
      approval_progress: store.approvalProgress(resolved),
      freshness_status: freshness?.result
        ?? ("freshness" in proposal.change_set && proposal.change_set.freshness ? "not_checked" : "not_required"),
      events: store.events(resolved),
      receipts: store.receipts(resolved),
      evidence_item_count: evidence?.items.length ?? 0,
    };
  });
}

async function withActionProposalStoreRead<T>(
  args: string[],
  command: string,
  callback: (store: Awaited<ReturnType<typeof openLocalStore>>) => T,
): Promise<T> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(
    args,
    command,
    (bridgeStorePath) => withActionProposalStoreRead(
      argsWithRuntimeStoreBridge(args, bridgeStorePath),
      command,
      callback,
    ),
  );
  if (bridged !== undefined) return bridged;
  const store = await openLocalStore(args);
  try {
    return callback(store);
  } finally {
    store.close();
  }
}
