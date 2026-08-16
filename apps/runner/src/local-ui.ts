import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { buildProposalReviewView, createMcpRuntime, evaluateProposalFreshness, loadRuntimeConfigFromFile, type ProposalFreshnessEvaluation } from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  type AttentionEvent,
  type AttentionItem,
  type AttentionItemStatus,
  type AttentionSeverity,
  type LocalProposalState,
  type ProposalSearchFilters,
  type QueryAuditSearchFilters,
  type RecordAttentionEventInput,
  type StoredProposal,
  type WorkerControlAction,
  type WorkerQueueItem,
} from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest, protocolVersions, type FreshnessProofV1 } from "@synapsor-runner/protocol";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { cursorProjectStatus } from "./cursor-project.js";
import {
  detectManagedMcpClientCommand,
  installManagedMcpProject,
  managedMcpProjectDefinition,
  parseManagedMcpProjectClient,
} from "./managed-mcp-project.js";
import { renderBoundaryWorkbench } from "./boundary-workbench.js";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  activateExplorationBoundary,
  assertCurrentExplorationBoundaryAuthority,
  buildAutoBoundary,
  databaseServerCompatibilityForLock,
  deactivateExplorationBoundary,
  emptyReviewOverrides,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundary,
  loadActivatedExplorationBoundaries,
  loadStructuredProjectEvidence,
  normalizeExplorationAutoBandPolicy,
  normalizeExplorationDerivedMeasure,
  normalizeExplorationNumericBand,
  pruneAutoBoundaryReviewOverrides,
  reviewExplorationBoundaryCandidate,
  writeAutoBoundaryArtifacts,
  type ActivatedExplorationBoundary,
  type AutoBoundaryBuild,
  type AutoBoundaryReviewOverrides,
  type ExplorationBoundaryDraft,
  type GenerationLock,
} from "./auto-boundary.js";
import { detectProjectContext } from "./project-detection.js";
import {
  activateProtectedQuery,
  createProtectedQueryDraft,
  disableScopedExplore,
  listProtectableQueries,
  loadProtectedQueryDraft,
  type ProtectArgumentSelection,
} from "./protect-query.js";
import {
  createScopedExploreRuntime,
  prepareScopedExplore,
  ScopedExploreError,
} from "./scoped-explore.js";
import {
  createScopedExploreBoundarySetRuntime,
  type ScopedExploreBoundarySetRuntime,
} from "./scoped-explore-boundary-set.js";
import type { ScopedExploreRuntime } from "./scoped-explore.js";
import {
  ExploreTrustedScopeError,
  resolveExploreTrustedScope,
  type ExploreTrustedScope,
} from "./explore-trusted-scope.js";
import {
  buildBoundaryCatalogDiagramExports,
  buildBoundaryCatalogModel,
  renderBoundaryCatalogMermaid,
} from "./boundary-catalog.js";
import {
  consumeGuidedGraduationTip,
  recordGuidedBoundaryRescan,
  readGuidedOnboardingState,
  resetGuidedOnboardingForBoundaryReview,
  updateGuidedOnboardingState,
} from "./guided-project.js";
import {
  commitBoundaryRescan,
  prepareBoundaryRescan,
  readBoundaryRescanReport,
} from "./boundary-rescan.js";
import { resolveConfiguredTrustedContextAuthority } from "./configured-trusted-context.js";
import { blockedTenantScopeGuidance } from "./boundary-scope-guidance.js";
import { buildInstantFirstValue } from "./instant-first-value.js";
import {
  derivedScopeStartSequence,
  formatDerivedScopePath,
} from "./derived-scope-display.js";
import {
  instantLocalBoundaryCandidate,
  recommendedBoundaryReviewCandidate,
} from "./boundary-candidate.js";
import {
  activateGuidedAction,
  createGuidedActionDraft,
  guidedActionDraftDetails,
  guidedActionOptions,
  guidedActionStatus,
  prepareGuidedActionPreview,
  recordGuidedActionPreview,
  type GuidedActionInput,
} from "./guided-action.js";
import {
  activateSafeActionDraft,
  prepareSafeActionPreview,
  recordSafeActionEffectPreview,
  safeActionStatus,
  type SafeActionStatus,
} from "./safe-action.js";
import {
  buildLifecycleView,
  LifecycleViewError,
  listLifecycleSummaries,
  resolveLifecycleProposal,
  type LifecycleViewV1,
} from "./lifecycle-view.js";
import {
  AskError,
  WorkbenchAskSession,
  type AskProvider,
  type AskProviderDependencies,
  type AskToolDefinition,
  type AskToolGateway,
} from "./model-ask.js";
import {
  collectAnalyticsAnalyses,
  modelAnswerForDisplay,
  redactPlanLiterals,
} from "./analytics-shell-render.js";
import { inspectCompiledExplorePlan } from "./explore-operator-evidence.js";
import { describeExploreAuditAttempt, describeExploreAuditPlan, reconstructExploreAuditQuery } from "./explore-audit-presentation.js";
import { queryAuditFiltersFromArgs } from "./ledger-options.js";
import { resolveExploreLedgerFilters } from "./ledger-search.js";
import { createWorkbenchAskMcpGateway } from "./ask-mcp-gateway.js";
import { resolveAskAccessGuidance } from "./ask-access-summary.js";
import {
  proveActiveExploreBoundaries,
  writeBoundaryProofArtifact,
} from "./boundary-proof.js";
import {
  computeAskAuthority,
  type AskMode,
} from "./ask-authority.js";
import { WORKBENCH_SYNTAX_CSS, workbenchSyntaxScript } from "./workbench-syntax.js";
import {
  BOUNDARY_REVIEW_PROGRESS_VERSION,
  boundaryReviewDecisions as sharedBoundaryReviewDecisions,
  createBoundaryReviewProgress as createSharedBoundaryReviewProgress,
  normalizeManagedBoundaryReviewDecision as normalizeSharedManagedBoundaryReviewDecision,
  normalizePartialReviewDecisions as normalizeSharedPartialReviewDecisions,
  readBoundaryReviewProgress as readSharedBoundaryReviewProgress,
  reconcileBoundaryReviewProgress as reconcileSharedBoundaryReviewProgress,
  saveBoundaryReviewProgress as saveSharedBoundaryReviewProgress,
  saveInstantBoundaryReviewBaseline,
  type BoundaryReviewConfirmation as SharedBoundaryReviewConfirmation,
  type BoundaryReviewDecision as SharedBoundaryReviewDecision,
  type BoundaryReviewInvalidation as SharedBoundaryReviewInvalidation,
  type BoundaryReviewProgress as SharedBoundaryReviewProgress,
  type ManagedBoundaryReviewDecision,
} from "./boundary-review-domain.js";
import {
  boundaryResourceRemovalImpact,
  commitBoundaryReviewMutationBatch,
  commitBoundaryResourceReviewMutation,
  formatBoundaryResourceRemovalBlocked,
  listBoundaryResourceReviews,
  prepareBoundaryReviewMutationBatch,
  prepareBoundaryResourceReviewMutation,
  type BoundaryReviewMutationBatchPreview,
  type BoundaryReviewMutationPreview,
  type BoundaryResourceReviewRequest,
} from "./boundary-review-mutation.js";
import {
  backupLegacyBoundaryReviewOverrides,
  boundaryReviewOverridesForCandidate,
} from "./boundary-review-policy.js";
import {
  createSavedBoundary,
  deleteSavedBoundary,
  resolveSavedBoundaryReviewAuthority,
  switchSavedBoundary,
  synchronizeBoundaryLibrary,
} from "./boundary-library.js";

type JsonRecord = Record<string, unknown>;
type WorkbenchScopedExploreRuntime = ScopedExploreRuntime | ScopedExploreBoundarySetRuntime;
type WorkbenchScopedExploreRuntimeFactory = (
  input: Parameters<typeof createScopedExploreBoundarySetRuntime>[0],
) => Promise<WorkbenchScopedExploreRuntime>;
export type BoundaryReviewProgress = SharedBoundaryReviewProgress;
export type BoundaryReviewDecision = SharedBoundaryReviewDecision;
type BoundaryReviewConfirmation = SharedBoundaryReviewConfirmation;
type BoundaryReviewInvalidation = SharedBoundaryReviewInvalidation;
const workbenchWorkerControlActions = new Set<WorkerControlAction>([
  "pause",
  "resume",
  "drain",
  "capability_enable",
  "capability_disable",
  "digest_revoke",
]);

export type LocalUiOptions = {
  configPath?: string;
  storePath?: string;
  host?: string;
  port?: number;
  token?: string;
  csrfToken?: string;
  allowRemoteBind?: boolean;
  tour?: boolean;
  boundaryRoot?: string;
  projectRoot?: string;
  storeAccess?: LocalUiStoreAccess;
  ledgerSource?: WorkbenchLedgerSource;
  safeActionPreview?: SafeActionPreview;
  guidedActionPreview?: GuidedActionPreview;
  freshnessEvaluator?: ProposalFreshnessEvaluator;
  schemaInspector?: typeof inspectDatabase;
  ledgerScope?: WorkbenchLedgerScope;
  deploymentProfile?: WorkbenchDeploymentProfile;
  proposalApprove?: WorkbenchProposalDecision;
  proposalApply?: WorkbenchProposalDecision;
  attentionAcknowledge?: WorkbenchAttentionDecision;
  workerDecision?: WorkbenchWorkerDecision;
  workerReconciliationInspect?: WorkbenchReconciliationInspect;
  workerReconciliationResolve?: WorkbenchReconciliationResolve;
  askGatewayFactory?: WorkbenchAskGatewayFactory;
  askProviderDependencies?: AskProviderDependencies;
  instantOnboarding?: boolean;
  scopedExploreRuntimeFactory?: WorkbenchScopedExploreRuntimeFactory;
  resolveTrustedScopeFn?: typeof resolveExploreTrustedScope;
  protectedQueryActivator?: typeof activateProtectedQuery;
  sessionIdleTimeoutMs?: number;
  sessionAbsoluteTimeoutMs?: number;
  now?: () => number;
};

export type WorkbenchLedgerSource =
  | { kind: "local_sqlite"; path: string }
  | { kind: "shared_postgres"; schema: string; url_env: string; read_only: true };

const DEFAULT_WORKBENCH_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_WORKBENCH_ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1_000;
const PROTECTED_QUERY_PREVIEW_TTL_MS = 10 * 60 * 1_000;

type WorkbenchSessionState = {
  bootstrapToken: string;
  sessionToken: string;
  csrfToken: string;
  consumed: boolean;
  allowHeaderSessionBeforeBootstrap: boolean;
  issuedAtMs?: number;
  lastSeenAtMs?: number;
  expiredStateCleared: boolean;
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
  now: () => number;
  trustedContext: Record<string, string>;
  askAuthorityRefreshPending?: boolean;
  boundaryPreview?: {
    digest: `sha256:${string}`;
    revision: number;
    actor: string;
    createdAtMs: number;
  };
  protectedQueryPreview?: {
    capability: string;
    digest: `sha256:${string}`;
    createdAtMs: number;
  };
};

export type WorkbenchDeploymentProfile = "development" | "staging" | "production" | "unknown";

export type WorkbenchLedgerScope = {
  tenant?: string;
  principal?: string;
  required?: boolean;
};

export type WorkbenchProposalDecision = (input: {
  proposalId: string;
  actor?: string;
  reason?: string;
  identityToken?: string;
  freshnessProofDigest?: string;
}) => Promise<{ code: number }>;

export type WorkbenchAttentionDecision = (input: {
  attentionId: string;
  actor?: string;
  identityToken?: string;
}) => Promise<{ code: number }>;

export type WorkbenchWorkerDecision = (input: {
  action:
    | WorkerControlAction
    | "cancel"
    | "dead_letter_requeue"
    | "dead_letter_discard";
  capability?: string;
  contractDigest?: `sha256:${string}`;
  proposalId?: string;
  retryBudget?: number;
  actor?: string;
  reason?: string;
  identityToken?: string;
}) => Promise<{ code: number }>;

export type WorkbenchReconciliationView = {
  intent_id: string;
  proposal_id: string;
  operation: string;
  intent_status: string;
  reconciliation_reason?: string;
  classification: string;
  supported_outcome: "applied" | "conflict" | "failed";
  observed_digest: `sha256:${string}`;
  expected_fields: string[];
  observed_fields: string[];
  member_count: number;
  member_classifications: Record<string, number>;
  source_database_changed: false;
};

export type WorkbenchReconciliationInspect = (input: {
  intentId: string;
}) => Promise<WorkbenchReconciliationView>;

export type WorkbenchReconciliationResolve = (input: {
  intentId: string;
  outcome: "applied" | "conflict" | "failed";
  actor?: string;
  reason: string;
  identityToken?: string;
}) => Promise<{ code: number }>;

export type WorkbenchAskGatewayFactory = (input: {
  configPath: string;
  storePath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  mode?: "auto" | AskMode;
}) => Promise<AskToolGateway>;

export type SafeActionPreview = (input: {
  projectRoot: string;
  configPath: string;
  storePath: string;
  args: JsonRecord;
}) => Promise<{
  draft_digest: `sha256:${string}`;
  proposal_id: string;
  proposal_hash: string;
  source_database_changed: boolean;
}>;

export type GuidedActionPreview = (input: {
  projectRoot: string;
  configPath: string;
  storePath: string;
  capabilityName: string;
  args: JsonRecord;
  env: NodeJS.ProcessEnv;
}) => Promise<{
  draft_digest: `sha256:${string}`;
  proposal_id: string;
  proposal_hash: string;
  source_database_changed: boolean;
}>;

export type ProposalFreshnessEvaluator = (
  proposal: StoredProposal,
) => Promise<ProposalFreshnessEvaluation>;

export type LocalUiStoreAccess = <T>(
  mode: "read" | "write",
  operation: string,
  callback: (store: ProposalStore) => T,
) => Promise<T>;

export type LocalUiServer = {
  server: Server;
  url: string;
  host: string;
  port: number;
  token: string;
  csrfToken: string;
  reissueBootstrapUrl: () => string;
  close: () => Promise<void>;
};

export async function startLocalUiServer(options: LocalUiOptions = {}): Promise<LocalUiServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLocalHost(host) && options.allowRemoteBind !== true) {
    throw new Error("synapsor-runner ui binds to localhost by default. Use --allow-remote-bind only for an intentional trusted local-network demo.");
  }
  const configPath = path.resolve(options.configPath ?? "synapsor.runner.json");
  const storePath = path.resolve(options.storePath ?? "./.synapsor/local.db");
  const token = options.token ?? crypto.randomBytes(24).toString("base64url");
  const csrfToken = options.csrfToken ?? crypto.randomBytes(24).toString("base64url");
  const now = options.now ?? Date.now;
  const startedAtMs = now();
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_WORKBENCH_IDLE_TIMEOUT_MS;
  const sessionAbsoluteTimeoutMs = options.sessionAbsoluteTimeoutMs ?? DEFAULT_WORKBENCH_ABSOLUTE_TIMEOUT_MS;
  if (!Number.isSafeInteger(sessionIdleTimeoutMs) || sessionIdleTimeoutMs <= 0) {
    throw new Error("Workbench session idle timeout must be a positive integer number of milliseconds.");
  }
  if (!Number.isSafeInteger(sessionAbsoluteTimeoutMs) || sessionAbsoluteTimeoutMs <= 0) {
    throw new Error("Workbench session absolute timeout must be a positive integer number of milliseconds.");
  }
  if (sessionIdleTimeoutMs > sessionAbsoluteTimeoutMs) {
    throw new Error("Workbench session idle timeout cannot exceed its absolute lifetime.");
  }
  const storeAccess = options.storeAccess ?? localStoreAccess(storePath);
  const projectRoot = path.resolve(options.projectRoot ?? path.dirname(configPath));
  const boundaryRoot = options.boundaryRoot ? path.resolve(options.boundaryRoot) : undefined;
  const deploymentProfile = options.deploymentProfile
    ?? (options.instantOnboarding === true ? "development" : undefined);
  const safeActionPreview = options.safeActionPreview ?? executeSafeActionPreview;
  const guidedActionPreview = options.guidedActionPreview ?? executeGuidedActionPreview;
  const schemaInspector = options.schemaInspector ?? inspectDatabase;
  const freshnessEvaluator = options.freshnessEvaluator
    ?? ((proposal: StoredProposal) => evaluateWorkbenchFreshness(configPath, proposal));
  const bootstrapState: WorkbenchSessionState = {
    bootstrapToken: token,
    sessionToken: token,
    csrfToken,
    consumed: false,
    allowHeaderSessionBeforeBootstrap: true,
    issuedAtMs: startedAtMs,
    lastSeenAtMs: startedAtMs,
    expiredStateCleared: false,
    idleTimeoutMs: sessionIdleTimeoutMs,
    absoluteTimeoutMs: sessionAbsoluteTimeoutMs,
    now,
    trustedContext: {} as Record<string, string>,
  };
  const askSession = new WorkbenchAskSession();
  const askGatewayFactory = options.askGatewayFactory ?? createWorkbenchAskMcpGateway;

  const server = createServer(async (request, response) => {
    try {
      await handleRequest({
        request,
        response,
        configPath,
        storePath,
        projectRoot,
        boundaryRoot,
        storeAccess,
        ledgerSource: options.ledgerSource ?? {
          kind: "local_sqlite",
          path: storePath === ":memory:" ? storePath : path.resolve(storePath),
        },
        safeActionPreview,
        guidedActionPreview,
        freshnessEvaluator,
        schemaInspector,
        ledgerScope: options.ledgerScope,
        deploymentProfile,
        proposalApprove: options.proposalApprove,
        proposalApply: options.proposalApply,
        attentionAcknowledge: options.attentionAcknowledge,
        workerDecision: options.workerDecision,
        workerReconciliationInspect: options.workerReconciliationInspect,
        workerReconciliationResolve: options.workerReconciliationResolve,
        askSession,
        askGatewayFactory,
        askProviderDependencies: options.askProviderDependencies,
        instantOnboarding: options.instantOnboarding === true,
        scopedExploreRuntimeFactory: options.scopedExploreRuntimeFactory ?? createScopedExploreBoundarySetRuntime,
        resolveTrustedScopeFn: options.resolveTrustedScopeFn ?? resolveExploreTrustedScope,
        protectedQueryActivator: options.protectedQueryActivator ?? activateProtectedQuery,
        workbenchHost: host,
        token,
        csrfToken,
        tour: options.tour === true,
        bootstrapState,
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const bootstrapUrl = () =>
    `http://${host}:${port}/?token=${encodeURIComponent(bootstrapState.bootstrapToken)}${options.tour ? "&tour=1" : ""}`;
  const url = bootstrapUrl();
  return {
    server,
    url,
    host,
    port,
    token,
    csrfToken,
    reissueBootstrapUrl: () => {
      bootstrapState.bootstrapToken = crypto.randomBytes(32).toString("base64url");
      bootstrapState.sessionToken = crypto.randomBytes(32).toString("base64url");
      bootstrapState.csrfToken = crypto.randomBytes(24).toString("base64url");
      bootstrapState.consumed = false;
      bootstrapState.allowHeaderSessionBeforeBootstrap = false;
      bootstrapState.issuedAtMs = undefined;
      bootstrapState.lastSeenAtMs = undefined;
      bootstrapState.expiredStateCleared = false;
      bootstrapState.trustedContext = {};
      bootstrapState.askAuthorityRefreshPending = false;
      bootstrapState.boundaryPreview = undefined;
      bootstrapState.protectedQueryPreview = undefined;
      askSession.clear();
      return bootstrapUrl();
    },
    close: () => new Promise((resolve, reject) => {
      askSession.clear();
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

async function handleRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  configPath: string;
  storePath: string;
  projectRoot: string;
  boundaryRoot?: string;
  storeAccess: LocalUiStoreAccess;
  ledgerSource: WorkbenchLedgerSource;
  safeActionPreview: SafeActionPreview;
  guidedActionPreview: GuidedActionPreview;
  freshnessEvaluator: ProposalFreshnessEvaluator;
  schemaInspector: typeof inspectDatabase;
  ledgerScope?: WorkbenchLedgerScope;
  deploymentProfile?: WorkbenchDeploymentProfile;
  proposalApprove?: WorkbenchProposalDecision;
  proposalApply?: WorkbenchProposalDecision;
  attentionAcknowledge?: WorkbenchAttentionDecision;
  workerDecision?: WorkbenchWorkerDecision;
  workerReconciliationInspect?: WorkbenchReconciliationInspect;
  workerReconciliationResolve?: WorkbenchReconciliationResolve;
  askSession: WorkbenchAskSession;
  askGatewayFactory: WorkbenchAskGatewayFactory;
  askProviderDependencies?: AskProviderDependencies;
  instantOnboarding: boolean;
  scopedExploreRuntimeFactory: WorkbenchScopedExploreRuntimeFactory;
  resolveTrustedScopeFn: typeof resolveExploreTrustedScope;
  protectedQueryActivator: typeof activateProtectedQuery;
  workbenchHost: string;
  token: string;
  csrfToken: string;
  tour: boolean;
  bootstrapState: WorkbenchSessionState;
}): Promise<void> {
  const {
    request,
    response,
    configPath,
    storePath,
    projectRoot,
    boundaryRoot,
    storeAccess,
    ledgerSource,
    safeActionPreview,
    guidedActionPreview,
    freshnessEvaluator,
    schemaInspector,
    ledgerScope,
    deploymentProfile,
    proposalApprove,
    proposalApply,
    attentionAcknowledge,
    workerDecision,
    workerReconciliationInspect,
    workerReconciliationResolve,
    askSession,
    askGatewayFactory,
    askProviderDependencies,
    instantOnboarding,
    scopedExploreRuntimeFactory,
    resolveTrustedScopeFn,
    protectedQueryActivator,
    workbenchHost,
    token,
    tour,
    bootstrapState,
  } = input;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
    const bootstrapTokenMatches = url.searchParams.get("token") === bootstrapState.bootstrapToken;
    const existingSessionIsValid = authenticateWorkbenchSession(request, bootstrapState, false).ok;
    if (!bootstrapTokenMatches || (bootstrapState.consumed && !existingSessionIsValid)) {
      sendJson(response, 401, {
        ok: false,
        error_code: "WORKBENCH_SESSION_INVALID",
        error: "This one-time Workbench URL is invalid or has already been consumed.",
      });
      return;
    }
    if (!bootstrapState.consumed) {
      const issuedAt = bootstrapState.now();
      bootstrapState.consumed = true;
      bootstrapState.issuedAtMs = issuedAt;
      bootstrapState.lastSeenAtMs = issuedAt;
      bootstrapState.expiredStateCleared = false;
      response.setHeader(
        "set-cookie",
        `synapsor_ui_token=${encodeURIComponent(bootstrapState.sessionToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.ceil(bootstrapState.absoluteTimeoutMs / 1_000)}`,
      );
    }
    const requestedView = url.searchParams.get("view");
    const requestedQueryRef = url.searchParams.get("query_ref");
    const requestedCapability = url.searchParams.get("capability");
    const protectRouteIsValid = requestedView === "protect"
      && /^A[1-9][0-9]*$/.test(requestedQueryRef ?? "")
      && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(requestedCapability ?? "");
    const redirectLocation = protectRouteIsValid
      ? `/#protect?${new URLSearchParams({
        query_ref: requestedQueryRef!,
        capability: requestedCapability!,
      }).toString()}`
      : tour || url.searchParams.get("tour") === "1"
        ? "/?tour=1"
        : "/";
    sendRedirect(response, redirectLocation);
    return;
  }
  const authentication = authenticateWorkbenchSession(request, bootstrapState, true);
  if (!authentication.ok) {
    if (authentication.errorCode === "WORKBENCH_SESSION_EXPIRED" && !bootstrapState.expiredStateCleared) {
      bootstrapState.trustedContext = {};
      bootstrapState.askAuthorityRefreshPending = false;
      bootstrapState.boundaryPreview = undefined;
      bootstrapState.protectedQueryPreview = undefined;
      askSession.clear();
      bootstrapState.expiredStateCleared = true;
    }
    sendJson(response, 401, {
      ok: false,
      error_code: authentication.errorCode,
      error: authentication.message,
      recovery_action: authentication.errorCode === "WORKBENCH_SESSION_EXPIRED"
        ? "Return to the terminal and type `r`, then open the fresh one-time URL."
        : "Open the current one-time Workbench URL from the terminal.",
      saved_review_progress_preserved: true,
      authority_changed: false,
      source_database_changed: false,
    });
    return;
  }
  const csrfToken = bootstrapState.csrfToken;

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, boundaryRoot && url.searchParams.get("surface") !== "activity"
      ? renderBoundaryWorkbench(csrfToken)
      : renderShell(csrfToken, tour || url.searchParams.get("tour") === "1", configPath, storePath));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/session") {
    const nowMs = bootstrapState.now();
    const issuedAtMs = bootstrapState.issuedAtMs ?? nowMs;
    const lastSeenAtMs = bootstrapState.lastSeenAtMs ?? nowMs;
    sendJson(response, 200, {
      ok: true,
      status: "active",
      idle_timeout_seconds: Math.floor(bootstrapState.idleTimeoutMs / 1_000),
      absolute_timeout_seconds: Math.floor(bootstrapState.absoluteTimeoutMs / 1_000),
      idle_expires_at: new Date(lastSeenAtMs + bootstrapState.idleTimeoutMs).toISOString(),
      absolute_expires_at: new Date(issuedAtMs + bootstrapState.absoluteTimeoutMs).toISOString(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/boundary") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Auto Boundary review is not enabled for this Workbench session." });
      return;
    }
    const draft = JSON.parse(await fs.readFile(path.join(boundaryRoot, "exploration-boundary.draft.json"), "utf8")) as ExplorationBoundaryDraft;
    const generationLock = JSON.parse(await fs.readFile(
      path.join(projectRoot, ".synapsor/generation-lock.json"),
      "utf8",
    )) as GenerationLock;
    const serverCompatibility = databaseServerCompatibilityForLock(generationLock) ?? null;
    const review = JSON.parse(await fs.readFile(
      path.join(boundaryRoot, "generation-review.json"),
      "utf8",
    )) as AutoBoundaryBuild["review"];
    const reviewForDisplay = {
      ...review,
      resources: review.resources.map((resource) => {
        const guidance = blockedTenantScopeGuidance(resource);
        return guidance ? { ...resource, scope_resolution_guidance: guidance } : resource;
      }),
    };
    let progress = await readBoundaryReviewProgress(projectRoot, draft);
    const hasReviewableResource = draft.pack.resources.length > 0;
    let candidate = progress?.candidate
      ?? (hasReviewableResource ? recommendedBoundaryReviewCandidate(draft) : structuredClone(draft));
    let activeBoundaries: ActivatedExplorationBoundary[] = [];
    try {
      activeBoundaries = await loadActivatedExplorationBoundaries(projectRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const boundaryCatalog = buildBoundaryCatalogModel(activeBoundaries);
    const instantCandidate = hasReviewableResource && instantOnboarding
      ? instantWorkbenchCandidate(draft)
      : null;
    const instantFirstValue = instantCandidate
      ? buildInstantFirstValue(instantCandidate)
      : null;
    const instantResource = instantCandidate?.pack.resources[0];
    let instantMissingBindings: string[] = [];
    let instantTenantScopeSource: ExploreTrustedScope["tenant_source"] | null = null;
    let instantScopeError: string | null = null;
    if (instantCandidate
      && instantResource
      && instantCandidate.trusted_context.provider === "environment") {
      const configuredTenant = process.env[instantCandidate.trusted_context.tenant_env]?.trim();
      const configuredPrincipal = process.env[instantCandidate.trusted_context.principal_env]?.trim();
      if ((instantResource.principal_key || instantResource.principal_scope) && !configuredPrincipal) {
        instantMissingBindings.push(instantCandidate.trusted_context.principal_env);
      }
      if (configuredTenant) {
        instantTenantScopeSource = "environment";
      } else if (instantCandidate.trusted_context.database_role_tenant && instantMissingBindings.length === 0) {
        try {
          const inspection = await schemaInspector({
            engine: generationLock.engine,
            databaseUrlEnv: generationLock.source_env,
            schema: generationLock.inspected_schema,
            env: process.env,
          });
          const scope = await resolveTrustedScopeFn({
            boundary: instantCandidate,
            lock: generationLock,
            inspection,
            env: process.env,
          });
          instantTenantScopeSource = scope.tenant_source;
        } catch (error) {
          instantMissingBindings = error instanceof ExploreTrustedScopeError
            ? error.missingBindings
            : [];
          instantScopeError = error instanceof Error
            ? error.message
            : "Runner could not verify trusted row scope from this database credential.";
        }
      } else if (!configuredTenant) {
        instantMissingBindings.push(instantCandidate.trusted_context.tenant_env);
      }
    }
    const instantAvailable = Boolean(instantCandidate)
      && instantOnboarding
      && activeBoundaries.length === 0
      && !progress
      && !draft.pack.resources.some((resource) => resource.minimum_cohort_overridden === true)
      && isLocalHost(workbenchHost)
      && (!deploymentProfile || deploymentProfile === "development");
    let boundaryLibrary;
    try {
      boundaryLibrary = await synchronizeBoundaryLibrary({
        projectRoot,
        draft,
        currentCandidate: candidate,
        ...(progress ? { currentProgress: progress } : {}),
      });
    } catch (error) {
      throw new Error(
        `Saved boundary workspace could not be synchronized: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    progress = await readBoundaryReviewProgress(projectRoot, draft);
    candidate = progress?.candidate
      ?? (hasReviewableResource ? recommendedBoundaryReviewCandidate(draft) : structuredClone(draft));
    const active = activeBoundaries.find((boundary) =>
      boundary.pack.name === candidate.pack.name) ?? null;
    const reviewDecisions = boundaryReviewDecisions(candidate);
    const confirmedDecisions = progress?.confirmed_decisions ?? [];
    sendJson(response, 200, {
      ok: true,
      draft,
      candidate,
      confirmed_decisions: confirmedDecisions,
      review_decisions: reviewDecisions,
      review_progress: {
        revision: progress?.revision ?? 0,
        policy_migration: progress?.policy_migration ?? null,
        invalidated_decisions: progress?.invalidated_decisions ?? [],
        outstanding_decisions: reviewDecisions
          .filter((decision) => !confirmedDecisions.includes(decision.decision)),
      },
      review: reviewForDisplay,
      database_server_compatibility: serverCompatibility,
      candidate_digest: explorationBoundaryCandidateDigest(candidate),
      boundary_library: boundaryLibrary,
      boundary_rescan_report: await readBoundaryRescanReport(projectRoot),
      active,
      active_boundaries: activeBoundaries,
      boundary_catalog: boundaryCatalog,
      boundary_mermaid: renderBoundaryCatalogMermaid(boundaryCatalog),
      boundary_diagrams: buildBoundaryCatalogDiagramExports(boundaryCatalog),
      journey: await readGuidedOnboardingState(projectRoot),
      operator_identity: instantActivationActor(),
      operator_identity_mode: "dev_env",
      instant_onboarding: {
        available: instantAvailable,
        eligible: instantAvailable
          && instantMissingBindings.length === 0
          && instantTenantScopeSource !== null
          && instantScopeError === null,
        candidate: instantCandidate,
        candidate_digest: instantCandidate ? explorationBoundaryCandidateDigest(instantCandidate) : null,
        resource: instantResource?.id ?? null,
        requires_principal: Boolean(instantResource?.principal_key || instantResource?.principal_scope),
        missing_bindings: instantMissingBindings,
        tenant_scope_source: instantTenantScopeSource,
        scope_error: instantScopeError,
        first_value: instantFirstValue,
      },
    });
    return;
  }

  if (request.method === "POST"
    && (url.pathname === "/api/instant/activate"
      || url.pathname === "/api/instant/activate-and-read")) {
    if (!boundaryRoot || !instantOnboarding || !isLocalHost(workbenchHost)) {
      sendJson(response, 404, { ok: false, error: "Instant onboarding is available only in a fresh secured loopback Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for instant onboarding." });
      return;
    }
    const draft = JSON.parse(await fs.readFile(path.join(boundaryRoot, "exploration-boundary.draft.json"), "utf8")) as ExplorationBoundaryDraft;
    if (await readBoundaryReviewProgress(projectRoot, draft)) {
      sendJson(response, 409, {
        ok: false,
        error: "Quick Start is unavailable after the full boundary review has begun. Resume the saved review instead.",
        source_database_changed: false,
      });
      return;
    }
    if (draft.pack.resources.length === 0) {
      sendJson(response, 409, {
        ok: false,
        error: "Instant onboarding is unavailable because every inspected resource is blocked. Review the listed identity and scope blockers first.",
      });
      return;
    }
    if (draft.pack.resources.some((resource) => resource.minimum_cohort_overridden === true)) {
      sendJson(response, 409, {
        ok: false,
        error: "Quick Start cannot activate a lowered minimum group size. Complete the full recorded boundary review.",
        source_database_changed: false,
      });
      return;
    }
    if (deploymentProfile && deploymentProfile !== "development") {
      sendJson(response, 409, {
        ok: false,
        error: "Quick Start is restricted to the local development authoring profile established by synapsor-runner start. Use full review for explicit staging, production, or unknown profiles.",
        source_database_changed: false,
      });
      return;
    }
    const body = await readJsonBody(request);
    if (Object.hasOwn(body, "profile")
      || Object.hasOwn(body, "deployment_profile")
      || Object.hasOwn(body, "profile_assertion")) {
      sendJson(response, 400, {
        ok: false,
        error: "The local authoring profile is established by synapsor-runner start and cannot be selected by a Workbench request.",
        source_database_changed: false,
      });
      return;
    }
    const activateOnly = url.pathname === "/api/instant/activate";
    const nextSurface = activateOnly
      && (body.next_surface === "model"
        || body.next_surface === "existing_client"
        || body.next_surface === "no_model")
      ? body.next_surface
      : activateOnly
        ? undefined
        : "no_model";
    if (!nextSurface) {
      sendJson(response, 400, {
        ok: false,
        error: "Choose the model, existing MCP client, or no-model surface after activation.",
        source_database_changed: false,
      });
      return;
    }
    const candidate = instantWorkbenchCandidate(draft);
    const resource = candidate.pack.resources[0];
    if (!resource) throw new Error("Runner could not identify a conservative first resource. Continue with the full boundary review.");
    const firstValue = buildInstantFirstValue(candidate);
    const lock = JSON.parse(await fs.readFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "utf8")) as GenerationLock;
    const inspection = await schemaInspector({
      engine: lock.engine,
      databaseUrlEnv: lock.source_env,
      schema: lock.inspected_schema,
      env: process.env,
    });
    let trustedScope: ExploreTrustedScope;
    try {
      trustedScope = await resolveTrustedScopeFn({
        boundary: candidate,
        lock,
        inspection,
        env: process.env,
      });
    } catch (error) {
      const missingBindings = error instanceof ExploreTrustedScopeError
        ? error.missingBindings
        : [];
      sendJson(response, 409, {
        ok: false,
        error_code: "EXPLORE_SCOPE_FORBIDDEN",
        error: error instanceof Error
          ? error.message
          : "Runner could not verify trusted row scope for this database credential.",
        missing_bindings: missingBindings,
        source_database_changed: false,
      });
      return;
    }
    let active: ActivatedExplorationBoundary;
    const digest = explorationBoundaryCandidateDigest(candidate);
    const activationActor = instantActivationActor();
    await saveInstantBoundaryReviewBaseline({
      projectRoot,
      draft,
      candidate,
      actor: activationActor,
    });
    active = await activateExplorationBoundary({
      projectRoot,
      candidate,
      expectedDigest: digest,
      actor: activationActor,
      confirmation: `ACTIVATE ${digest}`,
      confirmedDecisions: candidate.unresolved_decisions,
      currentInspection: inspection,
      activationAudit: {
        mode: "instant_development",
        launch_context: "start_from_env_local_authoring",
        confirmation_gesture: activateOnly
          ? `activate_for_${nextSurface}`
          : "activate_and_read",
      },
    });
    await recordWorkbenchAttention(storeAccess, {
      event_type: "capability.activated",
      severity: "informational",
      environment: "development",
      capability: "app.explore_data",
      contract_digest: active.activation.digest,
      attention_required: false,
      immediate_default: false,
      summary: "Conservative instant-development boundary activated",
      workbench_path: "/",
      details: {
        authority_type: "scoped_explore",
        activation_mode: "instant_development",
        source_database_changed: false,
      },
      source_event_key: `workbench-boundary-activated:instant:${active.activation.digest}`,
      now: active.activation.activated_at,
    });
    if (activateOnly) {
      const recommendedNextAction = nextSurface === "model"
        ? "Configure or use your model, then ask one plain-language question."
        : nextSurface === "existing_client"
          ? "Connect your existing model-enabled MCP client."
          : "Open the exact-plan composer and run one reviewed question.";
      await updateGuidedOnboardingState({
        projectRoot,
        status: "boundary_active",
        completedSteps: ["boundary_active"],
        authorityActive: true,
        recommendedNextAction,
      }).catch(() => undefined);
      sendJson(response, 200, {
        ok: true,
        active,
        next_surface: nextSurface,
        suggested_question: firstValue.question,
        operation: firstValue.operation,
        first_tool: "app.explore_data",
        resource: firstValue.resource,
        agent_can_see: firstValue.agent_can_see,
        agent_can_see_labels: firstValue.agent_can_see_labels,
        agent_cannot_see: firstValue.agent_cannot_see,
        agent_cannot_see_labels: firstValue.agent_cannot_see_labels,
        tenant_scope: firstValue.tenant_scope,
        tenant_scope_source: trustedScope.tenant_source,
        principal_scope: firstValue.principal_scope,
        source_rows_read: false,
        source_database_changed: false,
        model_can_activate: false,
        model_can_approve: false,
        model_can_apply: false,
        next_action: recommendedNextAction,
      });
      return;
    }
    let runtime: WorkbenchScopedExploreRuntime | undefined;
    try {
      runtime = await scopedExploreRuntimeFactory({
        projectRoot,
        transport: "loopback_workbench",
        env: { ...process.env, ...bootstrapState.trustedContext },
      });
      const plan = firstValue.plan;
      const result = withWorkbenchProtectQueryRef(await runtime.explore(plan));
      await updateGuidedOnboardingState({
        projectRoot,
        status: "first_value",
        completedSteps: ["boundary_active", "first_safe_read"],
        authorityActive: true,
        recommendedNextAction: "Ask a bounded aggregate question.",
      }).catch(() => undefined);
      const graduationTip = await consumeGuidedGraduationTip({ projectRoot }).catch(() => undefined);
      sendJson(response, 200, {
        ok: true,
        active,
        plan,
        result,
        question: firstValue.question,
        operation: firstValue.operation,
        first_tool: "app.explore_data",
        resource: firstValue.resource,
        agent_can_see: firstValue.agent_can_see,
        agent_can_see_labels: firstValue.agent_can_see_labels,
        agent_cannot_see: firstValue.agent_cannot_see,
        agent_cannot_see_labels: firstValue.agent_cannot_see_labels,
        tenant_scope: firstValue.tenant_scope,
        tenant_scope_source: trustedScope.tenant_source,
        principal_scope: firstValue.principal_scope,
        source_database_changed: false,
        model_can_activate: false,
        model_can_approve: false,
        model_can_apply: false,
        ...(graduationTip ? { graduation_tip: graduationTip } : {}),
        next_action: "Ask a bounded aggregate question.",
      });
    } finally {
      await runtime?.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "POST"
    && [
      "/api/boundary/library/create",
      "/api/boundary/library/switch",
      "/api/boundary/library/delete",
    ].includes(url.pathname)) {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Auto Boundary review is not enabled for this Workbench session." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to manage saved boundaries." });
      return;
    }
    const body = await readJsonBody(request);
    const name = requiredReviewText(body.name, "boundary name");
    const draft = JSON.parse(await fs.readFile(
      path.join(boundaryRoot, "exploration-boundary.draft.json"),
      "utf8",
    )) as ExplorationBoundaryDraft;
    const currentProgress = await readBoundaryReviewProgress(projectRoot, draft);
    const currentCandidate = currentProgress?.candidate ?? recommendedBoundaryReviewCandidate(draft);
    const context = {
      projectRoot,
      draft,
      currentCandidate,
      ...(currentProgress ? { currentProgress } : {}),
    };
    let progress: BoundaryReviewProgress;
    if (url.pathname === "/api/boundary/library/create") {
      const resourceId = requiredReviewText(body.resource_id, "starting table");
      const startingReview = (await listBoundaryResourceReviews(projectRoot)).find((resource) =>
        resource.resource_id === resourceId);
      if (startingReview?.first_table_startable === false
        && startingReview.first_table_scope_kind === "shared_reference") {
        throw new Error(
          resourceId + " cannot be the first table in this authoring flow. "
          + (startingReview.first_table_guidance
            ?? "Start with a tenant-scoped table, then add this table and confirm Shared reference for the new boundary")
          + ". The no-per-tenant-rows acknowledgement is reviewed separately for every boundary.",
        );
      }
      const startingResource = currentCandidate.pack.resources.find((resource) =>
        resource.id === resourceId);
      const requiredScopes = [
        ...(!currentCandidate.organization_scope && startingResource?.tenant_scope
          ? [startingResource.tenant_scope]
          : []),
        ...(startingResource?.principal_scope ? [startingResource.principal_scope] : []),
      ];
      if (requiredScopes.length > 0) {
        const guidance = requiredScopes.map((scope) => {
          const sequence = derivedScopeStartSequence(scope);
          const ancestor = sequence[0] ?? scope.ancestor_resource;
          const intermediate = sequence.slice(1, -1);
          return "start with " + ancestor
            + (intermediate.length ? ", then add " + intermediate.join(", then ") : "")
            + ", then add this table";
        });
        throw new Error(
          resourceId + " cannot be the first table. " + guidance.join("; ") + ". "
          + "Its required scope is derived through "
          + requiredScopes.map(formatDerivedScopePath).join("; ") + ".",
        );
      }
      progress = await createSavedBoundary({
        ...context,
        name,
        resourceId,
        actor: typeof body.actor === "string" && body.actor.trim()
          ? body.actor.trim().slice(0, 128)
          : instantActivationActor(),
      });
    } else if (url.pathname === "/api/boundary/library/switch") {
      progress = await switchSavedBoundary({ ...context, name });
    } else {
      if (body.confirmation !== `DELETE ${name}`) {
        sendJson(response, 409, {
          ok: false,
          error: `Deleting saved boundary ${name} requires its exact confirmation.`,
        });
        return;
      }
      const deleted = await deleteSavedBoundary({ ...context, name });
      progress = deleted.progress;
    }
    const boundaryLibrary = await synchronizeBoundaryLibrary({
      projectRoot,
      draft,
      currentCandidate: progress.candidate,
      currentProgress: progress,
    });
    sendJson(response, 200, {
      ok: true,
      candidate: progress.candidate,
      confirmed_decisions: progress.confirmed_decisions,
      review_progress: {
        revision: progress.revision,
        invalidated_decisions: progress.invalidated_decisions,
      },
      candidate_digest: progress.candidate_digest,
      boundary_library: boundaryLibrary,
      authority_changed: false,
      source_database_changed: false,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/boundary/progress") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Auto Boundary review is not enabled for this Workbench session." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to save boundary-review progress." });
      return;
    }
    const body = await readJsonBody(request);
    if (!isRecord(body.candidate)
      || !Array.isArray(body.confirmed_decisions)
      || body.confirmed_decisions.some((decision) => typeof decision !== "string")) {
      throw new Error("Boundary-review progress requires a candidate and an array of confirmed decisions.");
    }
    const draft = JSON.parse(await fs.readFile(path.join(boundaryRoot, "exploration-boundary.draft.json"), "utf8")) as ExplorationBoundaryDraft;
    const existingProgress = await readBoundaryReviewProgress(projectRoot, draft);
    const currentRevision = existingProgress?.revision ?? 0;
    if (body.expected_revision !== undefined
      && (!Number.isSafeInteger(body.expected_revision) || body.expected_revision !== currentRevision)) {
      sendJson(response, 409, {
        ok: false,
        error: "Boundary review changed in another Workbench session. Reload before saving this review.",
        current_revision: currentRevision,
      });
      return;
    }
    const submittedCandidate = body.candidate as unknown as ExplorationBoundaryDraft;
    const currentCandidate = existingProgress?.candidate
      ?? (draft.pack.resources.length > 0
        ? recommendedBoundaryReviewCandidate(draft)
        : structuredClone(draft));
    const submittedResourceIds = new Set(
      submittedCandidate.pack.resources.map((resource) => resource.id),
    );
    const removedResourceIds = currentCandidate.pack.resources
      .map((resource) => resource.id)
      .filter((resourceId) => !submittedResourceIds.has(resourceId));
    for (const resourceId of removedResourceIds) {
      const impact = boundaryResourceRemovalImpact(currentCandidate, resourceId, {
        also_removing: removedResourceIds,
      });
      if (!impact.blocking_dependencies.length) continue;
      sendJson(response, 409, {
        ok: false,
        error_code: "BOUNDARY_RESOURCE_REMOVAL_DEPENDENCY",
        error: formatBoundaryResourceRemovalBlocked(impact),
        removal_impact: impact,
        authority_changed: false,
        source_database_changed: false,
      });
      return;
    }
    const reviewAuthority = await resolveSavedBoundaryReviewAuthority({
      projectRoot,
      draft,
      candidate: submittedCandidate,
      ...(existingProgress ? { progress: existingProgress } : {}),
    });
    const preview = reviewExplorationBoundaryCandidate(
      reviewAuthority.reviewDraft,
      submittedCandidate,
    );
    const confirmed = normalizePartialReviewDecisions(
      preview.candidate.unresolved_decisions,
      body.confirmed_decisions as string[],
    );
    const unchanged = existingProgress
      && existingProgress.candidate_digest === preview.digest
      && existingProgress.confirmed_decisions.length === confirmed.length
      && existingProgress.confirmed_decisions.every(
        (decision, index) => decision === confirmed[index],
      );
    if (unchanged) {
      sendJson(response, 200, {
        ok: true,
        digest: preview.digest,
        confirmed_decisions: existingProgress.confirmed_decisions,
        revision: existingProgress.revision,
        invalidated_decisions: existingProgress.invalidated_decisions,
        unchanged: true,
        source_database_changed: false,
      });
      return;
    }
    const progress = createBoundaryReviewProgress({
      draft,
      candidate: preview.candidate,
      confirmedDecisions: confirmed,
      previous: existingProgress,
      actor: typeof body.actor === "string" ? body.actor : undefined,
      revision: currentRevision + 1,
    });
    await saveSharedBoundaryReviewProgress(projectRoot, progress);
    sendJson(response, 200, {
      ok: true,
      digest: preview.digest,
      confirmed_decisions: confirmed,
      revision: progress.revision,
      invalidated_decisions: progress.invalidated_decisions,
      source_database_changed: false,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/boundary/review-relationship") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Auto Boundary review is not enabled for this Workbench session." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to stage a relationship for human review." });
      return;
    }
    const body = await readJsonBody(request);
    const resourceId = requiredReviewText(body.resource, "resource");
    const relationshipId = requiredReviewText(body.relationship, "relationship");
    const expectedActiveDigest = requiredReviewText(body.active_boundary_digest, "active boundary digest");
    const actor = requiredReviewText(body.actor, "human reviewer");
    if (actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) {
      throw new Error("Relationship review requires a bounded human reviewer identity.");
    }
    const draft = JSON.parse(await fs.readFile(
      path.join(boundaryRoot, "exploration-boundary.draft.json"),
      "utf8",
    )) as ExplorationBoundaryDraft;
    const active = await loadActivatedExplorationBoundary(projectRoot, {
      digest: expectedActiveDigest as `sha256:${string}`,
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (!active || active.generation_lock_fingerprint !== draft.generation_lock_fingerprint) {
      sendJson(response, 409, {
        ok: false,
        error: "The active boundary or its catalog proof changed after this refusal. Retry the analysis before reviewing a relationship.",
      });
      return;
    }
    const source = draft.pack.resources.find((resource) => resource.id === resourceId);
    const reviewedRelationship = source?.relationships.find((relationship) =>
      relationship.id === relationshipId);
    if (!source || !reviewedRelationship?.proof
      || reviewedRelationship.proof.source !== "database_catalog"
      || canonicalJsonDigest(reviewedRelationship.proof.links) !== reviewedRelationship.proof.digest) {
      sendJson(response, 409, {
        ok: false,
        error: "This relationship is not backed by the current deterministic catalog proof.",
      });
      return;
    }
    if (body.confirmation !== `REVIEW RELATIONSHIP ${reviewedRelationship.proof.digest}`) {
      sendJson(response, 409, {
        ok: false,
        error: "Relationship review requires confirmation bound to the exact catalog-proof digest.",
      });
      return;
    }
    const existingProgress = await readBoundaryReviewProgress(projectRoot, draft);
    const activeCandidate: ExplorationBoundaryDraft = {
      schema_version: active.schema_version,
      activation: "disabled_unreviewed",
      deployment_profile: active.deployment_profile,
      source: active.source,
      compiler_version: active.compiler_version,
      spec_version: active.spec_version,
      ...(active.database_server_version
        ? { database_server_version: active.database_server_version }
        : {}),
      ...(active.database_server_tier
        ? { database_server_tier: active.database_server_tier }
        : {}),
      ...(active.database_server_authority
        ? { database_server_authority: structuredClone(active.database_server_authority) }
        : {}),
      ...(active.reporting_timezone ? { reporting_timezone: active.reporting_timezone } : {}),
      ...(active.organization_scope
        ? { organization_scope: structuredClone(active.organization_scope) }
        : {}),
      trusted_context: structuredClone(active.trusted_context),
      generation_lock_fingerprint: active.generation_lock_fingerprint,
      role_posture_fingerprint: active.role_posture_fingerprint,
      pack: structuredClone(active.pack),
      budgets: structuredClone(active.budgets),
      unresolved_decisions: [],
    };
    // Demand-driven review may widen only the currently active authority.
    // Saved progress can predate activation and therefore must not become an
    // implicit source of unrelated, unactivated resources or relationships.
    const candidate = structuredClone(activeCandidate);
    const candidateSource = candidate.pack.resources.find((resource) => resource.id === resourceId);
    const candidateResources = new Set(candidate.pack.resources.map((resource) => resource.id));
    if (!candidateSource || reviewedRelationship.proof.links.some((link) =>
      !candidateResources.has(link.source_resource) || !candidateResources.has(link.target_resource))) {
      sendJson(response, 409, {
        ok: false,
        error: "This path crosses a table or view outside the active reviewed pack. Review the pack explicitly instead.",
      });
      return;
    }
    if (!candidateSource.relationships.some((relationship) => relationship.id === relationshipId)) {
      candidateSource.relationships.push(structuredClone(reviewedRelationship));
      candidateSource.relationships.sort((left, right) =>
        (left.path_depth ?? 1) - (right.path_depth ?? 1) || left.id.localeCompare(right.id));
    }
    const relationshipDecision =
      `${resourceId}: review relationship ${relationshipId} cardinality and scope on ${reviewedRelationship.target_resource}`;
    // This endpoint constructs the only permitted widening from the active pack
    // after proving the catalog relationship and every resource in its path.
    // Reconstitute that boundary's own review requirements without borrowing a
    // policy-bound draft from another saved boundary.
    const reviewDraft = structuredClone(candidate);
    reviewDraft.unresolved_decisions = [...new Set([
      ...active.activation.reviewed_decisions
        .filter((decision) => decision.confirmed)
        .map((decision) => decision.decision),
      relationshipDecision,
    ])].sort();
    const preview = reviewExplorationBoundaryCandidate(reviewDraft, candidate);
    const confirmedDecisions = active.activation.reviewed_decisions
      .filter((decision) => decision.confirmed)
      .map((decision) => decision.decision)
      .filter((decision) => preview.candidate.unresolved_decisions.includes(decision));
    if (reviewedRelationship.unmatched_rows !== "review_required"
      && preview.candidate.unresolved_decisions.includes(relationshipDecision)
      && !confirmedDecisions.includes(relationshipDecision)) {
      confirmedDecisions.push(relationshipDecision);
    }
    const progress = createBoundaryReviewProgress({
      draft,
      candidate: preview.candidate,
      confirmedDecisions,
      ...(existingProgress ? { previous: existingProgress } : {}),
      actor,
      revision: (existingProgress?.revision ?? 0) + 1,
    });
    await saveBoundaryReviewProgress(projectRoot, progress);
    sendJson(response, 200, {
      ok: true,
      candidate: progress.candidate,
      candidate_digest: progress.candidate_digest,
      confirmed_decisions: progress.confirmed_decisions,
      invalidated_decisions: progress.invalidated_decisions,
      revision: progress.revision,
      relationship_review: {
        resource: resourceId,
        relationship: relationshipId,
        target_resource: reviewedRelationship.target_resource,
        path_depth: reviewedRelationship.path_depth ?? 1,
        nullable: reviewedRelationship.nullable ?? false,
        proof: reviewedRelationship.proof,
      },
      source_database_changed: false,
      message: "The catalog-proven path is staged for normal human review. It is not active and the model gained no authority.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/boundary/regenerate") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Auto Boundary review is not enabled for this Workbench session." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for managed boundary regeneration." });
      return;
    }
    const body = await readJsonBody(request);
    let preview: BoundaryReviewMutationPreview | BoundaryReviewMutationBatchPreview;
    let committed: Awaited<ReturnType<typeof commitBoundaryResourceReviewMutation>>
      | Awaited<ReturnType<typeof commitBoundaryReviewMutationBatch>>;
    if (body.kind === "minimum_cohort_all") {
      const included = (await listBoundaryResourceReviews(projectRoot))
        .filter((resource) => resource.included)
        .filter((resource) => resource.minimum_cohort_size !== Number(body.value));
      if (!included.length) {
        throw new Error("Every included table already uses this aggregate privacy threshold.");
      }
      const requests = included.map((resource) => managedReviewMutationRequest(
        normalizeSharedManagedBoundaryReviewDecision({
          ...body,
          kind: "minimum_cohort",
          resource_id: resource.resource_id,
        }),
      ));
      preview = await prepareBoundaryReviewMutationBatch(
        projectRoot,
        requests,
        schemaInspector,
      );
      committed = await commitBoundaryReviewMutationBatch(projectRoot, preview);
    } else {
      const normalizedDecision = normalizeSharedManagedBoundaryReviewDecision(body);
      const mutationRequest = managedReviewMutationRequest(normalizedDecision);
      preview = await prepareBoundaryResourceReviewMutation(
        projectRoot,
        mutationRequest,
        schemaInspector,
      );
      committed = await commitBoundaryResourceReviewMutation(projectRoot, preview);
    }
    const build = preview.build;
    const activeBeforeReview = await loadActivatedExplorationBoundary(projectRoot, {
      name: build.exploration_boundary.pack.name,
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const progress = await readSharedBoundaryReviewProgress(projectRoot, build.exploration_boundary);
    const journey = activeBeforeReview
      ? await updateGuidedOnboardingState({
        projectRoot,
        status: "boundary_active",
        authorityActive: true,
        recommendedNextAction: "Review and activate the disabled boundary revision when ready.",
      }).catch(() => undefined)
      : await resetGuidedOnboardingForBoundaryReview({
        projectRoot,
        schemaFingerprint: build.lock.schema_fingerprint,
        rolePostureFingerprint: build.lock.role_posture_fingerprint,
      }).catch(() => undefined);
    const candidateDigest = committed.candidate_digest;
    await recordWorkbenchAttention(storeAccess, {
      event_type: "capability.review_required",
      severity: "warning",
      environment: deploymentProfile ?? build.exploration_boundary.deployment_profile,
      capability: "app.explore_data",
      contract_digest: candidateDigest,
      attention_key: `boundary-review:${candidateDigest}`,
      attention_required: true,
      immediate_default: false,
      summary: "The changed authoring boundary requires review",
      workbench_path: "/",
      details: {
        authority_type: "scoped_explore",
        reason_code: "review_input_changed",
        source_database_changed: false,
      },
      source_event_key: `workbench-boundary-review:${candidateDigest}`,
    });
    const sensitiveOverride = Array.isArray(preview.semantic_diff)
      ? undefined
      : sensitiveFieldOverrideEvent(
        body,
        build.overrides,
        preview.semantic_diff,
      );
    if (sensitiveOverride) {
      await recordWorkbenchAttention(storeAccess, {
        event_type: "sensitive_override_activated",
        severity: "warning",
        environment: deploymentProfile ?? build.exploration_boundary.deployment_profile,
        capability: "auto_boundary_review",
        contract_digest: candidateDigest,
        attention_key: `sensitive-override:${sensitiveOverride.resourceFingerprint}:${sensitiveOverride.fieldFingerprint}`,
        attention_required: true,
        immediate_default: false,
        summary: "A reviewer allowed use of a field classified as sensitive or uncertain",
        workbench_path: "/",
        details: {
          authority_type: "reviewed_field_exposure",
          resource_fingerprint: sensitiveOverride.resourceFingerprint,
          field_fingerprint: sensitiveOverride.fieldFingerprint,
          source_database_changed: false,
        },
        source_event_key: `workbench-sensitive-override:${sensitiveOverride.decisionDigest}`,
        now: sensitiveOverride.decidedAt,
      });
    }
    sendJson(response, 200, {
      ok: true,
      draft: build.exploration_boundary,
      review: build.review,
      candidate: progress?.candidate ?? build.exploration_boundary,
      candidate_digest: candidateDigest,
      decision_digest: preview.decision_digest,
      semantic_diff: preview.semantic_diff,
      overrides: build.overrides,
      confirmed_decisions: progress?.confirmed_decisions ?? [],
      review_progress: {
        revision: progress?.revision ?? 0,
        invalidated_decisions: progress?.invalidated_decisions ?? [],
        outstanding_decisions: boundaryReviewDecisions(progress?.candidate ?? build.exploration_boundary)
          .filter((decision) => !(progress?.confirmed_decisions ?? []).includes(decision.decision)),
      },
      active: activeBeforeReview,
      journey,
      source_database_changed: false,
      message: activeBeforeReview
        ? "The disabled boundary revision was updated. Existing exact Explore authority remains active until this revision is separately reviewed and activated."
        : "The disabled boundary was updated and remains inactive until separate review and activation.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/project/rescan") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Managed project rescan is available only in an Auto Boundary Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to preview schema drift." });
      return;
    }
    const prepared = await prepareBoundaryRescan({
      projectRoot,
      boundaryRoot,
      schemaInspector,
    });
    sendJson(response, 200, {
      ok: true,
      preview_digest: prepared.previewDigest,
      diff: prepared.report,
      source_database_changed: false,
      message: "Rescan preview completed. No generated file, active boundary, protected capability, ledger record, or source row was changed.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/project/rescan/apply") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Managed project rescan is available only in an Auto Boundary Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to apply schema drift." });
      return;
    }
    const body = await readJsonBody(request);
    if (typeof body.expected_digest !== "string" || typeof body.confirmation !== "string") {
      throw new Error("Applying a rescan requires the exact preview digest and confirmation.");
    }
    const prepared = await prepareBoundaryRescan({
      projectRoot,
      boundaryRoot,
      schemaInspector,
    });
    if (body.expected_digest !== prepared.previewDigest || body.confirmation !== `RESCAN ${prepared.previewDigest}`) {
      throw new Error("Schema or review inputs changed after preview; preview the rescan again.");
    }
    const previousActiveBoundary = await loadActivatedExplorationBoundary(projectRoot, {
      name: prepared.selectedProgress.candidate.pack.name,
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const previousActive = activeBoundaryEventMetadata(previousActiveBoundary);
    await commitBoundaryRescan(prepared);
    const progress = prepared.selectedProgress;
    const authorityActive = (await loadActivatedExplorationBoundaries(projectRoot).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    })).length > 0;
    const journey = await recordGuidedBoundaryRescan({
      projectRoot,
      schemaFingerprint: prepared.selectedBuild.lock.schema_fingerprint,
      rolePostureFingerprint: prepared.selectedBuild.lock.role_posture_fingerprint,
      pendingReview: prepared.report.changed,
      authorityActive,
    }).catch(() => undefined);
    const candidateDigest = progress.candidate_digest;
    if (prepared.report.schema_changed || prepared.report.role_posture_changed) {
      await recordWorkbenchAttention(storeAccess, {
        event_type: "schema.drift_detected",
        severity: "critical",
        environment: deploymentProfile ?? prepared.selectedBuild.exploration_boundary.deployment_profile,
        capability: "app.explore_data",
        ...(previousActive ? { contract_digest: previousActive.digest } : {}),
        attention_key: `schema-drift:${prepared.previewDigest}`,
        attention_required: true,
        immediate_default: true,
        summary: "Schema drift invalidated generated authoring authority",
        workbench_path: "/",
        details: schemaDriftAttentionDetails(prepared.report as unknown as JsonRecord),
        source_event_key: `workbench-schema-drift:${prepared.previewDigest}`,
      });
    }
    if (prepared.report.changed) {
      await recordWorkbenchAttention(storeAccess, {
        event_type: "capability.review_required",
        severity: "warning",
        environment: deploymentProfile ?? prepared.selectedBuild.exploration_boundary.deployment_profile,
        capability: "app.explore_data",
        contract_digest: candidateDigest,
        attention_key: `boundary-review:${candidateDigest}`,
        attention_required: true,
        immediate_default: false,
        summary: "The rescanned authoring boundary requires review",
        workbench_path: "/",
        details: {
          authority_type: "scoped_explore",
          reason_code: prepared.report.schema_changed || prepared.report.role_posture_changed
            ? "schema_drift"
            : "operator_rescan",
          source_database_changed: false,
        },
        source_event_key: `workbench-boundary-review:rescan:${candidateDigest}`,
      });
    }
    sendJson(response, 200, {
      ok: true,
      diff: prepared.report,
      journey,
      confirmed_decisions: progress.confirmed_decisions,
      review_progress: {
        revision: progress.revision,
        invalidated_decisions: progress.invalidated_decisions,
        outstanding_decisions: boundaryReviewDecisions(progress.candidate)
          .filter((decision) => !progress.confirmed_decisions.includes(decision.decision)),
      },
      active: previousActive ?? null,
      source_database_changed: false,
      message: prepared.report.changed
        ? "The reconciled boundary revision is disabled and ready for review. Existing exact authority, protected capabilities, and ledger history were preserved."
        : prepared.report.authoring_baseline_refreshed
          ? "The private boundary-authoring baseline was repaired for CLI and Workbench. No active boundary or reviewed revision changed, and no boundary review is required."
          : "The schema, role posture, and trusted context are unchanged. No boundary revision was created.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/project/start-over") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Managed review reset is available only in an Auto Boundary Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to reset managed review decisions." });
      return;
    }
    const body = await readJsonBody(request);
    if (body.confirmation !== "START OVER REVIEW") {
      throw new Error("Start over requires the exact confirmation START OVER REVIEW.");
    }
    const prepared = await prepareAutoBoundaryRescan({
      projectRoot,
      boundaryRoot,
      schemaInspector,
      resetOverrides: true,
    });
    const boundaryName = prepared.build.exploration_boundary.pack.name;
    const previousActiveBoundary = await loadActivatedExplorationBoundary(projectRoot, {
      name: boundaryName,
    }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    const previousActive = activeBoundaryEventMetadata(previousActiveBoundary);
    await writeAutoBoundaryArtifacts({
      projectRoot,
      outputRoot: path.relative(projectRoot, boundaryRoot),
      build: prepared.build,
      force: true,
      preserveActiveBoundary: true,
    });
    const deactivated = previousActiveBoundary
      ? await deactivateExplorationBoundary(projectRoot, boundaryName)
      : { disabled: [], remaining: await loadActivatedExplorationBoundaries(projectRoot).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        }) };
    let journey = await resetGuidedOnboardingForBoundaryReview({
      projectRoot,
      schemaFingerprint: prepared.build.lock.schema_fingerprint,
      rolePostureFingerprint: prepared.build.lock.role_posture_fingerprint,
    }).catch(() => undefined);
    if (deactivated.remaining.length > 0) {
      journey = await updateGuidedOnboardingState({
        projectRoot,
        status: "boundary_active",
        authorityActive: true,
        recommendedNextAction: `Review ${boundaryName} when ready; Ask remains available through ${deactivated.remaining.length} other active ${deactivated.remaining.length === 1 ? "boundary" : "boundaries"}.`,
      }).catch(() => journey);
    }
    const candidateDigest = explorationBoundaryCandidateDigest(prepared.build.exploration_boundary);
    await recordWorkbenchAttention(storeAccess, {
      event_type: "capability.review_required",
      severity: "warning",
      environment: deploymentProfile ?? prepared.build.exploration_boundary.deployment_profile,
      capability: "app.explore_data",
      contract_digest: candidateDigest,
      attention_key: `boundary-review:${candidateDigest}`,
      attention_required: true,
      immediate_default: false,
      summary: "The reset authoring boundary requires review",
      workbench_path: "/",
      details: {
        authority_type: "scoped_explore",
        reason_code: "operator_review_reset",
        source_database_changed: false,
      },
      source_event_key: `workbench-boundary-review:reset:${candidateDigest}`,
    });
    if (previousActive) {
      await recordWorkbenchAttention(storeAccess, capabilityRevokedAttention({
        environment: deploymentProfile ?? prepared.build.exploration_boundary.deployment_profile,
        capability: "app.explore_data",
        digest: previousActive.digest,
        reasonCode: "operator_review_reset",
        sourceEventKey: `workbench-boundary-revoked:reset:${previousActive.digest}:${candidateDigest}`,
      }));
    }
    sendJson(response, 200, {
      ok: true,
      journey,
      active: null,
      remaining_active_boundaries: deactivated.remaining.map((boundary) => boundary.pack.name),
      source_database_changed: false,
      preserved: ["local ledger", "protected named capabilities", "Runner config", "source database"],
      message: deactivated.remaining.length > 0
        ? `Managed review decisions for ${boundaryName} were reset, and that boundary is inactive. Ask remains available through: ${deactivated.remaining.map((boundary) => boundary.pack.name).join(", ")}.`
        : `Managed review decisions for ${boundaryName} were reset. Its new inactive draft is ready for review.`,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/boundary/activate") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Auto Boundary review is not enabled for this Workbench session." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for exploration-boundary activation." });
      return;
    }
    const body = await readJsonBody(request);
    if (!isRecord(body.candidate)) throw new Error("Boundary activation requires the exact reviewed candidate object.");
    if (typeof body.expected_digest !== "string"
      || typeof body.actor !== "string"
      || typeof body.confirmation !== "string"
      || !Array.isArray(body.confirmed_decisions)
      || body.confirmed_decisions.some((decision) => typeof decision !== "string")) {
      throw new Error("Boundary activation requires expected_digest, actor, exact confirmation, and every reviewed decision.");
    }
    const preview = bootstrapState.boundaryPreview;
    const draft = JSON.parse(
      await fs.readFile(path.join(boundaryRoot, "exploration-boundary.draft.json"), "utf8"),
    ) as ExplorationBoundaryDraft;
    const progress = await readBoundaryReviewProgress(projectRoot, draft);
    if (progress?.policy_migration.status === "review_required") {
      sendJson(response, 409, {
        ok: false,
        error_code: "BOUNDARY_POLICY_MIGRATION_REQUIRED",
        error: [
          `Boundary ${progress.candidate.pack.name} has legacy project-wide review settings that are not yet isolated to its immutable boundary identity.`,
          "Runner preserved the exact saved boundary revision but will not activate it as newly reviewed policy.",
          "Edit and save a reviewed setting for this boundary, or apply a Rescan, then review and activate the resulting disabled revision.",
        ].join(" "),
        source_database_changed: false,
      });
      return;
    }
    const candidateDigest = explorationBoundaryCandidateDigest(
      body.candidate as unknown as ExplorationBoundaryDraft,
    );
    if (!preview
      || preview.digest !== body.expected_digest
      || preview.digest !== candidateDigest
      || preview.revision !== (progress?.revision ?? 0)
      || preview.actor !== body.actor.trim()) {
      sendJson(response, 409, {
        ok: false,
        error: "The final review fingerprint is missing or stale. Create a new final review fingerprint before activation.",
        error_code: "BOUNDARY_PREVIEW_STALE",
        source_database_changed: false,
      });
      return;
    }
    const candidate = body.candidate as unknown as ExplorationBoundaryDraft;
    const reviewAuthority = await resolveSavedBoundaryReviewAuthority({
      projectRoot,
      draft,
      candidate,
      ...(progress ? { progress } : {}),
    });
    const inspection = await schemaInspector({
      engine: reviewAuthority.generationLock.engine,
      databaseUrlEnv: reviewAuthority.generationLock.source_env,
      schema: reviewAuthority.generationLock.inspected_schema,
      env: process.env,
    });
    const active = await activateExplorationBoundary({
      projectRoot,
      candidate,
      reviewDraft: reviewAuthority.reviewDraft,
      generationLock: reviewAuthority.generationLock,
      expectedDigest: body.expected_digest,
      actor: body.actor,
      confirmation: body.confirmation,
      confirmedDecisions: body.confirmed_decisions,
      currentInspection: inspection,
      activeSetMode: "add",
    });
    bootstrapState.boundaryPreview = undefined;
    await recordWorkbenchAttention(storeAccess, {
      event_type: "capability.activated",
      severity: "informational",
      environment: deploymentProfile ?? active.deployment_profile,
      capability: "app.explore_data",
      contract_digest: active.activation.digest,
      attention_required: false,
      immediate_default: false,
      summary: "Reviewed local authoring authority activated",
      workbench_path: "/",
      details: {
        authority_type: "scoped_explore",
        source_database_changed: false,
      },
      source_event_key: `workbench-boundary-activated:${active.activation.digest}`,
      now: active.activation.activated_at,
    });
    await updateGuidedOnboardingState({
      projectRoot,
      status: "boundary_active",
      completedStep: "boundary_active",
      authorityActive: true,
      recommendedNextAction: "Try your first safe read.",
    }).catch(() => undefined);
    let retainedAsk: Awaited<ReturnType<typeof rebindConfiguredWorkbenchAskSession>>;
    let askAuthorityRefreshPending = false;
    try {
      retainedAsk = await rebindConfiguredWorkbenchAskSession({
        askSession,
        askGatewayFactory,
        configPath,
        storePath,
        projectRoot,
        profile: active.deployment_profile,
        env: { ...process.env, ...bootstrapState.trustedContext },
      });
      bootstrapState.askAuthorityRefreshPending = false;
    } catch {
      // Activation is durable even when the disposable authority probe fails.
      // Keep the in-memory provider credential so Ask can rebind on its next use.
      retainedAsk = askSession.status().configuration;
      askAuthorityRefreshPending = Boolean(retainedAsk);
      bootstrapState.askAuthorityRefreshPending = askAuthorityRefreshPending;
    }
    sendJson(response, 200, {
      ok: true,
      active,
      tools_list_changed: false,
      reconnect_required: false,
      active_boundary_added: active.pack.name,
      ask_provider_session_retained: Boolean(retainedAsk),
      ask_conversation_cleared: Boolean(retainedAsk) && !askAuthorityRefreshPending,
      ask_authority_refresh_pending: askAuthorityRefreshPending,
      ...(retainedAsk ? { ask_configuration: retainedAsk } : {}),
      source_database_changed: false,
      message: askAuthorityRefreshPending
        ? "The reviewed boundary was added to local Explore access. The in-memory provider credential was retained; Ask will refresh reviewed authority before the next question."
        : "The reviewed boundary was added to local Explore access. Existing active boundaries and the in-memory Ask provider session remain available.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/boundary/preview") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Auto Boundary review is not enabled for this Workbench session." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for exploration-boundary preview." });
      return;
    }
    const body = await readJsonBody(request);
    if (!isRecord(body.candidate)
      || !Number.isSafeInteger(body.expected_revision)
      || typeof body.actor !== "string"
      || !Array.isArray(body.confirmed_decisions)
      || body.confirmed_decisions.some((decision) => typeof decision !== "string")) {
      throw new Error("Boundary preview requires the exact candidate, saved review revision, reviewer identity, and confirmed decisions.");
    }
    const actor = body.actor.trim();
    if (!actor || actor.length > 128 || /[\u0000-\u001f\u007f]/.test(actor)) {
      throw new Error("Enter who reviewed this access before creating the final fingerprint.");
    }
    const draft = JSON.parse(await fs.readFile(path.join(boundaryRoot, "exploration-boundary.draft.json"), "utf8")) as ExplorationBoundaryDraft;
    const progress = await readBoundaryReviewProgress(projectRoot, draft);
    const currentRevision = progress?.revision ?? 0;
    if (body.expected_revision !== currentRevision) {
      sendJson(response, 409, {
        ok: false,
        error_code: "BOUNDARY_REVIEW_STALE",
        error: "Saved review progress changed. Reload the current review before creating the final fingerprint.",
        current_revision: currentRevision,
        source_database_changed: false,
      });
      return;
    }
    const submittedCandidate = body.candidate as unknown as ExplorationBoundaryDraft;
    const reviewAuthority = await resolveSavedBoundaryReviewAuthority({
      projectRoot,
      draft,
      candidate: submittedCandidate,
      ...(progress ? { progress } : {}),
    });
    const reviewed = reviewExplorationBoundaryCandidate(
      reviewAuthority.reviewDraft,
      submittedCandidate,
    );
    if (!progress
      || explorationBoundaryCandidateDigest(progress.candidate) !== reviewed.digest) {
      sendJson(response, 409, {
        ok: false,
        error_code: "BOUNDARY_REVIEW_STALE",
        error: "The disabled candidate differs from saved review progress. Save or reload it before creating the final fingerprint.",
        source_database_changed: false,
      });
      return;
    }
    const confirmed = new Set(body.confirmed_decisions as string[]);
    if (reviewed.candidate.unresolved_decisions.some((decision) => !confirmed.has(decision))
      || confirmed.size !== reviewed.candidate.unresolved_decisions.length) {
      sendJson(response, 409, {
        ok: false,
        error_code: "BOUNDARY_REVIEW_INCOMPLETE",
        error: "Every current review decision must be confirmed before creating the final fingerprint.",
        source_database_changed: false,
      });
      return;
    }
    const inspection = await schemaInspector({
      engine: reviewAuthority.generationLock.engine,
      databaseUrlEnv: reviewAuthority.generationLock.source_env,
      schema: reviewAuthority.generationLock.inspected_schema,
      env: process.env,
    });
    assertCurrentExplorationBoundaryAuthority({
      lock: reviewAuthority.generationLock,
      inspection,
      candidate: reviewed.candidate,
    });
    bootstrapState.boundaryPreview = {
      digest: reviewed.digest,
      revision: currentRevision,
      actor,
      createdAtMs: bootstrapState.now(),
    };
    sendJson(response, 200, {
      ok: true,
      ...reviewed,
      review_revision: currentRevision,
      source_database_changed: false,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/protect") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Protect This Query is available only in an Auto Boundary authoring Workbench." });
      return;
    }
    try {
      const queries = await listProtectableQueries({ projectRoot });
      sendJson(response, 200, {
        ok: true,
        available: true,
        queries: queries.map(({ token, ...query }) => ({ ...query, query_ref: token })),
      });
    } catch (error) {
      if (isInactiveExplorationBoundary(error)) {
        sendJson(response, 200, {
          ok: true,
          available: false,
          queries: [],
          message: "Activate the reviewed exploration boundary before protecting a query.",
        });
        return;
      }
      throw error;
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/explore/history") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Explore history is available only in a local Auto Boundary Workbench." });
      return;
    }
    const requestedAuditId = url.searchParams.get("audit_id");
    if (requestedAuditId !== null) {
      const auditId = Number(requestedAuditId);
      if (!Number.isSafeInteger(auditId) || auditId < 1) {
        sendJson(response, 400, { ok: false, error: "Explore history requires a positive audit_id." });
        return;
      }
      const record = await storeAccess(
        "read",
        "workbench-explore-history-detail",
        (store) => store.getQueryAudit(auditId),
      );
      const payload = asRecord(record?.payload);
      if (!record || typeof payload.scoped_explore_version !== "string") {
        sendJson(response, 404, { ok: false, error: "That Explore audit record was not found." });
        return;
      }
      const reconstructedQuery = reconstructExploreAuditQuery({
        normalizedPlan: payload.normalized_plan,
        scopeApplication: payload.scope_application,
        tenantRecorded: typeof record.tenant_id === "string",
        principalRecorded: typeof record.principal === "string",
      });
      const attemptedAccess = asRecord(payload.attempted_access);
      sendJson(response, 200, {
        ok: true,
        ledger_source: ledgerSource,
        audit: {
          audit_id: auditId,
          created_at: String(record.created_at ?? payload.recorded_at ?? ""),
          resource: String(record.table_name ?? "app.explore_data"),
          status: String(payload.status ?? "recorded"),
          error_code: typeof payload.error_code === "string" ? payload.error_code : null,
          refusal_stage: typeof payload.refusal_stage === "string" ? payload.refusal_stage : null,
          attempted_access: typeof attemptedAccess.resource === "string"
            ? {
                resource: attemptedAccess.resource,
                field: typeof attemptedAccess.field === "string" ? attemptedAccess.field : null,
                operation: typeof attemptedAccess.operation === "string" ? attemptedAccess.operation : null,
              }
            : null,
          boundary_digest: typeof payload.boundary_digest === "string" ? payload.boundary_digest : null,
          generation_lock_fingerprint: typeof payload.generation_lock_fingerprint === "string" ? payload.generation_lock_fingerprint : null,
          role_posture_fingerprint: typeof payload.role_posture_fingerprint === "string" ? payload.role_posture_fingerprint : null,
          query_fingerprint: String(record.query_fingerprint ?? ""),
          result_fingerprint: typeof payload.result_fingerprint === "string" ? payload.result_fingerprint : null,
          evidence_bundle_id: typeof record.evidence_bundle_id === "string"
            ? record.evidence_bundle_id
            : null,
          tenant_scope_fingerprint: typeof record.tenant_id === "string" ? record.tenant_id : null,
          principal_scope_fingerprint: typeof record.principal === "string" ? record.principal : null,
          capability: typeof record.capability === "string"
            ? record.capability
            : typeof payload.capability === "string"
              ? payload.capability
              : null,
          normalized_plan: isRecord(payload.normalized_plan) ? payload.normalized_plan : null,
          returned_rows_or_groups: Number(payload.returned_rows_or_groups ?? record.row_count ?? 0),
          returned_cells: Number(payload.returned_cells ?? 0),
          suppressed_groups: Number(payload.suppressed_groups ?? 0),
          execution_duration_ms: Number.isFinite(Number(payload.execution_duration_ms))
            ? Number(payload.execution_duration_ms)
            : null,
          budget_reservation_id: typeof payload.budget_reservation_id === "string" ? payload.budget_reservation_id : null,
          differencing_family: typeof payload.differencing_family === "string" ? payload.differencing_family : null,
          differencing_variant: typeof payload.differencing_variant === "string" ? payload.differencing_variant : null,
          source_query_executed: payload.source_query_executed === true,
          result_values_persisted: payload.result_values_persisted === true,
          trusted_scope_values_persisted: payload.trusted_scope_values_persisted === true,
          raw_sql_included: payload.raw_sql_included === true,
          source_database_changed: payload.source_database_changed === true,
          reconstructed_query: reconstructedQuery ?? null,
        },
      });
      return;
    }
    let recent: Awaited<ReturnType<typeof listProtectableQueries>> = [];
    try {
      recent = await listProtectableQueries({ projectRoot });
    } catch (error) {
      if (!isInactiveExplorationBoundary(error)) throw error;
    }
    const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
      sendJson(response, 400, { ok: false, error: "Explore history limit must be an integer from 1 to 200." });
      return;
    }
    const requestedOffset = Number(url.searchParams.get("offset") ?? 0);
    if (!Number.isSafeInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > 10_000_000) {
      sendJson(response, 400, { ok: false, error: "Explore history offset must be an integer from 0 through 10000000." });
      return;
    }
    const filterArgs = ["--config", configPath, "--limit", String(requestedLimit)];
    const appendFilter = (parameter: string, flag = `--${parameter}`) => {
      const value = url.searchParams.get(parameter)?.trim();
      if (value) filterArgs.push(flag, value);
    };
    appendFilter("tenant");
    appendFilter("principal");
    appendFilter("resource");
    appendFilter("capability");
    appendFilter("boundary");
    appendFilter("outcome");
    appendFilter("search");
    appendFilter("since");
    appendFilter("to");
    let resolvedAuditFilters;
    try {
      resolvedAuditFilters = await resolveExploreLedgerFilters(
        filterArgs,
        queryAuditFiltersFromArgs(filterArgs),
      );
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const auditFilters: QueryAuditSearchFilters = {
      ...resolvedAuditFilters.filters,
      limit: requestedLimit + 1,
      offset: requestedOffset,
    };
    const durableRecords = await storeAccess(
      "read",
      "workbench-explore-history-list",
      (store) => store.listQueryAudit(auditFilters),
    );
    const hasOlderRecords = durableRecords.length > requestedLimit;
    const durable = durableRecords
      .slice(0, requestedLimit)
      .filter((record) => typeof asRecord(record.payload).scoped_explore_version === "string")
      .map((record) => {
        const payload = asRecord(record.payload);
        return {
          audit_id: Number(record.audit_id),
          created_at: String(record.created_at ?? payload.recorded_at ?? ""),
          resource: String(record.table_name ?? "app.explore_data"),
          description: describeExploreAuditPlan(payload.normalized_plan)
            ?? describeExploreAuditAttempt(payload.attempted_access)
            ?? `Reviewed Explore on ${String(record.table_name ?? "an unknown resource")}.`,
          status: String(payload.status ?? "recorded"),
          returned_rows_or_groups: Number(payload.returned_rows_or_groups ?? record.row_count ?? 0),
          suppressed_groups: Number(payload.suppressed_groups ?? 0),
          source_query_executed: payload.source_query_executed === true,
          evidence_bundle_id: typeof record.evidence_bundle_id === "string"
            ? record.evidence_bundle_id
            : null,
          error_code: typeof payload.error_code === "string" ? payload.error_code : null,
        };
      });
    sendJson(response, 200, {
      ok: true,
      ledger_source: ledgerSource,
      recent: recent.map(({ token, ...query }) => ({ ...query, query_ref: token })),
      durable,
      durable_limit: requestedLimit,
      durable_offset: requestedOffset,
      has_newer_records: requestedOffset > 0,
      has_older_records: hasOlderRecords,
      filters: {
        tenant: url.searchParams.has("tenant") ? "applied (value not echoed)" : null,
        principal: url.searchParams.has("principal") ? "applied (value not echoed)" : null,
        resource: url.searchParams.get("resource")?.trim() || null,
        capability: url.searchParams.get("capability")?.trim() || null,
        boundary: url.searchParams.get("boundary")?.trim() || null,
        outcome: url.searchParams.get("outcome")?.trim() || null,
        search: url.searchParams.get("search")?.trim() || null,
        from: auditFilters.from ?? null,
        to: auditFilters.to ?? null,
        limit: requestedLimit,
        offset: requestedOffset,
      },
      notices: resolvedAuditFilters.notes,
      persisted: {
        model_conversation: false,
        result_values: false,
        trusted_scope_values: false,
        raw_sql: false,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/explore/evidence") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Explore evidence is available only in a local Auto Boundary Workbench." });
      return;
    }
    const evidenceId = url.searchParams.get("evidence_id");
    if (evidenceId) {
      const evidence = await storeAccess(
        "read",
        "workbench-explore-evidence-detail",
        (store) => store.getEvidenceBundle(evidenceId),
      );
      if (!evidence || evidence.payload.schema_version !== "synapsor.analytics-evidence.v1") {
        sendJson(response, 404, { ok: false, error: "That Explore evidence bundle was not found in the configured ledger." });
        return;
      }
      const reconstructedQuery = reconstructExploreAuditQuery({
        normalizedPlan: evidence.payload.normalized_plan,
        scopeApplication: evidence.payload.scope_application,
        trustedScope: evidence.payload.trusted_scope,
        tenantRecorded: Boolean(evidence.tenant_id),
        principalRecorded: Boolean(evidence.principal),
      });
      sendJson(response, 200, {
        ok: true,
        ledger_source: ledgerSource,
        evidence: {
          evidence_bundle_id: evidence.evidence_bundle_id,
          created_at: evidence.created_at,
          tenant_scope_fingerprint: evidence.tenant_id,
          capability: evidence.capability ?? null,
          source_id: evidence.source_id ?? null,
          source_table: evidence.source_table ?? null,
          query_fingerprint: evidence.query_fingerprint ?? null,
          payload: evidence.payload,
          query_audit: evidence.query_audit,
          result_values_persisted: evidence.payload.result_values_persisted === true,
          reconstructed_query: reconstructedQuery ?? null,
        },
      });
      return;
    }
    const queryRef = url.searchParams.get("query_ref");
    if (!queryRef) {
      sendJson(response, 400, { ok: false, error: "Explore evidence requires an evidence_id or an active analysis query_ref." });
      return;
    }
    const query = (await listProtectableQueries({ projectRoot }))
      .find((candidate) => candidate.token === queryRef);
    if (!query) {
      sendJson(response, 404, { ok: false, error: "This Explore analysis is unavailable or expired." });
      return;
    }
    const inspection = await inspectCompiledExplorePlan({
      projectRoot,
      boundaryDigest: query.boundary_digest,
      plan: query.normalized_plan,
    });
    const includeSql = url.searchParams.get("include_sql") === "1";
    sendJson(response, 200, {
      ok: true,
      ledger_source: ledgerSource,
      analysis_reference: query.token,
      original_question: null,
      original_question_status: "The server does not persist host conversations. The current Workbench transcript may still show the question locally.",
      model_request: {
        tool: "app.explore_data",
        arguments: {
          boundary: inspection.boundary_name,
          plan: query.normalized_plan,
        },
      },
      runner_execution: {
        normalized_plan: redactPlanLiterals(query.normalized_plan),
        boundary_name: inspection.boundary_name,
        boundary_digest: inspection.boundary_digest,
        trusted_scope: inspection.trusted_scope,
        role_posture: inspection.role_posture,
        transaction: inspection.transaction,
      },
      runner_returned: {
        outcome: query.outcome ?? "ok",
        rows_or_groups: query.returned_rows_or_groups ?? null,
        cells: query.returned_cells ?? null,
        suppressed_groups: query.suppressed_groups ?? 0,
        evidence_bundle_id: query.evidence_bundle_id ?? null,
        query_audit_handle: query.query_audit_handle ?? null,
        source_database_changed: false,
      },
      ...(includeSql ? { compiled_statement: inspection } : {}),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/protect/draft") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Protected capability review is available only in an Auto Boundary authoring Workbench." });
      return;
    }
    const capabilityName = url.searchParams.get("capability_name");
    if (!capabilityName) {
      sendJson(response, 400, { ok: false, error: "Protected capability review requires a capability name." });
      return;
    }
    const draft = await loadProtectedQueryDraft({ projectRoot, capabilityName });
    const dslPath = path.resolve(projectRoot, draft.dsl_path);
    const relativeDslPath = path.relative(projectRoot, dslPath);
    if (relativeDslPath.startsWith("..") || path.isAbsolute(relativeDslPath)) {
      throw new Error("Protected capability DSL path escapes the current project.");
    }
    const dsl = await fs.readFile(dslPath, "utf8");
    bootstrapState.protectedQueryPreview = {
      capability: draft.capability,
      digest: draft.contract_digest,
      createdAtMs: bootstrapState.now(),
    };
    sendJson(response, 200, {
      ok: true,
      draft,
      dsl,
      source_database_changed: false,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/protect/draft") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Protect This Query is available only in an Auto Boundary authoring Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for Protect This Query." });
      return;
    }
    const body = await readJsonBody(request);
    if (typeof body.query_ref !== "string"
      || typeof body.capability_name !== "string"
      || typeof body.description !== "string"
      || typeof body.returns_hint !== "string") {
      throw new Error("Protect This Query requires query_ref, capability_name, description, and returns_hint.");
    }
    if (body.arguments !== undefined && !Array.isArray(body.arguments)) {
      throw new Error("Protect This Query arguments must be a reviewed array.");
    }
    const created = await createProtectedQueryDraft({
      projectRoot,
      token: body.query_ref,
      capabilityName: body.capability_name,
      description: body.description,
      returnsHint: body.returns_hint,
      arguments: (body.arguments ?? []) as ProtectArgumentSelection[],
      ...(body.minimum_cohort_confirmed === true
        ? { minimumCohortConfirmed: true as const }
        : typeof body.minimum_cohort_confirmation === "string"
          ? { minimumCohortConfirmation: body.minimum_cohort_confirmation }
          : {}),
      ...(typeof body.minimum_cohort_actor === "string"
        ? { minimumCohortActor: body.minimum_cohort_actor }
        : {}),
      inspectDatabaseFn: schemaInspector,
    });
    await recordWorkbenchAttention(storeAccess, {
      event_type: "capability.review_required",
      severity: "warning",
      environment: deploymentProfile ?? "unknown",
      capability: created.draft.capability,
      contract_digest: created.draft.contract_digest,
      attention_key: `capability-review:${created.draft.capability}:${created.draft.contract_digest}`,
      attention_required: true,
      immediate_default: false,
      summary: "Protected query capability requires human review",
      workbench_path: "/",
      details: {
        authority_type: "protected_named_read",
        source_database_changed: false,
      },
      source_event_key: `workbench-protected-review:${created.draft.capability}:${created.draft.contract_digest}`,
    });
    bootstrapState.protectedQueryPreview = {
      capability: created.draft.capability,
      digest: created.draft.contract_digest,
      createdAtMs: bootstrapState.now(),
    };
    sendJson(response, 200, {
      ok: true,
      draft: created.draft,
      dsl: created.dsl,
      contract: created.contract,
      tests: created.tests,
      source_database_changed: false,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/protect/activate") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Protect This Query is available only in an Auto Boundary authoring Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for protected-capability activation." });
      return;
    }
    const body = await readJsonBody(request);
    if (typeof body.capability_name !== "string" || typeof body.actor !== "string") {
      throw new Error("Protected-capability activation requires a capability name and operator identity.");
    }
    const preview = bootstrapState.protectedQueryPreview;
    const previewExpired = preview
      ? bootstrapState.now() - preview.createdAtMs > PROTECTED_QUERY_PREVIEW_TTL_MS
      : false;
    if (!preview || previewExpired || preview.capability !== body.capability_name) {
      bootstrapState.protectedQueryPreview = undefined;
      sendJson(response, 409, {
        ok: false,
        error_code: previewExpired ? "PROTECTED_PREVIEW_EXPIRED" : "PROTECTED_PREVIEW_REQUIRED",
        error: previewExpired
          ? "This capability review expired. Reload the capability and review it again before activating."
          : "Open and review this exact capability in the current Workbench session before activating it.",
        source_database_changed: false,
      });
      return;
    }
    const protectedDraft = await loadProtectedQueryDraft({
      projectRoot,
      capabilityName: body.capability_name,
    });
    if (protectedDraft.contract_digest !== preview.digest) {
      bootstrapState.protectedQueryPreview = undefined;
      sendJson(response, 409, {
        ok: false,
        error_code: "PROTECTED_PREVIEW_STALE",
        error: "This capability changed after review. Review the updated capability before activating it.",
        source_database_changed: false,
      });
      return;
    }
    if (protectedDraft.minimum_cohort_override && body.minimum_cohort_confirmed !== true) {
      sendJson(response, 409, {
        ok: false,
        error_code: "PROTECTED_COHORT_RECONFIRMATION_REQUIRED",
        error: "Confirm that this capability keeps the explicitly lowered small-group threshold before activation.",
        source_database_changed: false,
      });
      return;
    }
    const sourceExploreBoundary = await loadActivatedExplorationBoundary(projectRoot, {
      digest: protectedDraft.boundary_digest,
    });
    const previousExploreAuthority = activeBoundaryEventMetadata(sourceExploreBoundary);
    const active = await protectedQueryActivator({
      projectRoot,
      capabilityName: body.capability_name,
      expectedDigest: preview.digest,
      operatorConfirmed: true,
      actor: body.actor,
      ...(body.minimum_cohort_confirmed === true
        ? { minimumCohortConfirmed: true as const }
        : {}),
      configPath,
      disableExplore: body.disable_explore === true,
      prepareScopedExploreFn: (input) => prepareScopedExplore({
        ...input,
        inspectDatabaseFn: schemaInspector,
      }),
    });
    bootstrapState.protectedQueryPreview = undefined;
    await recordWorkbenchAttention(storeAccess, {
      event_type: "capability.activated",
      severity: "informational",
      environment: deploymentProfile ?? "unknown",
      capability: active.capability,
      contract_digest: active.contract_digest,
      attention_required: false,
      immediate_default: false,
      summary: "Protected named capability activated",
      workbench_path: "/",
      details: {
        authority_type: "protected_named_read",
        source_database_changed: false,
      },
      source_event_key: `workbench-protected-activated:${active.capability}:${active.contract_digest}`,
      now: active.activated_at,
    });
    if (active.exploration_disabled) {
      if (previousExploreAuthority) {
        await recordWorkbenchAttention(storeAccess, capabilityRevokedAttention({
          environment: deploymentProfile ?? "unknown",
          capability: "app.explore_data",
          digest: previousExploreAuthority.digest,
          occurredAt: active.activated_at,
          reasonCode: "protected_capability_activated",
          sourceEventKey: `workbench-boundary-revoked:protect:${previousExploreAuthority.digest}:${active.contract_digest}`,
        }));
      }
    }
    const remainingBoundaries = active.exploration_disabled
      ? await loadActivatedExplorationBoundaries(projectRoot).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      })
      : await loadActivatedExplorationBoundaries(projectRoot);
    let retainedAsk: Awaited<ReturnType<typeof rebindConfiguredWorkbenchAskSession>>;
    let askAuthorityRefreshPending = false;
    if (!active.exploration_disabled || remainingBoundaries.length > 0) {
      try {
        retainedAsk = await rebindConfiguredWorkbenchAskSession({
          askSession,
          askGatewayFactory,
          configPath,
          storePath,
          projectRoot,
          profile: deploymentProfile ?? sourceExploreBoundary.deployment_profile,
          env: { ...process.env, ...bootstrapState.trustedContext },
        });
        bootstrapState.askAuthorityRefreshPending = false;
      } catch {
        retainedAsk = askSession.status().configuration;
        askAuthorityRefreshPending = Boolean(retainedAsk);
        bootstrapState.askAuthorityRefreshPending = askAuthorityRefreshPending;
      }
    } else {
      retainedAsk = askSession.status().configuration;
    }
    await updateGuidedOnboardingState({
      projectRoot,
      status: "add_action",
      completedStep: "protected",
      authorityActive: true,
      recommendedNextAction: "Add a safe action.",
    }).catch(() => undefined);
    sendJson(response, 200, {
      ok: true,
      active,
      disabled_boundary: active.exploration_disabled
        ? sourceExploreBoundary.pack.name
        : null,
      remaining_boundaries: remainingBoundaries.map((boundary) => boundary.pack.name),
      tools_list_changed: active.exploration_disabled && remainingBoundaries.length === 0,
      reconnect_required: active.exploration_disabled && remainingBoundaries.length === 0,
      ask_provider_session_retained: Boolean(retainedAsk),
      ask_conversation_cleared: Boolean(retainedAsk)
        && !active.exploration_disabled
        && !askAuthorityRefreshPending,
      ask_authority_refresh_pending: askAuthorityRefreshPending,
      message: active.exploration_disabled && remainingBoundaries.length === 0
        ? "The protected named capability is active and Scoped Explore is disabled. Reconnect the production MCP client to load only reviewed named tools."
        : active.exploration_disabled
          ? `The protected named capability is active. Its source boundary ${sourceExploreBoundary.pack.name} is inactive. Remaining local Explore ${remainingBoundaries.length === 1 ? "boundary" : "boundaries"}: ${remainingBoundaries.map((boundary) => boundary.pack.name).join(", ")}.`
        : "The protected named capability is active. Scoped Explore remains an explicitly enabled local authoring surface.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/explore/disable") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Scoped Explore is not enabled for this Workbench session." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to disable Scoped Explore." });
      return;
    }
    const body = await readJsonBody(request);
    const boundaryName = typeof body.boundary_name === "string" && body.boundary_name.trim()
      ? body.boundary_name.trim()
      : undefined;
    const previousActiveBoundary = boundaryName
      ? await loadActivatedExplorationBoundary(projectRoot, { name: boundaryName })
      : await loadActivatedExplorationBoundary(projectRoot).catch(() => undefined);
    const previousActive = activeBoundaryEventMetadata(previousActiveBoundary);
    const disabled = await disableScopedExplore(projectRoot, boundaryName);
    if (disabled.disabled && previousActive) {
      await recordWorkbenchAttention(storeAccess, capabilityRevokedAttention({
        environment: deploymentProfile ?? "unknown",
        capability: "app.explore_data",
        digest: previousActive.digest,
        reasonCode: "operator_disabled",
        sourceEventKey: `workbench-boundary-revoked:disable:${previousActive.digest}`,
      }));
    }
    sendJson(response, 200, {
      ok: true,
      ...disabled,
      protected_capabilities_changed: false,
      message: disabled.remaining_boundaries.length
        ? `The selected boundary is inactive. ${disabled.remaining_boundaries.length} other reviewed boundary or boundaries remain active.`
        : "Scoped Explore is disabled. Existing protected named capabilities were not changed.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/explore/trusted-context") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Trusted authoring scope is available only in an Auto Boundary Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to bind trusted authoring scope." });
      return;
    }
    const body = await readJsonBody(request);
    const activeBoundaries = await loadActivatedExplorationBoundaries(projectRoot);
    const active = activeBoundaries.at(-1)!;
    if (active.trusted_context.provider !== "environment") {
      sendJson(response, 409, { ok: false, error: "Production HTTP claim scope cannot be changed in the local Workbench." });
      return;
    }
    const principalRequired = activeBoundaries.some((boundary) =>
      boundary.pack.resources.some((resource) => Boolean(resource.principal_key || resource.principal_scope)));
    const tenant = active.trusted_context.database_role_tenant
      ? undefined
      : trustedScopeValue(body.tenant, "tenant");
    const principal = principalRequired
      ? trustedScopeValue(body.principal, "principal")
      : undefined;
    bootstrapState.trustedContext = {
      ...(tenant ? { [active.trusted_context.tenant_env]: tenant } : {}),
      ...(principal ? { [active.trusted_context.principal_env]: principal } : {}),
    };
    sendJson(response, 200, {
      ok: true,
      configured: true,
      tenant_binding: active.trusted_context.database_role_tenant?.setting
        ?? active.trusted_context.tenant_env,
      principal_binding: principalRequired ? active.trusted_context.principal_env : null,
      persisted: false,
      source_database_changed: false,
      message: "Trusted scope is bound only in this secured local Workbench process and remains outside model arguments. Its raw column value enters model context only when that output was reviewed as Model + Runner.",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/explore/preflight") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Scoped Explore is available only in an Auto Boundary authoring Workbench." });
      return;
    }
    let runtime: WorkbenchScopedExploreRuntime | undefined;
    try {
      runtime = await scopedExploreRuntimeFactory({
        projectRoot,
        transport: "loopback_workbench",
        env: { ...process.env, ...bootstrapState.trustedContext },
      });
      const description = await describeWorkbenchExploreCatalog(runtime, false);
      const runtimeBoundaries = isBoundarySetRuntime(runtime)
        ? runtime.boundaries
        : [runtime.boundary];
      const principalRequired = runtimeBoundaries.some((boundary) =>
        boundary.pack.resources.some((resource) =>
          (typeof resource.principal_key === "string" && resource.principal_key.length > 0)
          || Boolean(resource.principal_scope)));
      if (runtime.boundary.trusted_context.provider !== "environment") {
        throw new Error("The local Workbench cannot bind production HTTP claim scope.");
      }
      const tenantScope = runtime.trusted_scope?.tenant ?? {
        source: "environment" as const,
        binding: runtime.boundary.trusted_context.tenant_env,
      };
      const principalScope = runtime.trusted_scope?.principal ?? {
        source: principalRequired ? "environment" as const : "not_required" as const,
        ...(principalRequired ? { binding: runtime.boundary.trusted_context.principal_env } : {}),
      };
      sendJson(response, 200, {
        ok: true,
        ready: true,
        checks: [
          { name: "Local authoring transport", ok: true, detail: "Secured loopback Workbench" },
          {
            name: runtimeBoundaries.length === 1 ? "Reviewed boundary" : "Reviewed boundaries",
            ok: true,
            detail: isBoundarySetRuntime(runtime)
              ? `${runtimeBoundaries.length} active; set ${runtime.active_boundary_set_digest}`
              : runtime.boundary.activation.digest,
          },
          { name: "Deployment profile", ok: true, detail: runtime.boundary.deployment_profile },
          { name: "Generation lock", ok: true, detail: runtime.boundary.generation_lock_fingerprint },
          { name: "Database role posture", ok: true, detail: "Verified read-only and rechecked" },
          {
            name: "Trusted scope",
            ok: true,
            detail: principalRequired
              ? `Tenant verified from ${trustedScopeLabel(tenantScope.source, tenantScope.binding)}; principal configured from ${principalScope.binding}`
              : `Tenant verified from ${trustedScopeLabel(tenantScope.source, tenantScope.binding)}; the active boundaries have no principal-scoped table`,
          },
        ],
        trusted_scope: {
          tenant: {
            required: true,
            source: tenantScope.source,
            binding: tenantScope.binding,
            configured: true,
          },
          principal: {
            required: principalRequired,
            source: principalScope.source,
            binding: principalScope.binding ?? null,
            configured: principalRequired,
          },
        },
        description,
        budgets: runtime.boundary.budgets,
        boundary_digest: runtime.boundary.activation.digest,
        ...(isBoundarySetRuntime(runtime)
          ? {
            active_boundary_set_digest: runtime.active_boundary_set_digest,
            active_boundary_digests: runtime.boundaries.map((boundary) => boundary.activation.digest),
          }
          : {}),
        source_database_changed: false,
      });
    } catch (error) {
      const remediation = scopedExploreRemediation(error);
      sendJson(response, 409, {
        ok: false,
        ready: false,
        error_code: error instanceof ScopedExploreError ? error.code : "EXPLORE_INTERNAL",
        error: error instanceof ScopedExploreError ? error.message : "Scoped Explore preflight failed safely.",
        ...(error instanceof ScopedExploreError && error.code === "EXPLORE_SCOPE_FORBIDDEN"
          ? { scope_requirements: error.details }
          : {}),
        remediation,
        source_database_changed: false,
      });
    } finally {
      await runtime?.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/explore/describe") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Scoped Explore is available only in an Auto Boundary authoring Workbench." });
      return;
    }
    let runtime: WorkbenchScopedExploreRuntime | undefined;
    try {
      runtime = await scopedExploreRuntimeFactory({
        projectRoot,
        transport: "loopback_workbench",
        env: { ...process.env, ...bootstrapState.trustedContext },
      });
      const resource = url.searchParams.get("resource")?.trim() || undefined;
      const boundary = url.searchParams.get("boundary")?.trim() || undefined;
      const cursorValue = url.searchParams.get("cursor");
      const limitValue = url.searchParams.get("limit");
      const description = await runtime.describe({
        ...(boundary && isBoundarySetRuntime(runtime) ? { boundary } : {}),
        ...(resource ? { resource } : {}),
        ...(cursorValue ? { cursor: Number(cursorValue) } : {}),
        ...(limitValue ? { limit: Number(limitValue) } : {}),
      });
      sendJson(response, 200, { ok: true, ...description });
    } catch (error) {
      const remediation = scopedExploreRemediation(error);
      sendJson(response, 409, {
        ok: false,
        error_code: error instanceof ScopedExploreError ? error.code : "EXPLORE_INTERNAL",
        error: error instanceof ScopedExploreError ? error.message : "Scoped Explore description failed safely.",
        remediation,
      });
    } finally {
      await runtime?.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/explore/run") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Scoped Explore is available only in an Auto Boundary authoring Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for Scoped Explore." });
      return;
    }
    const body = await readJsonBody(request);
    if (!isRecord(body.plan)) throw new Error("Scoped Explore requires one structured plan.");
    let runtime: WorkbenchScopedExploreRuntime | undefined;
    try {
      runtime = await scopedExploreRuntimeFactory({
        projectRoot,
        transport: "loopback_workbench",
        env: { ...process.env, ...bootstrapState.trustedContext },
      });
      const boundary = typeof body.boundary === "string" ? body.boundary.trim() : undefined;
      const result = withWorkbenchProtectQueryRef(await (
        isBoundarySetRuntime(runtime)
          ? runtime.explore(body.plan, boundary)
          : runtime.explore(body.plan)
      ));
      const aggregate = body.plan.kind === "aggregate";
      await updateGuidedOnboardingState({
        projectRoot,
        status: aggregate ? "protect" : "first_value",
        completedSteps: aggregate ? ["first_safe_read", "aggregate_complete"] : ["first_safe_read"],
        authorityActive: true,
        recommendedNextAction: aggregate
          ? "Ask another bounded question; protect an analysis only when it should become a reusable named capability."
          : "Ask another bounded question.",
      }).catch(() => undefined);
      sendJson(response, 200, {
        ok: true,
        result,
        plan: body.plan,
        source_database_changed: false,
        protected_artifact_created: false,
        next_action: "Ask another bounded question. Protect this analysis only if it should become a reusable named capability.",
      });
    } catch (error) {
      const remediation = scopedExploreRemediation(error);
      sendJson(response, 409, {
        ok: false,
        error_code: error instanceof ScopedExploreError ? error.code : "EXPLORE_INTERNAL",
        error: error instanceof ScopedExploreError ? error.message : "Scoped Explore refused the request.",
        ...(error instanceof ScopedExploreError && error.details ? { details: error.details } : {}),
        remediation,
        source_database_changed: false,
      });
    } finally {
      await runtime?.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/boundary/prove") {
    if (!boundaryRoot || !isLocalHost(workbenchHost)) {
      sendJson(response, 404, {
        ok: false,
        error: "Boundary proof is available only in the secured local authoring Workbench.",
      });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to prove this boundary." });
      return;
    }
    let gateway: AskToolGateway | undefined;
    try {
      const boundaries = await loadActivatedExplorationBoundaries(projectRoot);
      const draft = await fs.readFile(
        path.join(boundaryRoot, "exploration-boundary.draft.json"),
        "utf8",
      ).then((value) => JSON.parse(value) as ExplorationBoundaryDraft).catch(() => undefined);
      gateway = await askGatewayFactory({
        configPath,
        storePath,
        projectRoot,
        env: { ...process.env, ...bootstrapState.trustedContext },
        mode: "authoring",
      });
      const proof = await proveActiveExploreBoundaries({ gateway, boundaries, draft });
      const artifactPath = await writeBoundaryProofArtifact({ projectRoot, proof });
      sendJson(response, 200, {
        ok: true,
        proof,
        artifact_path: path.relative(projectRoot, artifactPath),
        model_can_run_proof: false,
        source_database_changed: false,
      });
    } catch (error) {
      sendJson(response, 409, {
        ok: false,
        error_code: error instanceof AskError ? error.code : "BOUNDARY_PROOF_UNAVAILABLE",
        error: error instanceof Error ? error.message : "Runner could not prove the active boundary.",
        source_database_changed: false,
      });
    } finally {
      await gateway?.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/mcp/install") {
    if (!boundaryRoot || !isLocalHost(workbenchHost)) {
      sendJson(response, 404, {
        ok: false,
        error: "Managed MCP setup is available only in the secured local authoring Workbench.",
      });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to install project MCP setup." });
      return;
    }
    let gateway: AskToolGateway | undefined;
    try {
      const body = await readJsonBody(request);
      const client = parseManagedMcpProjectClient(
        typeof body.client === "string" ? body.client : undefined,
      );
      gateway = await askGatewayFactory({
        configPath,
        storePath,
        projectRoot,
        env: { ...process.env, ...bootstrapState.trustedContext },
        mode: "authoring",
      });
      const tools = (await gateway.listTools()).map((tool) => tool.name).sort();
      if (tools.join("\n") !== ["app.describe_data", "app.explore_data"].sort().join("\n")) {
        throw new Error("Managed client setup refused because the live authoring tool boundary was not exactly the reviewed Explore pair.");
      }
      const installed = await installManagedMcpProject({
        client,
        projectRoot,
        configPath,
        storePath,
        authoring: true,
      });
      const definition = managedMcpProjectDefinition(client);
      const detectedCommand = await detectManagedMcpClientCommand(client);
      sendJson(response, 200, {
        ok: true,
        client,
        client_name: definition.displayName,
        action: installed.action,
        destination: path.relative(projectRoot, installed.paths.destination),
        backup: installed.backup ? path.relative(projectRoot, installed.backup) : null,
        tools,
        credentials_in_client_config: false,
        model_can_install: false,
        client_command_detected: Boolean(detectedCommand),
        client_command: detectedCommand ?? null,
        tool_boundary_verified: true,
        live_client_session_verified: false,
        connection_state: "configured_not_connected",
        transport_lifecycle: "client_started_stdio",
        reload_instruction: definition.reloadInstruction,
        source_database_changed: false,
      });
    } catch (error) {
      sendJson(response, 409, {
        ok: false,
        error_code: "MCP_PROJECT_INSTALL_REFUSED",
        error: error instanceof Error ? error.message : "Managed MCP setup was refused.",
        source_database_changed: false,
      });
    } finally {
      await gateway?.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/ask/status") {
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    const unavailable = askWorkbenchAccessFailure(profile, workbenchHost);
    if (unavailable) {
      sendJson(response, 404, {
        ok: false,
        available: false,
        error_code: "ASK_SURFACE_UNAVAILABLE",
        error: unavailable,
        source_database_changed: false,
      });
      return;
    }
    let gateway: AskToolGateway | undefined;
    try {
      const activeBoundaries = await loadActivatedExplorationBoundaries(projectRoot)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw error;
        });
      const boundaryCatalog = buildBoundaryCatalogModel(activeBoundaries);
      gateway = await askGatewayFactory({
        configPath,
        storePath,
        projectRoot,
        env: { ...process.env, ...bootstrapState.trustedContext },
      });
      const tools = await gateway.listTools();
      const authority = await workbenchAskAuthority({
        tools,
        configPath,
        projectRoot,
        profile,
        mode: askGatewayMode(gateway, tools),
      });
      const authorityDigest = authority.authority_digest;
      if (bootstrapState.askAuthorityRefreshPending && askSession.status().configuration) {
        askSession.rebindAuthority(authorityDigest);
        bootstrapState.askAuthorityRefreshPending = false;
      }
      const session = askSession.status();
      sendJson(response, 200, {
        ok: true,
        available: tools.length > 0,
        profile,
        mode: authority.mode,
        authority_digest: authorityDigest,
        tool_surface_digest: authority.tool_surface_digest,
        active_boundary_digest: authority.active_boundary_digest,
        active_boundary_set_digest: authority.active_boundary_set_digest,
        active_boundary_digests: authority.active_boundary_digests,
        boundary_catalog: boundaryCatalog,
        boundary_mermaid: renderBoundaryCatalogMermaid(boundaryCatalog),
        boundary_diagrams: buildBoundaryCatalogDiagramExports(boundaryCatalog),
        runtime_config_digest: authority.runtime_config_digest,
        authority_matches_consent: session.configuration?.authority_digest === authorityDigest,
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title ?? tool.name,
          description: tool.description,
          kind: tool.metadata?.["synapsor.kind"] ?? "reviewed_tool",
        })),
        credential_environment: {
          openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
          anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
        },
        session,
        direct_provider_egress: true,
        synapsor_relay: false,
        persisted_conversation: false,
        source_database_changed: false,
        next_action: session.configured
          ? "Ask one question through the reviewed tools."
          : "Choose a provider and acknowledge direct data egress.",
      });
    } catch (error) {
      sendAskFailure(response, error);
    } finally {
      await gateway?.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ask/configure") {
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    const unavailable = askWorkbenchAccessFailure(profile, workbenchHost);
    if (unavailable) {
      sendJson(response, 404, {
        ok: false,
        error_code: "ASK_SURFACE_UNAVAILABLE",
        error: unavailable,
        source_database_changed: false,
      });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error_code: "ASK_CSRF_REQUIRED", error: "CSRF token required for Ask configuration." });
      return;
    }
    const body = await readJsonBody(request);
    let gateway: AskToolGateway | undefined;
    try {
      gateway = await askGatewayFactory({
        configPath,
        storePath,
        projectRoot,
        env: { ...process.env, ...bootstrapState.trustedContext },
      });
      const tools = await gateway.listTools();
      if (tools.length === 0) throw new AskError("ASK_NO_ACTIVE_TOOLS", "Activate a reviewed tool before configuring Ask.", 409);
      const authorityDigest = (await workbenchAskAuthority({
        tools,
        configPath,
        projectRoot,
        profile,
        mode: askGatewayMode(gateway, tools),
      })).authority_digest;
      if (body.authority_digest !== authorityDigest) {
        throw new AskError("ASK_AUTHORITY_CHANGED", "The reviewed tool surface changed. Reload Ask before acknowledging egress.", 409);
      }
      const configuration = askSession.configure({
        provider: askProviderValue(body.provider),
        model: askStringValue(body.model),
        ...(body.base_url === undefined ? {} : { base_url: askStringValue(body.base_url) }),
        ...(body.api_key === undefined ? {} : { api_key: askStringValue(body.api_key) }),
        ...(body.api_key_env === undefined ? {} : { api_key_env: askStringValue(body.api_key_env) }),
        ...(body.request_timeout_seconds === undefined
          ? {}
          : { request_timeout_seconds: askNumberValue(body.request_timeout_seconds) }),
        ...(body.session_token_budget === undefined
          ? {}
          : { session_token_budget: askNumberValue(body.session_token_budget) }),
        ...(body.max_output_tokens === undefined
          ? {}
          : { max_output_tokens: askNumberValue(body.max_output_tokens) }),
        authority_digest: authorityDigest,
        egress_acknowledged: body.egress_acknowledged === true,
      }, process.env);
      bootstrapState.askAuthorityRefreshPending = false;
      sendJson(response, 200, {
        ok: true,
        configuration,
        egress_notice: `Reviewed model-visible data may be sent directly to ${askProviderDisplayName(configuration.provider)}. Synapsor does not receive it. Model-withheld values stay in the local Runner result, and kept-out fields remain unavailable.`,
        model_can_activate: false,
        model_can_approve: false,
        model_can_apply: false,
        source_database_changed: false,
        next_action: "Ask one bounded question.",
      });
    } catch (error) {
      sendAskFailure(response, error);
    } finally {
      await gateway?.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ask/limits") {
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    const unavailable = askWorkbenchAccessFailure(profile, workbenchHost);
    if (unavailable) {
      sendJson(response, 404, {
        ok: false,
        error_code: "ASK_SURFACE_UNAVAILABLE",
        error: unavailable,
        source_database_changed: false,
      });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, {
        ok: false,
        error_code: "ASK_CSRF_REQUIRED",
        error: "CSRF token required for Ask limit changes.",
      });
      return;
    }
    const body = await readJsonBody(request);
    try {
      const status = askSession.updateTokenLimits({
        ...(body.session_token_budget === undefined
          ? {}
          : { session_token_budget: askNumberValue(body.session_token_budget) }),
        ...(body.max_output_tokens === undefined
          ? {}
          : {
              max_output_tokens: body.max_output_tokens === null
                ? null
                : askNumberValue(body.max_output_tokens),
            }),
      });
      sendJson(response, 200, {
        ok: true,
        session: status,
        source_database_changed: false,
        next_action: "Continue the same Ask conversation with the updated client-side limits.",
      });
    } catch (error) {
      sendAskFailure(response, error);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ask/run") {
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    const unavailable = askWorkbenchAccessFailure(profile, workbenchHost);
    if (unavailable) {
      sendJson(response, 404, {
        ok: false,
        error_code: "ASK_SURFACE_UNAVAILABLE",
        error: unavailable,
        source_database_changed: false,
      });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error_code: "ASK_CSRF_REQUIRED", error: "CSRF token required for Ask." });
      return;
    }
    const body = await readJsonBody(request);
    let gateway: AskToolGateway | undefined;
    try {
      gateway = await askGatewayFactory({
        configPath,
        storePath,
        projectRoot,
        env: { ...process.env, ...bootstrapState.trustedContext },
      });
      const tools = await gateway.listTools();
      const mode = askGatewayMode(gateway, tools);
      const authorityDigest = (await workbenchAskAuthority({
        tools,
        configPath,
        projectRoot,
        profile,
        mode,
      })).authority_digest;
      if (bootstrapState.askAuthorityRefreshPending) {
        askSession.rebindAuthority(authorityDigest);
        bootstrapState.askAuthorityRefreshPending = false;
      }
      const question = askStringValue(body.question);
      const result = await askSession.run(
        question,
        gateway,
        askProviderDependencies,
        authorityDigest,
        async () => revalidateWorkbenchAskAuthority({
          askGatewayFactory,
          configPath,
          storePath,
          projectRoot,
          profile,
          mode,
          env: { ...process.env, ...bootstrapState.trustedContext },
        }),
      );
      gateway = undefined;
      const completedDataPlan = result.tool_calls.some((call) =>
        call.tool === "app.explore_data"
        && call.status === "ok"
        && call.result.ok !== false);
      const accessGuidance = completedDataPlan
        ? undefined
        : await resolveAskAccessGuidance({
            projectRoot,
            question,
            toolCalls: result.tool_calls,
          }).catch(() => undefined);
      const displayAnswer = modelAnswerForDisplay(
        result.answer,
        collectAnalyticsAnalyses(result.tool_calls),
        accessGuidance,
      );
      sendJson(response, 200, {
        ...withWorkbenchAskQueryRefs(result),
        display_answer: displayAnswer,
        display_answer_source: accessGuidance && !completedDataPlan
          ? "runner"
          : result.answer_source,
        ...(accessGuidance ? { access_guidance: accessGuidance } : {}),
        model_can_activate: false,
        model_can_approve: false,
        model_can_apply: false,
        next_action: result.tool_calls.some((call) => workbenchAskProposalId(call.result))
          ? "Review the proposal through the separate operator workflow."
          : "Ask another question, protect a useful analysis, or clear this in-memory session.",
      });
    } catch (error) {
      sendAskFailure(response, error);
    } finally {
      await gateway?.close().catch(() => undefined);
    }
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ask/cancel") {
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    const unavailable = askWorkbenchAccessFailure(profile, workbenchHost);
    if (unavailable) {
      sendJson(response, 404, { ok: false, error_code: "ASK_SURFACE_UNAVAILABLE", error: unavailable });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error_code: "ASK_CSRF_REQUIRED", error: "CSRF token required for Ask cancellation." });
      return;
    }
    const cancelled = askSession.cancel();
    sendJson(response, 200, {
      ok: true,
      cancelled,
      source_database_changed: false,
      next_action: cancelled ? "The provider request was cancelled." : "No Ask request is running.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/ask/clear") {
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    const unavailable = askWorkbenchAccessFailure(profile, workbenchHost);
    if (unavailable) {
      sendJson(response, 404, { ok: false, error_code: "ASK_SURFACE_UNAVAILABLE", error: unavailable });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error_code: "ASK_CSRF_REQUIRED", error: "CSRF token required for clearing Ask." });
      return;
    }
    askSession.clear();
    bootstrapState.askAuthorityRefreshPending = false;
    sendJson(response, 200, {
      ok: true,
      cleared: true,
      provider_key_retained: false,
      conversation_retained: false,
      source_database_changed: false,
      next_action: "Configure a provider again, use the no-model composer, or connect an external MCP client.",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/summary") {
    const config = await readResolvedRunnerConfig(configPath);
    sendJson(response, 200, buildSummary(config, configPath, storePath));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools") {
    const config = await readResolvedRunnerConfig(configPath);
    sendJson(response, 200, buildTools(config));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/workbench") {
    const config = await readResolvedRunnerConfig(configPath);
    const manifest = await readOnboardingManifest(configPath);
    const cursorState = await cursorProjectStatus(path.dirname(configPath)).then((status) => status.state).catch(() => "tampered" as const);
    const activity = await storeAccess("read", "workbench-activity", (store) => ({
      proposals: store.listProposals(),
      queryAuditCount: store.listQueryAudit().length,
    }));
    const actionStatus = await safeActionStatus(projectRoot);
    sendJson(response, 200, buildWorkbench(config, manifest, cursorState, activity.proposals, activity.queryAuditCount, actionStatus));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/actions/guided") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Guided action authoring is available only in an Auto Boundary Workbench." });
      return;
    }
    const inspection = await inspectGuidedProject(projectRoot, schemaInspector);
    sendJson(response, 200, {
      ok: true,
      options: await guidedActionOptions({ projectRoot, inspection }),
      status: await guidedActionStatus(projectRoot),
      source_database_changed: false,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/actions/guided/draft") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Guided action authoring is available only in an Auto Boundary Workbench." });
      return;
    }
    const capabilityName = url.searchParams.get("capability")?.trim();
    if (!capabilityName) throw new Error("Guided action draft lookup requires a capability.");
    sendJson(response, 200, {
      ok: true,
      ...(await guidedActionDraftDetails(projectRoot, capabilityName)),
      source_database_changed: false,
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/actions/guided/draft") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Guided action authoring is available only in an Auto Boundary Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to create a guided action draft." });
      return;
    }
    const body = await readJsonBody(request);
    if (!isRecord(body.action)) throw new Error("Guided action authoring requires one reviewed action object.");
    const inspection = await inspectGuidedProject(projectRoot, schemaInspector);
    const created = await createGuidedActionDraft({
      projectRoot,
      action: body.action as GuidedActionInput,
      inspection,
    });
    await recordWorkbenchAttention(storeAccess, {
      event_type: "capability.review_required",
      severity: "warning",
      environment: deploymentProfile ?? "unknown",
      capability: created.draft.capability,
      contract_digest: created.draft.contract_digest,
      attention_key: `capability-review:${created.draft.capability}:${created.draft.contract_digest}`,
      attention_required: true,
      immediate_default: false,
      summary: "Guided action capability requires human review",
      workbench_path: "/",
      details: {
        authority_type: "guided_action",
        source_database_changed: false,
      },
      source_event_key: `workbench-guided-action-review:${created.draft.capability}:${created.draft.contract_digest}`,
      now: created.draft.created_at,
    });
    await updateGuidedOnboardingState({
      projectRoot,
      status: "add_action",
      completedStep: "action_drafted",
      authorityActive: true,
      recommendedNextAction: "Preview the exact staging proposal. The source database will remain unchanged.",
    }).catch(() => undefined);
    sendJson(response, 200, {
      ok: true,
      draft: created.draft,
      dsl: created.dsl,
      contract: created.contract,
      tests: created.tests,
      preview_args: created.preview_args,
      source_database_changed: false,
      message: "Disabled action draft created. No model-facing authority was activated.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/actions/guided/preview") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Guided action preview is available only in an Auto Boundary Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to preview a guided action." });
      return;
    }
    const body = await readJsonBody(request);
    if (typeof body.capability_name !== "string" || !isRecord(body.args)) {
      throw new Error("Guided action preview requires capability_name and exact proposal arguments.");
    }
    const preview = await guidedActionPreview({
      projectRoot,
      configPath,
      storePath,
      capabilityName: body.capability_name,
      args: body.args,
      env: { ...process.env, ...bootstrapState.trustedContext },
    });
    const draft = await recordGuidedActionPreview({
      projectRoot,
      capabilityName: body.capability_name,
      contractDigest: preview.draft_digest,
      proposalId: preview.proposal_id,
      proposalHash: preview.proposal_hash,
      sourceDatabaseChanged: preview.source_database_changed,
    });
    await updateGuidedOnboardingState({
      projectRoot,
      status: "proposal_ready",
      completedStep: "proposal_created",
      authorityActive: true,
      recommendedNextAction: "Review and activate this exact action digest.",
    }).catch(() => undefined);
    sendJson(response, 200, {
      ok: true,
      preview: draft.effect_preview,
      source_database_changed: false,
      model_can_approve: false,
      model_can_apply: false,
      message: "Proposal created. Source database changed: no. The model cannot approve or apply this proposal.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/actions/guided/activate") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Guided action activation is available only in an Auto Boundary Workbench." });
      return;
    }
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required to activate a guided action." });
      return;
    }
    if (await cloudLinkedGovernance(configPath)) {
      sendJson(response, 403, { ok: false, error: "Cloud-linked contract activation must use the governed Cloud contract-version workflow." });
      return;
    }
    const body = await readJsonBody(request);
    if (typeof body.capability_name !== "string"
      || typeof body.expected_digest !== "string"
      || typeof body.confirmation !== "string"
      || typeof body.actor !== "string") {
      throw new Error("Guided action activation requires capability_name, expected_digest, confirmation, and actor.");
    }
    const inspection = await inspectGuidedProject(projectRoot, schemaInspector);
    const active = await activateGuidedAction({
      projectRoot,
      capabilityName: body.capability_name,
      expectedDigest: body.expected_digest,
      confirmation: body.confirmation,
      actor: body.actor,
      inspection,
      configPath,
    });
    await recordWorkbenchAttention(storeAccess, {
      event_type: "capability.activated",
      severity: "informational",
      environment: deploymentProfile ?? "unknown",
      capability: active.capability,
      contract_digest: active.contract_digest,
      attention_required: false,
      immediate_default: false,
      summary: "Reviewed guided action capability activated",
      workbench_path: "/",
      details: {
        authority_type: "guided_action",
        source_database_changed: false,
      },
      source_event_key: `workbench-guided-action-activated:${active.capability}:${active.contract_digest}`,
      now: active.activated_at,
    });
    sendJson(response, 200, {
      ok: true,
      active,
      tools_list_changed: true,
      reconnect_required: true,
      source_database_changed: false,
      message: "The reviewed action is active. Its model-facing call creates a proposal only; approval and apply remain outside MCP.",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/actions/preview") {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for Safe Action preview" });
      return;
    }
    const body = await readJsonBody(request);
    if (!isRecord(body.args)) throw new Error("Safe Action preview requires an args object");
    const preview = await safeActionPreview({ projectRoot, configPath, storePath, args: body.args });
    const manifest = await recordSafeActionEffectPreview({
      projectRoot,
      draftDigest: preview.draft_digest,
      proposalId: preview.proposal_id,
      proposalHash: preview.proposal_hash,
      sourceDatabaseChanged: preview.source_database_changed,
    });
    sendJson(response, 200, { ok: true, preview: manifest.effect_preview, source_database_changed: false });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/actions/activate") {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for Safe Action activation" });
      return;
    }
    if (await cloudLinkedGovernance(configPath)) {
      sendJson(response, 403, { ok: false, error: "Cloud-linked contract activation must use the governed Cloud contract-version workflow." });
      return;
    }
    const body = await readJsonBody(request);
    if (typeof body.expected_digest !== "string" || typeof body.confirmation !== "string") throw new Error("Safe Action activation requires expected_digest and confirmation");
    const active = await activateSafeActionDraft({
      projectRoot,
      configPath,
      expectedDigest: body.expected_digest,
      confirmation: body.confirmation,
    });
    sendJson(response, 200, {
      ok: true,
      active,
      tools_list_changed: false,
      reconnect_required: true,
      message: "The immutable contract is active. Restart or reconnect the MCP client so it reloads the reviewed tool list.",
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/attention") {
    const scopeFailure = workbenchLedgerScopeFailure(ledgerScope);
    if (scopeFailure) {
      sendJson(response, 403, {
        ok: false,
        error: scopeFailure,
        source_database_changed: false,
        next_action: "Bind this Workbench to a verified tenant scope before inspecting shared attention.",
      });
      return;
    }
    try {
      const filters = workbenchAttentionFilters(url, ledgerScope);
      await storeAccess("read", "attention-list", (store) => {
        const items = store.listAttentionItems(filters);
        sendJson(response, 200, {
          ok: true,
          attention: items.map((item) => workbenchAttentionProjection(
            item,
            store.getAttentionEvent(item.latest_event_id),
          )),
          source_database_changed: false,
        });
      });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        source_database_changed: false,
      });
    }
    return;
  }

  const attentionDetailMatch = url.pathname.match(/^\/api\/attention\/([^/]+)$/);
  if (request.method === "GET" && attentionDetailMatch) {
    const scopeFailure = workbenchLedgerScopeFailure(ledgerScope);
    if (scopeFailure) {
      sendJson(response, 403, {
        ok: false,
        error: scopeFailure,
        source_database_changed: false,
        next_action: "Bind this Workbench to a verified tenant scope before inspecting shared attention.",
      });
      return;
    }
    const attentionId = decodeURIComponent(attentionDetailMatch[1] ?? "");
    await storeAccess("read", "attention-show", (store) => {
      const item = scopedWorkbenchAttentionItem(store, attentionId, ledgerScope);
      if (!item) {
        sendJson(response, 404, { ok: false, error: "attention item not found", source_database_changed: false });
        return;
      }
      const latestEvent = store.getAttentionEvent(item.latest_event_id);
      const proposal = latestEvent?.proposal_id ? store.getProposal(latestEvent.proposal_id) : undefined;
      sendJson(response, 200, {
        ok: true,
        attention: workbenchAttentionProjection(item, latestEvent),
        proposal: proposal && proposalMatchesWorkbenchScope(proposal, ledgerScope)
          ? summarizeProposal(proposal)
          : null,
        acknowledgement_is_approval: false,
        source_database_changed: latestEvent?.details.source_database_changed === true,
      });
    });
    return;
  }

  const attentionAcknowledgeMatch = url.pathname.match(/^\/api\/attention\/([^/]+)\/acknowledge$/);
  if (request.method === "POST" && attentionAcknowledgeMatch) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for attention acknowledgement" });
      return;
    }
    const scopeFailure = workbenchLedgerScopeFailure(ledgerScope);
    if (scopeFailure) {
      sendJson(response, 403, {
        ok: false,
        error: scopeFailure,
        source_database_changed: false,
      });
      return;
    }
    const attentionId = decodeURIComponent(attentionAcknowledgeMatch[1] ?? "");
    const body = await readJsonBody(request);
    const item = await storeAccess("read", "attention-acknowledge-scope", (store) =>
      scopedWorkbenchAttentionItem(store, attentionId, ledgerScope));
    if (!item) {
      sendJson(response, 404, { ok: false, error: "attention item not found", source_database_changed: false });
      return;
    }
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    if (profile === "production" || profile === "unknown") {
      if (!attentionAcknowledge) {
        sendJson(response, 403, {
          ok: false,
          error: `Attention acknowledgement in ${profile} requires the configured verified operator identity path.`,
          source_database_changed: false,
          next_action: "Authenticate with the configured operator identity, then acknowledge this item again.",
        });
        return;
      }
      try {
        const result = await attentionAcknowledge({
          attentionId,
          actor: stringValueOrUndefined(body.actor),
          identityToken: workbenchIdentityToken(body.identity_token),
        });
        if (result.code !== 0) {
          sendJson(response, 409, {
            ok: false,
            error: "Attention acknowledgement did not complete.",
            source_database_changed: false,
          });
          return;
        }
      } catch (error) {
        sendJson(response, 403, workbenchDecisionFailure(error, "attention acknowledgement"));
        return;
      }
    } else {
      await storeAccess("write", "attention-acknowledge", (store) => {
        store.acknowledgeAttention({
          attention_id: attentionId,
          actor: stringOrDefault(body.actor, "local_operator"),
        });
      });
    }
    await storeAccess("read", "attention-acknowledge-result", (store) => {
      const acknowledged = scopedWorkbenchAttentionItem(store, attentionId, ledgerScope);
      sendJson(response, 200, {
        ok: true,
        attention: acknowledged
          ? workbenchAttentionProjection(acknowledged, store.getAttentionEvent(acknowledged.latest_event_id))
          : null,
        approval_created: false,
        source_database_changed: false,
      });
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/notifications/status") {
    const scopeFailure = workbenchLedgerScopeFailure(ledgerScope);
    if (scopeFailure) {
      sendJson(response, 403, { ok: false, error: scopeFailure, source_database_changed: false });
      return;
    }
    const config = await readResolvedRunnerConfig(configPath);
    const notifications = asRecord(config.notifications);
    const configuredSinks = Array.isArray(notifications.sinks) ? notifications.sinks.map(asRecord) : [];
    await storeAccess("read", "notifications-status", (store) => {
      const scopedEventIds = new Set(store.listAttentionEvents({
        ...(ledgerScope?.tenant ? { tenant: ledgerScope.tenant } : {}),
        ...(ledgerScope?.principal ? { principal: ledgerScope.principal } : {}),
        limit: 1_000,
      }).map((event) => event.event_id));
      const deliveries = store.listNotificationDeliveries({ limit: 1_000 })
        .filter((delivery) => !ledgerScope?.required || scopedEventIds.has(delivery.event_id));
      sendJson(response, 200, {
        ok: true,
        enabled: notifications.enabled === true,
        sinks: configuredSinks.map((sink) => ({
          id: sink.id,
          type: sink.type,
          enabled: notifications.enabled === true && sink.enabled !== false,
          minimum_severity: sink.minimum_severity ?? "warning",
          delivery: sink.delivery ?? "immediate",
          counts: workbenchNotificationCounts(deliveries.filter((delivery) => delivery.sink_id === sink.id)),
        })),
        source_database_changed: false,
      });
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/worker") {
    const scopeFailure = workbenchLedgerScopeFailure(ledgerScope);
    if (scopeFailure) {
      sendJson(response, 403, { ok: false, error: scopeFailure, source_database_changed: false });
      return;
    }
    const config = await readResolvedRunnerConfig(configPath);
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    const operator = await workbenchOperatorPosture(configPath);
    await storeAccess("read", "worker-status", (store) => {
      sendJson(response, 200, {
        ok: true,
        worker: workbenchWorkerProjection(store, config, profile, configPath, ledgerScope),
        operator,
        source_database_changed: false,
      });
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/worker/control") {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for supervised-worker controls." });
      return;
    }
    const body = await readJsonBody(request);
    const action = String(body.action ?? "") as WorkerControlAction;
    if (!workbenchWorkerControlActions.has(action)) {
      sendJson(response, 400, { ok: false, error: "Unsupported supervised-worker control action." });
      return;
    }
    const capability = stringValueOrUndefined(body.capability);
    const digest = stringValueOrUndefined(body.contract_digest);
    const exactDigest = digest && /^sha256:[a-f0-9]{64}$/.test(digest)
      ? digest as `sha256:${string}`
      : undefined;
    const capabilityAction = action === "capability_enable"
      || action === "capability_disable"
      || action === "digest_revoke";
    if (capabilityAction && (!capability || !exactDigest)) {
      sendJson(response, 400, {
        ok: false,
        error: "Per-capability worker control requires one configured capability and exact sha256 digest.",
      });
      return;
    }
    const expectedConfirmation = workbenchWorkerConfirmation({
      action,
      capability,
      contractDigest: exactDigest,
    });
    if (body.confirm !== expectedConfirmation) {
      sendJson(response, 409, {
        ok: false,
        error: "Worker control confirmation does not match the exact target.",
        required_confirmation: expectedConfirmation,
        source_database_changed: false,
      });
      return;
    }
    const config = await readResolvedRunnerConfig(configPath);
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    const workerConfig = asRecord(config.supervised_worker);
    const workerPolicies = Array.isArray(workerConfig.capabilities)
      ? workerConfig.capabilities.map(asRecord)
      : [];
    if (capabilityAction && !workerPolicies.some((policy) =>
      policy.capability === capability && policy.contract_digest === exactDigest)) {
      sendJson(response, 409, {
        ok: false,
        error: "The exact capability/digest is not present in the deployment worker allowlist.",
        source_database_changed: false,
      });
      return;
    }
    try {
      if (workerDecision) {
        const result = await workerDecision({
          action,
          capability,
          contractDigest: exactDigest,
          actor: stringValueOrUndefined(body.actor),
          reason: stringValueOrUndefined(body.reason),
          identityToken: workbenchIdentityToken(body.identity_token),
        });
        if (result.code !== 0) throw new Error("The trusted worker control did not complete.");
      } else {
        if (profile !== "development" && profile !== "staging") {
          throw new Error(`Worker control in ${profile} requires the configured verified operator path.`);
        }
        const operatorConfig = asRecord(config.operator_identity);
        if (operatorConfig.provider === "signed_key" || operatorConfig.provider === "jwt_oidc") {
          throw new Error("This Workbench process has no verified operator decision callback.");
        }
        await storeAccess("write", "worker-control", (store) => {
          store.updateWorkerControl({
            action,
            ...(capability ? { capability } : {}),
            ...(exactDigest ? { contract_digest: exactDigest } : {}),
            actor: stringOrDefault(body.actor, "local_operator"),
            environment: profile,
          });
        });
      }
    } catch (error) {
      sendJson(response, 403, workbenchDecisionFailure(error, "worker control"));
      return;
    }
    await storeAccess("read", "worker-control-result", (store) => {
      sendJson(response, 200, {
        ok: true,
        worker: workbenchWorkerProjection(store, config, profile, configPath, ledgerScope),
        source_database_changed: false,
        queued_proposals_discarded: 0,
      });
    });
    return;
  }

  const workerQueueActionMatch = url.pathname.match(/^\/api\/worker\/queue\/([^/]+)\/(cancel|requeue|discard)$/);
  if (request.method === "POST" && workerQueueActionMatch) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for worker queue recovery." });
      return;
    }
    const proposalId = decodeURIComponent(workerQueueActionMatch[1] ?? "");
    const routeAction = workerQueueActionMatch[2] as "cancel" | "requeue" | "discard";
    const body = await readJsonBody(request);
    const expectedConfirmation = `${routeAction.toUpperCase()} ${proposalId}`;
    if (body.confirm !== expectedConfirmation) {
      sendJson(response, 409, {
        ok: false,
        error: "Queue control confirmation does not match the exact proposal.",
        required_confirmation: expectedConfirmation,
        source_database_changed: false,
      });
      return;
    }
    const proposal = await storeAccess("read", "worker-queue-scope", (store) => store.getProposal(proposalId));
    if (!proposal || !proposalMatchesWorkbenchScope(proposal, ledgerScope)) {
      sendJson(response, 404, { ok: false, error: "worker queue item not found", source_database_changed: false });
      return;
    }
    if (!workerDecision) {
      sendJson(response, 403, {
        ok: false,
        error: "This queue action requires the configured trusted operator path.",
        next_action: "Use the exact trusted CLI command shown in the worker console.",
        source_database_changed: false,
      });
      return;
    }
    try {
      const result = await workerDecision({
        action: routeAction === "cancel"
          ? "cancel"
          : routeAction === "requeue"
            ? "dead_letter_requeue"
            : "dead_letter_discard",
        proposalId,
        retryBudget: routeAction === "requeue"
          ? boundedWorkbenchInteger(body.retry_budget, 3, 1, 100)
          : undefined,
        actor: stringValueOrUndefined(body.actor),
        reason: stringValueOrUndefined(body.reason),
        identityToken: workbenchIdentityToken(body.identity_token),
      });
      if (result.code !== 0) throw new Error("The trusted queue action did not complete.");
    } catch (error) {
      sendJson(response, 403, workbenchDecisionFailure(error, "worker queue action"));
      return;
    }
    const config = await readResolvedRunnerConfig(configPath);
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    await storeAccess("read", "worker-queue-result", (store) => {
      sendJson(response, 200, {
        ok: true,
        worker: workbenchWorkerProjection(store, config, profile, configPath, ledgerScope),
        source_database_changed: false,
      });
    });
    return;
  }

  const workerReconciliationMatch = url.pathname.match(/^\/api\/worker\/reconciliation\/([^/]+)(?:\/resolve)?$/);
  if (request.method === "GET" && workerReconciliationMatch && !url.pathname.endsWith("/resolve")) {
    const scopeFailure = workbenchLedgerScopeFailure(ledgerScope);
    if (scopeFailure) {
      sendJson(response, 403, { ok: false, error: scopeFailure, source_database_changed: false });
      return;
    }
    const intentId = decodeURIComponent(workerReconciliationMatch[1] ?? "");
    const authority = await storeAccess("read", "worker-reconciliation-scope", (store) => {
      const intent = store.getWritebackIntent(intentId);
      if (!intent) return undefined;
      const proposal = store.getProposal(intent.proposal_id);
      if (!proposal || !proposalMatchesWorkbenchScope(proposal, ledgerScope)) return undefined;
      return { intent, proposal };
    });
    if (!authority) {
      sendJson(response, 404, { ok: false, error: "writeback reconciliation item not found", source_database_changed: false });
      return;
    }
    if (!workerReconciliationInspect) {
      sendJson(response, 403, {
        ok: false,
        error: "Live reconciliation inspection requires the configured trusted Runner path.",
        next_action: `Run synapsor-runner writeback reconcile inspect ${intentId} with the active project configuration.`,
        source_database_changed: false,
      });
      return;
    }
    try {
      const inspection = await workerReconciliationInspect({ intentId });
      if (inspection.intent_id !== authority.intent.intent_id
        || inspection.proposal_id !== authority.proposal.proposal_id) {
        throw new Error("trusted reconciliation inspection returned a different authority target");
      }
      sendJson(response, 200, {
        ok: true,
        reconciliation: inspection,
        required_confirmation: `RECONCILE ${intentId} AS ${inspection.supported_outcome.toUpperCase()}`,
        source_database_changed: false,
      });
    } catch {
      sendJson(response, 409, {
        ok: false,
        error: "Live reconciliation inspection failed safely. No outcome was selected and no source row changed.",
        next_action: `Inspect ${intentId} from the trusted CLI and resolve the database or credential condition before retrying.`,
        source_database_changed: false,
      });
    }
    return;
  }

  if (request.method === "POST" && workerReconciliationMatch && url.pathname.endsWith("/resolve")) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for writeback reconciliation." });
      return;
    }
    const intentId = decodeURIComponent(workerReconciliationMatch[1] ?? "");
    const body = await readJsonBody(request);
    const outcome = stringValueOrUndefined(body.outcome) as "applied" | "conflict" | "failed" | undefined;
    if (!outcome || !["applied", "conflict", "failed"].includes(outcome)) {
      sendJson(response, 400, {
        ok: false,
        error: "Reconciliation outcome must be applied, conflict, or failed.",
        source_database_changed: false,
      });
      return;
    }
    const reason = stringValueOrUndefined(body.reason);
    if (!reason) {
      sendJson(response, 400, {
        ok: false,
        error: "Reconciliation requires an operator reason.",
        source_database_changed: false,
      });
      return;
    }
    const expectedConfirmation = `RECONCILE ${intentId} AS ${outcome.toUpperCase()}`;
    if (body.confirm !== expectedConfirmation) {
      sendJson(response, 409, {
        ok: false,
        error: "Reconciliation confirmation does not match the exact intent and supported outcome.",
        required_confirmation: expectedConfirmation,
        source_database_changed: false,
      });
      return;
    }
    const authority = await storeAccess("read", "worker-reconciliation-resolve-scope", (store) => {
      const intent = store.getWritebackIntent(intentId);
      if (!intent) return undefined;
      const proposal = store.getProposal(intent.proposal_id);
      if (!proposal || !proposalMatchesWorkbenchScope(proposal, ledgerScope)) return undefined;
      return { intent, proposal };
    });
    if (!authority) {
      sendJson(response, 404, { ok: false, error: "writeback reconciliation item not found", source_database_changed: false });
      return;
    }
    if (!workerReconciliationResolve) {
      sendJson(response, 403, {
        ok: false,
        error: "Reconciliation requires the configured trusted operator path.",
        next_action: `Use synapsor-runner writeback reconcile resolve ${intentId} after trusted source inspection.`,
        source_database_changed: false,
      });
      return;
    }
    try {
      const result = await workerReconciliationResolve({
        intentId,
        outcome,
        actor: stringValueOrUndefined(body.actor),
        reason,
        identityToken: workbenchIdentityToken(body.identity_token),
      });
      if (result.code !== 0) throw new Error("trusted reconciliation did not complete");
    } catch {
      sendJson(response, 409, {
        ok: false,
        error: "Reconciliation was refused because the live observation, operator authority, or intent state did not match.",
        next_action: "Refresh the live inspection. Runner will not override the outcome supported by the source observation.",
        source_database_changed: false,
      });
      return;
    }
    const config = await readResolvedRunnerConfig(configPath);
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    await storeAccess("read", "worker-reconciliation-result", (store) => {
      const resolved = store.getWritebackIntent(intentId);
      sendJson(response, 200, {
        ok: true,
        intent: resolved
          ? {
            intent_id: resolved.intent_id,
            proposal_id: resolved.proposal_id,
            operation: resolved.operation,
            status: resolved.status,
            updated_at: resolved.updated_at,
          }
          : null,
        worker: workbenchWorkerProjection(store, config, profile, configPath, ledgerScope),
        source_database_changed: false,
      });
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/lifecycle") {
    const scopeFailure = workbenchLedgerScopeFailure(ledgerScope);
    if (scopeFailure) {
      sendJson(response, 403, {
        ok: false,
        error: scopeFailure,
        source_database_changed: false,
        next_action: "Bind this Workbench to a verified tenant scope before inspecting shared activity.",
      });
      return;
    }
    try {
      const filters = workbenchLifecycleFilters(url, ledgerScope);
      await storeAccess("read", "lifecycle-list", (store) => {
        sendJson(response, 200, {
          ok: true,
          ...listLifecycleSummaries(store, filters),
          source_database_changed: false,
        });
      });
    } catch (error) {
      sendLifecycleError(response, error);
    }
    return;
  }

  const lifecycleDetailMatch = url.pathname.match(/^\/api\/lifecycle\/(.+)$/);
  if (request.method === "GET" && lifecycleDetailMatch) {
    const scopeFailure = workbenchLedgerScopeFailure(ledgerScope);
    if (scopeFailure) {
      sendJson(response, 403, {
        ok: false,
        error: scopeFailure,
        source_database_changed: false,
        next_action: "Bind this Workbench to a verified tenant scope before inspecting shared activity.",
      });
      return;
    }
    const handle = decodeURIComponent(lifecycleDetailMatch[1] ?? "");
    const operator = await workbenchOperatorPosture(configPath);
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    try {
      await storeAccess("read", "lifecycle-show", (store) => {
        const resolved = resolveLifecycleProposal(store, { handle });
        if (!proposalMatchesWorkbenchScope(resolved.proposal, ledgerScope)) {
          sendJson(response, 404, { ok: false, error: "No lifecycle record matches that handle." });
          return;
        }
        const lifecycle = buildLifecycleView(store, resolved.proposal, resolved.selection);
        sendJson(response, 200, {
          ok: true,
          lifecycle: workbenchLifecycleProjection(lifecycle),
          operator,
          deployment_profile: profile,
          source_database_changed: false,
        });
      });
    } catch (error) {
      sendLifecycleError(response, error);
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/proposals") {
    const state = url.searchParams.get("state") as LocalProposalState | null;
    const scopeFailure = workbenchLedgerScopeFailure(ledgerScope);
    if (scopeFailure) {
      sendJson(response, 403, { ok: false, error: scopeFailure });
      return;
    }
    await storeAccess("read", "proposals-list", (store) => {
      const proposals = store.listProposals({
        ...(state ? { state } : {}),
        ...(ledgerScope?.tenant ? { tenant: ledgerScope.tenant } : {}),
        ...(ledgerScope?.principal ? { principal: ledgerScope.principal } : {}),
      }).map((proposal) => summarizeProposal(proposal));
      sendJson(response, 200, { ok: true, proposals });
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/shadow/studies") {
    await storeAccess("read", "shadow-studies-list", (store) => {
      const studies = store.listShadowStudies().map((study) => ({
        ...study,
        total_tasks_observed: store.shadowCases(study.study_id).length,
        authoritative_outcomes: store.shadowOutcomes(study.study_id).length,
      }));
      sendJson(response, 200, { ok: true, studies });
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/shadow/report") {
    await storeAccess("read", "shadow-study-report", (store) => {
      const requested = url.searchParams.get("study");
      const study = requested
        ? store.getShadowStudy(requested)
        : store.listShadowStudies()[0];
      if (!study) {
        sendJson(response, 200, { ok: true, report: null });
        return;
      }
      sendJson(response, 200, { ok: true, report: store.shadowStudyReport(study.study_id) });
    });
    return;
  }

  const proposalDetailMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)$/);
  if (request.method === "GET" && proposalDetailMatch) {
    const proposalId = decodeURIComponent(proposalDetailMatch[1] ?? "");
    const operator = await workbenchOperatorPosture(configPath);
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    await storeAccess("read", "proposal-show", (store) => {
      const proposal = requireProposal(store, proposalId);
      if (!proposalMatchesWorkbenchScope(proposal, ledgerScope)) {
        sendJson(response, 404, { ok: false, error: "proposal not found" });
        return;
      }
      sendJson(response, 200, {
        ok: true,
        ...workbenchProposalDetailPayload(store, proposal, operator, profile),
      });
    });
    return;
  }

  const freshnessMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/check-freshness$/);
  if (request.method === "POST" && freshnessMatch) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for proposal freshness checks" });
      return;
    }
    const proposalId = decodeURIComponent(freshnessMatch[1] ?? "");
    const proposal = await storeAccess("read", "proposal-freshness-read", (store) => requireProposal(store, proposalId));
    if (!proposalMatchesWorkbenchScope(proposal, ledgerScope)) {
      sendJson(response, 404, { ok: false, error: "proposal not found" });
      return;
    }
    const freshness = await freshnessEvaluator(proposal);
    if (freshness.required) {
      await storeAccess("write", "proposal-freshness-record", (store) => {
        store.recordFreshnessProof(freshness.proof);
      });
    }
    sendJson(response, freshnessHttpStatus(freshness), {
      ok: freshness.status === "fresh" || freshness.status === "not_required",
      freshness: workbenchFreshnessSummary(freshness),
    });
    return;
  }

  const approveMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/approve$/);
  if (request.method === "POST" && approveMatch) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for proposal review actions" });
      return;
    }
    if (await cloudLinkedGovernance(configPath)) {
      sendJson(response, 403, {
        ok: false,
        error: "Cloud-linked proposals must be reviewed in Synapsor Cloud; local approval is disabled.",
        source_database_changed: false,
        next_action: "Open this proposal in the configured Synapsor Cloud workspace.",
      });
      return;
    }
    const proposalId = decodeURIComponent(approveMatch[1] ?? "");
    const body = await readJsonBody(request);
    const proposalForScope = await storeAccess("read", "proposal-approve-scope", (store) => requireProposal(store, proposalId));
    if (!proposalMatchesWorkbenchScope(proposalForScope, ledgerScope)) {
      sendJson(response, 404, { ok: false, error: "proposal not found" });
      return;
    }
    if (proposalApprove) {
      const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
      if (profile !== "development" && profile !== "staging") {
        sendJson(response, 403, {
          ok: false,
          error: `Local Workbench approval requires an explicit development or staging profile; current profile is ${profile}.`,
          source_database_changed: false,
          next_action: "Use the configured Cloud or trusted production approval path.",
        });
        return;
      }
      const operator = await workbenchOperatorPosture(configPath);
      if (operator.provider === "jwt_oidc"
        && (typeof body.identity_token !== "string" || !body.identity_token.trim())) {
        sendJson(response, 403, {
          ok: false,
          error: "This approval requires a fresh OIDC bearer token for this decision.",
          source_database_changed: false,
          next_action: "Authenticate with the configured identity provider, then submit this approval again.",
        });
        return;
      }
      if (body.confirm !== `APPROVE ${proposalForScope.proposal_hash}`) {
        sendJson(response, 409, {
          ok: false,
          error: "Approval requires the exact current proposal hash.",
          source_database_changed: false,
          next_action: `Review the effect again and type APPROVE ${proposalForScope.proposal_hash}.`,
        });
        return;
      }
      try {
        const identityToken = workbenchIdentityToken(body.identity_token);
        const freshnessProofDigest = await storeAccess("read", "proposal-approve-freshness-proof", (store) => {
          const proposal = requireProposal(store, proposalId);
          const proof = store.latestFreshnessProof(proposalId);
          if (!proof || proof.result !== "fresh" || Date.parse(proof.valid_until) < Date.now()) return undefined;
          if (proof.proposal_hash !== proposal.proposal_hash || proof.proposal_version !== proposal.proposal_version) return undefined;
          return proof.proof_digest;
        });
        const result = await proposalApprove({
          proposalId,
          actor: stringValueOrUndefined(body.actor),
          reason: stringValueOrUndefined(body.reason),
          identityToken,
          freshnessProofDigest,
        });
        if (result.code !== 0) {
          const failure = workbenchApprovalExitFailure(result.code);
          sendJson(response, 409, {
            ok: false,
            error: failure.error,
            error_code: failure.errorCode,
            source_database_changed: false,
            next_action: failure.nextAction,
          });
          return;
        }
        await storeAccess("read", "proposal-approve-result", (store) => {
          const proposal = requireProposal(store, proposalId);
          sendJson(response, 200, {
            ok: true,
            ...workbenchProposalDetailPayload(store, proposal, operator, profile),
            source_database_changed: false,
          });
        });
      } catch (error) {
        sendJson(response, 403, workbenchDecisionFailure(error, "approval"));
      }
      return;
    }
    if (await signedIdentityRequired(configPath)) {
      sendJson(response, 403, { ok: false, error: "This Runner requires a signed operator identity. Approve with the CLI using --identity and --identity-key." });
      return;
    }
    if (body.confirm !== "approve") throw new Error("approval requires confirm=approve");
    const proposalForCheck = await storeAccess("read", "proposal-approve-freshness-read", (store) => requireProposal(store, proposalId));
    const freshness = await freshnessEvaluator(proposalForCheck);
    if (freshness.required) {
      await storeAccess("write", "proposal-approve-freshness-record", (store) => {
        store.recordFreshnessProof(freshness.proof);
      });
    }
    if (freshness.status !== "fresh" && freshness.status !== "not_required") {
      if (freshness.required) {
        await storeAccess("write", "proposal-approve-freshness-blocked", (store) => {
          store.recordFreshnessApprovalBlocked(proposalId, {
            proof_digest: freshness.proof.proof_digest,
            safe_code: freshness.safe_code,
            actor: stringOrDefault(body.actor, "local_reviewer"),
          });
        });
      }
      sendJson(response, freshnessHttpStatus(freshness), {
        ok: false,
        error: freshness.status === "stale"
          ? "Proposal or supporting evidence is stale. Create a new source read and proposal."
          : "Freshness could not be verified. No approval was recorded.",
        freshness: workbenchFreshnessSummary(freshness),
      });
      return;
    }
    await storeAccess("write", "proposal-approve", (store) => {
      const proposal = requireProposal(store, proposalId);
      const updated = store.approveProposal(proposalId, {
        approver: stringOrDefault(body.actor, "local_reviewer"),
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
        reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined,
        freshness_proof_digest: freshness.required ? freshness.proof.proof_digest : undefined,
      });
      sendJson(response, 200, {
        ok: true,
        proposal: updated,
        approval_progress: store.approvalProgress(proposalId),
        freshness: workbenchFreshnessSummary(freshness),
      });
    });
    return;
  }

  const applyMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/apply$/);
  if (request.method === "POST" && applyMatch) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for guarded apply." });
      return;
    }
    const proposalId = decodeURIComponent(applyMatch[1] ?? "");
    const proposal = await storeAccess("read", "proposal-apply-scope", (store) => requireProposal(store, proposalId));
    if (!proposalMatchesWorkbenchScope(proposal, ledgerScope)) {
      sendJson(response, 404, { ok: false, error: "proposal not found" });
      return;
    }
    if (await cloudLinkedGovernance(configPath)) {
      sendJson(response, 403, {
        ok: false,
        error: "Cloud-linked proposals must be applied through the governed Cloud worker path.",
        source_database_changed: false,
        next_action: "Open this proposal in the configured Synapsor Cloud workspace.",
      });
      return;
    }
    const profile = await resolveWorkbenchDeploymentProfile(projectRoot, deploymentProfile);
    if (profile !== "development" && profile !== "staging") {
      sendJson(response, 403, {
        ok: false,
        error: `Local Workbench apply requires an explicit development or staging profile; current profile is ${profile}.`,
        source_database_changed: false,
        next_action: "Use the configured trusted production apply path.",
      });
      return;
    }
    if (!proposalApply) {
      sendJson(response, 409, {
        ok: false,
        error: "Guarded apply is not enabled for this Workbench process.",
        source_database_changed: false,
        next_action: `Run the trusted apply command for proposal ${proposalId}.`,
      });
      return;
    }
    const body = await readJsonBody(request);
    const operator = await workbenchOperatorPosture(configPath);
    if (operator.provider === "jwt_oidc"
      && (typeof body.identity_token !== "string" || !body.identity_token.trim())) {
      sendJson(response, 403, {
        ok: false,
        error: "This apply decision requires a fresh OIDC bearer token.",
        source_database_changed: false,
        next_action: "Authenticate with the configured identity provider, then submit apply again.",
      });
      return;
    }
    if (body.confirm !== `APPLY ${proposal.proposal_hash}`) {
      sendJson(response, 409, {
        ok: false,
        error: "Apply requires a second confirmation bound to the exact approved proposal hash.",
        source_database_changed: false,
        next_action: `Review the current effect and type APPLY ${proposal.proposal_hash}.`,
      });
      return;
    }
    try {
      const identityToken = workbenchIdentityToken(body.identity_token);
      const result = await proposalApply({
        proposalId,
        actor: stringValueOrUndefined(body.actor),
        reason: stringValueOrUndefined(body.reason),
        identityToken,
      });
      await storeAccess("read", "proposal-apply-result", (store) => {
        const updated = requireProposal(store, proposalId);
        const detail = workbenchProposalDetailPayload(store, updated, operator, profile);
        const lifecycle = detail.lifecycle as JsonRecord & { next?: JsonRecord };
        const ok = result.code === 0 && updated.state === "applied";
        sendJson(response, ok ? 200 : 409, {
          ok,
          ...detail,
          source_database_changed: updated.source_database_mutated,
          next_action: lifecycle.next?.operator ?? lifecycle.next?.read_only,
        });
      });
    } catch (error) {
      sendJson(response, 403, workbenchDecisionFailure(error, "apply"));
    }
    return;
  }

  const rejectMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/reject$/);
  if (request.method === "POST" && rejectMatch) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for proposal review actions" });
      return;
    }
    if (await cloudLinkedGovernance(configPath)) {
      sendJson(response, 403, {
        ok: false,
        error: "Cloud-linked proposals must be reviewed in Synapsor Cloud; local rejection is disabled.",
        source_database_changed: false,
        next_action: "Open this proposal in the configured Synapsor Cloud workspace.",
      });
      return;
    }
    if (await signedIdentityRequired(configPath)) {
      sendJson(response, 403, { ok: false, error: "This Runner requires a signed operator identity. Reject with the CLI using --identity and --identity-key." });
      return;
    }
    const proposalId = decodeURIComponent(rejectMatch[1] ?? "");
    const body = await readJsonBody(request);
    const proposalForScope = await storeAccess("read", "proposal-reject-scope", (store) => requireProposal(store, proposalId));
    if (!proposalMatchesWorkbenchScope(proposalForScope, ledgerScope)) {
      sendJson(response, 404, { ok: false, error: "proposal not found" });
      return;
    }
    if (body.confirm !== "reject") throw new Error("rejection requires confirm=reject");
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "";
    if (!reason) throw new Error("rejection requires a reason");
    await storeAccess("write", "proposal-reject", (store) => {
      const proposal = requireProposal(store, proposalId);
      const updated = store.rejectProposal(proposalId, {
        actor: stringOrDefault(body.actor, "local_reviewer"),
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
        reason,
      });
      sendJson(response, 200, { ok: true, proposal: updated });
    });
    return;
  }

  const replayMatch = url.pathname.match(/^\/api\/replay\/([^/]+)$/);
  if (request.method === "GET" && replayMatch) {
    const proposalId = decodeURIComponent(replayMatch[1] ?? "");
    await storeAccess("read", "replay-show", (store) => {
      const proposal = requireProposal(store, proposalId);
      if (!proposalMatchesWorkbenchScope(proposal, ledgerScope)) {
        sendJson(response, 404, { ok: false, error: "proposal not found" });
        return;
      }
      sendJson(response, 200, { ok: true, replay: store.replay(proposalId) });
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: "not found" });
}

async function evaluateWorkbenchFreshness(
  configPath: string,
  proposal: StoredProposal,
): Promise<ProposalFreshnessEvaluation> {
  const required = "freshness" in proposal.change_set && proposal.change_set.freshness !== undefined;
  if (!required) {
    return {
      required: false,
      status: "not_required",
      safe_code: "FRESHNESS_NOT_REQUIRED",
      target_count: 0,
      supporting_count: 0,
    };
  }
  const config = await loadRuntimeConfigFromFile(configPath);
  return evaluateProposalFreshness({ config, proposal, env: process.env });
}

function workbenchFreshnessSummary(result: ProposalFreshnessEvaluation): JsonRecord {
  if (!result.required) {
    return {
      required: false,
      status: "not_required",
      safe_code: result.safe_code,
      target_count: 0,
      supporting_count: 0,
    };
  }
  return {
    required: true,
    status: result.status,
    safe_code: result.safe_code,
    checked_at: result.proof.checked_at,
    valid_until: result.proof.valid_until,
    proof_digest: result.proof.proof_digest,
    target_count: result.target_count,
    supporting_count: result.supporting_count,
    checks: result.proof.checks,
  };
}

function storedFreshnessSummary(
  proposal: StoredProposal,
  proof: FreshnessProofV1 | undefined,
): JsonRecord {
  const required = "freshness" in proposal.change_set && proposal.change_set.freshness !== undefined;
  if (!required) return { required: false, status: "not_required", safe_code: "FRESHNESS_NOT_REQUIRED" };
  if (!proof) return { required: true, status: "not_checked", safe_code: "FRESHNESS_PROOF_MISSING" };
  const expired = proof.result === "fresh" && Date.parse(proof.valid_until) < Date.now();
  return {
    required: true,
    status: expired ? "unavailable" : proof.result,
    safe_code: expired ? "FRESHNESS_PROOF_EXPIRED" : proof.safe_code,
    checked_at: proof.checked_at,
    valid_until: proof.valid_until,
    proof_digest: proof.proof_digest,
    target_count: proof.target_count,
    supporting_count: proof.supporting_count,
    checks: proof.checks,
  };
}

function freshnessHttpStatus(result: ProposalFreshnessEvaluation): number {
  if (result.status === "fresh" || result.status === "not_required") return 200;
  if (result.status === "stale") return 409;
  if (result.status === "unavailable") return 503;
  return 422;
}

async function executeSafeActionPreview(input: {
  projectRoot: string;
  configPath: string;
  storePath: string;
  args: JsonRecord;
}): ReturnType<SafeActionPreview> {
  const prepared = await prepareSafeActionPreview({ projectRoot: input.projectRoot, configPath: input.configPath });
  const previewConfigPath = path.resolve(input.projectRoot, prepared.config_path);
  const runtime = createMcpRuntime(loadRuntimeConfigFromFile(previewConfigPath), { storePath: input.storePath });
  try {
    const result = await runtime.callTool(prepared.capability, input.args);
    assertSuccessfulPreviewResult(result, "Safe Action preview");
    const proposalId = proposalIdFromToolResult(result);
    if (!proposalId) throw new Error("Safe Action preview did not create an immutable proposal");
    if (result.source_database_changed === true || result.source_database_mutated === true) throw new Error("Safe Action preview unexpectedly changed source data");
    const proposal = await runtime.store.getProposal(proposalId);
    const proposalHash = typeof result.proposal_hash === "string" ? result.proposal_hash : proposal?.proposal_hash ?? "";
    if (!proposal || proposal.proposal_hash !== proposalHash) throw new Error("Safe Action preview proposal is missing from the reviewed ledger");
    if (proposal.change_set.contract?.digest !== prepared.draft_digest) throw new Error("Safe Action preview proposal is not pinned to the current draft digest");
    return {
      draft_digest: prepared.draft_digest,
      proposal_id: proposalId,
      proposal_hash: proposalHash,
      source_database_changed: false,
    };
  } finally {
    await runtime.close();
  }
}

async function executeGuidedActionPreview(input: {
  projectRoot: string;
  configPath: string;
  storePath: string;
  capabilityName: string;
  args: JsonRecord;
  env: NodeJS.ProcessEnv;
}): ReturnType<GuidedActionPreview> {
  const prepared = await prepareGuidedActionPreview({
    projectRoot: input.projectRoot,
    capabilityName: input.capabilityName,
    configPath: input.configPath,
  });
  const previewConfigPath = path.resolve(input.projectRoot, prepared.config_path);
  const runtime = createMcpRuntime(loadRuntimeConfigFromFile(previewConfigPath), {
    storePath: input.storePath,
    env: input.env,
  });
  try {
    const result = await runtime.callTool(prepared.capability, input.args);
    assertSuccessfulPreviewResult(result, "Guided action preview");
    const proposalId = proposalIdFromToolResult(result);
    if (!proposalId) throw new Error("Guided action preview did not create an immutable proposal.");
    if (result.source_database_changed === true || result.source_database_mutated === true) {
      throw new Error("Guided action preview unexpectedly changed source data.");
    }
    const proposal = await runtime.store.getProposal(proposalId);
    const proposalHash = typeof result.proposal_hash === "string" ? result.proposal_hash : proposal?.proposal_hash ?? "";
    if (!proposal || proposal.proposal_hash !== proposalHash) {
      throw new Error("Guided action preview proposal is missing from the reviewed ledger.");
    }
    if (proposal.change_set.contract?.digest !== prepared.draft_digest) {
      throw new Error("Guided action preview proposal is not pinned to the current draft digest.");
    }
    return {
      draft_digest: prepared.draft_digest,
      proposal_id: proposalId,
      proposal_hash: proposalHash,
      source_database_changed: false,
    };
  } finally {
    await runtime.close();
  }
}

function assertSuccessfulPreviewResult(result: JsonRecord, label: string): void {
  if (result.ok !== false) return;
  const safeError = asRecord(result.error);
  const code = typeof safeError.code === "string" ? safeError.code : "TOOL_REJECTED";
  const message = typeof safeError.message === "string" ? safeError.message : "The runtime rejected the preview.";
  throw new Error(`${label} failed (${code}): ${message}`);
}

function proposalIdFromToolResult(result: JsonRecord): string {
  if (typeof result.proposal_id === "string") return result.proposal_id;
  const proposal = asRecord(result.proposal);
  return typeof proposal.id === "string" ? proposal.id : "";
}

async function inspectGuidedProject(
  projectRoot: string,
  schemaInspector: typeof inspectDatabase,
) {
  const lock = JSON.parse(
    await fs.readFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "utf8"),
  ) as GenerationLock;
  return schemaInspector({
    engine: lock.engine,
    databaseUrlEnv: lock.source_env,
    schema: lock.inspected_schema,
    env: process.env,
  });
}

async function readRunnerConfig(configPath: string): Promise<JsonRecord> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("runner config must be a JSON object");
  return parsed;
}

async function readResolvedRunnerConfig(configPath: string): Promise<JsonRecord> {
  const raw = await readRunnerConfig(configPath);
  return Array.isArray(raw.contracts) && raw.contracts.length > 0
    ? loadRuntimeConfigFromFile(configPath) as unknown as JsonRecord
    : raw;
}

async function readOnboardingManifest(configPath: string): Promise<JsonRecord | undefined> {
  const manifestPath = path.join(path.dirname(configPath), ".synapsor", "onboarding.json");
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    return isRecord(parsed) && parsed.schema_version === "synapsor.onboarding.v1" ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function signedIdentityRequired(configPath: string): Promise<boolean> {
  const config = await readRunnerConfig(configPath);
  return isRecord(config.operator_identity) && ["signed_key", "jwt_oidc"].includes(String(config.operator_identity.provider));
}

async function cloudLinkedGovernance(configPath: string): Promise<boolean> {
  const config = await readRunnerConfig(configPath);
  return isRecord(config.governance) && config.governance.mode === "cloud_linked";
}

function buildSummary(config: JsonRecord, configPath: string, storePath: string): JsonRecord {
  const validation = validateRunnerCapabilityConfig(config);
  const sources = Object.fromEntries(Object.entries(asRecord(config.sources)).map(([name, source]) => {
    const sourceConfig = asRecord(source);
    return [name, {
      engine: sourceConfig.engine,
      read_url_env: sourceConfig.read_url_env,
      write_url_env: sourceConfig.write_url_env,
      statement_timeout_ms: sourceConfig.statement_timeout_ms,
    }];
  }));
  const capabilities = Array.isArray(config.capabilities) ? config.capabilities.map((capability) => {
    const item = asRecord(capability);
    const target = asRecord(item.target);
    return {
      name: item.name,
      kind: item.kind,
      source: item.source,
      target: {
        schema: target.schema,
        table: target.table,
        primary_key: target.primary_key,
        tenant_key: target.tenant_key,
        single_tenant_dev: target.single_tenant_dev === true,
      },
      evidence: item.evidence,
      max_rows: item.max_rows,
      context: item.context,
      executor: item.executor ?? "sql_update",
      reversibility: item.reversibility,
    };
  }) : [];
  const forbiddenTools = capabilities
    .map((capability) => String(asRecord(capability).name ?? ""))
    .filter((name) => /execute_sql|run_query|approve|commit|apply_writeback/i.test(name));
  return {
    ok: true,
    setup: {
      config_path: configPath,
      store_path: storePath,
      mode: config.mode,
      storage: asRecord(config.storage),
      trusted_context: config.trusted_context,
      sources,
      capabilities,
    },
    doctor: {
      config_ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      no_raw_sql_exposed: forbiddenTools.length === 0,
      forbidden_model_tools: forbiddenTools,
    },
  };
}

function buildTools(config: JsonRecord): JsonRecord {
  const capabilities = Array.isArray(config.capabilities) ? config.capabilities.map((capability) => {
    const item = asRecord(capability);
    const target = asRecord(item.target);
    return {
      name: item.name,
      kind: item.kind,
      target_business_object: `${String(target.schema ?? "")}.${String(target.table ?? "")}`,
      input_schema: item.args,
      hidden_trusted_bindings: contextValuesForCapability(config, item),
      lookup: item.lookup,
      visible_columns: item.visible_columns,
      allowed_patch_columns: item.allowed_columns ?? [],
      operation: item.operation,
      conflict_guard: item.conflict_guard,
      executor: item.executor ?? "sql_update",
      reversibility: item.reversibility,
      no_raw_sql_exposed: !/execute_sql|run_query/i.test(String(item.name ?? "")),
      approval_or_commit_exposed: /approve|commit|apply_writeback/i.test(String(item.name ?? "")),
    };
  }) : [];
  return { ok: true, tools: capabilities };
}

function buildWorkbench(
  config: JsonRecord,
  manifest: JsonRecord | undefined,
  cursorState: "not_installed" | "installed" | "unowned" | "tampered",
  proposals: StoredProposal[],
  queryAuditCount: number,
  safeAction: SafeActionStatus,
): JsonRecord {
  const project = asRecord(manifest?.project);
  const source = asRecord(manifest?.source);
  const trustScope = asRecord(manifest?.trust_scope);
  const action = asRecord(manifest?.action);
  const safety = asRecord(manifest?.safety);
  const capabilities = Array.isArray(config.capabilities) ? config.capabilities.map(asRecord) : [];
  const readCapability = capabilities.find((capability) => capability.kind === "read");
  const proposalCapability = capabilities.find((capability) => capability.kind === "proposal");
  const validation = validateRunnerCapabilityConfig(config);
  const latest = proposals.at(0);
  const generated = Boolean(manifest);
  const cursorPrompt = buildCursorSafeActionPrompt(safeAction, proposalCapability);
  return {
    ok: validation.ok && capabilities.length > 0,
    title: "First safe action",
    status: manifest?.status ?? "existing_config",
    stages: [
      stage("Project", generated ? "complete" : "ready", generated
        ? `${String(project.frameworks || "existing application")}; package manager ${String(project.package_manager ?? "not detected")}`
        : "Existing reviewed Runner configuration"),
      stage("Data source", Object.keys(asRecord(config.sources)).length ? "complete" : "blocked",
        source.table ? `${String(source.engine)} ${String(source.schema)}.${String(source.table)} via ${String(source.database_url_env)}` : `${Object.keys(asRecord(config.sources)).length} configured source(s)`),
      stage("Trust scope", trustScope.tenant_key || trustScope.single_tenant_dev === true ? "complete" : "ready",
        trustScope.tenant_key ? `tenant key ${String(trustScope.tenant_key)}; identity from environment bindings` : "Review the configured tenant/principal authority"),
      stage("Action", readCapability ? "complete" : "blocked",
        [readCapability?.name, proposalCapability?.name].filter(Boolean).join(" -> ") || "No reviewed capability"),
      stage("Agent", cursorState === "installed" ? "complete" : cursorState === "not_installed" ? "ready" : "blocked",
        cursorState === "installed" ? "A project MCP entry is installed for Cursor" : `Project MCP client setup: ${cursorState}`),
      stage("Test", !validation.ok ? "blocked" : queryAuditCount > 0 ? "complete" : "ready",
        !validation.ok
          ? `${validation.errors.length} config error(s)`
          : queryAuditCount > 0
            ? `${queryAuditCount} scoped tool call(s) recorded; source unchanged during onboarding: ${safety.source_changed_during_onboarding === false ? "yes" : "not recorded"}`
            : "Configuration is valid; run the reviewed read tool against one staging record to complete this step"),
      stage("Review", latest ? "complete" : "ready",
        latest ? `${latest.proposal_id}: ${latest.state}` : "Waiting for the first exact proposal"),
    ],
    action: {
      read_capability: action.read_capability ?? readCapability?.name,
      proposal_capability: action.proposal_capability ?? proposalCapability?.name,
      visible_fields: Array.isArray(action.visible_fields) ? action.visible_fields : readCapability?.visible_columns ?? [],
      kept_out_fields: Array.isArray(action.kept_out_fields) ? action.kept_out_fields : [],
      writeback: action.writeback ?? "not recorded",
      activation_confirmed: safety.developer_confirmed_activation === true,
    },
    cursor: {
      state: cursorState,
      connection_status: cursorState === "installed" ? "project_configuration_installed" : "not_verified",
      prompt: cursorPrompt,
      prompt_deeplink: `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(cursorPrompt)}`,
      prompt_web_link: `https://cursor.com/link/prompt?text=${encodeURIComponent(cursorPrompt)}`,
      plugin_scope: "workspace",
      plugin_status: "local-validation-ready; Marketplace submission not yet completed",
      tools: capabilities.map((capability) => String(capability.name ?? "")).filter(Boolean),
      proposal_waiting: !latest,
      next_step: latest
        ? `Review ${latest.proposal_id} in this secured localhost Workbench.`
        : "Keep this Workbench open. It will update when any connected MCP client creates the first proposal; no follow-up CLI command is required.",
    },
    safe_action: safeAction,
    latest_proposal: latest ? summarizeProposal(latest) : null,
  };
}

function buildCursorSafeActionPrompt(safeAction: SafeActionStatus, proposalCapability: JsonRecord | undefined): string {
  const actionName = safeAction.draft?.action_name
    ?? (typeof proposalCapability?.name === "string" ? proposalCapability.name : "one reviewed business action");
  return `Use /synapsor-protect to make ${actionName} safe for an agent. Inspect this project, draft only a disabled TypeScript Safe Action, keep trusted tenant/principal values outside model arguments, keep sensitive or unknown fields out, run deterministic validation and tests, and leave effect review and activation to me in the secured Synapsor Workbench.`;
}

function stage(name: string, status: "complete" | "ready" | "blocked", detail: string): JsonRecord {
  return { name, status, detail };
}

function buildDataPr(proposal: StoredProposal, reviewView: JsonRecord, latestReceipt: unknown): JsonRecord {
  const changeSet = proposal.change_set;
  return {
    schema_version: "synapsor.data-pr.v1",
    title: `${proposal.action} on ${proposal.object_id}`,
    business_action: proposal.action,
    capability: proposal.capability ?? proposal.action,
    trusted_scope: reviewView.trusted_context,
    target: {
      source_id: proposal.source_id,
      schema: proposal.source_schema,
      table: proposal.source_table,
      object_id: proposal.object_id,
    },
    evidence_reference: reviewView.evidence_summary,
    kept_out_fields: reviewView.kept_out_fields,
    exact_diff: reviewView.diff,
    policy_result: reviewView.policy_and_risk,
    expected_version: reviewView.expected_source_version,
    operation_identity: {
      proposal_id: proposal.proposal_id,
      proposal_hash: proposal.proposal_hash,
      proposal_version: proposal.proposal_version,
      idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
    },
    executor: asRecord(reviewView.writeback).executor,
    receipt_mode: changeSet.writeback.mode,
    source_unchanged_before_approval: proposal.source_database_mutated === false,
    apply_result: latestReceipt ?? null,
    replay_id: `replay_${proposal.proposal_id}`,
  };
}

function workbenchProposalDetailPayload(
  store: ProposalStore,
  proposal: StoredProposal,
  operator: JsonRecord,
  profile: WorkbenchDeploymentProfile,
): JsonRecord {
  const receipts = store.receipts(proposal.proposal_id);
  const reviewView = buildProposalReviewView(proposal, receipts);
  const selection = resolveLifecycleProposal(store, { handle: `proposal:${proposal.proposal_id}` }).selection;
  const lifecycle = workbenchLifecycleProjection(buildLifecycleView(store, proposal, selection));
  return {
    proposal,
    approval_progress: store.approvalProgress(proposal.proposal_id),
    review_view: reviewView,
    data_pr: buildDataPr(proposal, reviewView, receipts.at(-1)),
    events: (lifecycle.timeline as Array<Record<string, unknown>>).map((event) => ({
      kind: event.kind,
      actor: event.actor,
      created_at: event.occurred_at,
      payload: event.summary,
    })),
    receipts: (lifecycle.writeback as JsonRecord).receipts,
    evidence: lifecycle.evidence,
    freshness: storedFreshnessSummary(proposal, store.latestFreshnessProof(proposal.proposal_id)),
    lifecycle,
    operator,
    deployment_profile: profile,
  };
}

function summarizeProposal(proposal: StoredProposal): JsonRecord {
  const changeSet = proposal.change_set;
  const boundedSet = changeSet.schema_version === protocolVersions.changeSetV3 ? {
    operation: changeSet.operation,
    row_count: changeSet.frozen_set.row_count,
    max_rows: changeSet.frozen_set.max_rows,
    aggregate_bounds: changeSet.frozen_set.aggregate_bounds,
    set_digest: changeSet.frozen_set.set_digest,
    identities: changeSet.frozen_set.members.map((member) => member.primary_key),
  } : undefined;
  return {
    proposal_id: proposal.proposal_id,
    action: proposal.action,
    state: proposal.state,
    tenant_id: proposal.tenant_id,
    principal: changeSet.principal,
    target: {
      source_kind: proposal.source_kind,
      source_id: proposal.source_id,
      schema: proposal.source_schema,
      table: proposal.source_table,
      object_id: proposal.object_id,
      primary_key: changeSet.source.primary_key,
    },
    approval: changeSet.approval,
    source_database_changed: proposal.source_database_mutated,
    expected_version: "expected_version" in changeSet.guards ? changeSet.guards.expected_version : undefined,
    evidence: changeSet.evidence,
    writeback_status: changeSet.writeback.status,
    writeback_mode: changeSet.writeback.mode,
    executor: (changeSet.writeback as { executor?: unknown }).executor ?? "sql_update",
    ...(boundedSet ? { bounded_set: boundedSet } : {}),
    diff: Object.fromEntries(Object.keys(changeSet.patch).map((column) => [column, {
      before: changeSet.before[column],
      proposed: changeSet.after[column],
    }])),
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
  };
}

function contextValuesForCapability(config: JsonRecord, capability: JsonRecord): unknown {
  const contextName = typeof capability.context === "string" ? capability.context : undefined;
  const contexts = asRecord(config.contexts);
  const named = contextName ? asRecord(contexts[contextName]) : {};
  if (Object.keys(named).length > 0) return asRecord(named.values) ?? named;
  return asRecord(asRecord(config.trusted_context).values) ?? config.trusted_context;
}

function localStoreAccess(storePath: string): LocalUiStoreAccess {
  return async <T>(_mode: "read" | "write", _operation: string, callback: (store: ProposalStore) => T): Promise<T> => {
    const store = new ProposalStore(storePath);
    try {
      return callback(store);
    } finally {
      store.close();
    }
  };
}

async function recordWorkbenchAttention(
  storeAccess: LocalUiStoreAccess,
  input: RecordAttentionEventInput,
): Promise<void> {
  await storeAccess("write", `workbench-attention:${input.event_type}`, (store) => {
    store.recordAttentionEvent(input);
  });
}

function activeBoundaryEventMetadata(value: unknown): {
  digest: `sha256:${string}`;
  activatedAt: string;
} | undefined {
  if (!isRecord(value) || !isRecord(value.activation)) return undefined;
  const digest = value.activation.digest;
  const activatedAt = value.activation.activated_at;
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) return undefined;
  if (typeof activatedAt !== "string" || !Number.isFinite(Date.parse(activatedAt))) return undefined;
  return { digest: digest as `sha256:${string}`, activatedAt };
}

function capabilityRevokedAttention(input: {
  environment: WorkbenchDeploymentProfile;
  capability: string;
  digest: `sha256:${string}`;
  reasonCode: string;
  sourceEventKey: string;
  occurredAt?: string;
}): RecordAttentionEventInput {
  return {
    event_type: "capability.revoked",
    severity: "informational",
    environment: input.environment,
    capability: input.capability,
    contract_digest: input.digest,
    attention_required: false,
    immediate_default: false,
    summary: "Previously active authority was disabled",
    workbench_path: "/",
    details: {
      reason_code: input.reasonCode,
      source_database_changed: false,
    },
    source_event_key: input.sourceEventKey,
    ...(input.occurredAt ? { now: input.occurredAt } : {}),
  };
}

function sensitiveFieldOverrideEvent(
  body: JsonRecord,
  overrides: AutoBoundaryReviewOverrides,
  semanticDiff: {
    removed_kept_out_fields: string[];
    removed_model_withheld_fields: string[];
  },
): {
  resourceFingerprint: `sha256:${string}`;
  fieldFingerprint: `sha256:${string}`;
  decisionDigest: `sha256:${string}`;
  decidedAt: string;
} | undefined {
  if (body.kind !== "field_exposure"
    || (body.exposure !== "allow_reviewed_use" && body.exposure !== "withhold_from_model")) {
    return undefined;
  }
  const loosensExposure = body.exposure === "allow_reviewed_use"
    ? semanticDiff.removed_kept_out_fields.length > 0
      || semanticDiff.removed_model_withheld_fields.length > 0
    : semanticDiff.removed_kept_out_fields.length > 0;
  if (!loosensExposure) return undefined;
  if (typeof body.resource_id !== "string" || typeof body.field !== "string") return undefined;
  const decision = overrides.resources[body.resource_id]?.fields?.[body.field];
  if (!decision
    || (decision.exposure !== "allow_reviewed_use"
      && decision.exposure !== "withhold_from_model")) {
    return undefined;
  }
  return {
    resourceFingerprint: canonicalJsonDigest({ resource: body.resource_id }),
    fieldFingerprint: canonicalJsonDigest({ resource: body.resource_id, field: body.field }),
    decisionDigest: canonicalJsonDigest({
      resource: body.resource_id,
      field: body.field,
      decision,
    }),
    decidedAt: decision.decided_at,
  };
}

function schemaDriftAttentionDetails(diff: JsonRecord): Record<string, string | number | boolean | null> {
  const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
  const totals = isRecord(diff.totals) ? diff.totals : {};
  const preserved = isRecord(totals.preserved_authority) ? totals.preserved_authority : {};
  const resourcesPreserved = typeof preserved.resources === "number" ? preserved.resources : 0;
  const pathsPreserved = typeof preserved.reviewed_paths === "number" ? preserved.reviewed_paths : 0;
  const fieldPoliciesPreserved = typeof preserved.field_policies === "number"
    ? preserved.field_policies
    : 0;
  return {
    reason_code: "generation_lock_schema_changed",
    boundaries_checked: typeof totals.boundaries === "number" ? totals.boundaries : 0,
    decisions_kept: resourcesPreserved + pathsPreserved + fieldPoliciesPreserved,
    resources_preserved: resourcesPreserved,
    reviewed_paths_preserved: pathsPreserved,
    field_policies_preserved: fieldPoliciesPreserved,
    confirmation_records_retained: typeof totals.kept_confirmations === "number"
      ? totals.kept_confirmations
      : 0,
    decisions_requiring_review: typeof totals.invalidated_decisions === "number"
      ? totals.invalidated_decisions
      : 0,
    resources_added: typeof totals.newly_available_resources === "number"
      ? totals.newly_available_resources
      : count(diff.added_resources),
    resources_removed: typeof totals.removed_resources === "number"
      ? totals.removed_resources
      : count(diff.removed_resources),
    fields_added: typeof totals.newly_available_fields === "number" ? totals.newly_available_fields : 0,
    value_allowlists_added: typeof totals.newly_proven_value_allowlists === "number"
      ? totals.newly_proven_value_allowlists
      : 0,
    relationships_added: typeof totals.newly_available_relationships === "number"
      ? totals.newly_available_relationships
      : 0,
    source_database_changed: false,
  };
}

const workbenchProposalStates = new Set<LocalProposalState>([
  "pending_review",
  "approved",
  "pending_worker",
  "applied",
  "rejected",
  "conflict",
  "failed",
  "canceled",
  "reconciliation_required",
]);

function workbenchLedgerScopeFailure(scope: WorkbenchLedgerScope | undefined): string | undefined {
  if (scope?.required === true && !scope.tenant) {
    return "Shared-ledger Workbench inspection requires a verified tenant scope and will not fall back to an organization-wide list.";
  }
  return undefined;
}

function workbenchAttentionFilters(
  url: URL,
  scope: WorkbenchLedgerScope | undefined,
): {
  status?: AttentionItemStatus;
  severity?: AttentionSeverity;
  capability?: string;
  tenant?: string;
  principal?: string;
  limit?: number;
} {
  const status = nonEmptySearchParam(url, "status");
  if (status && !["open", "acknowledged", "resolved", "expired"].includes(status)) {
    throw new Error(`Unsupported attention status filter: ${status}`);
  }
  const severity = nonEmptySearchParam(url, "severity");
  if (severity && !["informational", "warning", "critical"].includes(severity)) {
    throw new Error(`Unsupported attention severity filter: ${severity}`);
  }
  const rawLimit = nonEmptySearchParam(url, "limit");
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Attention limit must be an integer from 1 through 100.");
  }
  return {
    ...(status ? { status: status as AttentionItemStatus } : {}),
    ...(severity ? { severity: severity as AttentionSeverity } : {}),
    ...(nonEmptySearchParam(url, "capability") ? { capability: nonEmptySearchParam(url, "capability") } : {}),
    ...(scope?.tenant ? { tenant: scope.tenant } : {}),
    ...(scope?.principal ? { principal: scope.principal } : {}),
    limit,
  };
}

function scopedWorkbenchAttentionItem(
  store: ProposalStore,
  attentionId: string,
  scope: WorkbenchLedgerScope | undefined,
): AttentionItem | undefined {
  if (!scope?.required) return store.getAttentionItem(attentionId);
  return store.listAttentionItems({
    ...(scope.tenant ? { tenant: scope.tenant } : {}),
    ...(scope.principal ? { principal: scope.principal } : {}),
    limit: 1_000,
  }).find((item) => item.attention_id === attentionId);
}

function workbenchAttentionProjection(
  item: AttentionItem,
  event: AttentionEvent | undefined,
): Record<string, unknown> {
  const sourceChanged = event?.details.source_database_changed === true;
  return {
    attention_id: item.attention_id,
    status: item.status,
    severity: item.severity,
    title: item.title,
    occurrence_count: item.occurrence_count,
    capability: item.capability ?? null,
    contract_digest: item.contract_digest ?? null,
    first_seen_at: item.first_seen_at,
    last_seen_at: item.last_seen_at,
    acknowledged_by: item.acknowledged_by ?? null,
    acknowledged_at: item.acknowledged_at ?? null,
    resolved_at: item.resolved_at ?? null,
    expires_at: item.expires_at ?? null,
    latest_event: event ? {
      event_id: event.event_id,
      event_type: event.event_type,
      occurred_at: event.occurred_at,
      summary: event.summary,
      proposal_id: event.proposal_id ?? null,
      job_id: event.job_id ?? null,
      operation_id: event.operation_id ?? null,
      approval_source: event.approval_source ?? null,
      worker_state: event.worker_state ?? null,
      failure_class: event.failure_class ?? null,
      details: event.details,
    } : null,
    source_database_changed: sourceChanged,
    acknowledgement_is_approval: false,
    what_if_ignored: workbenchAttentionInaction(event),
    available_action: workbenchAttentionAction(event),
  };
}

function workbenchAttentionInaction(event: AttentionEvent | undefined): string {
  switch (event?.event_type) {
    case "proposal.review_required":
    case "proposal.expiring":
      return "The proposal remains unapplied and may expire. The source database is unchanged.";
    case "worker.unknown_outcome":
    case "worker.reconciliation_required":
      return "Automatic retries remain stopped. The outcome stays unresolved until a trusted operator reconciles it.";
    case "worker.dead_lettered":
      return "The job remains in the dead-letter queue and will not be retried automatically.";
    case "schema.drift_detected":
    case "contract.digest_stale":
    case "credential.posture_changed":
      return "Affected authority remains blocked until the underlying posture is reviewed.";
    default:
      return "Runner preserves the event and current fail-closed state in the ledger.";
  }
}

function workbenchAttentionAction(event: AttentionEvent | undefined): string {
  switch (event?.event_type) {
    case "proposal.review_required":
      return "review_proposal";
    case "worker.unknown_outcome":
    case "worker.reconciliation_required":
      return "reconcile";
    case "worker.dead_lettered":
      return "inspect_dead_letter";
    case "schema.drift_detected":
      return "review_boundary";
    default:
      return "acknowledge";
  }
}

function workbenchNotificationCounts(
  deliveries: ReturnType<ProposalStore["listNotificationDeliveries"]>,
): Record<string, number> {
  const counts: Record<string, number> = {
    pending: 0,
    leased: 0,
    delivered: 0,
    retry_wait: 0,
    dead_letter: 0,
    suppressed: 0,
    batched: 0,
  };
  for (const delivery of deliveries) counts[delivery.status] = (counts[delivery.status] ?? 0) + 1;
  return counts;
}

function workbenchWorkerProjection(
  store: ProposalStore,
  config: JsonRecord,
  profile: WorkbenchDeploymentProfile,
  configPath: string,
  ledgerScope?: WorkbenchLedgerScope,
): JsonRecord {
  const workerConfig = asRecord(config.supervised_worker);
  const policies = Array.isArray(workerConfig.capabilities)
    ? workerConfig.capabilities.map(asRecord)
    : [];
  const capabilities = Array.isArray(config.capabilities)
    ? config.capabilities.map(asRecord)
    : [];
  const sources = asRecord(config.sources);
  const control = store.workerControlState();
  const controlByTarget = new Map(control.capability_controls.map((entry) => [
    `${entry.capability}:${entry.contract_digest}`,
    entry,
  ]));
  const items = store.listWorkerQueue().filter((item) => {
    const proposal = store.getProposal(item.proposal_id);
    return proposal !== undefined && proposalMatchesWorkbenchScope(proposal, ledgerScope);
  });
  const now = Date.now();
  const queue = items.map((item) => {
    const proposal = store.getProposal(item.proposal_id);
    const capability = proposal?.action ?? proposal?.capability ?? "unknown";
    const reconciliationIntent = item.status === "reconciliation_required"
      ? store.listWritebackIntents({ proposal_id: item.proposal_id, limit: 10 })
        .find((intent) => intent.status === "reconciliation_required" || intent.status === "applying")
      : undefined;
    return {
      proposal_id: item.proposal_id,
      capability,
      status: item.status,
      execution_mode: item.execution_mode,
      contract_digest: item.contract_digest ?? null,
      approval_source: workbenchWorkerApprovalSource(store, item.proposal_id),
      attempts: item.attempts,
      max_attempts: item.max_attempts,
      next_attempt_at: item.next_attempt_at,
      queue_age_seconds: Math.max(0, Math.floor((now - Date.parse(item.created_at)) / 1_000)),
      lease_owner: item.lease_owner ?? null,
      lease_id: item.lease_id ?? null,
      lease_expires_at: item.lease_expires_at ?? null,
      last_error_code: item.last_error_code ?? null,
      terminal_outcome: item.terminal_outcome ?? null,
      source_database_changed: proposal?.source_database_mutated === true,
      next_action: workbenchWorkerNextAction(item),
      cancel_confirmation: item.status === "queued" || item.status === "retry_wait"
        ? `CANCEL ${item.proposal_id}`
        : null,
      recovery_confirmation: item.status === "dead_letter"
        ? `REQUEUE ${item.proposal_id}`
        : null,
      discard_confirmation: item.status === "dead_letter"
        ? `DISCARD ${item.proposal_id}`
        : null,
      reconciliation: reconciliationIntent
        ? {
          intent_id: reconciliationIntent.intent_id,
          operation: reconciliationIntent.operation,
          status: reconciliationIntent.status,
          reason: reconciliationIntent.reconciliation_reason ?? "source outcome requires operator reconciliation",
        }
        : null,
    };
  });
  const waiting = items.filter((item) => item.status === "queued" || item.status === "retry_wait");
  const activeLeases = items.filter((item) =>
    item.status === "leased" && Date.parse(item.lease_expires_at ?? "") > now);
  return {
    configured: Object.keys(workerConfig).length > 0,
    enabled: workerConfig.enabled === true,
    deployment_profile: profile,
    control: {
      mode: control.mode,
      revision: control.revision,
      updated_at: control.updated_at,
      integrity_hash: control.integrity_hash,
    },
    summary: {
      queue_depth: waiting.length,
      oldest_queue_age_seconds: waiting.length > 0
        ? Math.max(...waiting.map((item) => Math.max(0, Math.floor((now - Date.parse(item.created_at)) / 1_000))))
        : 0,
      active_leases: activeLeases.length,
      retry_wait: items.filter((item) => item.status === "retry_wait").length,
      blocked: items.filter((item) => item.status === "blocked").length,
      dead_letters: items.filter((item) => item.status === "dead_letter").length,
      unknown_or_reconciliation: items.filter((item) => item.status === "reconciliation_required").length,
    },
    capabilities: policies.map((policy) => {
      const capabilityName = String(policy.capability ?? "");
      const contractDigest = String(policy.contract_digest ?? "");
      const runtimeCapability = capabilities.find((candidate) => candidate.name === capabilityName);
      const source = runtimeCapability ? asRecord(sources[String(runtimeCapability.source ?? "")]) : {};
      const controlEntry = controlByTarget.get(`${capabilityName}:${contractDigest}`);
      const postureState = store.getRunnerState(`supervised_writer_posture:${canonicalJsonDigest({
        environment: String(workerConfig.profile ?? profile),
        capability: capabilityName,
        contract_digest: contractDigest,
      })}`);
      return {
        capability: capabilityName,
        contract_digest: contractDigest,
        control_status: controlEntry?.status ?? "enabled",
        allowlist_match: true,
        worker_identity: policy.worker_identity ?? null,
        concurrency: policy.concurrency ?? null,
        queue_limit: policy.queue_limit ?? null,
        proposal_ttl_seconds: policy.proposal_ttl_seconds ?? null,
        rate_limit: policy.rate_limit ?? null,
        required_attention_sinks: Array.isArray(policy.required_attention_sinks)
          ? policy.required_attention_sinks
          : [],
        writer_posture: {
          source: runtimeCapability?.source ?? null,
          reference: source.write_url_env ?? null,
          separation: source.write_url_env && source.write_url_env !== source.read_url_env
            ? "separate_reference"
            : "shared_or_missing_reference",
          hardened: policy.require_least_privilege_writer === true,
          expected_fingerprint: policy.writer_posture_fingerprint ?? null,
          observed_fingerprint: postureState?.observed_fingerprint ?? null,
          status: postureState?.status ?? "not_checked",
          checked_at: postureState?.checked_at ?? null,
          reason_codes: Array.isArray(postureState?.reason_codes)
            ? postureState.reason_codes
            : [],
          allowed_relation_count: postureState?.allowed_relation_count ?? null,
          writable_relation_count: postureState?.writable_relation_count ?? null,
        },
        enable_confirmation: `ENABLE ${capabilityName} ${contractDigest}`,
        disable_confirmation: `DISABLE ${capabilityName} ${contractDigest}`,
        revoke_confirmation: `REVOKE ${capabilityName} ${contractDigest}`,
      };
    }),
    queue,
    start_command: `synapsor-runner worker run --supervised --config ${shellQuoteForWorkbench(configPath)}`,
    controls_are_model_facing: false,
    source_database_changed: items.some((item) => store.getProposal(item.proposal_id)?.source_database_mutated === true),
  };
}

function workbenchWorkerApprovalSource(
  store: ProposalStore,
  proposalId: string,
): "human" | "policy_auto" | "none" {
  const events = store.events(proposalId);
  if (events.some((event) => /policy_auto_approv/.test(event.kind))) return "policy_auto";
  if (store.approvals(proposalId).some((approval) => approval.status === "approved")) return "human";
  return "none";
}

function workbenchWorkerNextAction(item: WorkerQueueItem): string {
  if (item.status === "queued") return "Run or resume the trusted worker, or cancel before it is leased.";
  if (item.status === "leased") return "Let the fenced lease finish; do not start a duplicate manual apply.";
  if (item.status === "retry_wait") return "Runner will retry only after a proven non-commit transient failure.";
  if (item.status === "dead_letter") return "Inspect the retained proposal and receipts, then explicitly requeue or discard.";
  if (item.status === "reconciliation_required") return "Inspect the live source observation and use the established reconciliation path.";
  if (item.status === "blocked") return "Fix the reported policy, digest, scope, limit, or credential condition before re-enabling.";
  if (item.status === "completed") return "Inspect the linked receipt and replay.";
  if (item.status === "cancelled" || item.status === "discarded") return "No worker action remains.";
  return "Inspect the proposal-centered lifecycle before taking operator action.";
}

function workbenchWorkerConfirmation(input: {
  action: WorkerControlAction;
  capability?: string;
  contractDigest?: string;
}): string {
  if (input.action === "pause") return "PAUSE WORKER";
  if (input.action === "resume") return "RESUME WORKER";
  if (input.action === "drain") return "DRAIN WORKER";
  const verb = input.action === "capability_enable"
    ? "ENABLE"
    : input.action === "capability_disable"
      ? "DISABLE"
      : "REVOKE";
  return `${verb} ${input.capability ?? ""} ${input.contractDigest ?? ""}`.trim();
}

function boundedWorkbenchInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`value must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function shellQuoteForWorkbench(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}

function workbenchLifecycleFilters(
  url: URL,
  scope: WorkbenchLedgerScope | undefined,
): ProposalSearchFilters {
  const requestedTenant = nonEmptySearchParam(url, "tenant");
  const requestedPrincipal = nonEmptySearchParam(url, "principal");
  const state = nonEmptySearchParam(url, "state") ?? nonEmptySearchParam(url, "status");
  if (state && !workbenchProposalStates.has(state as LocalProposalState)) {
    throw new Error(`Unsupported lifecycle state filter: ${state}`);
  }
  const rawLimit = nonEmptySearchParam(url, "limit");
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Lifecycle limit must be an integer from 1 through 100.");
  }
  return {
    tenant: scope?.tenant
      ? requestedTenant && requestedTenant !== scope.tenant ? "__outside_workbench_scope__" : scope.tenant
      : requestedTenant,
    principal: scope?.principal
      ? requestedPrincipal && requestedPrincipal !== scope.principal ? "__outside_workbench_scope__" : scope.principal
      : requestedPrincipal,
    capability: nonEmptySearchParam(url, "capability"),
    objectType: nonEmptySearchParam(url, "object_type"),
    objectId: nonEmptySearchParam(url, "object_id"),
    state: state as LocalProposalState | undefined,
    from: validatedWorkbenchDate(url, "from"),
    to: validatedWorkbenchDate(url, "to"),
    limit,
  };
}

function nonEmptySearchParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)?.trim();
  return value ? value : undefined;
}

function validatedWorkbenchDate(url: URL, name: "from" | "to"): string | undefined {
  const value = nonEmptySearchParam(url, name);
  if (!value) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO-8601 date or timestamp.`);
  return value;
}

function proposalMatchesWorkbenchScope(
  proposal: StoredProposal,
  scope: WorkbenchLedgerScope | undefined,
): boolean {
  if (scope?.tenant && proposal.tenant_id !== scope.tenant) return false;
  if (scope?.principal && (proposal.principal ?? proposal.change_set.principal.id) !== scope.principal) return false;
  return scope?.required !== true || Boolean(scope.tenant);
}

function workbenchLifecycleProjection(
  view: LifecycleViewV1,
): JsonRecord & { next: LifecycleViewV1["next"] } {
  const fieldNames = (value: unknown): string[] =>
    Object.keys(isRecord(value) ? value : {}).sort();
  const timeline = view.timeline.map((item) => {
    const payload = asRecord(item.payload);
    return {
      sequence: item.sequence ?? null,
      occurred_at: item.occurred_at ?? null,
      kind: item.kind ?? "unknown",
      actor: item.actor ?? null,
      summary: Object.fromEntries([
        "status",
        "state",
        "safe_code",
        "safe_error_code",
        "reason",
        "approval_progress",
        "tripped_limits",
        "rows_affected",
        "source_database_changed",
        "source_database_mutated",
        "event_id",
        "replay_id",
        "proposal_state",
      ].filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]])),
    };
  });
  return {
    ...view,
    proposal: {
      ...view.proposal,
      change: {
        before_fields: fieldNames(view.proposal.change.before),
        changed_fields: fieldNames(view.proposal.change.patch),
        after_fields: fieldNames(view.proposal.change.after),
        frozen_member_count: Array.isArray(view.proposal.change.frozen_set)
          ? view.proposal.change.frozen_set.length
          : 0,
      },
      guards: {
        reviewed: true,
        fields: fieldNames(view.proposal.guards),
      },
    },
    evidence: {
      count: view.evidence.count,
      bundles: view.evidence.bundles.map((bundle) => ({
        evidence_bundle_id: bundle.evidence_bundle_id ?? null,
        proposal_id: bundle.proposal_id ?? null,
        capability: bundle.capability ?? null,
        source_id: bundle.source_id ?? null,
        source_table: bundle.source_table ?? null,
        business_object: bundle.business_object ?? null,
        object_id: bundle.object_id ?? null,
        query_fingerprint: bundle.query_fingerprint ?? null,
        item_count: Array.isArray(bundle.items) ? bundle.items.length : 0,
        created_at: bundle.created_at ?? null,
      })),
    },
    query_audit: {
      count: view.query_audit.count,
      records: view.query_audit.records.map((record) => ({
        audit_id: record.audit_id ?? null,
        proposal_id: record.proposal_id ?? null,
        evidence_bundle_id: record.evidence_bundle_id ?? null,
        capability: record.capability ?? null,
        query_fingerprint: record.query_fingerprint ?? null,
        row_count: record.row_count ?? null,
        created_at: record.created_at ?? null,
      })),
    },
    writeback: {
      jobs: view.writeback.jobs.map(workbenchWritebackRecord),
      intents: view.writeback.intents.map(workbenchWritebackRecord),
      worker_queue: view.writeback.worker_queue
        ? workbenchWritebackRecord(view.writeback.worker_queue)
        : null,
      receipts: view.writeback.receipts.map(workbenchReceiptRecord),
      latest_outcome: view.writeback.latest_outcome
        ? workbenchReceiptRecord(view.writeback.latest_outcome)
        : null,
    },
    compensation: {
      requested: view.compensation.requested,
      lineage: view.compensation.lineage,
      inverse_receipt_count: view.compensation.inverse_receipts.length,
    },
    timeline,
  };
}

function workbenchWritebackRecord(record: Record<string, unknown>): JsonRecord {
  return Object.fromEntries([
    "writeback_job_id",
    "intent_id",
    "proposal_id",
    "proposal_hash",
    "runner_id",
    "kind",
    "executor",
    "operation",
    "status",
    "attempt_count",
    "attempts",
    "max_attempts",
    "last_error_code",
    "reconciliation_reason",
    "created_at",
    "updated_at",
  ].filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

function workbenchReceiptRecord(record: Record<string, unknown>): JsonRecord {
  return Object.fromEntries([
    "receipt_id",
    "writeback_job_id",
    "proposal_id",
    "runner_id",
    "status",
    "receipt_authority",
    "operation",
    "rows_affected",
    "source_database_mutated",
    "safe_outcome_code",
    "safe_error_code",
    "receipt_hash",
    "executed_at",
    "created_at",
  ].filter((key) => record[key] !== undefined).map((key) => [key, record[key]]));
}

async function resolveWorkbenchDeploymentProfile(
  projectRoot: string,
  configured: WorkbenchDeploymentProfile | undefined,
): Promise<WorkbenchDeploymentProfile> {
  if (configured) return configured;
  const active = await loadActivatedExplorationBoundary(projectRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  const draft = await readOptionalJson(path.join(projectRoot, "synapsor/generated/exploration-boundary.draft.json"));
  const profile = isRecord(active)
    ? active.deployment_profile
    : isRecord(draft)
      ? draft.deployment_profile
      : undefined;
  return profile === "development" || profile === "staging" || profile === "production"
    ? profile
    : "unknown";
}

async function workbenchOperatorPosture(configPath: string): Promise<JsonRecord> {
  const rawConfig = await readOptionalJson(path.resolve(configPath));
  const operator = isRecord(rawConfig) ? asRecord(rawConfig.operator_identity) : {};
  const provider = operator.provider === "signed_key" || operator.provider === "jwt_oidc"
    ? operator.provider
    : "dev_env";
  const applyRoles = Array.isArray(operator.apply_roles)
    ? operator.apply_roles.filter((role): role is string => typeof role === "string")
    : [];
  return {
    provider,
    verified_required: provider !== "dev_env",
    apply_roles: [...new Set(applyRoles)].sort(),
    workbench_identity_input: provider === "jwt_oidc"
      ? "bearer_token_per_decision"
      : provider === "signed_key"
        ? "trusted_cli_required"
        : "development_actor",
  };
}

function workbenchIdentityToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Operator identity token must be a string.");
  const token = value.trim();
  if (token.length < 16 || token.length > 16_384) {
    throw new Error("Operator identity token length is outside the accepted bound.");
  }
  return token;
}

function stringValueOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function workbenchDecisionFailure(
  error: unknown,
  action: "approval" | "apply" | "attention acknowledgement" | "worker control" | "worker queue action",
): JsonRecord {
  const raw = error instanceof Error ? error.message : String(error);
  const message = raw
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9._~-]{16,}\b/g, "<redacted>");
  return {
    ok: false,
    error: message,
    source_database_changed: false,
    next_action: action === "approval"
      ? "Refresh the lifecycle, verify the exact proposal and reviewer role, then submit a fresh decision."
      : action === "attention acknowledgement"
        ? "Refresh the inbox, authenticate through the configured operator identity, then acknowledge the same item."
      : "Refresh the lifecycle and resolve the reported apply-role, freshness, conflict, or reconciliation requirement.",
  };
}

function workbenchApprovalExitFailure(code: number): {
  error: string;
  errorCode: string;
  nextAction: string;
} {
  if (code === 3) {
    return {
      error: "Approval stopped because the proposal or its supporting evidence is stale. No approval was recorded.",
      errorCode: "APPROVAL_FRESHNESS_STALE",
      nextAction: "Read the current source state and create a new proposal for the exact effect.",
    };
  }
  if (code === 4) {
    return {
      error: "Approval stopped because Runner could not verify the current source state. No approval was recorded.",
      errorCode: "APPROVAL_FRESHNESS_UNAVAILABLE",
      nextAction: "Restore read access to the source, then run the freshness check again.",
    };
  }
  if (code === 5 || code === 6) {
    return {
      error: "Approval stopped because the reviewed freshness configuration cannot be verified. No approval was recorded.",
      errorCode: code === 5 ? "APPROVAL_FRESHNESS_INVALID" : "APPROVAL_FRESHNESS_UNSUPPORTED",
      nextAction: "Fix and reactivate the reviewed capability before creating a new proposal.",
    };
  }
  return {
    error: "Approval did not complete. The proposal and source database were left unchanged.",
    errorCode: "APPROVAL_COMMAND_FAILED",
    nextAction: `Open the refreshed lifecycle and resolve the reported freshness or identity requirement (status ${code}).`,
  };
}

function requireProposal(store: ProposalStore, proposalId: string): StoredProposal {
  const proposal = store.getProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  return proposal;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be a JSON object");
  return parsed;
}

async function readOptionalJson(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function recommendedWorkbenchCandidate(
  draft: ExplorationBoundaryDraft,
  maximumResources = 3,
): ExplorationBoundaryDraft {
  return recommendedBoundaryReviewCandidate(draft, maximumResources);
}

export function instantWorkbenchCandidate(draft: ExplorationBoundaryDraft): ExplorationBoundaryDraft {
  return instantLocalBoundaryCandidate(draft);
}

function trustedSessionValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Instant onboarding requires a trusted ${label} value.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Instant onboarding requires a non-empty trusted ${label} value of at most 256 characters.`);
  }
  return normalized;
}

function restoreTrustedSessionValue(
  target: Record<string, string>,
  name: string,
  previous: string | undefined,
): void {
  if (previous === undefined) delete target[name];
  else target[name] = previous;
}

function instantActivationActor(): string {
  const candidate = process.env.SYNAPSOR_OPERATOR_ID?.trim()
    || process.env.USER?.trim()
    || "local-developer";
  return candidate.length <= 128 && !/[\u0000-\u001f\u007f]/.test(candidate)
    ? candidate
    : "local-developer";
}

export async function readBoundaryReviewProgress(
  projectRoot: string,
  draft: ExplorationBoundaryDraft,
): Promise<import("./boundary-review-domain.js").BoundaryReviewProgress | undefined> {
  return readSharedBoundaryReviewProgress(projectRoot, draft);
}

function normalizePartialReviewDecisions(required: string[], confirmed: string[]): string[] {
  return normalizeSharedPartialReviewDecisions(required, confirmed);
}

export function createBoundaryReviewProgress(input: {
  draft: ExplorationBoundaryDraft;
  candidate: ExplorationBoundaryDraft;
  confirmedDecisions: string[];
  previous?: BoundaryReviewProgress;
  actor?: string;
  revision: number;
  now?: string;
}): BoundaryReviewProgress {
  return createSharedBoundaryReviewProgress(input);
}

export async function saveBoundaryReviewProgress(
  projectRoot: string,
  progress: BoundaryReviewProgress,
): Promise<void> {
  await saveSharedBoundaryReviewProgress(projectRoot, progress);
}

function reconcileBoundaryReviewProgress(
  previous: BoundaryReviewProgress | undefined,
  draft: ExplorationBoundaryDraft,
  reviewOverrides?: AutoBoundaryReviewOverrides,
): BoundaryReviewProgress | undefined {
  return reconcileSharedBoundaryReviewProgress(previous, draft, reviewOverrides);
}

function mergeBoundaryReviewInvalidations(
  previous: BoundaryReviewInvalidation[],
  next: BoundaryReviewInvalidation[],
): BoundaryReviewInvalidation[] {
  const merged = new Map(previous.map((item) => [`${item.id}:${item.previous_input_digest}`, item]));
  for (const item of next) merged.set(`${item.id}:${item.previous_input_digest}`, item);
  return [...merged.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(-200);
}

export function boundaryReviewDecisions(candidate: ExplorationBoundaryDraft): BoundaryReviewDecision[] {
  return sharedBoundaryReviewDecisions(candidate);
}

function legacyBoundaryReviewDecisions(candidate: ExplorationBoundaryDraft): BoundaryReviewDecision[] {
  const resources = new Map(candidate.pack.resources.map((resource) => [resource.id, resource]));
  return candidate.unresolved_decisions.map((decision) => {
    if (decision.startsWith("deployment profile:")) {
      return reviewDecision("global.deployment_profile", "deployment_profile", decision, {
        deployment_profile: candidate.deployment_profile,
      });
    }
    if (decision.startsWith("trusted context:")) {
      return reviewDecision("global.trusted_context", "trusted_context", decision, candidate.trusted_context);
    }
    if (decision.startsWith("database role:")) {
      return reviewDecision("global.database_role", "database_role", decision, {
        role_posture_fingerprint: candidate.role_posture_fingerprint,
      });
    }
    const separator = decision.indexOf(": ");
    if (separator < 1) {
      return reviewDecision(
        `other.${reviewDecisionSuffix(decision)}`,
        "other",
        decision,
        { decision },
      );
    }
    const resourceId = decision.slice(0, separator);
    const detail = decision.slice(separator + 2);
    const resource = resources.get(resourceId);
    if (!resource) {
      return reviewDecision(
        `resource.${resourceId}.blocked.${reviewDecisionSuffix(detail)}`,
        "resource_blocker",
        decision,
        { resource_id: resourceId, blocker: detail },
        resourceId,
      );
    }
    if (detail.startsWith("confirm tenant key ")) {
      return reviewDecision(`resource.${resourceId}.tenant_scope`, "tenant_scope", decision, {
        tenant_key: resource.tenant_key,
        trusted_tenant_env: candidate.trusted_context.tenant_env,
        rls_session: resource.rls_session ?? null,
      }, resourceId);
    }
    if (detail.startsWith("confirm principal scope ")) {
      return reviewDecision(`resource.${resourceId}.principal_scope`, "principal_scope", decision, {
        principal_key: resource.principal_key ?? null,
        trusted_principal_env: candidate.trusted_context.principal_env,
        rls_session: resource.rls_session ?? null,
      }, resourceId);
    }
    if (detail === "confirm visible and kept-out fields") {
      return reviewDecision(`resource.${resourceId}.field_visibility`, "field_visibility", decision, {
        selectable_fields: resource.selectable_fields,
        ...(resource.model_withheld_fields?.length
          ? { model_withheld_fields: resource.model_withheld_fields }
          : {}),
        kept_out_fields: resource.kept_out_fields,
      }, resourceId);
    }
    if (detail === "confirm filter/sort/group/aggregate-only field permissions") {
      return reviewDecision(`resource.${resourceId}.field_permissions`, "field_permissions", decision, {
        filterable_fields: resource.filterable_fields,
        sortable_fields: resource.sortable_fields,
        groupable_fields: resource.groupable_fields,
        aggregate_measures: resource.aggregate_measures,
        count_distinct_fields: resource.count_distinct_fields,
        time_bucket_fields: resource.time_bucket_fields,
      }, resourceId);
    }
    if (detail === "confirm minimum cohort and extraction/differencing budgets") {
      return reviewDecision(`resource.${resourceId}.privacy_budgets`, "privacy_budgets", decision, {
        minimum_cohort_size: resource.minimum_cohort_size,
        ...(resource.minimum_cohort_overridden ? { minimum_cohort_overridden: true } : {}),
        suppression_aware_totals: resource.suppression_aware_totals,
        budgets: candidate.budgets,
      }, resourceId);
    }
    const relationship = /^review relationship (.+) cardinality and scope on (.+)$/.exec(detail);
    if (relationship) {
      const relationshipId = relationship[1]!;
      const targetResource = resources.get(relationship[2]!);
      return reviewDecision(
        `resource.${resourceId}.relationship.${relationshipId}`,
        "relationship",
        decision,
        {
          relationship: resource.relationships.find((item) => item.id === relationshipId) ?? null,
          source_scope: {
            tenant_key: resource.tenant_key,
            principal_key: resource.principal_key ?? null,
          },
          target_scope: targetResource ? {
            tenant_key: targetResource.tenant_key,
            principal_key: targetResource.principal_key ?? null,
          } : null,
        },
        resourceId,
      );
    }
    return reviewDecision(
      `resource.${resourceId}.other.${reviewDecisionSuffix(detail)}`,
      "resource_other",
      decision,
      { resource_id: resourceId, detail },
      resourceId,
    );
  });
}

function reviewDecision(
  id: string,
  kind: string,
  decision: string,
  reviewedInput: unknown,
  resourceId?: string,
): BoundaryReviewDecision {
  return {
    id,
    kind,
    decision,
    input_digest: canonicalJsonDigest({
      schema_version: "synapsor.boundary-review-input.v1",
      decision_kind: kind,
      reviewed_input: reviewedInput,
    }),
    ...(resourceId ? { resource_id: resourceId } : {}),
  };
}

function reviewDecisionSuffix(value: string): string {
  return canonicalJsonDigest({ value }).slice("sha256:".length, "sha256:".length + 16);
}

async function writePrivateJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function hasValidCsrf(request: IncomingMessage, csrfToken: string): boolean {
  return request.headers["x-synapsor-csrf"] === csrfToken;
}

function workbenchSessionCredential(request: IncomingMessage): string | undefined {
  const header = request.headers["x-synapsor-ui-token"];
  if (typeof header === "string" && header.length > 0) return header;
  const cookies = parseCookies(String(request.headers.cookie ?? ""));
  return cookies.synapsor_ui_token;
}

type WorkbenchAuthentication =
  | { ok: true }
  | {
    ok: false;
    errorCode: "WORKBENCH_SESSION_REQUIRED" | "WORKBENCH_SESSION_EXPIRED" | "WORKBENCH_SESSION_INVALID";
    message: string;
  };

function authenticateWorkbenchSession(
  request: IncomingMessage,
  state: WorkbenchSessionState,
  renewIdleDeadline: boolean,
): WorkbenchAuthentication {
  const credential = workbenchSessionCredential(request);
  const usesHeader = typeof request.headers["x-synapsor-ui-token"] === "string";
  if (!credential) {
    return {
      ok: false,
      errorCode: "WORKBENCH_SESSION_REQUIRED",
      message: "A local Workbench session is required.",
    };
  }
  const authorizedTransport = state.consumed
    || (usesHeader && state.allowHeaderSessionBeforeBootstrap);
  if (credential !== state.sessionToken || !authorizedTransport
    || state.issuedAtMs === undefined || state.lastSeenAtMs === undefined) {
    return {
      ok: false,
      errorCode: "WORKBENCH_SESSION_INVALID",
      message: "This local Workbench session is no longer valid.",
    };
  }
  const now = state.now();
  if (now - state.lastSeenAtMs >= state.idleTimeoutMs
    || now - state.issuedAtMs >= state.absoluteTimeoutMs) {
    return {
      ok: false,
      errorCode: "WORKBENCH_SESSION_EXPIRED",
      message: "Your local Workbench session expired.",
    };
  }
  if (renewIdleDeadline) state.lastSeenAtMs = now;
  return { ok: true };
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) continue;
    result[rawKey] = decodeURIComponent(rest.join("="));
  }
  return result;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(`${JSON.stringify(redactSecrets(payload), null, 2)}\n`);
}

function askWorkbenchAccessFailure(
  profile: WorkbenchDeploymentProfile,
  host: string,
): string | undefined {
  if (!isLocalHost(host)) {
    return "Ask is available only from the local loopback Workbench authoring surface.";
  }
  if (profile !== "development" && profile !== "staging") {
    return "Ask is disabled unless trusted Runner launch or operator configuration establishes a development or staging authoring profile.";
  }
  return undefined;
}

async function workbenchAskAuthority(input: {
  tools: AskToolDefinition[];
  configPath: string;
  projectRoot: string;
  profile: WorkbenchDeploymentProfile;
  mode: AskMode;
}): Promise<{
  authority_digest: `sha256:${string}`;
  mode: AskMode;
  tool_surface_digest: `sha256:${string}`;
  runtime_config_digest: `sha256:${string}`;
  active_boundary_digest?: `sha256:${string}`;
  active_boundary_set_digest?: `sha256:${string}`;
  active_boundary_digests?: `sha256:${string}`[];
}> {
  return computeAskAuthority(input);
}

async function rebindConfiguredWorkbenchAskSession(input: {
  askSession: WorkbenchAskSession;
  askGatewayFactory: WorkbenchAskGatewayFactory;
  configPath: string;
  storePath: string;
  projectRoot: string;
  profile: WorkbenchDeploymentProfile;
  env: NodeJS.ProcessEnv;
}): Promise<ReturnType<WorkbenchAskSession["rebindAuthority"]> | undefined> {
  const status = input.askSession.status();
  if (!status.configuration) return undefined;
  let gateway: AskToolGateway | undefined;
  try {
    gateway = await input.askGatewayFactory({
      configPath: input.configPath,
      storePath: input.storePath,
      projectRoot: input.projectRoot,
      env: input.env,
      mode: "authoring",
    });
    const tools = await gateway.listTools();
    const authority = await workbenchAskAuthority({
      tools,
      configPath: input.configPath,
      projectRoot: input.projectRoot,
      profile: input.profile,
      mode: "authoring",
    });
    return status.configuration.authority_digest === authority.authority_digest
      ? status.configuration
      : input.askSession.rebindAuthority(authority.authority_digest);
  } finally {
    await gateway?.close().catch(() => undefined);
  }
}

function askGatewayMode(gateway: AskToolGateway, tools: AskToolDefinition[]): AskMode {
  if (gateway.mode) return gateway.mode;
  const names = tools.map((tool) => tool.name).sort();
  return names.length === 2
    && names[0] === "app.describe_data"
    && names[1] === "app.explore_data"
    ? "authoring"
    : "runtime";
}

function isBoundarySetRuntime(
  runtime: WorkbenchScopedExploreRuntime,
): runtime is ScopedExploreBoundarySetRuntime {
  return "active_boundary_set_digest" in runtime;
}

async function describeWorkbenchExploreCatalog(
  runtime: WorkbenchScopedExploreRuntime,
  includeTimeCoverage = true,
): Promise<Record<string, unknown>> {
  const resources: Record<string, unknown>[] = [];
  let first: Record<string, unknown> | undefined;
  let cursor: number | undefined;
  for (let page = 0; page < 100; page += 1) {
    const described = await runtime.describe({
      limit: 10,
      ...(cursor === undefined ? {} : { cursor }),
      include_time_coverage: includeTimeCoverage,
    });
    first ??= described;
    if (Array.isArray(described.resources)) {
      resources.push(...described.resources.filter(isRecord));
    }
    cursor = typeof described.next_cursor === "number"
      ? described.next_cursor
      : undefined;
    if (cursor === undefined) {
      return {
        ...(first ?? described),
        resources,
        next_cursor: null,
      };
    }
  }
  throw new ScopedExploreError(
    "EXPLORE_PLAN_INVALID",
    "The reviewed Workbench catalog exceeded its fixed pagination limit.",
  );
}

async function revalidateWorkbenchAskAuthority(input: {
  askGatewayFactory: WorkbenchAskGatewayFactory;
  configPath: string;
  storePath: string;
  projectRoot: string;
  profile: WorkbenchDeploymentProfile;
  mode: AskMode;
  env: NodeJS.ProcessEnv;
}): Promise<`sha256:${string}`> {
  let gateway: AskToolGateway | undefined;
  try {
    gateway = await input.askGatewayFactory({
      configPath: input.configPath,
      storePath: input.storePath,
      projectRoot: input.projectRoot,
      env: input.env,
      mode: input.mode,
    });
    const tools = await gateway.listTools();
    if (askGatewayMode(gateway, tools) !== input.mode) {
      throw new AskError(
        "ASK_AUTHORITY_CHANGED",
        "Ask mode changed during the provider session.",
        409,
      );
    }
    return (await computeAskAuthority({
      tools,
      configPath: input.configPath,
      projectRoot: input.projectRoot,
      profile: input.profile,
      mode: input.mode,
    })).authority_digest;
  } finally {
    await gateway?.close().catch(() => undefined);
  }
}

function askProviderValue(value: unknown): AskProvider {
  if (value === "openai" || value === "anthropic" || value === "openai_compatible") return value;
  throw new AskError("ASK_PROVIDER_INVALID", "Choose OpenAI, Anthropic, or an OpenAI-compatible provider.");
}

function askStringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AskError("ASK_INPUT_INVALID", "A required Ask field is missing.");
  }
  return value.trim();
}

function askNumberValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AskError("ASK_TIMEOUT_INVALID", "Model request timeout must be a number of seconds.");
  }
  return value;
}

function askProviderDisplayName(provider: AskProvider): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  return "the configured OpenAI-compatible provider";
}

function workbenchAskProposalId(result: Record<string, unknown>): string | undefined {
  if (typeof result.proposal_id === "string") return result.proposal_id;
  const proposal = asRecord(result.proposal);
  if (typeof proposal.proposal_id === "string") return proposal.proposal_id;
  if (typeof proposal.id === "string") return proposal.id;
  const changeSet = asRecord(result.change_set);
  return typeof changeSet.proposal_id === "string" ? changeSet.proposal_id : undefined;
}

function withWorkbenchProtectQueryRef(result: Record<string, unknown>): Record<string, unknown> {
  const protect = asRecord(result.protect);
  const token = typeof protect.token === "string" && /^A[1-9][0-9]*$/.test(protect.token)
    ? protect.token
    : undefined;
  return token
    ? {
      ...result,
      protect: {
        ...protect,
        query_ref: token,
      },
    }
    : result;
}

function withWorkbenchAskQueryRefs<T extends {
  tool_calls: Array<{ result: Record<string, unknown> }>;
}>(result: T): T {
  return {
    ...result,
    tool_calls: result.tool_calls.map((call) => ({
      ...call,
      result: withWorkbenchProtectQueryRef(call.result),
    })),
  };
}

function sendAskFailure(response: ServerResponse, error: unknown): void {
  const failure = error instanceof AskError
    ? error
    : new AskError("ASK_INTERNAL", "Ask failed safely without changing the source database.", 500);
  sendJson(response, failure.httpStatus, {
    ok: false,
    error_code: failure.code,
    error: failure.message,
    source_database_changed: false,
    next_action: askFailureNextAction(failure.code),
  });
}

function askFailureNextAction(code: string): string {
  if (code === "ASK_AUTHORITY_CHANGED") {
    return "Reload Ask, inspect the current reviewed tools, and acknowledge provider egress again.";
  }
  if (code === "ASK_PROVIDER_AUTHENTICATION_FAILED") {
    return "Change the provider credential. Paste only the key value, not an OPENAI_API_KEY= or ANTHROPIC_API_KEY= assignment.";
  }
  if (code === "ASK_PROVIDER_PERMISSION_DENIED") {
    return "Review the provider key's project and model permissions, or choose another provider or model.";
  }
  if (code === "ASK_SESSION_TOKEN_BUDGET_EXCEEDED"
    || code === "ASK_SESSION_TOKEN_BUDGET_BELOW_USAGE") {
    return "Open Ask limits and raise the reported-token session budget without clearing the conversation, or clear only when you intend to discard its context.";
  }
  if (code === "ASK_PROVIDER_RATE_LIMITED") {
    return "Wait for the provider limit to reset, review provider quota, or choose another configured model.";
  }
  if (code === "ASK_CANCELLED") {
    return "Ask another question when ready.";
  }
  return "Correct the reported Ask configuration or use the no-model composer.";
}

function sendLifecycleError(response: ServerResponse, error: unknown): void {
  if (error instanceof LifecycleViewError) {
    const status = error.code.includes("NOT_FOUND")
      ? 404
      : error.code.includes("CORRUPT")
        ? 409
        : 400;
    sendJson(response, status, {
      ok: false,
      error: error.message,
      source_database_changed: false,
      next_action: status === 404
        ? "Open recent activity and choose a lifecycle, or verify the handle."
        : "Correct the filter or explicit handle namespace and retry.",
    });
    return;
  }
  sendJson(response, 400, {
    ok: false,
    error: error instanceof Error ? error.message : "Lifecycle request failed.",
    source_database_changed: false,
    next_action: "Correct the lifecycle filter and retry.",
  });
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.end(html);
}

function sendRedirect(response: ServerResponse, location: string): void {
  response.statusCode = 303;
  response.setHeader("location", location);
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.end();
}

function renderBoundaryShell(csrfToken: string): string {
  const escapedCsrf = escapeScriptString(csrfToken);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Auto Boundary Review | Synapsor Runner</title>
  <style>
    :root{color-scheme:light dark;--bg:#f4f7f7;--surface:#fff;--text:#172126;--muted:#5d6b70;--line:#d5dfe1;--accent:#087f73;--warn:#9a6700;--bad:#b42318;--good:#137333}
    @media(prefers-color-scheme:dark){:root{--bg:#111718;--surface:#192124;--text:#edf3f2;--muted:#aab7b8;--line:#344247;--accent:#55c9b9;--warn:#f4c86a;--bad:#ff8d84;--good:#70d58c}}
    *{box-sizing:border-box;letter-spacing:0}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}header{background:var(--surface);border-bottom:1px solid var(--line)}header div,main{width:min(1180px,calc(100% - 32px));margin:auto}header div{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:20px;margin:0}h2{font-size:16px;margin:28px 0 10px}h3{font-size:15px;margin:0}main{padding:24px 0 48px}.state{color:var(--warn);font-weight:700}.notice{background:var(--surface);border-left:3px solid var(--warn);padding:12px 14px}.notice.compatibility{margin-top:12px}.notice.compatibility.full{border-left-color:var(--good)}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));background:var(--surface);border:1px solid var(--line)}.metric{padding:14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.metric strong{display:block;font-size:22px}.metric span,.scope{color:var(--muted)}.resource{padding:16px 0;border-top:1px solid var(--line)}.resource-head{display:flex;justify-content:space-between;gap:12px}.resource-toggle,.relationship{display:flex;align-items:center;gap:8px}.relationships{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:12px;padding:10px;background:var(--bg)}.panel{background:var(--surface);border:1px solid var(--line);padding:16px}.posture{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);gap:16px;align-items:start}.posture>*{min-width:0}.posture label{display:flex;flex-direction:column;gap:6px;color:var(--muted)}.posture code{overflow-wrap:anywhere;word-break:break-all}.query{display:block;width:100%;text-align:left;margin:8px 0;background:transparent;color:var(--text);border-color:var(--line)}.query.selected{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 20%,transparent)}table{width:100%;table-layout:fixed;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{color:var(--muted);font-size:12px}th:first-child{width:30%}code,pre{font:12px ui-monospace,monospace}pre{white-space:pre-wrap;overflow:auto;max-height:360px;background:var(--bg);border:1px solid var(--line);padding:12px}input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent)}input[type=text],input[type=number],textarea,select{width:100%;min-height:36px;padding:7px 9px;border:1px solid var(--line);border-radius:4px;background:var(--surface);color:var(--text)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.budgets,.protect-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.budgets label,.protect-fields label{display:flex;flex-direction:column;gap:5px;color:var(--muted)}.literal{margin:10px 0;padding:10px;border:1px solid var(--line)}.literal label:first-child{display:flex;flex-direction:row;align-items:center;gap:8px}.actions{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:24px;padding:14px;background:var(--surface);border:1px solid var(--line)}button{min-height:38px;padding:8px 14px;border:1px solid var(--accent);border-radius:4px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}button.secondary{background:transparent;color:var(--accent)}button:disabled{opacity:.5;cursor:not-allowed}#message,#protect-message{flex:1 1 260px;min-height:20px;color:var(--muted)}.error{color:var(--bad)!important}.success{color:var(--good)!important}
    ${WORKBENCH_SYNTAX_CSS}
    @media(max-width:760px){.summary,.budgets{grid-template-columns:1fr 1fr}.posture{grid-template-columns:1fr}.actions{position:static}table{font-size:12px}th:first-child{width:38%}}@media(max-width:480px){header div,main{width:calc(100% - 20px)}.summary,.budgets,.protect-fields{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid var(--line)}.resource-head{flex-direction:column}}
  </style>
</head>
<body>
  <header><div><h1>Synapsor Auto Boundary</h1><span id="state" class="state">Loading review</span></div></header>
  <main>
    <p>Review a temporary local authoring boundary. Existing active Runner tools remain unchanged.</p>
    <div class="notice">Source rows remain unavailable until this exact digest is activated. Approval, apply, and commit are never added to MCP.</div>
    <div id="database-compatibility" class="notice compatibility" role="status" hidden></div>
    <h2>Application Summary</h2><div id="summary" class="summary"></div>
    <h2>Authoring Posture</h2>
    <section class="panel posture">
      <label>Deployment profile
        <select id="deployment-profile"><option value="staging">Staging</option><option value="development">Development</option></select>
      </label>
      <div id="role-posture"></div>
    </section>
    <h2>Blocked Objects And Disabled Actions</h2><div id="blocked" class="panel"></div>
    <h2>Resources And Fields</h2><p>Keep only the resources, relationships, and field uses this authoring pack needs. You may add kept-out fields; generated kept-out fields cannot be restored.</p><div id="resources"></div>
    <h2>Privacy And Query Limits</h2><div id="budgets" class="budgets"></div>
    <h2>Required Confirmations</h2><div id="decisions"></div>
    <h2>Protect This Query</h2>
    <section class="panel">
      <p>After Cursor runs a reviewed local exploration, choose it here. Runner generates public DSL, canonical JSON, tests, and a disabled named capability. No opaque token needs to be copied.</p>
      <button id="refresh-protect" class="secondary" type="button">Refresh recent queries</button>
      <div id="protect-queries"></div>
      <div id="protect-editor"></div>
      <span id="protect-message" role="status" aria-live="polite"></span>
    </section>
    <div class="actions">
      <button id="preview" class="secondary" type="button">Preview exact digest</button>
      <input id="actor" type="text" maxlength="128" placeholder="Local operator identity" aria-label="Local operator identity">
      <button id="activate" type="button" disabled>Activate reviewed digest</button>
      <span id="message" role="status" aria-live="polite"></span>
    </div>
  </main>
  <script>
    ${workbenchSyntaxScript()}
    const csrf="${escapedCsrf}";let original,candidate,digest,reviewReport,reviewDecisions=[],protectQueries=[],selectedProtect=null,protectedDraft=null;
    const msg=document.getElementById("message");
    const permissions=[["raw","selectable_fields"],["filter","filterable_fields"],["sort","sortable_fields"],["group","groupable_fields"],["sum/avg","aggregate_measures"],["count distinct","count_distinct_fields"],["time","time_bucket_fields"]];
    const esc=v=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const post=async(url,body)=>{const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-synapsor-csrf":csrf},body:JSON.stringify(body)});const p=await r.json();if(!r.ok||!p.ok)throw new Error(p.error||"Request failed");return p};
    const has=(r,f,k)=>k==="filterable_fields"||k==="time_bucket_fields"?Object.hasOwn(r[k],f):r[k].includes(f);
    const currentResource=id=>candidate.pack.resources.find(r=>r.id===id);
    const scopePathLabel=scope=>{const links=scope?.proof?.links||[];const resources=[];if(links[0]?.source_resource)resources.push(links[0].source_resource);links.forEach(link=>{if(resources.at(-1)!==link.source_resource)resources.push(link.source_resource);if(resources.at(-1)!==link.target_resource)resources.push(link.target_resource)});if(resources.at(-1)!==scope.ancestor_resource)resources.push(scope.ancestor_resource);if(!resources.length)resources.push(scope.ancestor_resource);const shown=resources.map(resource=>resource.startsWith("public.")?resource.slice(7):resource);shown[shown.length-1]=shown.at(-1)+"."+scope.ancestor_column;return shown.join(" → ")};
    const scopeLabel=(resource,kind)=>{const direct=resource[kind+"_key"];if(direct)return direct;if(kind==="tenant"&&resource.shared_reference_scope)return "Shared reference; no tenant predicate";const scope=resource[kind+"_scope"];return scope?"mandatory relationship path "+scopePathLabel(scope):"not configured"};
    const reviewDecisionLabel=item=>{const separator=item.indexOf(":");if(separator<1)return item;const resource=currentResource(item.slice(0,separator));if(item.includes(": confirm mandatory derived tenant scope ")&&resource?.tenant_scope)return resource.id+": confirm customer isolation through "+scopePathLabel(resource.tenant_scope);if(item.includes(": confirm mandatory derived principal scope ")&&resource?.principal_scope)return resource.id+": confirm user/owner isolation through "+scopePathLabel(resource.principal_scope);return item};
    function allDecisionsConfirmed(){return reviewDecisions.length>0&&document.querySelectorAll("[data-review-decision]:checked").length===reviewDecisions.length}
    function updateActivationState(){document.getElementById("activate").disabled=!digest||!allDecisionsConfirmed()}
    function changed(){digest=undefined;updateActivationState()}
    function removeFieldAuthority(resource,field){resource.selectable_fields=resource.selectable_fields.filter(v=>v!==field);delete resource.filterable_fields[field];resource.sortable_fields=resource.sortable_fields.filter(v=>v!==field);resource.groupable_fields=resource.groupable_fields.filter(v=>v!==field);resource.aggregate_measures=resource.aggregate_measures.filter(v=>v!==field);resource.count_distinct_fields=resource.count_distinct_fields.filter(v=>v!==field);delete resource.time_bucket_fields[field];resource.relationships=resource.relationships.filter(r=>!r.local_columns.includes(field))}
    function setPermission(resource,field,key,checked){const source=original.pack.resources.find(r=>r.id===resource.id);if(resource.kept_out_fields.includes(field)&&checked)return;if(key==="filterable_fields"||key==="time_bucket_fields"){if(checked)resource[key][field]=structuredClone(source[key][field]);else delete resource[key][field]}else if(checked&&!resource[key].includes(field))resource[key].push(field);else if(!checked)resource[key]=resource[key].filter(v=>v!==field);changed()}
    function setResource(source,checked){if(checked&&!currentResource(source.id)){candidate.pack.resources.push(structuredClone(source));candidate.pack.resources.sort((a,b)=>a.id.localeCompare(b.id))}else if(!checked){candidate.pack.resources=candidate.pack.resources.filter(r=>r.id!==source.id);candidate.pack.resources.forEach(r=>{r.relationships=r.relationships.filter(rel=>rel.target_resource!==source.id)})}changed();renderResources()}
    function setKeptOut(source,field,checked){const resource=currentResource(source.id);if(!resource)return;if(source.kept_out_fields.includes(field)&&!checked)return;if(checked){if(!resource.kept_out_fields.includes(field))resource.kept_out_fields.push(field);removeFieldAuthority(resource,field);candidate.pack.resources.forEach(r=>{r.relationships=r.relationships.filter(rel=>!(rel.target_resource===resource.id&&rel.target_columns.includes(field)))})}else resource.kept_out_fields=resource.kept_out_fields.filter(v=>v!==field);changed();renderResources()}
    function setRelationship(source,relationship,checked){const resource=currentResource(source.id);if(!resource)return;if(checked){const target=currentResource(relationship.target_resource);if(!target||relationship.local_columns.some(field=>resource.kept_out_fields.includes(field))||relationship.target_columns.some(field=>target.kept_out_fields.includes(field)))return;if(!resource.relationships.some(item=>item.id===relationship.id))resource.relationships.push(structuredClone(relationship))}else resource.relationships=resource.relationships.filter(item=>item.id!==relationship.id);changed();renderResources()}
    function renderResources(){document.getElementById("resources").innerHTML=original.pack.resources.map((source,i)=>{const resource=currentResource(source.id);const included=Boolean(resource);const fields=Object.keys(source.field_types).sort();const relations=included&&source.relationships.length?'<div class="relationships">'+source.relationships.map((relationship,j)=>{const target=currentResource(relationship.target_resource);const blocked=!target||relationship.local_columns.some(field=>resource.kept_out_fields.includes(field))||relationship.target_columns.some(field=>target.kept_out_fields.includes(field));const checked=resource.relationships.some(item=>item.id===relationship.id);return '<label class="relationship"><input type="checkbox" data-relationship-resource="'+i+'" data-relationship="'+j+'" '+(checked?"checked":"")+(blocked?" disabled":"")+'> '+esc(relationship.id)+' → '+esc(relationship.target_resource)+' · many-to-one · max fan-out 1</label>'}).join("")+'</div>':"";return '<section class="resource"><div class="resource-head"><label class="resource-toggle"><input type="checkbox" data-resource-enabled="'+i+'" '+(included?"checked":"")+'> <h3>'+esc(source.id)+'</h3></label><span class="scope">tenant: '+esc(scopeLabel(source,"tenant"))+(source.principal_key||source.principal_scope?' · principal: '+esc(scopeLabel(source,"principal")):'')+'</span></div>'+(!included?'<p class="scope">Excluded from this model-visible authoring pack.</p>':'<table><thead><tr><th>Field</th>'+permissions.map(([l])=>'<th>'+esc(l)+'</th>').join("")+'<th>kept out</th></tr></thead><tbody>'+fields.map(field=>'<tr><td><code>'+esc(field)+'</code></td>'+permissions.map(([label,key])=>'<td>'+(has(source,field,key)?'<input type="checkbox" aria-label="'+esc(label)+' '+esc(field)+' for '+esc(source.id)+'" data-permission-resource="'+i+'" data-field="'+esc(field)+'" data-key="'+key+'" '+(has(resource,field,key)?"checked":"")+(resource.kept_out_fields.includes(field)?" disabled":"")+'>':'—')+'</td>').join("")+'<td><input type="checkbox" aria-label="Keep '+esc(field)+' out" data-kept-out-resource="'+i+'" data-kept-out-field="'+esc(field)+'" '+(resource.kept_out_fields.includes(field)?"checked":"")+(source.kept_out_fields.includes(field)?" disabled":"")+'></td></tr>').join("")+'</tbody></table>'+relations)+'</section>'}).join("");document.querySelectorAll("[data-resource-enabled]").forEach(input=>input.addEventListener("change",e=>{const t=e.currentTarget;setResource(original.pack.resources[Number(t.dataset.resourceEnabled)],t.checked)}));document.querySelectorAll("[data-permission-resource]").forEach(input=>input.addEventListener("change",e=>{const t=e.currentTarget;setPermission(currentResource(original.pack.resources[Number(t.dataset.permissionResource)].id),t.dataset.field,t.dataset.key,t.checked)}));document.querySelectorAll("[data-kept-out-resource]").forEach(input=>input.addEventListener("change",e=>{const t=e.currentTarget;setKeptOut(original.pack.resources[Number(t.dataset.keptOutResource)],t.dataset.keptOutField,t.checked)}));document.querySelectorAll("[data-relationship-resource]").forEach(input=>input.addEventListener("change",e=>{const t=e.currentTarget;const source=original.pack.resources[Number(t.dataset.relationshipResource)];setRelationship(source,source.relationships[Number(t.dataset.relationship)],t.checked)}))}
    function renderBudgets(){document.getElementById("budgets").innerHTML=Object.entries(candidate.budgets).map(([key,value])=>'<label>'+esc(key.replaceAll("_"," "))+'<input type="number" min="1" max="'+original.budgets[key]+'" value="'+value+'" data-budget="'+key+'"></label>').join("");document.querySelectorAll("[data-budget]").forEach(input=>input.addEventListener("change",e=>{candidate.budgets[e.currentTarget.dataset.budget]=Number(e.currentTarget.value);changed()}))}
    function renderDatabaseCompatibility(value){const panel=document.getElementById("database-compatibility");if(!value){panel.hidden=true;return}const limited=value.tier==="compatible_limited";const limits=[];if(value.authority?.features?.schema_check_constraints===false)limits.push("Text grouping and filtering require a bounded native ENUM.");if(value.authority?.features?.automatic_numeric_bands===false)limits.push("Automatic numeric bands are unavailable.");const profile=value.authority?.version_line?' Reviewed capability profile: '+value.authority.version_line+'.':'';panel.hidden=false;panel.className="notice compatibility"+(limited?"":" full");panel.innerHTML='<strong>Reviewed database compatibility: '+esc(value.detected_version)+'</strong><br>'+(limited?'Supported limited grammar. '+esc(limits.join(" ")):'Full reviewed grammar is available for this supported server line.')+esc(profile)}
    function renderPosture(){const role=reviewReport.database_role||{};document.getElementById("deployment-profile").value=candidate.deployment_profile;document.getElementById("role-posture").innerHTML='<strong>Exact database role posture</strong><p class="scope">role: '+esc(role.name||"unknown")+' · verified: '+esc(role.verified===true?"yes":"no")+' · read only: '+esc(role.read_only===true?"yes":"no")+' · superuser: '+esc(String(role.superuser))+' · BYPASSRLS: '+esc(String(role.bypass_rls))+'</p><p class="scope">role/grant/RLS fingerprint: <code>'+esc(role.fingerprint||candidate.role_posture_fingerprint)+'</code></p>'}
    function renderBlocked(){const resources=(reviewReport.resources||[]).filter(resource=>resource.status!=="draft_read");const actions=reviewReport.structured_actions||[];const resourceRows=resources.map(resource=>'<li><strong>'+esc(resource.id)+'</strong>: '+esc(resource.blockers.join("; ")||"scope unresolved")+'</li>').join("");const actionRows=actions.map(action=>'<li><strong>'+esc(action.name)+'</strong>: disabled, business review required · source '+esc(action.source)+'</li>').join("");document.getElementById("blocked").innerHTML=(resourceRows?'<h3>Blocked objects</h3><ul>'+resourceRows+'</ul>':'<p>No blocked objects.</p>')+(actionRows?'<h3>Disabled action candidates</h3><ul>'+actionRows+'</ul>':'<p>No structured action candidates were detected.</p>')}
    function renderProtect(){
      const list=document.getElementById("protect-queries");
      const editor=document.getElementById("protect-editor");
      if(!protectQueries.length){list.innerHTML="<p>No unexpired query is ready. Activate this boundary, reconnect the local authoring MCP session, ask a scoped question, then refresh.</p>";editor.innerHTML="";return}
      list.innerHTML=protectQueries.map((query,index)=>'<button class="query '+(selectedProtect===index?"selected":"")+'" data-protect-index="'+index+'" type="button"><strong>'+esc(query.kind==="aggregate"?"Aggregate analysis":"Bounded rows")+'</strong><br><span class="scope">'+esc(query.resource)+" · expires "+esc(query.expires_at)+'</span></button>').join("");
      document.querySelectorAll("[data-protect-index]").forEach(button=>button.onclick=()=>{selectedProtect=Number(button.dataset.protectIndex);protectedDraft=null;renderProtect()});
      if(selectedProtect===null||!protectQueries[selectedProtect]){editor.innerHTML="<p>Select a recent query to review and protect.</p>";return}
      const query=protectQueries[selectedProtect];
      const literals=query.literal_positions.map((position,index)=>'<div class="literal"><label><input type="checkbox" data-arg-enable="'+index+'"> Turn this reviewed literal into a bounded argument</label><code>'+esc(position.location)+" · "+esc(position.relationship?position.relationship+"."+position.field:position.field)+" = "+esc(JSON.stringify(position.current_value))+'</code><div class="protect-fields"><label>Argument name<input type="text" data-arg-name="'+index+'" value="'+esc(position.suggested_argument)+'"></label><label>Description<input type="text" data-arg-description="'+index+'" value="'+esc("Reviewed "+position.field+" filter.")+'"></label>'+(position.inferred_type==="number"?'<label>Minimum<input type="number" data-arg-min="'+index+'" value="'+esc(position.current_value)+'"></label><label>Maximum<input type="number" data-arg-max="'+index+'" value="'+esc(position.current_value)+'"></label>':position.inferred_type==="string"?'<label>Maximum length<input type="number" min="'+String(position.current_value).length+'" max="512" data-arg-length="'+index+'" value="'+Math.max(32,String(position.current_value).length)+'"></label>':"")+'</div></div>').join("");
      editor.innerHTML='<div class="protect-fields"><label>Capability name<input id="protect-name" type="text" value="analytics.protected_query"></label><label>Description<input id="protect-description" type="text" value="Answer one reviewed, bounded data question."></label><label>Returns hint<input id="protect-returns" type="text" value="Returns only the reviewed bounded result shape."></label></div><h3 style="margin-top:16px">Literal review</h3>'+literals+'<button id="create-protected" type="button">Generate disabled capability</button><div id="protect-preview"></div>';
      document.getElementById("create-protected").onclick=createProtected;
    }
    function selectedArguments(query){
      return query.literal_positions.flatMap((position,index)=>{
        const enabled=document.querySelector('[data-arg-enable="'+index+'"]');
        if(!enabled||!enabled.checked)return[];
        const base={location:position.location,name:document.querySelector('[data-arg-name="'+index+'"]').value.trim(),description:document.querySelector('[data-arg-description="'+index+'"]').value.trim()};
        if(position.inferred_type==="number")return[{...base,minimum:Number(document.querySelector('[data-arg-min="'+index+'"]').value),maximum:Number(document.querySelector('[data-arg-max="'+index+'"]').value)}];
        if(position.inferred_type==="string")return[{...base,max_length:Number(document.querySelector('[data-arg-length="'+index+'"]').value)}];
        return[base];
      });
    }
    async function createProtected(){
      const status=document.getElementById("protect-message");const query=protectQueries[selectedProtect];
      try{
        status.className="";status.textContent="Compiling public DSL and canonical contract…";
        const payload=await post("/api/protect/draft",{query_ref:query.query_ref,capability_name:document.getElementById("protect-name").value.trim(),description:document.getElementById("protect-description").value.trim(),returns_hint:document.getElementById("protect-returns").value.trim(),arguments:selectedArguments(query)});
        protectedDraft=payload.draft;
        document.getElementById("protect-preview").innerHTML='<h3 style="margin-top:16px">Disabled draft</h3><p>Review the generated read authority below. Its exact fingerprint is bound to this page internally.</p><details><summary>Advanced fingerprint</summary><code>'+esc(payload.draft.contract_digest)+'</code></details><pre id="legacy-protect-dsl-preview"></pre><div class="protect-fields"><label>Operator identity<input id="protect-actor" type="text" maxlength="128"></label></div><label><input id="protect-disable-explore" type="checkbox"> Disable temporary Scoped Explore after activation</label><br><button id="activate-protected" type="button">Activate this reviewed capability</button>';
        renderSyntaxCode("legacy-protect-dsl-preview",payload.dsl,"synapsor-dsl");
        document.getElementById("activate-protected").onclick=activateProtected;
        status.textContent="Draft generated and still disabled. Review the DSL and exact digest.";
      }catch(e){status.className="error";status.textContent=e.message}
    }
    async function activateProtected(){
      const status=document.getElementById("protect-message");
      try{
        const result=await post("/api/protect/activate",{capability_name:protectedDraft.capability,actor:document.getElementById("protect-actor").value.trim(),disable_explore:document.getElementById("protect-disable-explore").checked});
        status.className="success";status.textContent=result.message;document.getElementById("activate-protected").disabled=true;document.getElementById("state").textContent=result.active.exploration_disabled?(result.remaining_boundaries.length?"Protected capability active · "+result.remaining_boundaries.length+" Explore "+(result.remaining_boundaries.length===1?"boundary remains":"boundaries remain"):"Protected capability active · Explore disabled"):"Protected capability active · Explore local-only";
      }catch(e){status.className="error";status.textContent=e.message}
    }
    async function loadProtect(){const status=document.getElementById("protect-message");try{const p=await fetch("/api/protect").then(r=>r.json());if(!p.ok)throw new Error(p.error||"Could not load recent queries");protectQueries=p.queries;selectedProtect=protectQueries.length?0:null;renderProtect();status.className="";status.textContent=protectQueries.length?protectQueries.length+" recent query or analysis result(s) ready for review.":p.message||"No recent query is ready yet."}catch(e){protectQueries=[];selectedProtect=null;renderProtect();status.className="error";status.textContent=e.message}}
    async function load(){const p=await fetch("/api/boundary").then(r=>r.json());if(!p.ok)throw new Error(p.error||"Could not load review");original=p.draft;candidate=structuredClone(p.draft);reviewReport=p.review;reviewDecisions=[...p.review.unresolved_decisions];const s=p.review.summary;document.getElementById("summary").innerHTML=[[s.objects,"objects"],[s.draft_reads,"draft reads"],[s.blocked_objects,"blocked"],[s.sensitive_fields_kept_out,"kept-out fields"],[s.rls_policies,"RLS policies"],[s.structured_write_candidates,"disabled actions"]].map(([v,l])=>'<div class="metric"><strong>'+v+'</strong><span>'+l+'</span></div>').join("");document.getElementById("decisions").innerHTML=reviewDecisions.map((item,index)=>'<p><label><input type="checkbox" data-review-decision="'+index+'"> '+esc(reviewDecisionLabel(item))+"</label></p>").join("");document.querySelectorAll("[data-review-decision]").forEach(input=>input.addEventListener("change",updateActivationState));document.getElementById("deployment-profile").addEventListener("change",event=>{candidate.deployment_profile=event.currentTarget.value;changed();renderPosture()});document.getElementById("state").textContent=p.active?"Active reviewed boundary":"Disabled · review required";renderDatabaseCompatibility(p.database_server_compatibility);renderPosture();renderBlocked();renderResources();renderBudgets()}
    document.getElementById("preview").onclick=async()=>{try{msg.className="";msg.textContent="Validating narrowed boundary…";const p=await post("/api/boundary/preview",{candidate});digest=p.digest;msg.textContent="Exact digest: "+digest;updateActivationState()}catch(e){msg.className="error";msg.textContent=e.message}};
    document.getElementById("activate").onclick=async()=>{try{const actor=document.getElementById("actor").value.trim();if(!actor)throw new Error("Enter the local operator identity.");const confirmedDecisions=[...document.querySelectorAll("[data-review-decision]:checked")].map(input=>reviewDecisions[Number(input.dataset.reviewDecision)]);msg.className="";msg.textContent="Rechecking schema lock and database-role posture…";await post("/api/boundary/activate",{candidate,expected_digest:digest,actor,confirmation:"ACTIVATE "+digest,confirmed_decisions:confirmedDecisions});msg.className="success";msg.textContent="Activated. Reconnect the local authoring MCP session to use Scoped Explore.";document.getElementById("state").textContent="Active reviewed boundary";document.getElementById("activate").disabled=true}catch(e){msg.className="error";msg.textContent=e.message}};
    document.getElementById("refresh-protect").onclick=loadProtect;
    load().then(loadProtect).catch(e=>{msg.className="error";msg.textContent=e.message});
  </script>
</body>
</html>`;
}

function renderShell(csrfToken: string, tour = false, configPath = "synapsor.runner.json", storePath = "./.synapsor/local.db"): string {
  const escapedCsrf = escapeScriptString(csrfToken);
  const escapedConfigPath = escapeScriptString(configPath);
  const escapedStorePath = escapeScriptString(storePath);
  const tourHtml = tour ? `
    <section class="surface tour">
      <h2>Commit-safe MCP in one loop</h2>
      <div class="tour-grid">
        <section>
          <h3>What the model can do</h3>
          <ul><li>Inspect a business object</li><li>Propose a change</li></ul>
        </section>
        <section>
          <h3>What the model cannot do</h3>
          <ul><li>Run SQL</li><li>Approve</li><li>Commit</li><li>Choose tenant authority</li><li>Access write credentials</li></ul>
        </section>
        <section>
          <h3>What the trusted runner does</h3>
          <ul><li>Checks tenant scope</li><li>Checks allowed columns</li><li>Checks idempotency</li><li>Checks row version</li><li>Stores receipt and replay</li></ul>
        </section>
      </div>
    </section>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapsor Workbench | Activity</title>
<style>
:root { color-scheme:light dark; --bg:#f7f8fa; --surface:#ffffff; --soft:#f1f4f5; --ink:#162024; --muted:#5b696f; --line:#d3dcdf; --line-strong:#aebdc1; --blue:#087f73; --blue-strong:#05665e; --blue-soft:#e5f4f1; --ok:#137333; --ok-soft:#e8f5eb; --warn:#8a5a00; --warn-soft:#fff4d6; --bad:#b42318; --bad-soft:#ffebe8; --shadow:0 8px 28px rgba(22,32,36,.08); }
@media (prefers-color-scheme:dark) { :root { --bg:#101617; --surface:#182124; --soft:#222c2f; --ink:#edf3f2; --muted:#aab7b8; --line:#35464b; --line-strong:#52666b; --blue:#5bcabb; --blue-strong:#79ddcf; --blue-soft:#173c38; --ok:#70d58c; --ok-soft:#1d3826; --warn:#f4c86a; --warn-soft:#3d3219; --bad:#ff8d84; --bad-soft:#3f2221; --shadow:none; } }
* { box-sizing:border-box; letter-spacing:0; }
html { scroll-behavior:smooth; }
body { margin:0; font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--ink); background:var(--bg); }
.app-header { position:sticky; top:0; z-index:20; border-bottom:1px solid var(--line); background:color-mix(in srgb,var(--surface) 94%,transparent); backdrop-filter:blur(12px); }
.app-header > div { width:min(1440px,calc(100% - 40px)); min-height:64px; margin:auto; display:flex; align-items:center; justify-content:space-between; gap:16px; }
.brand { display:flex; align-items:center; gap:11px; min-width:0; }
.brand-mark { display:grid; place-items:center; width:30px; height:30px; border-radius:7px; background:var(--ink); color:var(--surface); font-size:13px; font-weight:800; }
.brand h1 { margin:0; font-size:17px; }
.brand p { margin:0; font-size:12px; }
.source-state { border:1px solid var(--line); border-radius:999px; padding:4px 9px; color:var(--muted); font-size:12px; white-space:nowrap; }
main { width:min(1440px,calc(100% - 40px)); margin:auto; padding:24px 0 56px; }
.ops-layout { display:grid; grid-template-columns:224px minmax(0,1fr); gap:24px; align-items:start; }
.ops-nav { position:sticky; top:88px; display:flex; flex-direction:column; gap:5px; }
.ops-nav > p { margin:0 0 7px; color:var(--muted); font-size:11px; font-weight:800; text-transform:uppercase; }
.ops-nav a { display:block; padding:9px 10px; border-left:3px solid transparent; color:var(--muted); text-decoration:none; font-weight:650; }
.ops-nav a:hover,.ops-nav a:focus-visible { color:var(--ink); background:var(--soft); border-left-color:var(--blue); outline:none; }
.ops-note { margin-top:12px; padding:11px; border:1px solid var(--line); border-radius:7px; background:var(--surface); }
.ops-note p { margin:4px 0 0; font-size:12px; }
.ops-workspace { min-width:0; display:flex; flex-direction:column; gap:20px; }
h1 { margin:0; font-size:17px; }
h2 { margin:0 0 8px; font-size:20px; }
h3 { margin:0 0 6px; font-size:15px; }
p { color:var(--muted); line-height:1.5; }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
.grid > * { min-width:0; }
.tour-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:14px; }
.surface { padding:18px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); background:var(--surface); }
.card,.subsurface { background:var(--surface); border:1px solid var(--line); border-radius:7px; padding:16px; box-shadow:var(--shadow); }
.full { grid-column: 1 / -1; }
.pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:999px; padding:5px 10px; margin:4px 6px 4px 0; color:var(--muted); background:var(--soft); font-size:12px; }
.pill.ok { color:var(--ok); background:var(--ok-soft); border-color:color-mix(in srgb,var(--ok) 35%,var(--line)); }
.pill.warn { color:var(--warn); background:var(--warn-soft); border-color:color-mix(in srgb,var(--warn) 35%,var(--line)); }
.pill.bad { color:var(--bad); background:var(--bad-soft); border-color:color-mix(in srgb,var(--bad) 35%,var(--line)); }
button { min-height:38px; border:1px solid var(--blue); border-radius:6px; padding:8px 13px; color:#fff; background:var(--blue); font-weight:700; cursor:pointer; transition:background .15s ease,border-color .15s ease,transform .15s ease; }
button:not(:disabled):hover { background:var(--blue-strong); border-color:var(--blue-strong); }
button:not(:disabled):active { transform:translateY(1px); }
button.secondary { color:var(--blue); background:var(--surface); border-color:var(--line-strong); }
button.secondary:hover { color:var(--ink); background:var(--soft); }
button.danger { background:var(--bad); border-color:var(--bad); }
button:disabled { opacity:.55; cursor:not-allowed; }
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible,a:focus-visible { outline:3px solid color-mix(in srgb,var(--blue) 40%,transparent); outline-offset:2px; }
pre { white-space:pre-wrap; overflow:auto; max-height:380px; background:#11191b; color:#e7f7f4; border:1px solid var(--line); border-radius:7px; padding:14px; }
table { width:100%; border-collapse:collapse; }
td, th { border-bottom:1px solid var(--line); padding:10px; text-align:left; vertical-align:top; }
input, textarea, select { width:100%; border:1px solid var(--line-strong); border-radius:6px; padding:10px; color:var(--ink); background:var(--surface); }
.actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
header h1 { margin-bottom:6px; }
.console { display:grid; grid-template-columns:minmax(0,1fr); gap:16px; align-items:start; }
.console > *, .detail-head > *, .step-main { min-width:0; }
#proposals { border:0; border-radius:0; padding:0; box-shadow:none; background:transparent; }
#proposals .plist { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:8px; }
#detail { width:100%; }
.plist { display:flex; flex-direction:column; gap:8px; }
.pitem { display:block; width:100%; min-height:0; text-align:left; background:var(--surface); color:var(--ink); border:1px solid var(--line); border-radius:7px; padding:12px; cursor:pointer; box-shadow:none; font-weight:400; }
.pitem:hover { border-color:var(--blue); background:var(--blue-soft); }
.pitem.sel { border-color:var(--blue); box-shadow:0 0 0 2px color-mix(in srgb,var(--blue) 22%,transparent); }
.pitem-action { font-weight:700; font-size:14px; color:var(--ink); }
.pitem-target { font-size:12px; color:var(--muted); margin:2px 0 8px; overflow-wrap:anywhere; }
.chip { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:3px 9px; font-size:11px; font-weight:600; border:1px solid var(--line); }
.chip-ok{color:var(--ok);background:var(--ok-soft);border-color:color-mix(in srgb,var(--ok) 35%,var(--line));}
.chip-wait,.chip-warn{color:var(--warn);background:var(--warn-soft);border-color:color-mix(in srgb,var(--warn) 35%,var(--line));}
.chip-bad{color:var(--bad);background:var(--bad-soft);border-color:color-mix(in srgb,var(--bad) 35%,var(--line));}
.chip-info{color:var(--blue);background:var(--blue-soft);border-color:color-mix(in srgb,var(--blue) 35%,var(--line));}
.chip-muted{color:var(--muted);background:var(--soft);border-color:var(--line);}
.detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:4px; }
.detail-head .sub { font-size:13px; color:var(--muted); margin-top:2px; overflow-wrap:anywhere; }
.tabs { display:flex; gap:0; margin:10px 0 18px; border-bottom:1px solid var(--line); }
.tab { background:transparent; color:var(--muted); border:0; border-bottom:2px solid transparent; border-radius:0; padding:8px 2px; margin-right:18px; font-weight:600; cursor:pointer; }
.tab.active { color:var(--blue); border-bottom-color:var(--blue); }
.hidden { display:none; }
.step { display:grid; grid-template-columns:36px 1fr; gap:14px; padding:0 0 18px; }
.step-rail { display:flex; flex-direction:column; align-items:center; }
.step-num { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; color:white; background:#94a3b8; flex:none; }
.step .step-rail::after { content:""; flex:1; width:2px; background:var(--line); margin-top:6px; }
.step:last-child .step-rail::after { display:none; }
.step-ok .step-num{background:var(--ok);} .step-wait .step-num{background:#d97706;} .step-warn .step-num{background:#ea580c;} .step-bad .step-num{background:var(--bad);} .step-info .step-num{background:#0b72a8;} .step-muted .step-num{background:#94a3b8;}
.step-title { font-weight:700; font-size:15px; margin-bottom:4px; }
.step-main p { margin:2px 0 6px; }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; background:var(--soft); border:1px solid var(--line); border-radius:6px; padding:8px 10px; display:inline-block; color:var(--ink); word-break:break-all; }
.callout { background:var(--blue-soft); border-left:3px solid var(--blue); padding:10px 12px; color:var(--ink); font-size:13px; margin:6px 0; }
.status-line { font-size:13px; margin:4px 0; }
.diff { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; border:1px solid var(--line); border-radius:10px; overflow:hidden; margin:6px 0; }
.diff-col { background:#f1f6fb; padding:6px 10px; font-weight:600; border-bottom:1px solid var(--line); color:var(--muted); }
.diff-line { padding:5px 10px; white-space:pre-wrap; overflow-wrap:anywhere; }
.diff-line.del { background:var(--bad-soft); color:var(--bad); }
.diff-line.add { background:var(--ok-soft); color:var(--ok); }
.badge-row { display:flex; align-items:center; gap:10px; font-size:14px; margin:6px 0; }
.badge { border-radius:999px; padding:4px 12px; font-weight:700; font-size:13px; }
.badge.no { color:var(--ok); background:var(--ok-soft); border:1px solid color-mix(in srgb,var(--ok) 35%,var(--line)); }
.badge.yes { color:var(--blue); background:var(--blue-soft); border:1px solid color-mix(in srgb,var(--blue) 35%,var(--line)); }
.timeline { display:flex; flex-direction:column; margin-top:4px; }
.tl-row { display:grid; grid-template-columns:14px 1fr; gap:10px; padding-bottom:12px; position:relative; }
.tl-row::before { content:""; position:absolute; left:5px; top:14px; bottom:-2px; width:2px; background:var(--line); }
.tl-row:last-child::before { display:none; }
.tl-dot { width:11px; height:11px; border-radius:50%; margin-top:3px; background:#94a3b8; z-index:1; }
.tl-ok{background:var(--ok);} .tl-warn{background:#ea580c;} .tl-bad{background:var(--bad);} .tl-info{background:#0b72a8;} .tl-wait{background:#d97706;} .tl-muted{background:#94a3b8;}
.tl-label { font-weight:600; font-size:13px; }
.tl-meta { font-size:12px; color:var(--muted); word-break:break-all; }
.kv { display:grid; grid-template-columns:minmax(110px,auto) minmax(0,1fr); gap:4px 14px; font-size:13px; margin:8px 0; }
.kv dt { color:var(--muted); } .kv dd { margin:0; color:var(--ink); overflow-wrap:anywhere; }
details.raw { margin-top:12px; }
details.raw > summary { cursor:pointer; color:var(--blue); font-weight:600; font-size:13px; }
.config-section { margin-top:24px; }
.config-section > summary { cursor:pointer; font-weight:700; font-size:16px; padding:10px 0; color:var(--ink); }
.activation { display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); gap:1px; overflow:hidden; border:1px solid var(--line); border-radius:8px; background:var(--line); margin-top:12px; }
.activation-step { min-width:0; padding:12px; background:white; }
.activation-step strong { display:block; font-size:12px; margin-bottom:5px; }
.activation-step span { display:block; color:var(--muted); font-size:11px; line-height:1.35; overflow-wrap:anywhere; }
.activation-step.complete { box-shadow:inset 0 3px 0 var(--ok); }
.activation-step.ready { box-shadow:inset 0 3px 0 #d97706; }
.activation-step.blocked { box-shadow:inset 0 3px 0 var(--bad); }
.data-pr-head { border:1px solid var(--line); border-left:3px solid var(--blue); border-radius:8px; padding:12px; margin:10px 0 18px; background:var(--soft); }
.filter-grid { display:grid; grid-template-columns:1fr; gap:8px; margin:12px 0; }
.filter-grid label { display:flex; flex-direction:column; gap:4px; color:var(--muted); font-size:12px; }
.filter-actions { display:flex; gap:8px; flex-wrap:wrap; }
.filter-actions button { flex:1 1 100px; }
.handle-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px; align-items:end; }
.handle-row button { min-width:46px; padding-inline:12px; }
.decision-panel { margin-top:16px; padding-top:16px; border-top:1px solid var(--line); }
.decision-panel h3 { margin:0 0 6px; font-size:15px; }
.decision-panel .exact-confirmation { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.operator-posture { margin:8px 0; color:var(--muted); font-size:12px; }
.ledger-summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; margin:10px 0 16px; }
.ledger-summary > div { border-left:3px solid var(--blue); padding:8px 10px; background:var(--soft); }
.ledger-summary strong { display:block; font-size:18px; }
.attention-console { display:grid; grid-template-columns:minmax(240px, .8fr) minmax(0, 1.6fr); gap:14px; align-items:start; }
.attention-list { display:flex; flex-direction:column; gap:8px; }
.attention-item { width:100%; min-height:0; text-align:left; color:var(--ink); background:var(--surface); border:1px solid var(--line); border-radius:7px; padding:10px; box-shadow:none; font-weight:400; }
.attention-item.sel { border-color:var(--blue); box-shadow:0 0 0 2px color-mix(in srgb,var(--blue) 22%,transparent); }
.attention-item strong, .attention-item span { display:block; }
.attention-item span { margin-top:4px; color:var(--muted); font-size:12px; }
@media (max-width: 960px) { .ops-layout { grid-template-columns:1fr; } .ops-nav { position:static; display:flex; flex-direction:row; overflow:auto; border-bottom:1px solid var(--line); } .ops-nav > p,.ops-note { display:none; } .ops-nav a { white-space:nowrap; border-left:0; border-bottom:3px solid transparent; } .ops-nav a:hover,.ops-nav a:focus-visible { border-left-color:transparent; border-bottom-color:var(--blue); } }
@media (max-width: 900px) { .console { grid-template-columns:1fr; } }
@media (max-width: 850px) { .grid, .tour-grid, .activation, .attention-console { grid-template-columns: 1fr; } }
@media (max-width: 600px) {
  .app-header > div,main { width:min(100% - 24px,1440px); }
  .app-header > div { min-height:58px; }
  .source-state { display:none; }
  main { padding-top:14px; }
  .ops-nav { flex-wrap:wrap; overflow:visible; gap:4px; padding-bottom:8px; }
  .ops-nav a { flex:1 1 calc(50% - 4px); text-align:center; border:1px solid var(--line); border-radius:6px; padding:8px; }
  .data-pr-head .kv, .step .kv { grid-template-columns:1fr; gap:2px; }
  .data-pr-head .kv dd { margin-bottom:8px; }
  .step .kv dd { margin-bottom:6px; }
  .ledger-summary { grid-template-columns:1fr; }
}
</style>
</head>
<body>
<header class="app-header"><div>
  <div class="brand"><span class="brand-mark" aria-hidden="true">S</span><div><h1>Synapsor Workbench</h1><p>Review and operate agent data changes</p></div></div>
  <span class="source-state">Source access stays governed</span>
</div></header>
<main>
  <div class="ops-layout">
    <aside class="ops-nav" aria-label="Workbench areas">
      <p>Operations</p>
      <a href="#attention">Needs attention</a>
      <a href="#worker">Automatic apply</a>
      <a href="#activity">Change history</a>
      <a href="#shadow-report">Shadow studies</a>
      <a href="#runtime-tools">Runtime tools</a>
      <div class="ops-note"><strong>Outside the model</strong><p>Approval, apply, recovery, and worker controls are never MCP tools.</p></div>
    </aside>
    <div class="ops-workspace">
      ${tourHtml}
      <section class="surface" id="workbench">
        <h2>First safe action</h2>
        <p>Loading reviewed project activation state...</p>
      </section>
      <section class="surface" id="attention">
        <h2>Needs attention</h2>
        <p>Human Attention Inbox: loading decisions and investigations that cannot proceed automatically...</p>
      </section>
      <section class="surface" id="worker">
        <h2>Automatic apply</h2>
        <p>Loading separately trusted worker eligibility, queue state, and operator controls...</p>
      </section>
      <section class="console" id="activity">
        <div class="card" id="proposals"><h2>Activity</h2><p>Change history is loading...</p></div>
        <div class="card" id="detail"><h2>Review one change</h2><p><strong>Lifecycle review:</strong> select recent activity, or find evidence, proposals, receipts, replay, jobs, intents, and audit records without copying an opaque ID.</p></div>
      </section>
      <section class="surface" id="shadow-report">
        <h2>Shadow studies</h2>
        <p>Loading local agent-versus-authoritative-outcome comparisons...</p>
      </section>
      <details class="surface config-section" id="runtime-tools">
        <summary>Runtime configuration and MCP tools</summary>
        <div class="grid" style="margin-top:14px">
          <div class="subsurface" id="summary"><h2>Setup summary</h2><p>Loading...</p></div>
          <div class="subsurface" id="tools"><h2>Tools</h2><p>Loading...</p></div>
        </div>
      </details>
    </div>
  </div>
</main>
<script>
const csrfToken = "${escapedCsrf}";
const configPath = "${escapedConfigPath}";
const storePath = "${escapedStorePath}";
const state = { selected: null, firstId: null, shadowStudy: null, activityFilters: {}, attentionSelected: null, attentionStatus: "open", detailRequestRevision: 0 };
const byId = (id) => document.getElementById(id);
const text = (tag, value, className = "") => { const node = document.createElement(tag); node.textContent = value == null ? "" : String(value); if (className) node.className = className; return node; };
function el(tag, opts, kids) {
  const node = document.createElement(tag);
  if (opts) {
    if (opts.id) node.id = opts.id;
    if (opts.class) node.className = opts.class;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.onclick) node.onclick = opts.onclick;
    if (opts.style) node.style.cssText = opts.style;
  }
  if (kids != null) for (const k of [].concat(kids)) if (k) node.append(k);
  return node;
}
async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || "request failed");
  return payload;
}
function pre(value) { const node = document.createElement("pre"); node.textContent = JSON.stringify(value, null, 2); return node; }
function pill(label, kind = "") { return text("span", label, "pill " + kind); }
function chip(label, tone) { return text("span", label, "chip chip-" + tone); }
function rawJson(label, value) {
  const d = el("details", { class: "raw" });
  d.append(el("summary", { text: label || "View raw JSON" }));
  d.append(pre(value));
  return d;
}
function fmtVal(v) {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function humanizeState(s) {
  switch (s) {
    case "pending_review": return { label: "Awaiting approval", tone: "wait" };
    case "approved": return { label: "Approved", tone: "ok" };
    case "pending_worker": return { label: "Queued for runner", tone: "wait" };
    case "applied": return { label: "Committed", tone: "ok" };
    case "conflict": return { label: "Conflict blocked", tone: "warn" };
    case "failed": return { label: "Failed", tone: "bad" };
    case "reconciliation_required": return { label: "Reconciliation required", tone: "warn" };
    case "rejected": return { label: "Rejected", tone: "bad" };
    case "canceled": return { label: "Canceled", tone: "muted" };
    default: return { label: s, tone: "muted" };
  }
}
function eventMeta(kind) {
  const map = {
    evidence_recorded: { label: "Evidence recorded", tone: "info" },
    proposal_created: { label: "Proposal created", tone: "info" },
    proposal_approved: { label: "Approved outside MCP", tone: "ok" },
    proposal_rejected: { label: "Rejected", tone: "bad" },
    proposal_canceled: { label: "Canceled", tone: "muted" },
    proposal_pending_worker: { label: "Queued for trusted runner", tone: "wait" },
    proposal_freshness_checked: { label: "Freshness checked against live source", tone: "info" },
    proposal_freshness_approval_blocked: { label: "Approval blocked by freshness", tone: "warn" },
    operator_authorized: { label: "Operator apply authority verified", tone: "ok" },
    writeback_job_recorded: { label: "Writeback job recorded", tone: "info" },
    writeback_intent_recorded: { label: "Writeback intent recorded", tone: "info" },
    writeback_applied: { label: "Committed by trusted runner", tone: "ok" },
    writeback_already_applied: { label: "Idempotent retry matched prior receipt", tone: "ok" },
    writeback_conflict: { label: "Conflict guard blocked stale write", tone: "warn" },
    writeback_failed: { label: "Writeback failed", tone: "bad" },
    writeback_reconciliation_required: { label: "Reconciliation required", tone: "warn" },
    compensation_proposal_created: { label: "Compensation proposal created", tone: "info" },
    replay_recorded: { label: "Replay record linked", tone: "info" },
  };
  return map[kind] || { label: String(kind).replace(/_/g, " "), tone: "info" };
}
function stepCard(n, title, tone, body) {
  const rail = el("div", { class: "step-rail" }, el("span", { class: "step-num", text: n }));
  const main = el("div", { class: "step-main" }, [el("div", { class: "step-title", text: title })].concat([].concat(body || [])));
  return el("div", { class: "step step-" + tone }, [rail, main]);
}
function diffBlock(target, diff) {
  const wrap = el("div", { class: "diff" });
  const cols = Object.keys(diff || {});
  if (!cols.length) { wrap.append(el("div", { class: "diff-line", text: "(no field changes)" })); return wrap; }
  for (const col of cols) {
    const d = diff[col];
    wrap.append(el("div", { class: "diff-col", text: target + "." + col }));
    wrap.append(el("div", { class: "diff-line del", text: "- " + fmtVal(d.before) }));
    wrap.append(el("div", { class: "diff-line add", text: "+ " + fmtVal(d.proposed) }));
  }
  return wrap;
}
function guardDrawer(gc) {
  const d = el("details", { class: "raw" });
  d.append(el("summary", { text: "What the trusted runner enforces" }));
  const kv = el("dl", { class: "kv" });
  const add = (k, v) => { kv.append(el("dt", { text: k }), el("dd", { text: v })); };
  if (gc.tenant_guard) add("Tenant scope", gc.tenant_guard.column + " = " + fmtVal(gc.tenant_guard.value));
  if (gc.allowed_columns) add("Allowed columns", (gc.allowed_columns || []).join(", "));
  if (gc.primary_key) add("Primary key", gc.primary_key.column + " = " + fmtVal(gc.primary_key.value));
  if (gc.conflict_version) add("Conflict guard", gc.conflict_version.column + " = " + fmtVal(gc.conflict_version.value));
  if (gc.idempotency_key) add("Idempotency key", gc.idempotency_key);
  if (gc.affected_row_count_required != null) add("Affected rows required", String(gc.affected_row_count_required));
  d.append(kv);
  return d;
}
function shellQuote(value) {
  const text = String(value || "");
  return /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\\\''") + "'";
}
function trustedApplyCommand(proposalId) {
  return "synapsor-runner apply " + shellQuote(proposalId) + " --config " + shellQuote(configPath) + " --store " + shellQuote(storePath);
}
function trustedApproveCommand(proposalId) {
  return "synapsor-runner proposals approve " + shellQuote(proposalId) + " --config " + shellQuote(configPath) + " --store " + shellQuote(storePath);
}
function trustedRevertCommand(proposalId) {
  return "synapsor-runner revert " + shellQuote(proposalId) + " --config " + shellQuote(configPath) + " --store " + shellQuote(storePath);
}
async function loadSummary() {
  const payload = await api("/api/summary");
  const root = byId("summary"); root.replaceChildren(text("h2", "Setup summary"));
  root.append(pill("mode: " + payload.setup.mode, payload.doctor.config_ok ? "ok" : "bad"));
  root.append(pill("config valid: " + payload.doctor.config_ok, payload.doctor.config_ok ? "ok" : "bad"));
  root.append(pill("no raw SQL exposed: " + payload.doctor.no_raw_sql_exposed, payload.doctor.no_raw_sql_exposed ? "ok" : "bad"));
  const kv = el("dl", { class: "kv" });
  const add = (k, v) => { kv.append(el("dt", { text: k }), el("dd", { text: v })); };
  add("Config path", payload.setup.config_path);
  add("Local store", payload.setup.store_path);
  add("Sources", Object.keys(payload.setup.sources || {}).join(", ") || "(none)");
  root.append(kv);
  root.append(rawJson("View raw JSON", { sources: payload.setup.sources, trusted_context: payload.setup.trusted_context, storage: payload.setup.storage, warnings: payload.doctor.warnings, errors: payload.doctor.errors }));
}
async function loadWorkbench() {
  const payload = await api("/api/workbench");
  const root = byId("workbench");
  root.replaceChildren(el("div", { class: "detail-head" }, [
    el("div", {}, [el("h2", { text: payload.title, style: "margin:0" }), el("div", { class: "sub", text: "Project to reviewed Data PR" })]),
    chip(payload.ok ? "Boundary ready" : "Needs attention", payload.ok ? "ok" : "warn"),
  ]));
  const activation = el("div", { class: "activation" });
  for (const step of payload.stages || []) {
    activation.append(el("div", { class: "activation-step " + step.status }, [
      el("strong", { text: step.name }),
      el("span", { text: step.detail }),
    ]));
  }
  root.append(activation);
  if (payload.action && payload.action.kept_out_fields && payload.action.kept_out_fields.length) {
    root.append(el("p", { text: "Kept out of the model-facing action: " + payload.action.kept_out_fields.join(", ") }));
  }
  const cursor = payload.cursor || {};
  const cursorPanel = el("div", { class: "card", style: "box-shadow:none;margin-top:16px" });
  cursorPanel.append(el("div", { class: "detail-head" }, [
    el("div", {}, [el("h3", { text: "Connect your agent", style: "margin:0" }), el("div", { class: "sub", text: "Any MCP client; project-scoped, proposal-only authority" })]),
    chip(cursor.state === "installed" ? "Cursor project entry configured" : "MCP connection not verified", cursor.state === "installed" ? "ok" : cursor.state === "not_installed" ? "wait" : "bad"),
  ]));
  cursorPanel.append(el("p", { text: "Managed project installers are available for Cursor, Claude Code, and VS Code. Other MCP clients use the same generated stdio configuration and receive the same reviewed tools." }));
  const managedClients = [
    ["cursor", "Cursor"],
    ["claude-code", "Claude Code"],
    ["vscode", "VS Code"],
  ];
  const clientPicker = document.createElement("select");
  clientPicker.setAttribute("aria-label", "Managed MCP client");
  for (const [value, label] of managedClients) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    clientPicker.append(option);
  }
  const installCommand = el("pre", { text: "synapsor-runner mcp install cursor --project --yes" });
  const installStatus = el("span", { class: "status-line", text: "Choose your client, then copy this runnable command." });
  clientPicker.onchange = () => {
    installCommand.textContent = "synapsor-runner mcp install " + clientPicker.value + " --project --yes";
    installStatus.textContent = "Ready to copy the " + clientPicker.options[clientPicker.selectedIndex].text + " project installer.";
  };
  const copyInstall = el("button", { class: "secondary", text: "Copy install command", onclick: async () => {
    await navigator.clipboard.writeText(installCommand.textContent || "");
    installStatus.textContent = "Install command copied. Runner still exposes only the reviewed tools shown below.";
  } });
  cursorPanel.append(
    el("label", { class: "field" }, [text("span", "MCP client"), clientPicker]),
    installCommand,
    el("div", { class: "actions" }, [copyInstall]),
    installStatus,
  );
  const cursorDetails = el("details");
  cursorDetails.append(el("summary", { text: "Optional Cursor Safe Action helper" }));
  cursorDetails.append(el("p", { text: "Cursor can draft and validate a disabled action; only you can review and activate its digest here." }));
  const prompt = document.createElement("textarea");
  prompt.rows = 5;
  prompt.readOnly = true;
  prompt.value = String(cursor.prompt || "");
  prompt.setAttribute("aria-label", "Copyable Cursor Safe Action prompt");
  const copyPromptStatus = el("div", { class: "status-line", text: String(cursor.next_step || "") });
  const copyPrompt = el("button", { class: "secondary", text: "Copy Cursor prompt", onclick: async () => {
    await navigator.clipboard.writeText(prompt.value);
    copyPromptStatus.textContent = "Prompt copied. Cursor still requires you to review and submit it.";
  } });
  const openCursor = el("button", { text: "Open in Cursor", onclick: () => {
    window.location.href = String(cursor.prompt_deeplink || cursor.prompt_web_link || "#");
  } });
  cursorDetails.append(prompt, el("div", { class: "actions" }, [copyPrompt, openCursor]), copyPromptStatus);
  cursorPanel.append(cursorDetails);
  cursorPanel.append(el("p", { class: "sub", text: "Model-visible reviewed tools: " + ((cursor.tools || []).join(", ") || "none until a reviewed contract is active") }));
  cursorPanel.append(el("p", { class: "sub", text: "Connection evidence: " + String(cursor.connection_status || "not_verified") + ". Use synapsor-runner mcp status --check-launch for a real Runner initialize/tools-list handshake; the selected host UI still requires client-side verification." }));
  if (cursor.proposal_waiting) {
    cursorPanel.append(el("div", { class: "callout", text: "Waiting for a connected MCP client to create the first exact proposal. Source data remains unchanged; this page checks the local ledger only." }));
  } else {
    const reviewButton = el("button", { text: "Review the first Data PR", onclick: async () => {
      await loadProposals();
      if (state.firstId) await loadDetail(state.firstId);
      byId("proposals").scrollIntoView({ behavior: "smooth", block: "start" });
    } });
    cursorPanel.append(el("div", { class: "actions" }, reviewButton));
  }
  root.append(cursorPanel);
  const safeAction = payload.safe_action || {};
  if (safeAction.draft) {
    const draft = safeAction.draft;
    const validation = draft.validation || {};
    const panel = el("div", { class: "card", style: "box-shadow:none;margin-top:16px" });
    panel.append(el("div", { class: "detail-head" }, [
      el("div", {}, [el("h3", { text: "Disabled Safe Action draft", style: "margin:0" }), el("div", { class: "sub", text: draft.action_name })]),
      chip(draft.state === "activated" ? "Activated artifact" : "Not active", draft.state === "activated" ? "ok" : "wait"),
    ]));
    const kv = el("dl", { class: "kv" });
    kv.append(
      el("dt", { text: "Draft digest" }), el("dd", { text: draft.draft_contract_digest }),
      el("dt", { text: "Source" }), el("dd", { text: draft.source_path }),
      el("dt", { text: "Active tools changed by editing" }), el("dd", { text: "No" }),
      el("dt", { text: "Unresolved authority" }), el("dd", { text: String((draft.unresolved_authority || []).length) }),
      el("dt", { text: "Incremental strict lint" }), el("dd", { text: validation.blocking_lint_issues === 0 ? "Passed" : "Blocked: " + String(validation.blocking_lint_issues || 0) + " new/error finding(s)" }),
      el("dt", { text: "Static contract tests" }), el("dd", { text: validation.static_test_summary ? String(validation.static_test_summary.passed) + "/" + String(validation.static_test_summary.total) + " passed" : "Missing" }),
      el("dt", { text: "Live staging tests" }), el("dd", { text: String((validation.live_tests_pending || []).length) + " pending exact source/scope input" }),
    );
    panel.append(kv);
    panel.append(el("div", { class: "tour-grid" }, [
      el("section", {}, [el("strong", { text: "Agent can" }), el("p", { text: "Edit the TypeScript draft and run deterministic validation/tests." })]),
      el("section", {}, [el("strong", { text: "Agent cannot" }), el("p", { text: "Activate, approve, apply, commit, choose tenant authority, or access write credentials." })]),
      el("section", {}, [el("strong", { text: "Operator reviews" }), el("p", { text: "Exact staging effect, final digest, approval role, bounds, and executor authority." })]),
    ]));
    if (draft.state === "disabled_draft" && validation.ok !== true) {
      panel.append(el("div", { class: "callout bad", text: "Preview and activation are blocked. Resolve the listed lint/static-test findings, then validate a new disabled digest." }));
    }
    if (draft.state === "disabled_draft" && validation.ok === true) {
      const args = document.createElement("textarea");
      args.rows = 6;
      args.value = JSON.stringify(safeAction.preview_args || {}, null, 2);
      args.setAttribute("aria-label", "Safe Action staging preview arguments");
      const status = el("div", { class: "status-line", text: draft.effect_preview
        ? "Preview recorded: " + draft.effect_preview.proposal_id + " (source unchanged)."
        : "Run one real staging proposal preview. It may read scoped data and write the proposal ledger, but it cannot apply the source mutation." });
      const previewButton = el("button", { text: "Preview exact staging Data PR", onclick: async () => {
        previewButton.disabled = true;
        try {
          const preview = await api("/api/actions/preview", { method: "POST", headers: { "x-synapsor-csrf": csrfToken }, body: JSON.stringify({ args: JSON.parse(args.value) }) });
          status.textContent = "Preview recorded: " + preview.preview.proposal_id + " (source unchanged). Review the Data PR below, then confirm the exact digest.";
          await loadProposals();
          if (preview.preview.proposal_id) await loadDetail(preview.preview.proposal_id);
          await loadWorkbench();
        } catch (error) {
          status.textContent = error.message;
          previewButton.disabled = false;
        }
      } });
      panel.append(el("p", { text: "Staging preview arguments" }), args, el("div", { class: "actions" }, previewButton), status);
      if (draft.effect_preview) {
        const activateStatus = el("div", { class: "status-line", text: "Activating adds only this reviewed proposal capability. The model still cannot approve or apply it. Runner binds this button to the exact reviewed artifact and rechecks it before activation." });
        const activateButton = el("button", { text: "Activate reviewed immutable artifact", onclick: async () => {
          activateButton.disabled = true;
          try {
            const result = await api("/api/actions/activate", { method: "POST", headers: { "x-synapsor-csrf": csrfToken }, body: JSON.stringify({ expected_digest: draft.draft_contract_digest, confirmation: "ACTIVATE " + draft.draft_contract_digest }) });
            activateStatus.textContent = result.message;
            await loadWorkbench();
            await loadTools();
          } catch (error) {
            activateStatus.textContent = error.message;
            activateButton.disabled = false;
          }
        } });
        panel.append(el("p", { text: "Separate operator activation" }), el("div", { class: "actions" }, activateButton), activateStatus);
      }
    }
    if (safeAction.active) panel.append(el("div", { class: "callout", text: "Active immutable digest: " + safeAction.active.contract_digest + ". Reconnect or restart the MCP client to reload tools." }));
    panel.append(rawJson("View draft/active state", safeAction));
    root.append(panel);
  }
}
async function loadAttention() {
  const statusFilter = state.attentionStatus === "all" ? "" : "&status=" + encodeURIComponent(state.attentionStatus);
  const [payload, notificationStatus] = await Promise.all([
    api("/api/attention?limit=100" + statusFilter),
    api("/api/notifications/status"),
  ]);
  const root = byId("attention");
  const statusSelect = document.createElement("select");
  statusSelect.setAttribute("aria-label", "Human attention status");
  for (const value of ["open", "acknowledged", "resolved", "expired", "all"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "all" ? "All states" : value[0].toUpperCase() + value.slice(1);
    option.selected = value === state.attentionStatus;
    statusSelect.append(option);
  }
  statusSelect.onchange = async () => {
    state.attentionStatus = statusSelect.value;
    state.attentionSelected = null;
    await loadAttention();
  };
  root.replaceChildren(el("div", { class: "detail-head" }, [
    el("div", {}, [
      el("h2", { text: "Human Attention Inbox", style: "margin:0" }),
      el("div", { class: "sub", text: "One item per related issue; immutable event history remains in the ledger" }),
    ]),
    el("div", { class: "filter-actions" }, [
      statusSelect,
      chip((payload.attention || []).length + " " + state.attentionStatus, (payload.attention || []).length && state.attentionStatus === "open" ? "warn" : "ok"),
    ]),
  ]));
  const sinkLine = (notificationStatus.sinks || []).map((sink) =>
    sink.id + ": " + (sink.enabled ? "enabled" : "disabled") + ", delivered " + (sink.counts.delivered || 0) + ", dead letter " + (sink.counts.dead_letter || 0)
  ).join(" · ");
  root.append(el("p", { class: "status-line", text: notificationStatus.enabled
    ? "External delivery is enabled. " + (sinkLine || "No enabled sink.")
    : "External notifications are off. Workbench and the ledger remain the source of truth." }));
  const items = payload.attention || [];
  if (!items.length) {
    state.attentionSelected = null;
    root.append(el("div", { class: "callout", text: state.attentionStatus === "open"
      ? "Nothing needs human attention. Successful automatic activity remains available in the lifecycle timeline without interrupting you."
      : "No attention items match this state. Change the status filter to inspect another part of the durable history." }));
    return;
  }
  if (!items.some((item) => item.attention_id === state.attentionSelected)) state.attentionSelected = items[0].attention_id;
  const list = el("div", { class: "attention-list" });
  const detail = el("div", { id: "attention-detail" });
  for (const item of items) {
    const button = el("button", {
      class: "attention-item" + (item.attention_id === state.attentionSelected ? " sel" : ""),
      onclick: async () => {
        state.attentionSelected = item.attention_id;
        await loadAttention();
      },
    }, [
      el("strong", { text: item.title }),
      el("span", { text: item.severity.toUpperCase() + " · " + item.occurrence_count + " related event" + (item.occurrence_count === 1 ? "" : "s") }),
      el("span", { text: item.capability || "Runner operations" }),
    ]);
    list.append(button);
  }
  root.append(el("div", { class: "attention-console" }, [list, detail]));
  await loadAttentionDetail(state.attentionSelected);
}
async function loadAttentionDetail(attentionId) {
  const root = byId("attention-detail");
  if (!root || !attentionId) return;
  const payload = await api("/api/attention/" + encodeURIComponent(attentionId));
  const item = payload.attention;
  const event = item.latest_event || {};
  root.replaceChildren(el("div", { class: "detail-head" }, [
    el("div", {}, [
      el("h3", { text: item.title, style: "margin:0" }),
      el("div", { class: "sub", text: item.capability || "Runner operations" }),
    ]),
    chip(item.severity, item.severity === "critical" ? "bad" : "warn"),
  ]));
  root.append(el("p", { text: event.summary || item.title }));
  root.append(el("div", { class: "badge-row" }, [
    el("span", { class: "badge " + (item.source_database_changed ? "yes" : "no"), text: "Source database changed: " + (item.source_database_changed ? "yes" : "no") }),
  ]));
  root.append(el("p", { text: "If you do nothing: " + item.what_if_ignored }));
  const actions = el("div", { class: "actions" });
  if (event.proposal_id) {
    actions.append(el("button", { text: "Review exact proposal", onclick: async () => {
      await loadProposals();
      await loadDetail(event.proposal_id);
      byId("proposals").scrollIntoView({ behavior: "smooth", block: "start" });
    } }));
  }
  if (item.available_action === "reconcile") {
    actions.append(el("button", { class: "secondary", text: "Inspect reconciliation queue", onclick: () => {
      byId("detail").scrollIntoView({ behavior: "smooth", block: "start" });
    } }));
  }
  if (item.status === "open") {
    const actor = document.createElement("input");
    actor.placeholder = "Operator identity";
    actor.setAttribute("aria-label", "Attention acknowledgement operator");
    const identityToken = document.createElement("input");
    identityToken.type = "password";
    identityToken.placeholder = "Fresh operator token when required";
    identityToken.autocomplete = "off";
    identityToken.setAttribute("aria-label", "Attention acknowledgement identity token");
    const status = el("div", { class: "status-line", text: "Acknowledgement only records that you saw this. It cannot approve or apply." });
    const acknowledge = el("button", { class: "secondary", text: "Acknowledge", onclick: async () => {
      acknowledge.disabled = true;
      try {
        await api("/api/attention/" + encodeURIComponent(attentionId) + "/acknowledge", {
          method: "POST",
          headers: { "x-synapsor-csrf": csrfToken },
          body: JSON.stringify({ actor: actor.value, identity_token: identityToken.value }),
        });
        identityToken.value = "";
        status.textContent = "Acknowledged. No proposal was approved and no source row was changed.";
        await loadAttention();
      } catch (error) {
        identityToken.value = "";
        status.textContent = error.message;
        acknowledge.disabled = false;
      }
    } });
    root.append(actor, identityToken);
    actions.append(acknowledge);
    root.append(actions, status);
  } else {
    root.append(actions);
  }
  root.append(rawJson("Safe event metadata", event));
}
async function loadWorker() {
  const payload = await api("/api/worker");
  const worker = payload.worker || {};
  const operator = payload.operator || {};
  const summary = worker.summary || {};
  const root = byId("worker");
  const mode = worker.control ? worker.control.mode : "active";
  root.replaceChildren(el("div", { class: "detail-head" }, [
    el("div", {}, [
      el("h2", { text: "Trusted Worker", style: "margin:0" }),
      el("div", { class: "sub", text: "Approval and execution stay separate; controls are never MCP tools" }),
    ]),
    chip(worker.enabled ? mode : "disabled", worker.enabled && mode === "active" ? "ok" : "wait"),
  ]));
  const totals = el("div", { class: "ledger-summary" });
  for (const [label, value] of [
    ["Waiting", summary.queue_depth || 0],
    ["Active leases", summary.active_leases || 0],
    ["Needs recovery", (summary.dead_letters || 0) + (summary.unknown_or_reconciliation || 0)],
  ]) {
    totals.append(el("div", {}, [el("strong", { text: value }), el("span", { class: "sub", text: label })]));
  }
  root.append(totals);
  root.append(el("p", { class: "status-line", text: "Profile: " + worker.deployment_profile
    + " · control revision: " + ((worker.control && worker.control.revision) || 0)
    + " · oldest waiting: " + (summary.oldest_queue_age_seconds || 0) + "s" }));
  root.append(el("div", { class: "callout", text: worker.enabled
    ? "The model can submit only bounded requests. A reviewed policy may approve them, but only this separately trusted worker can invoke guarded apply."
    : "Supervised automatic apply is disabled. Approved proposals remain available for manual guarded apply." }));

  const identityActor = document.createElement("input");
  identityActor.placeholder = "Operator identity";
  identityActor.value = "local_operator";
  identityActor.setAttribute("aria-label", "Worker control operator identity");
  if (operator.provider !== "dev_env") identityActor.classList.add("hidden");
  const identityToken = document.createElement("input");
  identityToken.type = "password";
  identityToken.autocomplete = "off";
  identityToken.placeholder = "Fresh OIDC bearer token for this decision";
  identityToken.setAttribute("aria-label", "Worker control OIDC token");
  if (operator.provider !== "jwt_oidc") identityToken.classList.add("hidden");
  const reason = document.createElement("textarea");
  reason.rows = 2;
  reason.placeholder = "Operator reason";
  reason.setAttribute("aria-label", "Worker control reason");
  root.append(el("div", { class: "operator-posture", text: "Operator identity: " + operator.provider
    + (operator.verified_required ? " (verified decision required)" : " (development, unverified)") }));
  if (operator.provider !== "signed_key") root.append(identityActor, identityToken, reason);

  const runControl = async (action, capability, digest, confirmation, statusNode) => {
    const token = identityToken.value;
    identityToken.value = "";
    try {
      await api("/api/worker/control", {
        method: "POST",
        headers: { "x-synapsor-csrf": csrfToken },
        body: JSON.stringify({
          action,
          capability,
          contract_digest: digest,
          confirm: confirmation,
          actor: identityActor.value,
          reason: reason.value,
          identity_token: token || undefined,
        }),
      });
      statusNode.textContent = "Control recorded. Queued proposals were preserved and no source row changed.";
      await Promise.all([loadWorker(), loadAttention()]);
    } catch (error) {
      statusNode.textContent = error.message;
    }
  };

  const globalControl = el("section", { class: "decision-panel" });
  globalControl.append(el("h3", { text: "Worker lease control" }));
  if (operator.provider === "signed_key") {
    globalControl.append(
      el("p", { text: "The browser never accepts a private key. Run the exact signed CLI control instead." }),
      el("div", { class: "mono", text: "synapsor-runner worker "
        + (mode === "active" ? "pause" : "resume") + " --yes --config " + configPath, style: "display:block" }),
    );
  } else {
    const selector = document.createElement("select");
    selector.setAttribute("aria-label", "Worker lease control action");
    for (const [value, label] of [["pause", "Pause new leases"], ["resume", "Resume leasing"], ["drain", "Drain without new leases"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = label; selector.append(option);
    }
    selector.value = mode === "active" ? "pause" : "resume";
    const confirmation = document.createElement("input");
    confirmation.className = "exact-confirmation";
    confirmation.setAttribute("aria-label", "Exact worker lease control confirmation");
    const expected = () => selector.value === "pause" ? "PAUSE WORKER" : selector.value === "resume" ? "RESUME WORKER" : "DRAIN WORKER";
    const updateExpected = () => { confirmation.placeholder = expected(); };
    selector.onchange = updateExpected; updateExpected();
    const status = el("div", { class: "status-line", text: "This changes leasing only. It does not discard queued work or interrupt a committed transaction." });
    const submit = el("button", { text: "Apply exact worker control", onclick: async () => {
      submit.disabled = true;
      await runControl(selector.value, undefined, undefined, confirmation.value, status);
      submit.disabled = false;
    } });
    globalControl.append(selector, confirmation, el("div", { class: "actions" }, submit), status);
  }
  root.append(globalControl);

  const capabilitySection = el("section", { class: "decision-panel" });
  capabilitySection.append(el("h3", { text: "Exact capability digests" }));
  const capabilities = worker.capabilities || [];
  if (!capabilities.length) {
    capabilitySection.append(el("p", { text: "No exact capability/digest worker allowlist is configured." }));
  }
  for (const capability of capabilities) {
    const row = el("details", { class: "raw" });
    row.append(el("summary", { text: capability.capability + " · " + capability.control_status }));
    const kv = el("dl", { class: "kv" });
    kv.append(
      el("dt", { text: "Exact digest" }), el("dd", { text: capability.contract_digest }),
      el("dt", { text: "Worker identity" }), el("dd", { text: capability.worker_identity || "(deployment default)" }),
      el("dt", { text: "Writer posture" }), el("dd", { text: capability.writer_posture.separation + " · " + capability.writer_posture.live_role_verification }),
      el("dt", { text: "Required sinks" }), el("dd", { text: (capability.required_attention_sinks || []).join(", ") || "none" }),
    );
    row.append(kv);
    if (operator.provider === "signed_key") {
      row.append(el("div", { class: "mono", text: "synapsor-runner worker disable "
        + capability.capability + " --digest " + capability.contract_digest + " --yes --config " + configPath, style: "display:block" }));
    } else {
      const selector = document.createElement("select");
      selector.setAttribute("aria-label", "Exact capability digest control action for " + capability.capability);
      for (const [value, label] of [["capability_enable", "Enable exact digest"], ["capability_disable", "Disable exact digest"], ["digest_revoke", "Revoke digest permanently"]]) {
        const option = document.createElement("option"); option.value = value; option.textContent = label; selector.append(option);
      }
      selector.value = capability.control_status === "enabled" ? "capability_disable" : "capability_enable";
      if (capability.control_status === "revoked") selector.value = "digest_revoke";
      const confirmation = document.createElement("input");
      confirmation.className = "exact-confirmation";
      confirmation.setAttribute("aria-label", "Exact capability digest confirmation for " + capability.capability);
      const expected = () => selector.value === "capability_enable"
        ? capability.enable_confirmation
        : selector.value === "capability_disable"
          ? capability.disable_confirmation
          : capability.revoke_confirmation;
      const updateExpected = () => { confirmation.placeholder = expected(); };
      selector.onchange = updateExpected; updateExpected();
      const status = el("div", { class: "status-line", text: "Only the named capability and exact digest are affected." });
      const submit = el("button", { class: selector.value === "digest_revoke" ? "danger" : "secondary", text: "Apply exact digest control", onclick: async () => {
        submit.disabled = true;
        await runControl(selector.value, capability.capability, capability.contract_digest, confirmation.value, status);
        submit.disabled = false;
      } });
      row.append(selector, confirmation, el("div", { class: "actions" }, submit), status);
    }
    capabilitySection.append(row);
  }
  root.append(capabilitySection);

  const queueSection = el("section", { class: "decision-panel" });
  queueSection.append(el("div", { class: "detail-head" }, [
    el("h3", { text: "Execution queue", style: "margin:0" }),
    chip((worker.queue || []).length + " tracked", (worker.queue || []).length ? "wait" : "ok"),
  ]));
  if (!(worker.queue || []).length) queueSection.append(el("p", { text: "No worker jobs are recorded." }));
  for (const item of worker.queue || []) {
    const row = el("details", { class: "raw" });
    row.append(el("summary", { text: item.status.toUpperCase() + " · " + item.capability + " · " + item.proposal_id }));
    const kv = el("dl", { class: "kv" });
    kv.append(
      el("dt", { text: "Approval / execution" }), el("dd", { text: item.approval_source + " / " + item.execution_mode }),
      el("dt", { text: "Digest" }), el("dd", { text: item.contract_digest || "(legacy)" }),
      el("dt", { text: "Attempt" }), el("dd", { text: item.attempts + "/" + item.max_attempts }),
      el("dt", { text: "Lease" }), el("dd", { text: item.lease_owner ? item.lease_owner + " until " + item.lease_expires_at : "not leased" }),
      el("dt", { text: "Safe error" }), el("dd", { text: item.last_error_code || "none" }),
      el("dt", { text: "Next" }), el("dd", { text: item.next_action }),
    );
    row.append(kv);
    const actions = el("div", { class: "actions" });
    actions.append(el("button", { class: "secondary", text: "Open proposal timeline", onclick: async () => {
      await loadProposals(); await loadDetail(item.proposal_id); byId("proposals").scrollIntoView({ behavior: "smooth", block: "start" });
    } }));
    if (item.cancel_confirmation || item.recovery_confirmation) {
      if (operator.provider === "signed_key") {
        const subcommand = item.cancel_confirmation ? "cancel" : "dead-letter requeue";
        row.append(
          el("p", { text: "The browser never accepts a private signing key. Use the exact trusted CLI recovery path." }),
          el("div", { class: "mono", text: "synapsor-runner worker " + subcommand + " "
            + item.proposal_id + " --yes --config " + configPath, style: "display:block" }),
        );
      } else {
        const selector = document.createElement("select");
        selector.setAttribute("aria-label", "Worker queue control action for " + item.proposal_id);
        const choices = item.cancel_confirmation
          ? [["cancel", "Cancel before lease"]]
          : [["requeue", "Requeue dead letter"], ["discard", "Discard terminal dead letter"]];
        for (const [value, label] of choices) {
          const option = document.createElement("option"); option.value = value; option.textContent = label; selector.append(option);
        }
        const confirmation = document.createElement("input");
        confirmation.className = "exact-confirmation";
        confirmation.setAttribute("aria-label", "Exact worker queue confirmation for " + item.proposal_id);
        const expected = () => selector.value === "cancel"
          ? item.cancel_confirmation
          : selector.value === "discard"
            ? item.discard_confirmation
            : item.recovery_confirmation;
        const updateExpected = () => { confirmation.placeholder = expected(); };
        selector.onchange = updateExpected; updateExpected();
        const status = el("div", { class: "status-line", text: item.cancel_confirmation
          ? "Cancellation is allowed only before lease."
          : "Dead-letter recovery requires a verified operator and never replays a database mutation by itself." });
        const submit = el("button", { class: item.cancel_confirmation ? "danger" : "secondary", text: "Apply exact queue control", onclick: async () => {
          submit.disabled = true;
          const token = identityToken.value; identityToken.value = "";
          try {
            await api("/api/worker/queue/" + encodeURIComponent(item.proposal_id) + "/" + selector.value, {
              method: "POST",
              headers: { "x-synapsor-csrf": csrfToken },
              body: JSON.stringify({
                confirm: confirmation.value,
                actor: identityActor.value,
                reason: reason.value,
                identity_token: token || undefined,
                retry_budget: 3,
              }),
            });
            await Promise.all([loadWorker(), loadAttention(), loadProposals()]);
          } catch (error) {
            status.textContent = error.message;
            submit.disabled = false;
          }
        } });
        row.append(selector, confirmation);
        actions.append(submit);
        row.append(status);
      }
    }
    if (item.reconciliation) {
      const intentId = item.reconciliation.intent_id;
      if (operator.provider === "signed_key") {
        row.append(
          el("p", { text: "Inspect the live source from the trusted terminal before signing a reconciliation decision." }),
          el("div", { class: "mono", text: "synapsor-runner writeback reconcile inspect "
            + intentId + " --config " + configPath, style: "display:block" }),
        );
      } else {
        const inspectionRoot = el("div", { class: "callout", text: "Live source state has not been inspected in this browser session." });
        const inspect = el("button", { class: "secondary", text: "Inspect live reconciliation", onclick: async () => {
          inspect.disabled = true;
          try {
            const payload = await api("/api/worker/reconciliation/" + encodeURIComponent(intentId));
            const view = payload.reconciliation;
            inspectionRoot.replaceChildren(
              el("strong", { text: "Supported outcome: " + view.supported_outcome }),
              el("p", { text: "Live classification: " + view.classification
                + " · observed digest: " + view.observed_digest
                + " · members: " + view.member_count }),
              el("p", { text: "Runner returns only field names, classification, and digests here; source-row values remain outside Workbench." }),
            );
            const confirmation = document.createElement("input");
            confirmation.className = "exact-confirmation";
            confirmation.placeholder = payload.required_confirmation;
            const resolveStatus = el("div", { class: "status-line", text: "Resolution re-inspects the source and refuses any outcome other than the one still supported." });
            const resolve = el("button", { class: "danger", text: "Resolve exact observed outcome", onclick: async () => {
              resolve.disabled = true;
              const token = identityToken.value; identityToken.value = "";
              try {
                await api("/api/worker/reconciliation/" + encodeURIComponent(intentId) + "/resolve", {
                  method: "POST",
                  headers: { "x-synapsor-csrf": csrfToken },
                  body: JSON.stringify({
                    outcome: view.supported_outcome,
                    confirm: confirmation.value,
                    actor: identityActor.value,
                    reason: reason.value,
                    identity_token: token || undefined,
                  }),
                });
                await Promise.all([loadWorker(), loadAttention(), loadProposals()]);
              } catch (error) {
                resolveStatus.textContent = error.message;
                resolve.disabled = false;
              }
            } });
            inspectionRoot.append(confirmation, el("div", { class: "actions" }, resolve), resolveStatus);
          } catch (error) {
            inspectionRoot.textContent = error.message;
            inspect.disabled = false;
          }
        } });
        row.append(inspectionRoot);
        actions.append(inspect);
      }
    }
    row.append(actions);
    queueSection.append(row);
  }
  queueSection.append(el("p", { class: "status-line", text: "Starting a long-running worker remains an explicit operator process action:" }));
  queueSection.append(el("div", { class: "mono", text: worker.start_command, style: "display:block" }));
  root.append(queueSection, rawJson("Safe worker status JSON", worker));
}
async function loadTools() {
  const payload = await api("/api/tools");
  const root = byId("tools"); root.replaceChildren(text("h2", "Tools"));
  for (const tool of payload.tools) {
    const box = document.createElement("div"); box.className = "card"; box.style.margin = "10px 0"; box.style.boxShadow = "none";
    box.append(text("strong", tool.name), text("div", tool.target_business_object, "pitem-target"));
    box.append(chip(tool.kind, tool.kind === "read" ? "ok" : "wait"));
    box.append(chip(tool.no_raw_sql_exposed ? "No raw SQL" : "RAW SQL EXPOSED", tool.no_raw_sql_exposed ? "ok" : "bad"));
    box.append(rawJson("View reviewed boundary", { target: tool.target_business_object, operation: tool.operation, input_schema: tool.input_schema, hidden_trusted_bindings: tool.hidden_trusted_bindings, allowed_patch_columns: tool.allowed_patch_columns, conflict_guard: tool.conflict_guard, reversibility: tool.reversibility }));
    root.append(box);
  }
}
async function loadProposals() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state.activityFilters)) if (value) params.set(key, value);
  const payload = await api("/api/lifecycle" + (params.size ? "?" + params.toString() : ""));
  const root = byId("proposals"); root.replaceChildren(text("h2", "Activity"));
  root.append(text("p", "Recent lifecycles appear automatically. No proposal ID is needed."));

  const handleInput = document.createElement("input");
  handleInput.placeholder = "Known proposal, evidence, replay, job, intent, receipt, or audit handle";
  handleInput.setAttribute("aria-label", "Known ledger handle");
  const handleStatus = el("div", { class: "status-line", text: "" });
  const openHandle = el("button", { class: "secondary", text: "Open", onclick: async () => {
    const handle = handleInput.value.trim();
    if (!handle) { handleStatus.textContent = "Enter a known ledger handle."; return; }
    openHandle.disabled = true;
    try {
      const resolved = await api("/api/lifecycle/" + encodeURIComponent(handle));
      await loadDetail(resolved.lifecycle.proposal.proposal_id);
      handleInput.value = "";
      handleStatus.textContent = "Opened the linked proposal lifecycle.";
    } catch (error) {
      handleStatus.textContent = error.message;
    } finally {
      openHandle.disabled = false;
    }
  } });
  handleInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); openHandle.click(); }
  });
  root.append(el("div", { class: "handle-row" }, [
    el("label", {}, [text("span", "Open a known handle"), handleInput]),
    openHandle,
  ]), handleStatus);

  const filterGrid = el("div", { class: "filter-grid" });
  const controls = {};
  const addInput = (key, label, type = "text", placeholder = "") => {
    const input = document.createElement("input");
    input.type = type;
    input.value = state.activityFilters[key] || "";
    input.placeholder = placeholder;
    input.setAttribute("aria-label", label);
    controls[key] = input;
    filterGrid.append(el("label", {}, [text("span", label), input]));
  };
  const status = document.createElement("select");
  status.setAttribute("aria-label", "Lifecycle status");
  const statusOptions = [
    ["", "All statuses"],
    ["pending_review", "Awaiting approval"],
    ["approved", "Approved"],
    ["pending_worker", "Queued"],
    ["applied", "Committed"],
    ["conflict", "Conflict"],
    ["failed", "Failed"],
    ["reconciliation_required", "Reconciliation required"],
    ["rejected", "Rejected"],
    ["canceled", "Canceled"],
  ];
  for (const [value, label] of statusOptions) {
    const option = document.createElement("option");
    option.value = value; option.textContent = label;
    status.append(option);
  }
  status.value = state.activityFilters.status || "";
  controls.status = status;
  filterGrid.append(el("label", {}, [text("span", "Status"), status]));
  addInput("capability", "Capability", "text", "billing.propose_credit");
  addInput("object_type", "Business object", "text", "invoice");
  addInput("object_id", "Object ID", "text", "INV-3001");
  addInput("tenant", "Tenant", "text", "acme");
  addInput("principal", "Principal", "text", "support-agent");
  addInput("from", "From", "datetime-local");
  addInput("to", "To", "datetime-local");
  const filterDetails = el("details", { class: "raw" });
  filterDetails.append(el("summary", { text: "Filter activity" }), filterGrid);
  const applyFilters = el("button", { class: "secondary", text: "Apply filters", onclick: async () => {
    state.activityFilters = Object.fromEntries(Object.entries(controls)
      .map(([key, control]) => [key, control.value.trim()])
      .filter(([, value]) => value));
    await loadProposals();
    if (state.firstId) await loadDetail(state.firstId);
  } });
  const clearFilters = el("button", { class: "secondary", text: "Clear", onclick: async () => {
    state.activityFilters = {};
    await loadProposals();
    if (state.firstId) await loadDetail(state.firstId);
  } });
  filterDetails.append(el("div", { class: "filter-actions" }, [applyFilters, clearFilters]));
  root.append(filterDetails);

  root.append(el("div", { class: "status-line", text: payload.total_matches + " matched · " + payload.returned + " shown" }));
  if (payload.lifecycles.length === 0) {
    root.append(text("p", "No proposal lifecycles match. Clear filters, or have an agent call an active proposal capability."));
    state.firstId = null;
    return;
  }
  const list = el("div", { class: "plist" });
  for (const lifecycle of payload.lifecycles) {
    const st = humanizeState(lifecycle.state);
    const item = el("button", { class: "pitem" + (lifecycle.proposal_id === state.selected ? " sel" : ""), onclick: () => loadDetail(lifecycle.proposal_id) }, [
      el("div", { class: "pitem-action", text: lifecycle.capability }),
      el("div", { class: "pitem-target", text: lifecycle.business_object + ":" + lifecycle.object_id + " · " + lifecycle.operation }),
      chip(st.label, st.tone),
      chip(lifecycle.source_database_mutated ? "Source changed" : "Source unchanged", lifecycle.source_database_mutated ? "info" : "muted"),
    ]);
    list.append(item);
  }
  root.append(list);
  state.firstId = payload.lifecycles[0].proposal_id;
}
function shadowMetric(label, value) {
  return el("div", { class: "pill", text: label + ": " + String(value) });
}
async function loadShadowReport(studyId) {
  const root = byId("shadow-report");
  const studiesPayload = await api("/api/shadow/studies");
  const studies = studiesPayload.studies || [];
  if (!studies.length) {
    root.replaceChildren(
      el("h2", { text: "Shadow studies" }),
      el("p", { text: "No studies yet. Create one with synapsor-runner shadow study create, then record authoritative outcomes without giving the shadow agent write authority." }),
    );
    return;
  }
  const selected = studyId || state.shadowStudy || studies[0].study_id;
  state.shadowStudy = selected;
  const payload = await api("/api/shadow/report?study=" + encodeURIComponent(selected));
  const report = payload.report;
  if (!report) return;
  const selector = el("div", { class: "actions" });
  for (const study of studies) {
    selector.append(el("button", {
      class: study.study_id === selected ? "" : "secondary",
      text: study.name,
      onclick: () => loadShadowReport(study.study_id),
    }));
  }
  const metrics = el("div", { class: "actions" }, [
    shadowMetric("Observed", report.total_tasks_observed),
    shadowMetric("Authoritative", report.tasks_with_authoritative_outcomes),
    shadowMetric("Comparable", report.comparable_tasks),
    shadowMetric("Exact", report.exact_agreements),
    shadowMetric("Partial", report.partial_agreements),
    shadowMetric("Disagreements", report.disagreements),
    shadowMetric("Unmatched", report.unmatched_cases),
    shadowMetric("Unsafe scope blocked", report.invalid_or_unsafe_scope_attempts),
  ]);
  const risks = el("div");
  risks.append(el("h3", { text: "Highest-risk disagreements" }));
  if (!report.highest_risk_disagreements.length) {
    risks.append(el("p", { text: "None recorded." }));
  } else {
    const table = document.createElement("table");
    table.append(el("thead", {}, [el("tr", {}, [
      el("th", { text: "Case" }),
      el("th", { text: "Classification" }),
      el("th", { text: "Target" }),
      el("th", { text: "Risk" }),
    ])]));
    const body = document.createElement("tbody");
    for (const item of report.highest_risk_disagreements) {
      body.append(el("tr", {}, [
        el("td", { text: item.case_id }),
        el("td", { text: item.status }),
        el("td", { text: item.business_object + ":" + item.object_id }),
        el("td", { text: item.risk_score == null ? "n/a" : item.risk_score }),
      ]));
    }
    table.append(body);
    risks.append(table);
  }
  const raw = document.createElement("details");
  raw.className = "raw";
  raw.append(el("summary", { text: "View stable report JSON" }), pre(report));
  root.replaceChildren(
    el("h2", { text: "Shadow study: " + report.study.name }),
    el("p", { text: "Agent proposals are compared with explicit authoritative outcomes. Unmatched tasks stay visible and suggestions remain inactive." }),
    selector,
    metrics,
    risks,
    raw,
  );
}
function commitResult(stateVal) {
  switch (stateVal) {
    case "pending_review": return { label: "Not committed yet — awaiting human approval.", tone: "wait" };
    case "approved": return { label: "Approved. The trusted runner will attempt the commit.", tone: "wait" };
    case "pending_worker": return { label: "Queued for the trusted runner.", tone: "wait" };
    case "applied": return { label: "Committed by the trusted runner. The approved change was applied.", tone: "ok" };
    case "conflict": return { label: "Conflict: the row changed after the proposal. No write applied.", tone: "warn" };
    case "failed": return { label: "Writeback failed. No write applied.", tone: "bad" };
    case "rejected": return { label: "No commit. The proposal was rejected.", tone: "bad" };
    case "canceled": return { label: "No commit. The proposal was canceled.", tone: "muted" };
    default: return { label: stateVal, tone: "muted" };
  }
}
function buildStory(payload) {
  const proposal = payload.proposal;
  const rv = payload.review_view || {};
  const cs = proposal.change_set || {};
  const stateVal = proposal.state;
  const target = proposal.source_schema + "." + proposal.source_table;
  const objectId = proposal.object_id;
  const mutated = proposal.source_database_mutated === true;
  const events = payload.events || [];
  const find = (k) => events.find((e) => e.kind === k);
  const principalId = (cs.principal && cs.principal.id) || "the agent";
  const requiredRole = (cs.approval && cs.approval.required_role) || "a reviewer";
  const approvalProgress = payload.approval_progress || { approved: 0, required: 1, remaining: 1, complete: false };
  const freshness = payload.freshness || { required: false, status: "not_required" };
  const story = el("div", { class: "story" });

  // 1. Agent requested a change
  story.append(stepCard("1", "Agent requested a change", "info", [
    el("div", { class: "mono", text: proposal.action + " for " + objectId }),
    el("p", { text: "The model called a semantic MCP tool. It could request this change, but it had no tools to run SQL, approve, or commit." }),
  ]));

  // 2. Synapsor Runner created a proposal
  story.append(stepCard("2", "Synapsor Runner created a proposal", "ok", [
    el("p", { text: "The request was captured as a reviewable proposal in the local store." }),
    el("div", { class: "kv" }, [
      el("dt", { text: "Proposal" }), el("dd", { text: proposal.proposal_id }),
      el("dt", { text: "Tenant" }), el("dd", { text: proposal.tenant_id }),
      el("dt", { text: "Principal" }), el("dd", { text: principalId }),
      el("dt", { text: "Evidence" }), el("dd", { text: (rv.evidence_summary && rv.evidence_summary.bundle_id) || "not recorded" }),
    ]),
    el("p", { text: rv.kept_out_fields && rv.kept_out_fields.note ? rv.kept_out_fields.note : "Fields outside the reviewed visible-column allowlist stay out." }),
  ]));

  // 3. The proposed change
  const proposedChange = [diffBlock(target, rv.diff)];
  if (rv.bounded_set) {
    proposedChange.push(el("div", { class: "callout", text: "Bounded set: " + rv.bounded_set.row_count + " exact rows frozen (reviewed maximum " + rv.bounded_set.max_rows + "). Apply will not re-run a broad predicate." }));
    proposedChange.push(rawJson("Review exact members and aggregate bounds", rv.bounded_set));
  }
  story.append(stepCard("3", "The proposed change", "info", proposedChange));

  // 4. Safety result
  story.append(stepCard("4", "Safety result", mutated ? "ok" : "ok", [
    el("div", { class: "badge-row" }, [
      el("span", { text: "Source database changed:" }),
      el("span", { class: "badge " + (mutated ? "yes" : "no"), text: mutated ? "Yes" : "No" }),
    ]),
    el("p", { text: mutated
      ? "The trusted runner applied the approved change to the source database."
      : "Proposing and reviewing did not modify the source database." }),
  ]));

  // 5. Approval boundary
  const approveBody = [
    el("div", { class: "callout", text: "Approval happened outside MCP. The model did not get approve or commit tools." }),
    el("div", { class: "kv" }, [
      el("dt", { text: "Approval progress" }), el("dd", { text: approvalProgress.approved + "/" + approvalProgress.required }),
      el("dt", { text: "Policy result" }), el("dd", { text: (rv.policy_and_risk && rv.policy_and_risk.decision) || stateVal }),
      el("dt", { text: "Live freshness" }), el("dd", { text: String(freshness.status || "not checked").replaceAll("_", " ") }),
      el("dt", { text: "Freshness checks" }), el("dd", { text: String(freshness.target_count || 0) + " target / " + String(freshness.supporting_count || 0) + " supporting" }),
    ]),
  ];
  if (freshness.required) {
    approveBody.push(el("p", { text: freshness.status === "fresh"
      ? "The live preflight passed. Approval still does not guarantee freshness through apply; the trusted apply path checks again."
      : freshness.status === "stale"
        ? "The target or supporting evidence drifted. This proposal cannot be refreshed; create a new source read and proposal."
        : "A live source preflight is required before this proposal can be approved." }));
  }
  const approvedEv = find("proposal_approved");
  const rejectedEv = find("proposal_rejected");
  if (stateVal === "pending_review") {
    approveBody.push(el("div", { class: "status-line", text: "Waiting for a human reviewer (" + requiredRole + ")." }));
  } else if (rejectedEv) {
    approveBody.push(el("div", { class: "status-line", text: "Rejected by " + rejectedEv.actor + (rejectedEv.payload && rejectedEv.payload.reason ? ": " + rejectedEv.payload.reason : "") + "." }));
  } else if (approvedEv) {
    approveBody.push(el("div", { class: "status-line", text: "Approved by " + approvedEv.actor + (approvedEv.payload && approvedEv.payload.reason ? ": " + approvedEv.payload.reason : "") + "." }));
  } else if (stateVal === "canceled") {
    approveBody.push(el("div", { class: "status-line", text: "The proposal was canceled before approval." }));
  }
  story.append(stepCard("5", "Approval boundary", rejectedEv ? "bad" : (approvedEv ? "ok" : "wait"), approveBody));

  // 6. Commit result
  const cr = commitResult(stateVal);
  const commitBody = [el("p", { text: cr.label })];
  if (rv.guard_checklist) commitBody.push(guardDrawer(rv.guard_checklist));
  story.append(stepCard("6", "Commit result", cr.tone, commitBody));

  // 7. Reviewed compensation, when configured or captured
  const reversibility = rv.reversibility || {};
  let replayStep = "7";
  if (reversibility.status && reversibility.status !== "not_configured") {
    const reverseBody = [el("p", { text: reversibility.message })];
    if (reversibility.status === "available") {
      reverseBody.push(el("div", { class: "mono", text: trustedRevertCommand(proposal.proposal_id), style: "display:block;margin-top:8px" }));
      reverseBody.push(el("div", { class: "callout", text: "Run this from a trusted terminal. It creates a new proposal and performs no immediate write." }));
    }
    if (reversibility.status === "unavailable" && reversibility.reason_codes) {
      reverseBody.push(el("div", { class: "status-line", text: "Reason: " + reversibility.reason_codes.join(", ") }));
    }
    if (reversibility.status === "compensation_proposal") {
      reverseBody.push(el("div", { class: "kv" }, [
        el("dt", { text: "Reverts proposal" }), el("dd", { text: reversibility.reverts_proposal_id }),
        el("dt", { text: "Lineage depth" }), el("dd", { text: String(reversibility.depth) }),
        el("dt", { text: "Exact members" }), el("dd", { text: String(reversibility.member_count) }),
      ]));
    }
    const reverseTone = reversibility.status === "unavailable" ? "warn" : (reversibility.status === "available" ? "ok" : "info");
    story.append(stepCard("7", "Reviewed compensation", reverseTone, reverseBody));
    replayStep = "8";
  }

  // Final step. Replay
  const tl = el("div", { class: "timeline" });
  if (!events.length) {
    tl.append(el("p", { text: "No replay events recorded yet." }));
  } else {
    for (const e of events) {
      const m = eventMeta(e.kind);
      tl.append(el("div", { class: "tl-row" }, [
        el("span", { class: "tl-dot tl-" + m.tone }),
        el("div", {}, [
          el("div", { class: "tl-label", text: m.label }),
          el("div", { class: "tl-meta", text: (e.actor || "") + (e.created_at ? " · " + e.created_at : "") }),
        ]),
      ]));
    }
  }
  const replayDrawer = rawJson("View redacted replay linkage", {
    replay: payload.lifecycle ? payload.lifecycle.replay : null,
    timeline: payload.lifecycle ? payload.lifecycle.timeline : [],
  });
  story.append(stepCard(replayStep, "Replay saved what happened", "info", [tl, replayDrawer]));

  return story;
}
async function loadDetail(proposalId, knownPayload) {
  const requestRevision = ++state.detailRequestRevision;
  state.selected = proposalId;
  const payload = knownPayload || await api("/api/proposals/" + encodeURIComponent(proposalId));
  if (requestRevision !== state.detailRequestRevision) return;
  const proposal = payload.proposal;
  const lifecycle = payload.lifecycle || {};
  const operator = payload.operator || { provider: "dev_env", verified_required: false, apply_roles: [], workbench_identity_input: "development_actor" };
  const profile = payload.deployment_profile || "unknown";
  const st = humanizeState(proposal.state);
  const root = byId("detail"); root.replaceChildren();

  const head = el("div", { class: "detail-head" }, [
    el("div", {}, [
      el("h2", { text: "Data PR", style: "margin:0" }),
      el("div", { class: "sub", text: proposal.action + " · " + proposal.object_id + " · " + proposal.source_schema + "." + proposal.source_table }),
    ]),
    chip(st.label, st.tone),
  ]);
  root.append(head);

  const reviewTab = el("button", { class: "tab active", text: "Review" });
  const lifecycleTab = el("button", { class: "tab", text: "Ledger timeline" });
  const jsonTab = el("button", { class: "tab", text: "Safe JSON" });
  const reviewPane = el("div", { class: "pane" });
  const lifecyclePane = el("div", { class: "pane hidden" });
  const jsonPane = el("div", { class: "pane hidden" });
  const showPane = (tab, pane) => {
    for (const item of [reviewTab, lifecycleTab, jsonTab]) item.classList.remove("active");
    for (const item of [reviewPane, lifecyclePane, jsonPane]) item.classList.add("hidden");
    tab.classList.add("active"); pane.classList.remove("hidden");
  };
  reviewTab.onclick = () => showPane(reviewTab, reviewPane);
  lifecycleTab.onclick = () => showPane(lifecycleTab, lifecyclePane);
  jsonTab.onclick = () => showPane(jsonTab, jsonPane);
  root.append(el("div", { class: "tabs" }, [reviewTab, lifecycleTab, jsonTab]));

  const dataPr = payload.data_pr || {};
  const dataPrHead = el("div", { class: "data-pr-head" }, [
    el("strong", { text: dataPr.title || proposal.action }),
    el("div", { class: "kv" }, [
      el("dt", { text: "Capability" }), el("dd", { text: dataPr.capability || proposal.action }),
      el("dt", { text: "Operation identity" }), el("dd", { text: dataPr.operation_identity ? dataPr.operation_identity.proposal_hash : proposal.proposal_hash }),
      el("dt", { text: "Source unchanged before approval" }), el("dd", { text: dataPr.source_unchanged_before_approval ? "Yes" : "No" }),
      el("dt", { text: "Executor / receipt mode" }), el("dd", { text: fmtVal(dataPr.executor) + " / " + fmtVal(dataPr.receipt_mode) }),
    ]),
  ]);
  reviewPane.append(dataPrHead, buildStory(payload));
  lifecyclePane.append(buildLedgerTimeline(lifecycle));

  if (proposal.state === "pending_review") {
    const decision = el("section", { class: "decision-panel" });
    const approval = proposal.change_set && typeof proposal.change_set.approval === "object"
      ? proposal.change_set.approval
      : {};
    const requiredRole = approval.required_role;
    decision.append(
      el("h3", { text: "1. Approve this exact proposal" }),
      el("div", { class: "callout", text: "Approval records a human decision outside MCP. It does not apply or mutate the source database." }),
      el("div", { class: "operator-posture", text: "Identity: " + operator.provider + (operator.verified_required ? " (verified)" : " (development, unverified)") + " · required role: " + (typeof requiredRole === "string" ? requiredRole : "reviewer") }),
    );
    const freshness = payload.freshness || { required: false, status: "not_required" };
    const freshnessStatus = el("div", { class: "status-line", text: freshness.required
      ? "Freshness: " + String(freshness.status || "not checked").replaceAll("_", " ") + "."
      : "Approval-time source freshness is not configured for this capability. Guarded apply still enforces its reviewed conflict and idempotency controls." });
    decision.append(freshnessStatus);
    const setReviewActionsDisabled = (disabled) => {
      for (const button of decision.querySelectorAll("button")) button.disabled = disabled;
    };
    const check = freshness.required
      ? el("button", { id: "check-live-freshness", class: "secondary", text: "Check live freshness", onclick: async () => {
        setReviewActionsDisabled(true);
        freshnessStatus.textContent = "Checking the current source state...";
        try {
          await api("/api/proposals/" + encodeURIComponent(proposalId) + "/check-freshness", {
            method: "POST",
            headers: { "x-synapsor-csrf": csrfToken },
            body: JSON.stringify({}),
          });
        } catch (error) {
          freshnessStatus.textContent = error.message;
        } finally {
          await loadProposals();
          await loadDetail(proposalId);
          if (decision.isConnected) setReviewActionsDisabled(false);
        }
      } })
      : null;
    if (operator.provider === "signed_key") {
      decision.append(
        el("p", { text: "This project requires a local private-key signature. The browser does not accept or retain that key." }),
        el("div", { class: "mono", text: trustedApproveCommand(proposalId), style: "display:block;margin-top:8px" }),
      );
      if (check) decision.append(el("div", { class: "actions" }, [check]));
    } else {
      const actor = document.createElement("input");
      actor.placeholder = "Reviewer identity";
      actor.value = "local_reviewer";
      actor.setAttribute("aria-label", "Reviewer identity");
      if (operator.provider !== "dev_env") actor.classList.add("hidden");
      const reason = document.createElement("textarea");
      reason.placeholder = "Why this exact effect is approved";
      reason.rows = 2;
      reason.setAttribute("aria-label", "Approval reason");
      const confirmation = document.createElement("input");
      confirmation.className = "exact-confirmation";
      confirmation.placeholder = "APPROVE " + proposal.proposal_hash;
      confirmation.setAttribute("aria-label", "Exact approval confirmation");
      const token = document.createElement("input");
      token.type = "password";
      token.autocomplete = "off";
      token.placeholder = "Fresh OIDC bearer token for this approval only";
      token.setAttribute("aria-label", "OIDC bearer token for approval");
      if (operator.provider !== "jwt_oidc") token.classList.add("hidden");
      const decisionStatus = el("div", { class: "status-line", text: "Type the exact hash-bound confirmation. Approval uses the current unexpired freshness proof and checks again only when needed." });
      const approve = el("button", { text: "Approve outside MCP", onclick: async () => {
        setReviewActionsDisabled(true);
        const identityToken = token.value;
        token.value = "";
        try {
          const result = await api("/api/proposals/" + encodeURIComponent(proposalId) + "/approve", {
            method: "POST",
            headers: { "x-synapsor-csrf": csrfToken },
            body: JSON.stringify({
              actor: actor.value,
              reason: reason.value,
              confirm: confirmation.value,
              identity_token: identityToken || undefined,
            }),
          });
          await Promise.all([loadProposals(), loadDetail(proposalId, result)]);
        } catch (error) {
          decisionStatus.textContent = error.message;
          if (decision.isConnected) setReviewActionsDisabled(false);
        }
      } });
      const actions = el("div", { class: "actions" });
      if (check) actions.append(check);
      actions.append(approve);
      if (operator.provider === "dev_env") {
        const reject = el("button", { class: "danger", text: "Reject", onclick: async () => {
          try {
            await api("/api/proposals/" + encodeURIComponent(proposalId) + "/reject", {
              method: "POST",
              headers: { "x-synapsor-csrf": csrfToken },
              body: JSON.stringify({ actor: actor.value, reason: reason.value || "rejected from local Workbench", confirm: "reject" }),
            });
            await loadProposals();
            await loadDetail(proposalId);
          } catch (error) {
            decisionStatus.textContent = error.message;
          }
        } });
        actions.append(reject);
      }
      decision.append(actor, token, reason, confirmation, actions, decisionStatus);
    }
    reviewPane.append(decision);
  } else if (proposal.state === "approved" || proposal.state === "pending_worker") {
    const decision = el("section", { class: "decision-panel" });
    decision.append(
      el("h3", { text: "2. Apply guarded writeback" }),
      el("div", { class: "callout", text: "This is a separate trusted-operator decision. Apply re-verifies approval integrity, identity and apply role, live freshness, tenant/principal scope, conflict guards, idempotency, and affected-row bounds." }),
      el("div", { class: "badge-row" }, [
        el("span", { text: "Source database changed so far:" }),
        el("span", { class: "badge no", text: "No" }),
      ]),
      el("div", { class: "operator-posture", text: "Profile: " + profile + " · identity: " + operator.provider + " · apply roles: " + ((operator.apply_roles || []).join(", ") || "no extra apply-role gate") }),
    );
    const localApplyAllowed = profile === "development" || profile === "staging";
    if (!localApplyAllowed || operator.provider === "signed_key") {
      const command = trustedApplyCommand(proposalId);
      decision.append(
        el("p", { text: !localApplyAllowed
          ? "Browser apply is disabled for production or unknown profiles. Use the configured trusted production path."
          : "The browser never accepts a private signing key. Use the trusted CLI path." }),
        el("div", { class: "mono", text: command, style: "display:block;margin-top:8px" }),
      );
    } else {
      const actor = document.createElement("input");
      actor.placeholder = "Apply operator identity";
      actor.value = "local_operator";
      actor.setAttribute("aria-label", "Apply operator identity");
      if (operator.provider !== "dev_env") actor.classList.add("hidden");
      const reason = document.createElement("textarea");
      reason.placeholder = "Why this approved effect should be committed now";
      reason.rows = 2;
      reason.setAttribute("aria-label", "Apply reason");
      const confirmation = document.createElement("input");
      confirmation.className = "exact-confirmation";
      confirmation.placeholder = "APPLY " + proposal.proposal_hash;
      confirmation.setAttribute("aria-label", "Exact apply confirmation");
      const token = document.createElement("input");
      token.type = "password";
      token.autocomplete = "off";
      token.placeholder = "Fresh OIDC bearer token for this apply decision only";
      token.setAttribute("aria-label", "OIDC bearer token for apply");
      if (operator.provider !== "jwt_oidc") token.classList.add("hidden");
      const applyStatus = el("div", { class: "status-line", text: "Type the second exact hash-bound confirmation. This action may change the source database." });
      const apply = el("button", { text: "Apply guarded writeback", onclick: async () => {
        apply.disabled = true;
        const identityToken = token.value;
        token.value = "";
        try {
          const result = await api("/api/proposals/" + encodeURIComponent(proposalId) + "/apply", {
            method: "POST",
            headers: { "x-synapsor-csrf": csrfToken },
            body: JSON.stringify({
              actor: actor.value,
              reason: reason.value,
              confirm: confirmation.value,
              identity_token: identityToken || undefined,
            }),
          });
          applyStatus.textContent = result.source_database_changed
            ? "Guarded writeback applied. Receipt and replay are now linked."
            : "No source mutation was needed; inspect the receipt outcome.";
          await Promise.all([loadProposals(), loadDetail(proposalId, result)]);
        } catch (error) {
          applyStatus.textContent = error.message;
          apply.disabled = false;
        }
      } });
      decision.append(actor, token, reason, confirmation, el("div", { class: "actions" }, [apply]), applyStatus);
    }
    reviewPane.append(decision);
  }

  jsonPane.append(
    el("p", { text: "The lifecycle JSON is metadata-only: evidence rows, trusted tenant/principal values, credentials, write requests, and receipt bodies are not returned here." }),
    el("h3", { text: "Redacted lifecycle", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(lifecycle),
    el("h3", { text: "Exact reviewed proposal effect", style: "margin:16px 0 2px;font-size:13px;color:var(--muted)" }), pre({
      proposal_id: proposal.proposal_id,
      proposal_version: proposal.proposal_version,
      proposal_hash: proposal.proposal_hash,
      capability: proposal.capability || proposal.action,
      state: proposal.state,
      tenant_id: proposal.tenant_id,
      principal: proposal.principal,
      change_set: proposal.change_set,
      source_database_mutated: proposal.source_database_mutated,
    }),
  );
  root.append(reviewPane, lifecyclePane, jsonPane);
}
function buildLedgerTimeline(lifecycle) {
  const root = el("div");
  const approval = lifecycle.approval || {};
  const evidence = lifecycle.evidence || { count: 0, bundles: [] };
  const audit = lifecycle.query_audit || { count: 0, records: [] };
  const writeback = lifecycle.writeback || { jobs: [], intents: [], receipts: [] };
  root.append(el("div", { class: "ledger-summary" }, [
    el("div", {}, [el("strong", { text: String((approval.decisions || []).length) }), text("span", "approval decisions")]),
    el("div", {}, [el("strong", { text: String(evidence.count || 0) }), text("span", "evidence bundles")]),
    el("div", {}, [el("strong", { text: String((writeback.receipts || []).length) }), text("span", "writeback receipts")]),
  ]));
  const timeline = el("div", { class: "timeline" });
  for (const event of lifecycle.timeline || []) {
    const meta = eventMeta(event.kind);
    const row = el("div", { class: "tl-row" }, [
      el("span", { class: "tl-dot tl-" + meta.tone }),
      el("div", {}, [
        el("div", { class: "tl-label", text: meta.label }),
        el("div", { class: "tl-meta", text: (event.actor || "system") + (event.occurred_at ? " · " + event.occurred_at : "") }),
      ]),
    ]);
    if (event.summary && Object.keys(event.summary).length) row.lastChild.append(rawJson("Event metadata", event.summary));
    timeline.append(row);
  }
  if (!(lifecycle.timeline || []).length) timeline.append(el("p", { text: "No lifecycle events recorded." }));
  root.append(timeline);
  const sections = [
    ["Approval and verified identity", approval],
    ["Approval-time freshness", lifecycle.freshness],
    ["Evidence metadata", evidence],
    ["Query-audit metadata", audit],
    ["Writeback jobs, intents, queue and receipts", writeback],
    ["Replay linkage", lifecycle.replay],
    ["Compensation lineage", lifecycle.compensation],
    ["Cloud references", lifecycle.cloud],
  ];
  for (const [label, value] of sections) root.append(rawJson(label, value || null));
  if (lifecycle.next) {
    root.append(el("div", { class: "callout", text: "Next: " + (lifecycle.next.operator || lifecycle.next.read_only) }));
  }
  return root;
}
async function init() {
  await Promise.all([loadWorkbench(), loadAttention(), loadWorker(), loadSummary(), loadTools(), loadProposals(), loadShadowReport()]);
  if (state.firstId && !state.selected) await loadDetail(state.firstId);
  window.setInterval(async () => {
    try {
      await Promise.all([loadAttention(), loadWorker()]);
    } catch (_) {
      // Keep the current inbox visible while the local ledger is temporarily busy.
    }
  }, 5000);
  window.setInterval(async () => {
    if (state.firstId) return;
    try {
      await loadProposals();
      if (state.firstId) {
        await loadWorkbench();
        await loadDetail(state.firstId);
      }
    } catch (_) {
      // Keep the current operator view intact during a transient local poll failure.
    }
  }, 2000);
}
init().catch((error) => {
  document.body.textContent = error.message;
});
</script>
</body>
</html>`;
}

function redactSecrets(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSecrets(entryValue, entryKey)]));
  }
  if (typeof value === "string") {
    const safeMetadataKey = key === "credential_source";
    if (!safeMetadataKey && !key.endsWith("_env") && /(password|secret|token|api[_-]?key|private[_-]?key|cookie|credential|connection[_-]?string|database[_-]?url)/i.test(key)) {
      return "<redacted>";
    }
    return value
      .replace(/(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@/gi, "$1<user>:<redacted>@")
      .replace(/(mysql:\/\/)([^:]+):([^@]+)@/gi, "$1<user>:<redacted>@")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
      .replace(/syn_wbr_[A-Za-z0-9._~+/=-]+/g, "syn_wbr_<redacted>");
  }
  return value;
}

function escapeScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/</g, "\\u003c");
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isInactiveExplorationBoundary(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const fsError = error as NodeJS.ErrnoException;
  return error.message === "Exploration boundary is not active."
    || (fsError.code === "ENOENT"
      && typeof fsError.path === "string"
      && ["exploration-boundary.active.json", "exploration-boundaries.active.json"]
        .includes(path.basename(fsError.path)));
}

async function prepareAutoBoundaryRescan(input: {
  projectRoot: string;
  boundaryRoot: string;
  schemaInspector: typeof inspectDatabase;
  resetOverrides: boolean;
}): Promise<{
  build: AutoBoundaryBuild;
  previewDigest: `sha256:${string}`;
  diff: JsonRecord;
}> {
  const lock = JSON.parse(await fs.readFile(path.join(input.projectRoot, ".synapsor/generation-lock.json"), "utf8")) as GenerationLock;
  const oldDraft = JSON.parse(await fs.readFile(path.join(input.boundaryRoot, "exploration-boundary.draft.json"), "utf8")) as ExplorationBoundaryDraft;
  const inspection = await input.schemaInspector({
    engine: lock.engine,
    databaseUrlEnv: lock.source_env,
    schema: lock.inspected_schema,
    env: process.env,
  });
  const project = await detectProjectContext(input.projectRoot);
  const evidence = await loadStructuredProjectEvidence(project);
  const previousProgress = await readSharedBoundaryReviewProgress(input.projectRoot, oldDraft);
  const configuredTrustedContext = await resolveConfiguredTrustedContextAuthority({
    projectRoot: input.projectRoot,
    sourceEnv: lock.source_env,
    candidate: previousProgress?.candidate ?? oldDraft,
    fallbackAuthority: lock.trusted_context_authority,
  });
  const buildInput = {
    inspection,
    project,
    parsedEvidence: evidence.parsed,
    existingContracts: evidence.existingContracts,
    sourceEnv: lock.source_env,
    inspectedSchema: lock.inspected_schema,
    deploymentProfile: oldDraft.deployment_profile,
    configuredTrustedContext,
    ...(oldDraft.trusted_context.provider === "http_claims" ? {
      httpClaims: {
        tenantClaim: oldDraft.trusted_context.tenant_claim,
        principalClaim: oldDraft.trusted_context.principal_claim,
      },
    } : {}),
    ...(oldDraft.organization_scope ? {
      singleOrganization: { organizationId: oldDraft.organization_scope.organization_id },
    } : {}),
  } satisfies Parameters<typeof buildAutoBoundary>[0];
  const cleanBuild = buildAutoBoundary(buildInput);
  const currentOverrides = input.resetOverrides
    ? { overrides: emptyReviewOverrides(), removed: [] }
    : pruneAutoBoundaryReviewOverrides(
      inspection,
      boundaryReviewOverridesForCandidate({
        progress: previousProgress,
        baseline: cleanBuild.exploration_boundary,
        candidate: previousProgress?.candidate ?? oldDraft,
      }),
      {
        project,
        parsedEvidence: evidence.parsed,
        existingContracts: evidence.existingContracts,
        configuredTrustedContext,
      },
    );
  const build = buildAutoBoundary({
    ...buildInput,
    overrides: currentOverrides.overrides,
  });
  build.exploration_boundary.pack.name = oldDraft.pack.name;
  build.policy_baseline.boundary.pack.name = oldDraft.pack.name;
  const diff = boundarySemanticDiff(oldDraft, build, currentOverrides.removed);
  const previewDigest = canonicalJsonDigest({
    schema_version: "synapsor.boundary-rescan-preview.v1",
    old_generation_lock: oldDraft.generation_lock_fingerprint,
    new_generation_lock: build.exploration_boundary.generation_lock_fingerprint,
    new_contract_digest: build.contract_digest,
    reviewed_overrides: build.overrides,
    diff,
  });
  return { build, previewDigest, diff };
}

function boundarySemanticDiff(
  previous: ExplorationBoundaryDraft,
  next: AutoBoundaryBuild,
  removedOverrides: string[],
): JsonRecord {
  const before = new Map(previous.pack.resources.map((resource) => [resource.id, resource]));
  const after = new Map(next.exploration_boundary.pack.resources.map((resource) => [resource.id, resource]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort();
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort();
  const changed = [...after.keys()].filter((id) => {
    const existing = before.get(id);
    return existing !== undefined && canonicalJsonDigest(existing) !== canonicalJsonDigest(after.get(id));
  }).sort();
  return {
    schema_changed: previous.generation_lock_fingerprint !== next.exploration_boundary.generation_lock_fingerprint,
    resources_before: before.size,
    resources_after: after.size,
    added_resources: added,
    removed_resources: removed,
    changed_resources: changed,
    pruned_review_inputs: removedOverrides,
    source_database_changed: false,
  };
}

function managedReviewMutationRequest(
  decision: ManagedBoundaryReviewDecision,
): BoundaryResourceReviewRequest {
  const common = {
    resource_id: decision.resource_id,
    actor: decision.actor,
    reason: decision.reason,
    ...(decision.decided_at ? { decided_at: decision.decided_at } : {}),
  };
  if (decision.kind === "resource_metadata") {
    return {
      ...common,
      metadata: {
        ...(decision.label !== undefined ? { label: decision.label } : {}),
        ...(decision.description !== undefined ? { description: decision.description } : {}),
      },
    };
  }
  if (decision.kind === "field_metadata") {
    return {
      ...common,
      field_metadata: [{
        field: decision.field,
        ...(decision.label !== undefined ? { label: decision.label } : {}),
        ...(decision.description !== undefined ? { description: decision.description } : {}),
      }],
    };
  }
  if (decision.kind === "field_exposure") {
    return {
      ...common,
      ...(decision.exposure === "keep_out"
        ? { keep_out_fields: [decision.field] }
        : decision.exposure === "withhold_from_model"
          ? { withhold_from_model_fields: [decision.field] }
          : { allow_reviewed_fields: [decision.field] }),
    };
  }
  if (decision.kind === "field_enum") {
    return {
      ...common,
      field_enum: {
        field: decision.field,
        values: [...decision.values],
      },
    };
  }
  if (decision.kind === "derived_measure") {
    if (decision.definition === null) {
      throw new Error("Workbench derived-measure removal requires the reviewed resource editor.");
    }
    if ("base_measure" in decision.definition) {
      return {
        ...common,
        derived_measure: {
          name: decision.name,
          label: decision.definition.label,
          shape: decision.definition.shape,
          base_measure: structuredClone(decision.definition.base_measure),
          ...(decision.definition.direction ? { direction: decision.definition.direction } : {}),
          ...(decision.definition.window_size !== undefined
            ? { window_size: decision.definition.window_size }
            : {}),
          ...(decision.remove ? { remove: true } : {}),
        },
      };
    }
    if ("child_resource" in decision.definition) {
      return {
        ...common,
        derived_measure: {
          name: decision.name,
          label: decision.definition.label,
          shape: decision.definition.shape,
          child_resource: decision.definition.child_resource,
          relationship: decision.definition.relationship,
          ...(decision.remove ? { remove: true } : {}),
        },
      };
    }
    return {
      ...common,
      derived_measure: {
        name: decision.name,
        label: decision.definition.label,
        shape: decision.definition.shape,
        numerator: structuredClone(decision.definition.numerator),
        denominator: structuredClone(decision.definition.denominator),
        ...(decision.remove ? { remove: true } : {}),
      },
    };
  }
  if (decision.kind === "numeric_band") {
    if (decision.definition === null) {
      throw new Error("Workbench numeric-band removal requires the reviewed resource editor.");
    }
    return {
      ...common,
      numeric_band: {
        name: decision.name,
        label: decision.definition.label,
        field: decision.definition.field,
        ...(decision.definition.relationship
          ? { relationship: decision.definition.relationship }
          : {}),
        edges: [...decision.definition.edges],
        bucket_labels: [...decision.definition.bucket_labels],
        ...(decision.remove ? { remove: true } : {}),
      },
    };
  }
  if (decision.kind === "auto_band") {
    if (decision.definition === null) {
      throw new Error("Workbench automatic-band removal requires the reviewed resource editor.");
    }
    return {
      ...common,
      auto_band: {
        ...structuredClone(decision.definition),
        ...(decision.remove ? { remove: true } : {}),
      },
    };
  }
  if (decision.kind === "row_identity") {
    return { ...common, include: true, row_identity: decision.value };
  }
  if (decision.kind === "tenant_key") {
    return { ...common, include: true, tenant_key: decision.value };
  }
  if (decision.kind === "tenant_scope_path") {
    return { ...common, include: true, tenant_scope_path: decision.value };
  }
  if (decision.kind === "shared_reference_scope") {
    return {
      ...common,
      include: true,
      shared_reference_scope: decision.acknowledgement,
    };
  }
  if (decision.kind === "principal_key") {
    return { ...common, principal_key: decision.value };
  }
  if (decision.kind === "principal_scope_path") {
    return { ...common, principal_scope_path: decision.value };
  }
  if (decision.kind === "minimum_cohort") {
    return { ...common, minimum_cohort_size: decision.value };
  }
  throw new Error(`Unsupported managed review decision ${decision.kind}.`);
}

function applyManagedBoundaryReviewDecision(
  current: AutoBoundaryReviewOverrides,
  body: JsonRecord,
): AutoBoundaryReviewOverrides {
  const kind = typeof body.kind === "string" ? body.kind : "";
  const resourceId = requiredReviewText(body.resource_id, "resource_id");
  const actor = requiredReviewText(body.actor, "actor");
  const reason = requiredReviewText(body.reason, "reason");
  const decidedAt = new Date().toISOString();
  const next = structuredClone(current);
  if (next.schema_version !== AUTO_BOUNDARY_OVERRIDES_VERSION) {
    throw new Error(`Managed review decisions require ${AUTO_BOUNDARY_OVERRIDES_VERSION}.`);
  }
  const resource = next.resources[resourceId] ?? {};

  if (kind === "field_exposure") {
    const field = requiredReviewText(body.field, "field");
    if (body.exposure !== "keep_out"
      && body.exposure !== "withhold_from_model"
      && body.exposure !== "allow_reviewed_use") {
      throw new Error(
        "field_exposure review requires exposure keep_out, withhold_from_model, or allow_reviewed_use.",
      );
    }
    resource.fields = {
      ...(resource.fields ?? {}),
      [field]: {
        exposure: body.exposure,
        actor,
        reason,
        decided_at: decidedAt,
      },
    };
  } else if (kind === "field_enum") {
    const field = requiredReviewText(body.field, "field");
    if (!Array.isArray(body.values)
      || body.values.length > 64
      || body.values.some((value) => typeof value !== "string" || [...value].length > 64)
      || new Set(body.values).size !== body.values.length
      || Buffer.byteLength(JSON.stringify(body.values), "utf8") > 2_048) {
      throw new Error(
        "field_enum review requires at most 64 unique values, at most 64 characters each and 2048 bytes total.",
      );
    }
    resource.field_enums = {
      ...(resource.field_enums ?? {}),
      [field]: {
        values: body.values.map(String),
        actor,
        reason,
        decided_at: decidedAt,
      },
    };
  } else if (kind === "derived_measure") {
    const name = requiredReviewText(body.name, "name");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new Error("derived_measure review requires a safe name of at most 64 characters.");
    }
    if (body.remove === true || body.definition === null) {
      if (resource.derived_measures) {
        delete resource.derived_measures[name];
        if (Object.keys(resource.derived_measures).length === 0) delete resource.derived_measures;
      }
    } else {
      const definition = normalizeExplorationDerivedMeasure(
        body.definition,
        `${resourceId}.${name} derived measure`,
      );
      if (definition.name !== name) {
        throw new Error("derived_measure review name must match its fixed definition name.");
      }
      resource.derived_measures = {
        ...(resource.derived_measures ?? {}),
        [name]: { definition, actor, reason, decided_at: decidedAt },
      };
    }
  } else if (kind === "numeric_band") {
    const name = requiredReviewText(body.name, "name");
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new Error("numeric_band review requires a safe name of at most 64 characters.");
    }
    if (body.remove === true || body.definition === null) {
      if (resource.numeric_bands) {
        delete resource.numeric_bands[name];
        if (Object.keys(resource.numeric_bands).length === 0) delete resource.numeric_bands;
      }
    } else {
      const definition = normalizeExplorationNumericBand(
        body.definition,
        `${resourceId}.${name} numeric band`,
      );
      if (definition.name !== name) {
        throw new Error("numeric_band review name must match its fixed definition name.");
      }
      resource.numeric_bands = {
        ...(resource.numeric_bands ?? {}),
        [name]: { definition, actor, reason, decided_at: decidedAt },
      };
    }
  } else if (kind === "auto_band") {
    const field = requiredReviewText(body.field, "field");
    if (body.remove === true || body.definition === null) {
      if (resource.auto_bands) {
        delete resource.auto_bands[field];
        if (Object.keys(resource.auto_bands).length === 0) delete resource.auto_bands;
      }
    } else {
      const definition = normalizeExplorationAutoBandPolicy(
        body.definition,
        `${resourceId}.${field} auto band`,
      );
      if (definition.field !== field) {
        throw new Error("auto_band review field must match its policy field.");
      }
      resource.auto_bands = {
        ...(resource.auto_bands ?? {}),
        [field]: { definition, actor, reason, decided_at: decidedAt },
      };
    }
  } else if (kind === "row_identity" || kind === "tenant_key" || kind === "tenant_scope_path") {
    const decision = {
      value: requiredReviewText(body.value, "value"),
      actor,
      reason,
      decided_at: decidedAt,
    };
    if (kind === "row_identity") resource.row_identity = decision;
    else if (kind === "tenant_key") {
      resource.tenant_key = decision;
      delete resource.tenant_scope_path;
      delete resource.shared_reference_scope;
    } else {
      resource.tenant_scope_path = decision;
      delete resource.tenant_key;
      delete resource.shared_reference_scope;
    }
  } else if (kind === "shared_reference_scope") {
    if (body.acknowledgement !== SHARED_REFERENCE_ACKNOWLEDGEMENT) {
      throw new Error(
        `shared_reference_scope review requires acknowledgement ${SHARED_REFERENCE_ACKNOWLEDGEMENT}.`,
      );
    }
    resource.shared_reference_scope = {
      value: SHARED_REFERENCE_ACKNOWLEDGEMENT,
      actor,
      reason,
      decided_at: decidedAt,
    };
    delete resource.tenant_key;
    delete resource.tenant_scope_path;
  } else if (kind === "principal_key" || kind === "principal_scope_path") {
    const value = body.value === null ? null : requiredReviewText(body.value, "value");
    if (kind === "principal_key") {
      resource.principal_key = { value, actor, reason, decided_at: decidedAt };
      delete resource.principal_scope_path;
    } else {
      resource.principal_scope_path = { value, actor, reason, decided_at: decidedAt };
      delete resource.principal_key;
    }
  } else if (kind === "minimum_cohort") {
    if (!Number.isSafeInteger(body.value) || Number(body.value) < 1 || Number(body.value) > 5) {
      throw new Error("minimum_cohort review requires an integer from 1 through 5.");
    }
    if (Number(body.value) === 5) {
      delete resource.minimum_cohort;
    } else {
      resource.minimum_cohort = {
        value: Number(body.value),
        actor,
        reason,
        decided_at: decidedAt,
      };
    }
  } else {
    throw new Error(
      "Managed boundary review kind must be field_exposure, field_enum, derived_measure, numeric_band, auto_band, row_identity, tenant_key, tenant_scope_path, shared_reference_scope, principal_key, principal_scope_path, or minimum_cohort.",
    );
  }

  next.resources[resourceId] = resource;
  return next;
}

function requiredReviewText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Managed boundary review requires ${label}.`);
  return value.trim();
}

function trustedScopeLabel(
  source: "environment" | "postgres_role_setting" | "verified_http_claim" | "reviewed_organization",
  binding: string,
): string {
  if (source === "verified_http_claim") return `verified HTTP claim ${binding}`;
  if (source === "reviewed_organization") return binding;
  return source === "postgres_role_setting"
    ? `the read-only database credential (${binding})`
    : `the operator environment (${binding})`;
}

function trustedScopeValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Trusted ${label} scope must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\r\n\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Trusted ${label} scope must be 1-256 characters without control characters.`);
  }
  return normalized;
}

function scopedExploreRemediation(error: unknown): {
  action: string;
  command?: string;
  preserved: string;
} {
  const code = error instanceof ScopedExploreError ? error.code : "EXPLORE_INTERNAL";
  const preserved = "The reviewed boundary, generated files, and source database were not changed.";
  const relationshipReview = error instanceof ScopedExploreError
    && isRecord(error.details?.relationship_review)
    ? error.details.relationship_review
    : undefined;
  if (code === "EXPLORE_RELATIONSHIP_FORBIDDEN" && relationshipReview) {
    return {
      action: "Review and add this catalog-proven relationship. Runner will stage only this path for normal human review and exact-digest activation.",
      preserved,
    };
  }
  switch (code) {
    case "EXPLORE_DISABLED":
      return {
        action: "Return to Boundary Review, complete the required decisions, and activate the exact reviewed digest.",
        preserved,
      };
    case "EXPLORE_PROFILE_FORBIDDEN":
      return {
        action: "Relaunch through the local guided start path, or configure an explicit Development or Staging profile through the established operator route before activating a new digest.",
        preserved,
      };
    case "EXPLORE_LOCK_STALE":
    case "EXPLORE_BOUNDARY_MISMATCH":
      return {
        action: "Choose Rescan and show changes. Review the semantic drift before activating a new digest.",
        preserved,
      };
    case "EXPLORE_ROLE_UNSAFE":
      return {
        action: "Reconnect with a verified non-owner, non-superuser, non-BYPASSRLS, SELECT-only database role, then rescan.",
        preserved,
      };
    case "EXPLORE_SCOPE_FORBIDDEN":
      {
        const missing = error instanceof ScopedExploreError
          && Array.isArray(error.details?.missing_bindings)
          ? error.details.missing_bindings
            .filter(isRecord)
            .map((binding) => typeof binding.env === "string" ? binding.env : undefined)
            .filter((value): value is string => Boolean(value))
          : [];
        const namedBindings = missing.length > 0 ? missing.join(" and ") : "the trusted scope environment values";
        return {
          action: `Configure ${namedBindings} in the operator-owned environment, then retry. Do not enter identity values into an analytics question or model prompt.`,
          preserved,
        };
      }
    case "EXPLORE_SOURCE_UNAVAILABLE":
      return {
        action: "Restore the reviewed read-only database connection and retry. Runner will recheck role and schema posture.",
        preserved,
      };
    case "EXPLORE_PRIVACY_BUDGET_EXHAUSTED":
    case "EXPLORE_RATE_LIMITED":
    case "EXPLORE_RESPONSE_TOO_LARGE":
      return {
        action: "Narrow the reviewed request or wait for the documented session/rate window; do not widen the boundary to bypass the limit.",
        preserved,
      };
    case "EXPLORE_FIELD_FORBIDDEN":
    case "EXPLORE_RESOURCE_FORBIDDEN":
    case "EXPLORE_RELATIONSHIP_FORBIDDEN":
    case "EXPLORE_PLAN_INVALID":
      return {
        action: "Use only the resources, fields, relationships, and bounds shown in Explore reviewed data.",
        preserved,
      };
    case "EXPLORE_TRANSPORT_FORBIDDEN":
      return {
        action: "Use this secured loopback Workbench or the local stdio authoring configuration.",
        preserved,
      };
    default:
      return {
        action: "Review the local Runner diagnostics, preserve the current draft, and retry from Workbench.",
        preserved,
      };
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
