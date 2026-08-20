import path from "node:path";
import {
  configUsesHttpClaims,
  createMcpRuntime,
  loadRuntimeConfigFromFile,
  sessionAuthVerifier,
  verifySessionJwt,
} from "@synapsor-runner/mcp-server";
import { prepareGuidedActionPreview } from "./guided-action.js";
import { withDisposableActionPreviewLedger } from "./action-preview-ledger.js";

export type GuidedActionRuntimePreview = {
  draft_digest: `sha256:${string}`;
  proposal_id: string;
  proposal_hash: string;
  source_database_changed: false;
};

/**
 * Executes the exact disabled action draft only far enough to create its
 * immutable proposal rehearsal. It never approves or applies that proposal.
 * HTTP-claim projects must provide a real token; the same asymmetric verifier,
 * issuer, audience, claims, and OAuth scope checks are used as the HTTP server.
 */
export async function executeGuidedActionPreview(input: {
  projectRoot: string;
  baseConfigPath?: string;
  storePath?: string;
  capabilityName: string;
  args: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  accessTokenEnv?: string;
}): Promise<GuidedActionRuntimePreview> {
  const projectRoot = path.resolve(input.projectRoot);
  const env = input.env ?? process.env;
  const prepared = await prepareGuidedActionPreview({
    projectRoot,
    capabilityName: input.capabilityName,
    ...(input.baseConfigPath ? { configPath: input.baseConfigPath } : {}),
  });
  const previewConfigPath = path.resolve(projectRoot, prepared.config_path);
  const config = loadRuntimeConfigFromFile(previewConfigPath);
  const trustedContext = configUsesHttpClaims(config)
    ? await verifiedPreviewHttpContext(
        config,
        env,
        path.dirname(previewConfigPath),
        input.accessTokenEnv ?? "SYNAPSOR_MCP_ACCESS_TOKEN",
      )
    : undefined;
  return withDisposableActionPreviewLedger({
    projectRoot,
    run: async (previewStorePath) => {
      const runtime = createMcpRuntime(config, {
        env,
        storePath: previewStorePath,
        ...(trustedContext ? { trustedContext } : {}),
      });
      try {
        const result = await runtime.callTool(prepared.capability, input.args);
        if (result.ok === false) {
          const error = record(result.error);
          const code = typeof error.code === "string" ? error.code : "TOOL_REJECTED";
          const message = typeof error.message === "string" ? error.message : "The draft proposal was refused.";
          throw new Error(`GUIDED_ACTION_PREVIEW_REFUSED: ${code}: ${message}`);
        }
        const proposalId = proposalIdFromResult(result);
        if (!proposalId) throw new Error("GUIDED_ACTION_PREVIEW_PROPOSAL_MISSING: the exact draft did not create an immutable proposal.");
        if (result.source_database_changed === true || result.source_database_mutated === true) {
          throw new Error("GUIDED_ACTION_PREVIEW_MUTATED_SOURCE: proposal rehearsal unexpectedly changed source data.");
        }
        const proposal = await runtime.store.getProposal(proposalId);
        const proposalHash = typeof result.proposal_hash === "string"
          ? result.proposal_hash
          : proposal?.proposal_hash ?? "";
        if (!proposal || proposal.proposal_hash !== proposalHash) {
          throw new Error("GUIDED_ACTION_PREVIEW_LEDGER_MISMATCH: the immutable rehearsal is missing from the reviewed ledger.");
        }
        if (proposal.change_set.contract?.digest !== prepared.draft_digest) {
          throw new Error("GUIDED_ACTION_PREVIEW_DIGEST_MISMATCH: the rehearsal belongs to another action revision.");
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
    },
  });
}

async function verifiedPreviewHttpContext(
  config: ReturnType<typeof loadRuntimeConfigFromFile>,
  env: NodeJS.ProcessEnv,
  baseDir: string,
  accessTokenEnv: string,
) {
  const token = env[accessTokenEnv]?.trim();
  if (!token) {
    throw new Error(
      `GUIDED_ACTION_PREVIEW_TOKEN_REQUIRED: ${accessTokenEnv} must contain a real signed access token for this production-shaped preview. The value is never persisted or displayed.`,
    );
  }
  const verifier = sessionAuthVerifier(config, env, baseDir);
  return verifySessionJwt(config, token, verifier);
}

function proposalIdFromResult(result: Record<string, unknown>): string {
  if (typeof result.proposal_id === "string") return result.proposal_id;
  const proposal = record(result.proposal);
  return typeof proposal.id === "string" ? proposal.id : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
