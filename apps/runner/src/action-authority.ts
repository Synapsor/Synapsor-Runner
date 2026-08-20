import type { CapabilitySpec } from "@synapsor/spec";

export type ActionWritebackMode = "none" | "direct_sql" | "app_handler" | "cloud_worker";
export type ActionAuthorityPosture = "proposal_only" | "executable" | "supervised_execution";

export type ActionAuthorityInput = {
  authority_posture?: ActionAuthorityPosture;
  writeback?: {
    mode: ActionWritebackMode;
    executor?: string;
  };
  supervised_worker_execution?: boolean;
};

export type ResolvedActionAuthority = {
  posture: ActionAuthorityPosture;
  writeback: {
    mode: ActionWritebackMode;
    executor?: string;
  };
  supervised_worker_execution: boolean;
  source_database_can_change_after_separate_execution: boolean;
};

export type ActionAuthorityTransition = {
  kind: "unchanged" | "promotion" | "demotion" | "replacement";
  requires_new_revision: boolean;
  old_proposals_gain_execution_authority: false;
};

export function resolveActionAuthority(
  input: ActionAuthorityInput,
  options: { legacyExecutableHint?: boolean } = {},
): ResolvedActionAuthority {
  const supervised = input.supervised_worker_execution === true;
  const requestedPosture = input.authority_posture;
  const requestedWriteback = input.writeback;
  const inferredExecutable = options.legacyExecutableHint === true || supervised;
  const writebackMode = requestedWriteback?.mode
    ?? (requestedPosture === "proposal_only" ? "none" : inferredExecutable ? "direct_sql" : "none");
  const posture = requestedPosture
    ?? (supervised ? "supervised_execution" : writebackMode === "none" ? "proposal_only" : "executable");

  if (posture === "proposal_only" && writebackMode !== "none") {
    throw new Error("ACTION_AUTHORITY_PROPOSAL_ONLY_WRITEBACK_FORBIDDEN: proposal-only authority must use WRITEBACK NONE.");
  }
  if (posture !== "proposal_only" && writebackMode === "none") {
    throw new Error("ACTION_AUTHORITY_EXECUTOR_REQUIRED: executable authority must name a reviewed writeback mode.");
  }
  if (posture === "supervised_execution" && !supervised) {
    throw new Error("ACTION_AUTHORITY_SUPERVISED_PERMISSION_REQUIRED: supervised execution requires an explicit contract permission.");
  }
  if (supervised && posture !== "supervised_execution") {
    throw new Error("ACTION_AUTHORITY_SUPERVISED_POSTURE_REQUIRED: supervised worker permission requires the supervised_execution posture.");
  }
  if (supervised && writebackMode !== "direct_sql") {
    throw new Error("ACTION_AUTHORITY_SUPERVISED_DIRECT_SQL_REQUIRED: supervised execution is limited to Runner-owned direct_sql writeback.");
  }
  if (writebackMode === "app_handler" && !requestedWriteback?.executor?.trim()) {
    throw new Error("ACTION_AUTHORITY_HANDLER_REQUIRED: app_handler writeback requires one reviewed executor name.");
  }
  if (writebackMode !== "app_handler" && requestedWriteback?.executor) {
    throw new Error(`ACTION_AUTHORITY_EXECUTOR_FORBIDDEN: ${writebackMode} writeback must not name an app-handler executor.`);
  }

  return {
    posture,
    writeback: {
      mode: writebackMode,
      ...(requestedWriteback?.executor ? { executor: requestedWriteback.executor.trim() } : {}),
    },
    supervised_worker_execution: supervised,
    source_database_can_change_after_separate_execution: writebackMode !== "none",
  };
}

export function actionAuthorityForCapability(capability: CapabilitySpec): ResolvedActionAuthority | undefined {
  if (capability.kind !== "proposal" || !capability.proposal) return undefined;
  return resolveActionAuthority({
    writeback: {
      mode: capability.proposal.writeback?.mode ?? "direct_sql",
      ...(capability.proposal.writeback?.executor
        ? { executor: capability.proposal.writeback.executor }
        : {}),
    },
    supervised_worker_execution: capability.proposal.execution?.supervised_worker === "allowed",
  });
}

export function classifyActionAuthorityTransition(
  previous: ResolvedActionAuthority,
  next: ResolvedActionAuthority,
): ActionAuthorityTransition {
  if (authorityIdentity(previous) === authorityIdentity(next)) {
    return {
      kind: "unchanged",
      requires_new_revision: false,
      old_proposals_gain_execution_authority: false,
    };
  }
  const order: Record<ActionAuthorityPosture, number> = {
    proposal_only: 0,
    executable: 1,
    supervised_execution: 2,
  };
  const postureDirection = order[next.posture] - order[previous.posture];
  const sameExecutor = previous.writeback.mode === next.writeback.mode
    && previous.writeback.executor === next.writeback.executor;
  return {
    kind: postureDirection > 0
      ? "promotion"
      : postureDirection < 0
        ? "demotion"
        : sameExecutor
          ? "replacement"
          : "replacement",
    requires_new_revision: true,
    old_proposals_gain_execution_authority: false,
  };
}

function authorityIdentity(authority: ResolvedActionAuthority): string {
  return JSON.stringify({
    posture: authority.posture,
    writeback: authority.writeback,
    supervised_worker_execution: authority.supervised_worker_execution,
  });
}
