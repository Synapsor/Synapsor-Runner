import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  attentionDecisionSubject,
  ProposalStore,
  workerControlDecisionSubject,
  type AttentionItem,
  type StoredProposal,
  type WorkerControlAction,
  type WorkerControlTarget
} from "@synapsor-runner/proposal-store";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { envValue, optionalArg } from "./cli-options.js";
import { operatorIdentityForDecision, optionalRuntimeConfig, requireLocalProposal, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { applyProposal } from "./guarded-apply.js";
import { loadActivatedExplorationBoundary } from "./auto-boundary.js";
import {
  startLocalUiServer,
  type LocalUiStoreAccess,
  type WorkbenchAttentionDecision,
  type WorkbenchDeploymentProfile,
  type WorkbenchLedgerScope,
  type WorkbenchLedgerSource,
  type WorkbenchProposalDecision,
  type WorkbenchReconciliationInspect,
  type WorkbenchReconciliationResolve,
  type WorkbenchWorkerDecision
} from "./local-ui.js";
import { resolveOperatorIdentity, type OperatorIdentityConfig } from "./operator-identity.js";
import { proposalsApprove } from "./proposal-ledger.js";
import { withSharedPostgresRuntimeStoreBridge, withSharedPostgresRuntimeStoreReadBridge } from "./store-shared.js";
import { sharedPostgresLedgerMirrorOptions } from "./shared-ledger-domain.js";
import { workerControlOperatorDecisionAction } from "./worker-policy.js";
import { inspectWritebackSourceContext, reconciliationReceipt, reconciliationSupportedOutcome, workbenchReconciliationView } from "./writeback-setup.js";


export async function ui(args: string[]): Promise<number> {
  const portArg = optionalArg(args, "--port");
  const boundaryRoot = optionalArg(args, "--boundary-root");
  const boundaryProjectRoot = boundaryRoot ? path.resolve(boundaryRoot, "../..") : undefined;
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  const projectRoot = boundaryProjectRoot ?? path.dirname(path.resolve(configPath));
  const deploymentProfile = workbenchDeploymentProfileArg(args);
  const ledgerScope = workbenchLedgerScopeFromConfig(config);
  const configuredStorePath = resolvedLocalStorePath(args, config?.storage?.sqlite_path);
  const sharedLedger = config?.storage?.shared_postgres?.mode === "runtime_store"
    ? sharedPostgresLedgerMirrorOptions(args, config)
    : undefined;
  const ledgerSource: WorkbenchLedgerSource = sharedLedger
    ? { kind: "shared_postgres", schema: sharedLedger.schema, url_env: sharedLedger.urlEnv, read_only: true }
    : {
      kind: "local_sqlite",
      path: configuredStorePath === ":memory:" ? configuredStorePath : path.resolve(configuredStorePath),
    };
  const storeAccess: LocalUiStoreAccess | undefined = config?.storage?.shared_postgres?.mode === "runtime_store"
    ? async (mode, operation, callback) => (mode === "read" ? withSharedPostgresRuntimeStoreReadBridge : withSharedPostgresRuntimeStoreBridge)(args, config, `ui ${operation}`, async (bridgeStorePath) => {
      const store = new ProposalStore(bridgeStorePath);
      try {
        return callback(store);
      } finally {
        store.close();
      }
    })
    : undefined;
  const workbenchStore = async <T>(
    mode: "read" | "write",
    operation: string,
    callback: (store: ProposalStore) => T,
  ): Promise<T> => {
    if (storeAccess) return await storeAccess(mode, operation, callback);
    const store = new ProposalStore(configuredStorePath);
    try {
      return callback(store);
    } finally {
      store.close();
    }
  };
  const trustedDecisionSupported = config?.operator_identity?.provider !== "signed_key";
  const authorityArgs = ["--yes", "--config", configPath, "--store", configuredStorePath];
  const proposalApprove: WorkbenchProposalDecision | undefined = trustedDecisionSupported
    ? (input) => proposalsApprove([input.proposalId, ...authorityArgs], {
      quiet: true,
      freshnessProofDigest: input.freshnessProofDigest,
      decision: {
        actor: input.actor,
        reason: input.reason,
        identityToken: input.identityToken,
      },
    }).then((code) => ({ code }))
    : undefined;
  const proposalApply: WorkbenchProposalDecision | undefined = trustedDecisionSupported
    ? (input) => applyProposal(authorityArgs, input.proposalId, {
      quiet: true,
      decision: {
        actor: input.actor,
        reason: input.reason,
        identityToken: input.identityToken,
      },
    }).then((code) => ({ code }))
    : undefined;
  const attentionAcknowledge: WorkbenchAttentionDecision | undefined = config?.operator_identity?.provider === "jwt_oidc"
    ? async (input) => {
      const item = await workbenchStore("read", "attention-acknowledge-authority-read", (store) => {
        const selected = store.getAttentionItem(input.attentionId);
        if (!selected) throw new Error(`attention item not found: ${input.attentionId}`);
        assertWorkbenchAttentionScope(store, selected, ledgerScope);
        return selected;
      });
      const identity = await resolveOperatorIdentity({
        config: config.operator_identity as OperatorIdentityConfig,
        configPath,
        proposal: attentionDecisionSubject(item),
        action: "attention_acknowledge",
        actor: input.actor,
        token: input.identityToken,
      });
      await workbenchStore("write", "attention-acknowledge-authority-write", (store) => {
        store.acknowledgeAttention({
          attention_id: item.attention_id,
          actor: identity.subject,
          identity,
          require_verified_identity: true,
        });
      });
      return { code: 0 };
    }
    : undefined;
  const workerDecision: WorkbenchWorkerDecision | undefined = config && trustedDecisionSupported
    ? async (input) => {
      if ([
        "pause",
        "resume",
        "drain",
        "capability_enable",
        "capability_disable",
        "digest_revoke",
      ].includes(input.action)) {
        const action = input.action as WorkerControlAction;
        const target: WorkerControlTarget = {
          action,
          ...(input.capability ? { capability: input.capability } : {}),
          ...(input.contractDigest ? { contract_digest: input.contractDigest } : {}),
        };
        const current = await workbenchStore(
          "read",
          "worker-control-authority-read",
          (store) => store.workerControlState(),
        );
        const policies = config.supervised_worker?.capabilities.filter((policy) =>
          !input.capability
          || (policy.capability === input.capability && policy.contract_digest === input.contractDigest)) ?? [];
        if (input.capability && policies.length !== 1) {
          throw new Error("worker capability control must target one configured exact capability/digest entry");
        }
        const identity = await resolveOperatorIdentity({
          config: config.operator_identity as OperatorIdentityConfig | undefined,
          configPath,
          proposal: workerControlDecisionSubject(current, target),
          action: workerControlOperatorDecisionAction(action),
          reason: input.reason,
          actor: input.actor,
          token: input.identityToken,
        });
        const requiredRoles = [...new Set(policies.flatMap((policy) =>
          policy.control_role ? [policy.control_role] : []))];
        for (const role of requiredRoles) {
          if (!identity.roles.includes(role)) {
            throw new Error(`operator ${identity.subject} lacks required supervised-worker control role ${role}`);
          }
        }
        await workbenchStore("write", "worker-control-authority-write", (store) => {
          store.updateWorkerControl({
            ...target,
            actor: identity.subject,
            identity,
            require_verified_identity: config.supervised_worker?.profile === "production",
            environment: config.supervised_worker?.profile ?? "unknown",
          });
        });
        return { code: 0 };
      }

      if (!input.proposalId) throw new Error("worker queue decision requires an exact proposal id");
      const proposal = await workbenchStore("read", "worker-queue-authority-read", (store) => {
        const selected = requireLocalProposal(store, input.proposalId!);
        assertWorkbenchProposalScope(selected, ledgerScope);
        const queue = store.getWorkerQueueItem(selected.proposal_id);
        if (!queue) throw new Error(`worker queue item not found for ${selected.proposal_id}`);
        return selected;
      });
      if (input.action === "cancel") {
        const queue = await workbenchStore(
          "read",
          "worker-cancel-policy-read",
          (store) => store.getWorkerQueueItem(proposal.proposal_id),
        );
        const policy = config.supervised_worker?.capabilities.find((candidate) =>
          candidate.capability === proposal.action
          && candidate.contract_digest === queue?.contract_digest);
        const identity = await resolveOperatorIdentity({
          config: config.operator_identity as OperatorIdentityConfig | undefined,
          configPath,
          proposal,
          action: "worker_cancel",
          reason: input.reason,
          actor: input.actor,
          token: input.identityToken,
          requiredRole: policy?.control_role,
        });
        await workbenchStore("write", "worker-cancel-authority-write", (store) => {
          store.cancelWorkerItem({
            proposalId: proposal.proposal_id,
            actor: identity.subject,
            identity,
            require_verified_identity: config.supervised_worker?.profile === "production",
          });
        });
        return { code: 0 };
      }

      const deadLetterAction = input.action === "dead_letter_requeue"
        ? "worker_requeue"
        : "worker_discard";
      const identity = await operatorIdentityForDecision({
        args: [],
        config,
        configPath,
        proposal,
        action: deadLetterAction,
        reason: input.reason,
        decision: {
          actor: input.actor,
          reason: input.reason,
          identityToken: input.identityToken,
        },
      });
      if (!identity.verified) {
        throw new Error(`${input.action.replaceAll("_", " ")} requires a verified operator identity`);
      }
      await workbenchStore("write", "worker-dead-letter-authority-write", (store) => {
        if (input.action === "dead_letter_requeue") {
          store.requeueDeadLetter({
            proposalId: proposal.proposal_id,
            retryBudget: input.retryBudget ?? 3,
            identity,
            reason: input.reason,
          });
        } else {
          if (!input.reason?.trim()) throw new Error("dead-letter discard requires an operator reason");
          store.discardDeadLetter({
            proposalId: proposal.proposal_id,
            identity,
            reason: input.reason,
          });
        }
      });
      return { code: 0 };
    }
    : undefined;
  const workbenchReconciliationContext = config
    ? async (intentId: string) => {
      const authority = await workbenchStore("read", "worker-reconciliation-authority-read", (store) => {
        const intent = store.getWritebackIntent(intentId);
        if (!intent) throw new Error(`writeback intent not found: ${intentId}`);
        if (intent.status !== "reconciliation_required" && intent.status !== "applying") {
          throw new Error(`writeback intent ${intentId} is ${intent.status}, not reconcilable`);
        }
        const proposal = requireLocalProposal(store, intent.proposal_id);
        assertWorkbenchProposalScope(proposal, ledgerScope);
        return { intent, proposal };
      });
      const observation = await inspectWritebackSourceContext(
        authority.intent,
        authority.proposal,
        configPath,
        config,
      );
      return { ...authority, observation };
    }
    : undefined;
  const workerReconciliationInspect: WorkbenchReconciliationInspect | undefined = workbenchReconciliationContext
    ? async ({ intentId }) => {
      const context = await workbenchReconciliationContext(intentId);
      return workbenchReconciliationView(context.intent, context.observation);
    }
    : undefined;
  const workerReconciliationResolve: WorkbenchReconciliationResolve | undefined =
    workbenchReconciliationContext && config && trustedDecisionSupported
      ? async (input) => {
        const context = await workbenchReconciliationContext(input.intentId);
        const supportedOutcome = reconciliationSupportedOutcome(context.observation);
        if (input.outcome !== supportedOutcome) {
          throw new Error(`live source observation supports ${supportedOutcome}, not ${input.outcome}`);
        }
        const identity = await operatorIdentityForDecision({
          args: [],
          config,
          configPath,
          proposal: context.proposal,
          action: "reconcile",
          reason: input.reason,
          decision: {
            actor: input.actor,
            reason: input.reason,
            identityToken: input.identityToken,
          },
        });
        const receipt = reconciliationReceipt(
          context.intent,
          context.observation,
          input.outcome,
          identity.subject,
          input.reason,
        );
        await workbenchStore("write", "worker-reconciliation-authority-write", (store) => {
          store.reconcileWritebackIntent({
            intent_id: context.intent.intent_id,
            receipt,
            actor: identity.subject,
            reason: input.reason,
            observation: context.observation,
            identity,
            require_verified_identity: Boolean(config.operator_identity && config.operator_identity.provider !== "dev_env"),
          });
        });
        return { code: 0 };
      }
      : undefined;
  const server = await startLocalUiServer({
    configPath,
    storePath: configuredStorePath,
    storeAccess,
    ledgerSource,
    host: optionalArg(args, "--host") ?? "127.0.0.1",
    port: portArg ? Number(portArg) : 0,
    allowRemoteBind: args.includes("--allow-remote-bind"),
    tour: args.includes("--tour"),
    initialView: args.includes("--playground") ? "playground" : undefined,
    boundaryRoot,
    projectRoot,
    ledgerScope,
    deploymentProfile,
    proposalApprove,
    proposalApply,
    attentionAcknowledge,
    workerDecision,
    workerReconciliationInspect,
    workerReconciliationResolve,
    instantOnboarding: args.includes("--instant-onboarding"),
  });
  process.stdout.write(`Synapsor Runner local UI: ${server.url}\n`);
  if (args.includes("--open")) {
    openBrowser(server.url);
    process.stdout.write(args.includes("--playground")
      ? "Opening Workbench directly at the JSON Plan Playground when a desktop opener is available.\n"
      : "Opening the local review UI in your browser when a desktop opener is available.\n");
  }
  const reissueBootstrap = (chunk: Buffer | string) => {
    if (String(chunk).trim().toLowerCase() !== "r") return;
    process.stdout.write([
      "Fresh one-time Workbench URL:",
      server.reissueBootstrapUrl(),
      "The previous URL is invalid. This did not restart onboarding or change authority.",
      "",
    ].join("\n"));
  };
  if (process.stdin.isTTY) process.stdin.on("data", reissueBootstrap);
  const scopedExploreActive = await loadActivatedExplorationBoundary(projectRoot)
    .then(() => true)
    .catch(() => false);
  process.stdout.write([
    args.includes("--playground") && scopedExploreActive
      ? "Next: paste or edit one fixed Explore JSON plan, then Validate only or Run reviewed plan."
      : scopedExploreActive
      ? "Next: ask your reviewed data in Workbench. Access review remains available when you need to change it."
      : "Next: review the proposed boundary, then ask your first question in Workbench.",
    "Approval and guarded apply are separate trusted-operator actions protected by the per-run local session and CSRF token.",
    ...(process.stdin.isTTY
      ? ["If the browser tab is lost, type r then Enter here to issue a fresh one-time URL from this same process."]
      : ["If the browser tab is lost, restart only this UI command to issue a fresh session; the saved onboarding review is preserved."]),
    "Press Ctrl+C to stop.",
    "",
  ].join("\n"));
  await new Promise<void>((resolve) => {
    const stop = async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      process.stdin.off("data", reissueBootstrap);
      await server.close();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}


export function workbenchDeploymentProfileArg(args: string[]): WorkbenchDeploymentProfile | undefined {
  const value = optionalArg(args, "--profile");
  if (value === undefined) return undefined;
  if (value !== "development" && value !== "staging" && value !== "production" && value !== "unknown") {
    throw new Error("ui --profile must be development, staging, production, or unknown");
  }
  return value;
}


function workbenchLedgerScopeFromConfig(config: RuntimeConfig | undefined): WorkbenchLedgerScope | undefined {
  const shared = config?.storage?.shared_postgres?.mode === "runtime_store";
  const context = config?.trusted_context;
  if (!context) return shared ? { required: true } : undefined;
  const values = context.values ?? {};
  const tenantEnv = typeof values.tenant_id_env === "string" ? values.tenant_id_env : "SYNAPSOR_TENANT_ID";
  const principalEnv = typeof values.principal_env === "string" ? values.principal_env : "SYNAPSOR_PRINCIPAL";
  const tenant = context.provider === "environment"
    ? envValue(process.env, tenantEnv)
    : context.provider === "static_dev"
      ? envValue(process.env, tenantEnv) ?? stringRecordValue(values, "tenant_id")
      : undefined;
  const principal = context.provider === "environment"
    ? envValue(process.env, principalEnv)
    : context.provider === "static_dev"
      ? envValue(process.env, principalEnv) ?? stringRecordValue(values, "principal")
      : undefined;
  return {
    ...(tenant ? { tenant } : {}),
    ...(principal ? { principal } : {}),
    required: shared,
  };
}


function assertWorkbenchAttentionScope(
  store: ProposalStore,
  item: AttentionItem,
  scope: WorkbenchLedgerScope | undefined,
): void {
  if (!scope) return;
  if (scope.required && (!scope.tenant || !scope.principal)) {
    throw new Error("verified tenant and principal scope are required for this shared Workbench acknowledgement");
  }
  const event = store.getAttentionEvent(item.latest_event_id);
  const proposal = event?.proposal_id ? store.getProposal(event.proposal_id) : undefined;
  if (
    (scope.tenant && proposal?.tenant_id !== scope.tenant)
    || (scope.principal && proposal?.principal !== scope.principal)
  ) {
    throw new Error("attention item is outside the trusted Workbench tenant or principal scope");
  }
}


function assertWorkbenchProposalScope(
  proposal: StoredProposal,
  scope: WorkbenchLedgerScope | undefined,
): void {
  if (!scope) return;
  if (scope.required && (!scope.tenant || !scope.principal)) {
    throw new Error("verified tenant and principal scope are required for this shared Workbench action");
  }
  if (
    (scope.tenant && proposal.tenant_id !== scope.tenant)
    || (scope.principal && proposal.principal !== scope.principal)
  ) {
    throw new Error("proposal is outside the trusted Workbench tenant or principal scope");
  }
}


function stringRecordValue(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}


export function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
