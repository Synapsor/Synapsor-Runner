import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { buildProposalReviewView, createMcpRuntime, evaluateProposalFreshness, loadRuntimeConfigFromFile, type ProposalFreshnessEvaluation } from "@synapsor-runner/mcp-server";
import { ProposalStore, type LocalProposalState, type StoredProposal } from "@synapsor-runner/proposal-store";
import { protocolVersions, type FreshnessProofV1 } from "@synapsor-runner/protocol";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { cursorProjectStatus } from "./cursor-project.js";
import {
  activateExplorationBoundary,
  explorationBoundaryCandidateDigest,
  reviewExplorationBoundaryCandidate,
  type ExplorationBoundaryDraft,
  type GenerationLock,
} from "./auto-boundary.js";
import {
  activateProtectedQuery,
  createProtectedQueryDraft,
  disableScopedExplore,
  listProtectableQueries,
  type ProtectArgumentSelection,
} from "./protect-query.js";
import {
  activateSafeActionDraft,
  prepareSafeActionPreview,
  recordSafeActionEffectPreview,
  safeActionStatus,
  type SafeActionStatus,
} from "./safe-action.js";

type JsonRecord = Record<string, unknown>;

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
  safeActionPreview?: SafeActionPreview;
  freshnessEvaluator?: ProposalFreshnessEvaluator;
};

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
  const storeAccess = options.storeAccess ?? localStoreAccess(storePath);
  const projectRoot = path.resolve(options.projectRoot ?? path.dirname(configPath));
  const boundaryRoot = options.boundaryRoot ? path.resolve(options.boundaryRoot) : undefined;
  const safeActionPreview = options.safeActionPreview ?? executeSafeActionPreview;
  const freshnessEvaluator = options.freshnessEvaluator
    ?? ((proposal: StoredProposal) => evaluateWorkbenchFreshness(configPath, proposal));
  const bootstrapState = { consumed: false };

  const server = createServer(async (request, response) => {
    try {
      await handleRequest({ request, response, configPath, storePath, projectRoot, boundaryRoot, storeAccess, safeActionPreview, freshnessEvaluator, token, csrfToken, tour: options.tour === true, bootstrapState });
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
  const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}${options.tour ? "&tour=1" : ""}`;
  return {
    server,
    url,
    host,
    port,
    token,
    csrfToken,
    close: () => new Promise((resolve, reject) => {
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
  safeActionPreview: SafeActionPreview;
  freshnessEvaluator: ProposalFreshnessEvaluator;
  token: string;
  csrfToken: string;
  tour: boolean;
  bootstrapState: { consumed: boolean };
}): Promise<void> {
  const { request, response, configPath, storePath, projectRoot, boundaryRoot, storeAccess, safeActionPreview, freshnessEvaluator, token, csrfToken, tour, bootstrapState } = input;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("token")) {
    if (url.searchParams.get("token") !== token || bootstrapState.consumed) {
      sendJson(response, 401, { ok: false, error: "local UI bootstrap token is invalid or already consumed" });
      return;
    }
    bootstrapState.consumed = true;
    response.setHeader("set-cookie", `synapsor_ui_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=900`);
    sendRedirect(response, tour || url.searchParams.get("tour") === "1" ? "/?tour=1" : "/");
    return;
  }
  if (!hasValidSessionToken(request, url, token)) {
    sendJson(response, 401, { ok: false, error: "local UI session token required" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, boundaryRoot
      ? renderBoundaryShell(csrfToken)
      : renderShell(csrfToken, tour || url.searchParams.get("tour") === "1", configPath, storePath));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/boundary") {
    if (!boundaryRoot) {
      sendJson(response, 404, { ok: false, error: "Auto Boundary review is not enabled for this Workbench session." });
      return;
    }
    const draft = JSON.parse(await fs.readFile(path.join(boundaryRoot, "exploration-boundary.draft.json"), "utf8")) as ExplorationBoundaryDraft;
    const review = JSON.parse(await fs.readFile(path.join(boundaryRoot, "generation-review.json"), "utf8")) as Record<string, unknown>;
    sendJson(response, 200, {
      ok: true,
      draft,
      review,
      candidate_digest: explorationBoundaryCandidateDigest(draft),
      active: await readOptionalJson(path.join(projectRoot, ".synapsor/exploration-boundary.active.json")),
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
    const lock = JSON.parse(await fs.readFile(path.join(projectRoot, ".synapsor/generation-lock.json"), "utf8")) as GenerationLock;
    const inspection = await inspectDatabase({
      engine: lock.engine,
      databaseUrlEnv: lock.source_env,
      env: process.env,
    });
    const active = await activateExplorationBoundary({
      projectRoot,
      candidate: body.candidate as unknown as ExplorationBoundaryDraft,
      expectedDigest: body.expected_digest,
      actor: body.actor,
      confirmation: body.confirmation,
      confirmedDecisions: body.confirmed_decisions,
      currentInspection: inspection,
    });
    sendJson(response, 200, {
      ok: true,
      active,
      tools_list_changed: false,
      reconnect_required: true,
      message: "The reviewed authoring boundary is active. Scoped Explore remains local-only and must be explicitly served from this project.",
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
    if (!isRecord(body.candidate)) throw new Error("Boundary preview requires a candidate object.");
    const draft = JSON.parse(await fs.readFile(path.join(boundaryRoot, "exploration-boundary.draft.json"), "utf8")) as ExplorationBoundaryDraft;
    const preview = reviewExplorationBoundaryCandidate(draft, body.candidate as unknown as ExplorationBoundaryDraft);
    sendJson(response, 200, { ok: true, ...preview });
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
    });
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
    if (typeof body.capability_name !== "string"
      || typeof body.expected_digest !== "string"
      || typeof body.confirmation !== "string"
      || typeof body.actor !== "string") {
      throw new Error("Protected-capability activation requires capability_name, expected_digest, confirmation, and actor.");
    }
    const active = await activateProtectedQuery({
      projectRoot,
      capabilityName: body.capability_name,
      expectedDigest: body.expected_digest,
      confirmation: body.confirmation,
      actor: body.actor,
      configPath,
      disableExplore: body.disable_explore !== false,
    });
    sendJson(response, 200, {
      ok: true,
      active,
      tools_list_changed: true,
      reconnect_required: true,
      message: active.exploration_disabled
        ? "The protected named capability is active and Scoped Explore is disabled. Reconnect the production MCP client to load only reviewed named tools."
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
    const disabled = await disableScopedExplore(projectRoot);
    sendJson(response, 200, {
      ok: true,
      ...disabled,
      protected_capabilities_changed: false,
      message: "Scoped Explore is disabled. Existing protected named capabilities were not changed.",
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

  if (request.method === "GET" && url.pathname === "/api/proposals") {
    const state = url.searchParams.get("state") as LocalProposalState | null;
    await storeAccess("read", "proposals-list", (store) => {
      const proposals = store.listProposals(state ?? undefined).map((proposal) => summarizeProposal(proposal));
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
    await storeAccess("read", "proposal-show", (store) => {
      const proposal = requireProposal(store, proposalId);
      const receipts = store.receipts(proposalId);
      const reviewView = buildProposalReviewView(proposal, receipts);
      sendJson(response, 200, {
        ok: true,
        proposal,
        approval_progress: store.approvalProgress(proposalId),
        review_view: reviewView,
        data_pr: buildDataPr(proposal, reviewView, receipts.at(-1)),
        events: store.events(proposalId),
        receipts,
        evidence: store.getEvidenceBundle(proposal.change_set.evidence.bundle_id),
        freshness: storedFreshnessSummary(proposal, store.latestFreshnessProof(proposalId)),
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
      sendJson(response, 403, { ok: false, error: "Cloud-linked proposals must be reviewed in Synapsor Cloud; local approval is disabled." });
      return;
    }
    if (await signedIdentityRequired(configPath)) {
      sendJson(response, 403, { ok: false, error: "This Runner requires a signed operator identity. Approve with the CLI using --identity and --identity-key." });
      return;
    }
    const proposalId = decodeURIComponent(approveMatch[1] ?? "");
    const body = await readJsonBody(request);
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

  const rejectMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/reject$/);
  if (request.method === "POST" && rejectMatch) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for proposal review actions" });
      return;
    }
    if (await cloudLinkedGovernance(configPath)) {
      sendJson(response, 403, { ok: false, error: "Cloud-linked proposals must be reviewed in Synapsor Cloud; local rejection is disabled." });
      return;
    }
    if (await signedIdentityRequired(configPath)) {
      sendJson(response, 403, { ok: false, error: "This Runner requires a signed operator identity. Reject with the CLI using --identity and --identity-key." });
      return;
    }
    const proposalId = decodeURIComponent(rejectMatch[1] ?? "");
    const body = await readJsonBody(request);
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
    const proposalId = typeof result.proposal_id === "string" ? result.proposal_id : "";
    const proposalHash = typeof result.proposal_hash === "string" ? result.proposal_hash : "";
    if (!proposalId || !proposalHash) throw new Error("Safe Action preview did not create an immutable proposal");
    if (result.source_database_changed === true || result.source_database_mutated === true) throw new Error("Safe Action preview unexpectedly changed source data");
    const proposal = await runtime.store.getProposal(proposalId);
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
        cursorState === "installed" ? "Project Cursor MCP entry is installed" : `Cursor project state: ${cursorState}`),
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
        : "Keep this Workbench open. It will update when Cursor creates the first proposal; no follow-up CLI command is required.",
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

function hasValidCsrf(request: IncomingMessage, csrfToken: string): boolean {
  return request.headers["x-synapsor-csrf"] === csrfToken;
}

function hasValidSessionToken(request: IncomingMessage, url: URL, expectedToken: string): boolean {
  void url;
  const header = request.headers["x-synapsor-ui-token"];
  if (header === expectedToken) return true;
  const cookies = parseCookies(String(request.headers.cookie ?? ""));
  return cookies.synapsor_ui_token === expectedToken;
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
    *{box-sizing:border-box;letter-spacing:0}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,sans-serif}header{background:var(--surface);border-bottom:1px solid var(--line)}header div,main{width:min(1180px,calc(100% - 32px));margin:auto}header div{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px}h1{font-size:20px;margin:0}h2{font-size:16px;margin:28px 0 10px}h3{font-size:15px;margin:0}main{padding:24px 0 48px}.state{color:var(--warn);font-weight:700}.notice{background:var(--surface);border-left:3px solid var(--warn);padding:12px 14px}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));background:var(--surface);border:1px solid var(--line)}.metric{padding:14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}.metric strong{display:block;font-size:22px}.metric span,.scope{color:var(--muted)}.resource{padding:16px 0;border-top:1px solid var(--line)}.resource-head{display:flex;justify-content:space-between;gap:12px}.resource-toggle,.relationship{display:flex;align-items:center;gap:8px}.relationships{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:12px;padding:10px;background:var(--bg)}.panel{background:var(--surface);border:1px solid var(--line);padding:16px}.posture{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);gap:16px;align-items:start}.posture>*{min-width:0}.posture label{display:flex;flex-direction:column;gap:6px;color:var(--muted)}.posture code{overflow-wrap:anywhere;word-break:break-all}.query{display:block;width:100%;text-align:left;margin:8px 0;background:transparent;color:var(--text);border-color:var(--line)}.query.selected{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 20%,transparent)}table{width:100%;table-layout:fixed;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{color:var(--muted);font-size:12px}th:first-child{width:30%}code,pre{font:12px ui-monospace,monospace}pre{white-space:pre-wrap;overflow:auto;max-height:360px;background:var(--bg);border:1px solid var(--line);padding:12px}input[type=checkbox]{width:16px;height:16px;accent-color:var(--accent)}input[type=text],input[type=number],textarea,select{width:100%;min-height:36px;padding:7px 9px;border:1px solid var(--line);border-radius:4px;background:var(--surface);color:var(--text)}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.budgets,.protect-fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.budgets label,.protect-fields label{display:flex;flex-direction:column;gap:5px;color:var(--muted)}.literal{margin:10px 0;padding:10px;border:1px solid var(--line)}.literal label:first-child{display:flex;flex-direction:row;align-items:center;gap:8px}.actions{position:sticky;bottom:0;display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:24px;padding:14px;background:var(--surface);border:1px solid var(--line)}button{min-height:38px;padding:8px 14px;border:1px solid var(--accent);border-radius:4px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}button.secondary{background:transparent;color:var(--accent)}button:disabled{opacity:.5;cursor:not-allowed}#message,#protect-message{flex:1 1 260px;min-height:20px;color:var(--muted)}.error{color:var(--bad)!important}.success{color:var(--good)!important}
    @media(max-width:760px){.summary,.budgets{grid-template-columns:1fr 1fr}.posture{grid-template-columns:1fr}.actions{position:static}table{font-size:12px}th:first-child{width:38%}}@media(max-width:480px){header div,main{width:calc(100% - 20px)}.summary,.budgets,.protect-fields{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid var(--line)}.resource-head{flex-direction:column}}
  </style>
</head>
<body>
  <header><div><h1>Synapsor Auto Boundary</h1><span id="state" class="state">Loading review</span></div></header>
  <main>
    <p>Review a temporary local authoring boundary. Existing active Runner tools remain unchanged.</p>
    <div class="notice">Source rows remain unavailable until this exact digest is activated. Approval, apply, and commit are never added to MCP.</div>
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
    const csrf="${escapedCsrf}";let original,candidate,digest,reviewReport,reviewDecisions=[],protectQueries=[],selectedProtect=null,protectedDraft=null;
    const msg=document.getElementById("message");
    const permissions=[["raw","selectable_fields"],["filter","filterable_fields"],["sort","sortable_fields"],["group","groupable_fields"],["sum/avg","aggregate_measures"],["count distinct","count_distinct_fields"],["time","time_bucket_fields"]];
    const esc=v=>String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const post=async(url,body)=>{const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-synapsor-csrf":csrf},body:JSON.stringify(body)});const p=await r.json();if(!r.ok||!p.ok)throw new Error(p.error||"Request failed");return p};
    const has=(r,f,k)=>k==="filterable_fields"||k==="time_bucket_fields"?Object.hasOwn(r[k],f):r[k].includes(f);
    const currentResource=id=>candidate.pack.resources.find(r=>r.id===id);
    function allDecisionsConfirmed(){return reviewDecisions.length>0&&document.querySelectorAll("[data-review-decision]:checked").length===reviewDecisions.length}
    function updateActivationState(){document.getElementById("activate").disabled=!digest||!allDecisionsConfirmed()}
    function changed(){digest=undefined;updateActivationState()}
    function removeFieldAuthority(resource,field){resource.selectable_fields=resource.selectable_fields.filter(v=>v!==field);delete resource.filterable_fields[field];resource.sortable_fields=resource.sortable_fields.filter(v=>v!==field);resource.groupable_fields=resource.groupable_fields.filter(v=>v!==field);resource.aggregate_measures=resource.aggregate_measures.filter(v=>v!==field);resource.count_distinct_fields=resource.count_distinct_fields.filter(v=>v!==field);delete resource.time_bucket_fields[field];resource.relationships=resource.relationships.filter(r=>!r.local_columns.includes(field))}
    function setPermission(resource,field,key,checked){const source=original.pack.resources.find(r=>r.id===resource.id);if(resource.kept_out_fields.includes(field)&&checked)return;if(key==="filterable_fields"||key==="time_bucket_fields"){if(checked)resource[key][field]=structuredClone(source[key][field]);else delete resource[key][field]}else if(checked&&!resource[key].includes(field))resource[key].push(field);else if(!checked)resource[key]=resource[key].filter(v=>v!==field);changed()}
    function setResource(source,checked){if(checked&&!currentResource(source.id)){candidate.pack.resources.push(structuredClone(source));candidate.pack.resources.sort((a,b)=>a.id.localeCompare(b.id))}else if(!checked){candidate.pack.resources=candidate.pack.resources.filter(r=>r.id!==source.id);candidate.pack.resources.forEach(r=>{r.relationships=r.relationships.filter(rel=>rel.target_resource!==source.id)})}changed();renderResources()}
    function setKeptOut(source,field,checked){const resource=currentResource(source.id);if(!resource)return;if(source.kept_out_fields.includes(field)&&!checked)return;if(checked){if(!resource.kept_out_fields.includes(field))resource.kept_out_fields.push(field);removeFieldAuthority(resource,field);candidate.pack.resources.forEach(r=>{r.relationships=r.relationships.filter(rel=>!(rel.target_resource===resource.id&&rel.target_columns.includes(field)))})}else resource.kept_out_fields=resource.kept_out_fields.filter(v=>v!==field);changed();renderResources()}
    function setRelationship(source,relationship,checked){const resource=currentResource(source.id);if(!resource)return;if(checked){const target=currentResource(relationship.target_resource);if(!target||relationship.local_columns.some(field=>resource.kept_out_fields.includes(field))||relationship.target_columns.some(field=>target.kept_out_fields.includes(field)))return;if(!resource.relationships.some(item=>item.id===relationship.id))resource.relationships.push(structuredClone(relationship))}else resource.relationships=resource.relationships.filter(item=>item.id!==relationship.id);changed();renderResources()}
    function renderResources(){document.getElementById("resources").innerHTML=original.pack.resources.map((source,i)=>{const resource=currentResource(source.id);const included=Boolean(resource);const fields=Object.keys(source.field_types).sort();const relations=included&&source.relationships.length?'<div class="relationships">'+source.relationships.map((relationship,j)=>{const target=currentResource(relationship.target_resource);const blocked=!target||relationship.local_columns.some(field=>resource.kept_out_fields.includes(field))||relationship.target_columns.some(field=>target.kept_out_fields.includes(field));const checked=resource.relationships.some(item=>item.id===relationship.id);return '<label class="relationship"><input type="checkbox" data-relationship-resource="'+i+'" data-relationship="'+j+'" '+(checked?"checked":"")+(blocked?" disabled":"")+'> '+esc(relationship.id)+' → '+esc(relationship.target_resource)+' · many-to-one · max fan-out 1</label>'}).join("")+'</div>':"";return '<section class="resource"><div class="resource-head"><label class="resource-toggle"><input type="checkbox" data-resource-enabled="'+i+'" '+(included?"checked":"")+'> <h3>'+esc(source.id)+'</h3></label><span class="scope">tenant: '+esc(source.tenant_key)+(source.principal_key?' · principal: '+esc(source.principal_key):'')+'</span></div>'+(!included?'<p class="scope">Excluded from this model-visible authoring pack.</p>':'<table><thead><tr><th>Field</th>'+permissions.map(([l])=>'<th>'+esc(l)+'</th>').join("")+'<th>kept out</th></tr></thead><tbody>'+fields.map(field=>'<tr><td><code>'+esc(field)+'</code></td>'+permissions.map(([label,key])=>'<td>'+(has(source,field,key)?'<input type="checkbox" aria-label="'+esc(label)+' '+esc(field)+' for '+esc(source.id)+'" data-permission-resource="'+i+'" data-field="'+esc(field)+'" data-key="'+key+'" '+(has(resource,field,key)?"checked":"")+(resource.kept_out_fields.includes(field)?" disabled":"")+'>':'—')+'</td>').join("")+'<td><input type="checkbox" aria-label="Keep '+esc(field)+' out" data-kept-out-resource="'+i+'" data-kept-out-field="'+esc(field)+'" '+(resource.kept_out_fields.includes(field)?"checked":"")+(source.kept_out_fields.includes(field)?" disabled":"")+'></td></tr>').join("")+'</tbody></table>'+relations)+'</section>'}).join("");document.querySelectorAll("[data-resource-enabled]").forEach(input=>input.addEventListener("change",e=>{const t=e.currentTarget;setResource(original.pack.resources[Number(t.dataset.resourceEnabled)],t.checked)}));document.querySelectorAll("[data-permission-resource]").forEach(input=>input.addEventListener("change",e=>{const t=e.currentTarget;setPermission(currentResource(original.pack.resources[Number(t.dataset.permissionResource)].id),t.dataset.field,t.dataset.key,t.checked)}));document.querySelectorAll("[data-kept-out-resource]").forEach(input=>input.addEventListener("change",e=>{const t=e.currentTarget;setKeptOut(original.pack.resources[Number(t.dataset.keptOutResource)],t.dataset.keptOutField,t.checked)}));document.querySelectorAll("[data-relationship-resource]").forEach(input=>input.addEventListener("change",e=>{const t=e.currentTarget;const source=original.pack.resources[Number(t.dataset.relationshipResource)];setRelationship(source,source.relationships[Number(t.dataset.relationship)],t.checked)}))}
    function renderBudgets(){document.getElementById("budgets").innerHTML=Object.entries(candidate.budgets).map(([key,value])=>'<label>'+esc(key.replaceAll("_"," "))+'<input type="number" min="1" max="'+original.budgets[key]+'" value="'+value+'" data-budget="'+key+'"></label>').join("");document.querySelectorAll("[data-budget]").forEach(input=>input.addEventListener("change",e=>{candidate.budgets[e.currentTarget.dataset.budget]=Number(e.currentTarget.value);changed()}))}
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
        document.getElementById("protect-preview").innerHTML='<h3 style="margin-top:16px">Disabled draft</h3><p><code>'+esc(payload.draft.contract_digest)+'</code></p><pre>'+esc(payload.dsl)+'</pre><div class="protect-fields"><label>Operator identity<input id="protect-actor" type="text" maxlength="128"></label><label>Exact activation confirmation<input id="protect-confirmation" type="text" placeholder="ACTIVATE '+esc(payload.draft.contract_digest)+'"></label></div><label><input id="protect-disable-explore" type="checkbox" checked> Disable temporary Scoped Explore after activation</label><br><button id="activate-protected" type="button">Activate exact digest</button>';
        document.getElementById("activate-protected").onclick=activateProtected;
        status.textContent="Draft generated and still disabled. Review the DSL and exact digest.";
      }catch(e){status.className="error";status.textContent=e.message}
    }
    async function activateProtected(){
      const status=document.getElementById("protect-message");
      try{
        const result=await post("/api/protect/activate",{capability_name:protectedDraft.capability,expected_digest:protectedDraft.contract_digest,confirmation:document.getElementById("protect-confirmation").value,actor:document.getElementById("protect-actor").value.trim(),disable_explore:document.getElementById("protect-disable-explore").checked});
        status.className="success";status.textContent=result.message;document.getElementById("activate-protected").disabled=true;document.getElementById("state").textContent=result.active.exploration_disabled?"Protected capability active · Explore disabled":"Protected capability active · Explore local-only";
      }catch(e){status.className="error";status.textContent=e.message}
    }
    async function loadProtect(){const status=document.getElementById("protect-message");try{const p=await fetch("/api/protect").then(r=>r.json());if(!p.ok)throw new Error(p.error||"Could not load recent queries");protectQueries=p.queries;selectedProtect=protectQueries.length?0:null;renderProtect();status.className="";status.textContent=protectQueries.length?protectQueries.length+" recent query or analysis result(s) ready for review.":p.message||"No recent query is ready yet."}catch(e){protectQueries=[];selectedProtect=null;renderProtect();status.className="error";status.textContent=e.message}}
    async function load(){const p=await fetch("/api/boundary").then(r=>r.json());if(!p.ok)throw new Error(p.error||"Could not load review");original=p.draft;candidate=structuredClone(p.draft);reviewReport=p.review;reviewDecisions=[...p.review.unresolved_decisions];const s=p.review.summary;document.getElementById("summary").innerHTML=[[s.objects,"objects"],[s.draft_reads,"draft reads"],[s.blocked_objects,"blocked"],[s.sensitive_fields_kept_out,"kept-out fields"],[s.rls_policies,"RLS policies"],[s.structured_write_candidates,"disabled actions"]].map(([v,l])=>'<div class="metric"><strong>'+v+'</strong><span>'+l+'</span></div>').join("");document.getElementById("decisions").innerHTML=reviewDecisions.map((item,index)=>'<p><label><input type="checkbox" data-review-decision="'+index+'"> '+esc(item)+"</label></p>").join("");document.querySelectorAll("[data-review-decision]").forEach(input=>input.addEventListener("change",updateActivationState));document.getElementById("deployment-profile").addEventListener("change",event=>{candidate.deployment_profile=event.currentTarget.value;changed();renderPosture()});document.getElementById("state").textContent=p.active?"Active reviewed boundary":"Disabled · review required";renderPosture();renderBlocked();renderResources();renderBudgets()}
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
    <div class="card full tour">
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
    </div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapsor Runner Local UI</title>
<style>
:root { color-scheme: light; --ink:#0f172a; --muted:#475569; --line:#d8e2ee; --blue:#075985; --soft:#f8fbff; --ok:#116b35; --warn:#8a4b00; --bad:#991b1b; }
* { box-sizing: border-box; }
body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:#f4f8fb; }
main { max-width: 1180px; margin: 0 auto; padding: 28px; }
h1 { margin: 0 0 4px; font-size: 28px; }
h2 { margin: 0 0 12px; font-size: 18px; }
p { color: var(--muted); line-height: 1.5; }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
.grid > * { min-width:0; }
.tour-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:14px; }
.card { background:white; border:1px solid var(--line); border-radius:14px; padding:18px; box-shadow:0 8px 28px rgba(15,23,42,.05); }
.full { grid-column: 1 / -1; }
.pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:999px; padding:5px 10px; margin:4px 6px 4px 0; color:var(--muted); background:var(--soft); font-size:12px; }
.pill.ok { color:var(--ok); background:#eefaf2; border-color:#b7e3c2; }
.pill.warn { color:var(--warn); background:#fff7ed; border-color:#fed7aa; }
.pill.bad { color:var(--bad); background:#fef2f2; border-color:#fecaca; }
button { border:0; border-radius:10px; padding:10px 13px; color:white; background:linear-gradient(135deg,#0b72a8,#0d9488); font-weight:700; cursor:pointer; }
button.secondary { color:var(--blue); background:#e8f4fb; border:1px solid #acd5ec; }
button.danger { background:linear-gradient(135deg,#b91c1c,#d97706); }
button:disabled { opacity:.55; cursor:not-allowed; }
pre { white-space:pre-wrap; overflow:auto; max-height:380px; background:#08111f; color:#d9f7ff; border-radius:12px; padding:14px; }
table { width:100%; border-collapse:collapse; }
td, th { border-bottom:1px solid var(--line); padding:10px; text-align:left; vertical-align:top; }
input, textarea { width:100%; border:1px solid var(--line); border-radius:10px; padding:10px; color:var(--ink); }
.actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
header h1 { margin-bottom:6px; }
.console { display:grid; grid-template-columns:300px minmax(0,1fr); gap:16px; align-items:start; }
.console > *, .detail-head > *, .step-main { min-width:0; }
.plist { display:flex; flex-direction:column; gap:8px; }
.pitem { display:block; width:100%; text-align:left; background:white; color:var(--ink); border:1px solid var(--line); border-radius:12px; padding:12px; cursor:pointer; box-shadow:none; font-weight:400; }
.pitem:hover { border-color:#9cc6e6; }
.pitem.sel { border-color:#0b72a8; box-shadow:0 0 0 3px rgba(11,114,168,.12); }
.pitem-action { font-weight:700; font-size:14px; color:var(--ink); }
.pitem-target { font-size:12px; color:var(--muted); margin:2px 0 8px; overflow-wrap:anywhere; }
.chip { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:3px 9px; font-size:11px; font-weight:600; border:1px solid var(--line); }
.chip-ok{color:var(--ok);background:#eefaf2;border-color:#b7e3c2;}
.chip-wait{color:var(--warn);background:#fff7ed;border-color:#fed7aa;}
.chip-warn{color:#9a3412;background:#fff4ed;border-color:#fdba74;}
.chip-bad{color:var(--bad);background:#fef2f2;border-color:#fecaca;}
.chip-info{color:var(--blue);background:#eef6fc;border-color:#bfdcf0;}
.chip-muted{color:var(--muted);background:var(--soft);border-color:var(--line);}
.detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:4px; }
.detail-head .sub { font-size:13px; color:var(--muted); margin-top:2px; word-break:break-all; }
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
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; background:#f1f6fb; border:1px solid var(--line); border-radius:8px; padding:8px 10px; display:inline-block; color:var(--ink); word-break:break-all; }
.callout { background:#eef6fc; border:1px solid #bfdcf0; border-left:3px solid #0b72a8; border-radius:8px; padding:10px 12px; color:#0c4a6e; font-size:13px; margin:6px 0; }
.status-line { font-size:13px; margin:4px 0; }
.diff { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; border:1px solid var(--line); border-radius:10px; overflow:hidden; margin:6px 0; }
.diff-col { background:#f1f6fb; padding:6px 10px; font-weight:600; border-bottom:1px solid var(--line); color:var(--muted); }
.diff-line { padding:5px 10px; white-space:pre-wrap; overflow-wrap:anywhere; }
.diff-line.del { background:#fef2f2; color:#991b1b; }
.diff-line.add { background:#eefaf2; color:#116b35; }
.badge-row { display:flex; align-items:center; gap:10px; font-size:14px; margin:6px 0; }
.badge { border-radius:999px; padding:4px 12px; font-weight:700; font-size:13px; }
.badge.no { color:var(--ok); background:#eefaf2; border:1px solid #b7e3c2; }
.badge.yes { color:var(--blue); background:#eef6fc; border:1px solid #bfdcf0; }
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
@media (max-width: 900px) { .console { grid-template-columns:1fr; } }
@media (max-width: 850px) { .grid, .tour-grid, .activation { grid-template-columns: 1fr; } main { padding:18px; } }
@media (max-width: 600px) {
  .data-pr-head .kv, .step .kv { grid-template-columns:1fr; gap:2px; }
  .data-pr-head .kv dd { margin-bottom:8px; }
  .step .kv dd { margin-bottom:6px; }
}
</style>
</head>
<body>
<main>
  <header>
    <h1>Synapsor Runner Local UI</h1>
    <p>A local review console for what an agent proposed, what the safety boundary did, and what the trusted runner committed. No raw SQL editor is exposed.</p>
  </header>
  ${tourHtml}
  <section class="card full" id="workbench" style="margin-bottom:16px">
    <h2>First safe action</h2>
    <p>Loading reviewed project activation state...</p>
  </section>
  <section class="console">
    <div class="card" id="proposals"><h2>Proposals</h2><p>Loading...</p></div>
    <div class="card" id="detail"><h2>Local review console</h2><p>Select a proposal to walk through what happened.</p></div>
  </section>
  <section class="card full" id="shadow-report" style="margin-top:14px">
    <h2>Shadow studies</h2>
    <p>Loading local agent-versus-authoritative-outcome comparisons...</p>
  </section>
  <details class="card config-section">
    <summary>Runtime configuration &amp; tools</summary>
    <div class="grid" style="margin-top:14px">
      <div class="card" id="summary"><h2>Setup summary</h2><p>Loading...</p></div>
      <div class="card" id="tools"><h2>Tools</h2><p>Loading...</p></div>
    </div>
  </details>
</main>
<script>
const csrfToken = "${escapedCsrf}";
const configPath = "${escapedConfigPath}";
const storePath = "${escapedStorePath}";
const state = { selected: null, firstId: null, shadowStudy: null };
const byId = (id) => document.getElementById(id);
const text = (tag, value, className = "") => { const node = document.createElement(tag); node.textContent = value == null ? "" : String(value); if (className) node.className = className; return node; };
function el(tag, opts, kids) {
  const node = document.createElement(tag);
  if (opts) {
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
    writeback_job_recorded: { label: "Writeback job recorded", tone: "info" },
    writeback_applied: { label: "Committed by trusted runner", tone: "ok" },
    writeback_conflict: { label: "Conflict guard blocked stale write", tone: "warn" },
    writeback_failed: { label: "Writeback failed", tone: "bad" },
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
    el("div", {}, [el("h3", { text: "Add the action to Cursor", style: "margin:0" }), el("div", { class: "sub", text: "Project-scoped, proposal-only MCP" })]),
    chip(cursor.state === "installed" ? "Project MCP configured" : "MCP connection not verified", cursor.state === "installed" ? "ok" : cursor.state === "not_installed" ? "wait" : "bad"),
  ]));
  cursorPanel.append(el("p", { text: "Copy this exact first prompt. Cursor may draft and validate the disabled action; only you can review and activate its digest here." }));
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
  cursorPanel.append(prompt, el("div", { class: "actions" }, [copyPrompt, openCursor]), copyPromptStatus);
  cursorPanel.append(el("p", { class: "sub", text: "Cursor-visible tools: " + ((cursor.tools || []).join(", ") || "none until a reviewed contract is active") }));
  cursorPanel.append(el("p", { class: "sub", text: "Connection evidence: " + String(cursor.connection_status || "not_verified") + ". Use mcp status --check-launch for a real Runner initialize/tools-list handshake; host GUI connection still requires Cursor verification." }));
  if (cursor.proposal_waiting) {
    cursorPanel.append(el("div", { class: "callout", text: "Waiting for Cursor to create the first exact proposal. Source data remains unchanged; this page checks the local ledger only." }));
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
        const confirmation = document.createElement("input");
        confirmation.placeholder = "ACTIVATE " + draft.draft_contract_digest;
        confirmation.setAttribute("aria-label", "Safe Action activation confirmation");
        const activateStatus = el("div", { class: "status-line", text: "Type ACTIVATE followed by the complete digest. Activation is not available through MCP or CLI." });
        const activateButton = el("button", { text: "Activate reviewed immutable artifact", onclick: async () => {
          activateButton.disabled = true;
          try {
            const result = await api("/api/actions/activate", { method: "POST", headers: { "x-synapsor-csrf": csrfToken }, body: JSON.stringify({ expected_digest: draft.draft_contract_digest, confirmation: confirmation.value }) });
            activateStatus.textContent = result.message;
            await loadWorkbench();
            await loadTools();
          } catch (error) {
            activateStatus.textContent = error.message;
            activateButton.disabled = false;
          }
        } });
        activateButton.disabled = true;
        confirmation.addEventListener("input", () => { activateButton.disabled = confirmation.value !== "ACTIVATE " + draft.draft_contract_digest; });
        panel.append(el("p", { text: "Explicit operator activation" }), confirmation, el("div", { class: "actions" }, activateButton), activateStatus);
      }
    }
    if (safeAction.active) panel.append(el("div", { class: "callout", text: "Active immutable digest: " + safeAction.active.contract_digest + ". Reconnect or restart the MCP client to reload tools." }));
    panel.append(rawJson("View draft/active state", safeAction));
    root.append(panel);
  }
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
  const payload = await api("/api/proposals");
  const root = byId("proposals"); root.replaceChildren(text("h2", "Proposals"));
  if (payload.proposals.length === 0) {
    root.append(text("p", "No proposals in the local store yet. Run synapsor-runner mcp serve and have an agent propose a change."));
    state.firstId = null;
    return;
  }
  const list = el("div", { class: "plist" });
  for (const proposal of payload.proposals) {
    const st = humanizeState(proposal.state);
    const item = el("button", { class: "pitem" + (proposal.proposal_id === state.selected ? " sel" : ""), onclick: () => loadDetail(proposal.proposal_id) }, [
      el("div", { class: "pitem-action", text: proposal.action }),
      el("div", { class: "pitem-target", text: proposal.target.object_id + " · " + proposal.target.schema + "." + proposal.target.table }),
      chip(st.label, st.tone),
    ]);
    list.append(item);
  }
  root.append(list);
  state.firstId = payload.proposals[0].proposal_id;
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
  const replayDrawer = el("details", { class: "raw" });
  replayDrawer.append(el("summary", { text: "View full replay JSON" }));
  let replayLoaded = false;
  replayDrawer.addEventListener("toggle", async () => {
    if (!replayDrawer.open || replayLoaded) return;
    replayLoaded = true;
    try {
      const replayPayload = await api("/api/replay/" + encodeURIComponent(proposal.proposal_id));
      replayDrawer.append(pre(replayPayload.replay));
    } catch (error) {
      replayDrawer.append(el("p", { text: error.message }));
    }
  });
  story.append(stepCard(replayStep, "Replay saved what happened", "info", [tl, replayDrawer]));

  return story;
}
async function loadDetail(proposalId) {
  state.selected = proposalId;
  const payload = await api("/api/proposals/" + encodeURIComponent(proposalId));
  const proposal = payload.proposal;
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
  const jsonTab = el("button", { class: "tab", text: "View raw JSON" });
  const reviewPane = el("div", { class: "pane" });
  const jsonPane = el("div", { class: "pane hidden" });
  reviewTab.onclick = () => { reviewTab.classList.add("active"); jsonTab.classList.remove("active"); reviewPane.classList.remove("hidden"); jsonPane.classList.add("hidden"); };
  jsonTab.onclick = () => { jsonTab.classList.add("active"); reviewTab.classList.remove("active"); jsonPane.classList.remove("hidden"); reviewPane.classList.add("hidden"); };
  root.append(el("div", { class: "tabs" }, [reviewTab, jsonTab]));

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

  if (proposal.state === "pending_review") {
    const actor = document.createElement("input"); actor.placeholder = "Reviewer identity"; actor.value = "local_reviewer";
    const reason = document.createElement("textarea"); reason.placeholder = "Reason for approval or rejection"; reason.rows = 3;
    actor.setAttribute("aria-label", "Reviewer identity");
    reason.setAttribute("aria-label", "Reason for approval or rejection");
    const actions = el("div", { class: "actions" });
    const freshness = payload.freshness || { required: false, status: "not_required" };
    const freshnessStatus = el("div", { class: "status-line", text: freshness.required
      ? "Freshness: " + String(freshness.status || "not checked").replaceAll("_", " ") + "."
      : "Freshness: not required for this legacy proposal." });
    const check = freshness.required
      ? el("button", { class: "secondary", text: "Check live freshness", onclick: async () => {
        check.disabled = true;
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
        }
      } })
      : null;
    const approve = el("button", { text: "Approve outside MCP", onclick: async () => { await api("/api/proposals/" + encodeURIComponent(proposalId) + "/approve", { method: "POST", headers: { "x-synapsor-csrf": csrfToken }, body: JSON.stringify({ actor: actor.value, reason: reason.value, confirm: "approve" }) }); await loadProposals(); await loadDetail(proposalId); } });
    approve.disabled = freshness.required && freshness.status !== "fresh";
    approve.title = freshness.required
      ? "A fresh live check is required. Approval performs another check immediately before recording the decision."
      : "Record this human decision outside MCP.";
    const reject = el("button", { class: "danger", text: "Reject", onclick: async () => { await api("/api/proposals/" + encodeURIComponent(proposalId) + "/reject", { method: "POST", headers: { "x-synapsor-csrf": csrfToken }, body: JSON.stringify({ actor: actor.value, reason: reason.value || "rejected from local UI", confirm: "reject" }) }); await loadProposals(); await loadDetail(proposalId); } });
    if (check) actions.append(check);
    actions.append(approve, reject);
    reviewPane.append(
      el("div", { class: "callout", text: "You are the approval authority here — the model cannot reach these controls." }),
      freshnessStatus,
      actor,
      reason,
      actions,
    );
  } else if (proposal.state === "approved" || proposal.state === "pending_worker") {
    const command = trustedApplyCommand(proposalId);
    const commandBox = el("div", { class: "mono", text: command, style: "display:block;margin-top:8px" });
    const copied = el("span", { class: "status-line", text: "" });
    const copy = el("button", { text: "Copy guarded apply command", onclick: async () => {
      try {
        await navigator.clipboard.writeText(command);
        copied.textContent = "Copied. Run this from a trusted terminal with write credentials.";
      } catch {
        copied.textContent = "Copy this guarded apply command and run it from a trusted terminal with write credentials.";
      }
    } });
    reviewPane.append(
      el("div", { class: "callout", text: "Apply guarded writeback from a trusted terminal. This remains outside MCP, so the model still cannot commit." }),
      commandBox,
      el("div", { class: "actions" }, [copy]),
      copied,
    );
  }

  jsonPane.append(
    el("h3", { text: "proposal", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(payload.proposal),
    el("h3", { text: "events", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(payload.events),
    el("h3", { text: "receipts", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(payload.receipts),
    el("h3", { text: "evidence", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(payload.evidence),
    el("h3", { text: "freshness", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(payload.freshness),
  );
  root.append(reviewPane, jsonPane);
}
async function init() {
  await Promise.all([loadWorkbench(), loadSummary(), loadTools(), loadProposals(), loadShadowReport()]);
  if (state.firstId && !state.selected) await loadDetail(state.firstId);
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
    if (!key.endsWith("_env") && /(password|secret|token|api[_-]?key|private[_-]?key|cookie|credential|connection[_-]?string|database[_-]?url)/i.test(key)) {
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
      && path.basename(fsError.path) === "exploration-boundary.active.json");
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
