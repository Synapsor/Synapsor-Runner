import crypto from "node:crypto";
import fs from "node:fs";
import {
  assertValidRunnerCapabilityConfig,
} from "@synapsor-runner/config";
import {
  createPostgresPool,
} from "@synapsor-runner/postgres";
import {
  PostgresProposalRuntimeStore,
  ProposalStore,
  type ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import type {
  RuntimeConfig,
  McpRuntimeOptions,
  McpRuntime,
} from "./runtime-types.js";
import {
  listedLocalCapabilities,
  localCapabilities,
} from "./capability-authority.js";
import {
  CloudLinkedSynchronizer,
  createCloudClient,
  loadCloudLinkedConnection,
} from "./cloud-linked.js";
import {
  readLocalResource,
} from "./local-resources.js";
import {
  callConfiguredToolV2,
  errorEnvelopeFromError,
} from "./result-envelope.js";
import {
  resolveRuntimeConfig,
} from "./runtime-config.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  logToolRejection,
} from "./runtime-logging.js";
import {
  envValue,
} from "./safe-values.js";
import {
  createMcpRuntimeSharedResources,
} from "./source-runtime.js";
import {
  toolMetadata,
} from "./tool-catalog.js";
import {
  callConfiguredTool,
} from "./tool-dispatch.js";
import {
  resolveTrustedContext,
} from "./trusted-context.js";

export function createMcpRuntime(config: RuntimeConfig, options: McpRuntimeOptions = {}): McpRuntime {
  config = resolveRuntimeConfig(config);
  assertValidRunnerCapabilityConfig(config);
  if (options.readRow && Object.values(config.sources ?? {}).some((source) => source.database_scope?.mode === "postgres_rls")) {
    throw new McpRuntimeError("POSTGRES_RLS_CUSTOM_READER_UNVERIFIED", "Hardened postgres_rls mode requires Runner's verified PostgreSQL reader; a custom readRow cannot be attested.");
  }
  const env = options.env ?? process.env;
  const storePath = options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db";
  const sharedPostgres = config.storage?.shared_postgres;
  const ownsStore = !options.store;
  const store = options.store ?? createDefaultRuntimeStore(config, env, storePath);
  const ownsResources = !options.sharedResources;
  const resources = options.sharedResources ?? createMcpRuntimeSharedResources(config, env, options.readRow, options.clock, options.credentialResolver);
  const readRow = resources.readRow;
  const cloudClient = options.controlPlaneClient ?? (config.mode === "cloud" ? createCloudClient(config, env) : undefined);
  const cloudTools = options.cloudTools ?? [];
  const resultFormat = options.resultFormat ?? config.result_format ?? 1;
  const trustedContext = options.trustedContext;
  const privacySessionId = crypto.randomBytes(32).toString("base64url");
  if (config.governance?.mode === "cloud_linked") loadCloudLinkedConnection(config, env);
  const cloudSynchronizer = ownsStore && config.governance?.mode === "cloud_linked"
    ? new CloudLinkedSynchronizer(config, store, env)
    : undefined;
  cloudSynchronizer?.start();
  const assertLocalStoreAvailable = ownsStore && sharedPostgres?.mode !== "runtime_store";
  const assertStoreAvailable = () => {
    if (assertLocalStoreAvailable) assertPersistentStoreAvailable(storePath);
  };

  return {
    config,
    store,
    listTools: () => config.mode === "cloud"
      ? cloudTools
      : listedLocalCapabilities(config).map((capability) => toolMetadata(capability, config)),
    callTool: async (name, args) => {
      const capability = config.mode === "cloud" ? undefined : localCapabilities(config).find((item) => item.name === name);
      try {
        if (capability?.kind === "proposal") await cloudSynchronizer?.synchronizeBeforeProposal();
        if (capability) {
          const context = resolveTrustedContext(config, env, capability, trustedContext);
          await resources.consumeRateLimit(context, capability.name);
        }
        if (resultFormat === 2) {
          assertStoreAvailable();
          return await callConfiguredToolV2({
            config,
            env,
            store,
            readRow,
            cloudClient,
            trustedContext,
            privacySessionId,
            ...(options.generatedAuthorityInspector
              ? { generatedAuthorityInspector: options.generatedAuthorityInspector }
              : {}),
            name,
            args,
          });
        }
        assertStoreAvailable();
        return await callConfiguredTool({
          config,
          env,
          store,
          readRow,
          cloudClient,
          trustedContext,
          privacySessionId,
          ...(options.generatedAuthorityInspector
            ? { generatedAuthorityInspector: options.generatedAuthorityInspector }
            : {}),
          name,
          args,
        });
      } catch (error) {
        logToolRejection(error, config, env, capability, name, trustedContext);
        if (resultFormat === 2) return errorEnvelopeFromError(error, capability, name);
        throw error;
      }
    },
    readResource: async (uri) => {
      assertStoreAvailable();
      return readLocalResource(store, uri, config, env, trustedContext);
    },
    poolMetrics: () => resources.poolMetrics(),
    rateLimitMetrics: () => resources.rateLimitMetrics(),
    cloudSyncStatus: async () => cloudSynchronizer
      ? cloudSynchronizer.status()
      : ({ authority_mode: "local_only", evidence_residency: "metadata_only", pending: 0, leased: 0, acknowledged: 0, dead_letter: 0, reconciliation_required: 0 }),
    close: async () => {
      await cloudSynchronizer?.stop();
      if (ownsResources) await resources.close();
      if (!options.store) await store.close();
    },
  };
}

export function createDefaultRuntimeStore(config: RuntimeConfig, env: NodeJS.ProcessEnv, storePath: string): ProposalRuntimeStore {
  const sharedPostgres = config.storage?.shared_postgres;
  if (sharedPostgres?.mode === "runtime_store") {
    const databaseUrl = envValue(env, sharedPostgres.url_env);
    if (!databaseUrl) {
      throw new McpRuntimeError("POSTGRES_RUNTIME_STORE_URL_MISSING", `${sharedPostgres.url_env} is required when storage.shared_postgres.mode is runtime_store.`);
    }
    return new PostgresProposalRuntimeStore({
      pool: createPostgresPool(databaseUrl),
      schema: sharedPostgres.schema ?? "synapsor_runner",
      lockTimeoutMs: sharedPostgres.lock_timeout_ms,
      maxEntries: sharedPostgres.max_entries,
      autoMigrate: true,
      closePool: true,
    });
  }
  return new ProposalStore(storePath);
}

export function assertRuntimeStoreStartupReady(config: RuntimeConfig, env: NodeJS.ProcessEnv): void {
  const sharedPostgres = config.storage?.shared_postgres;
  if (sharedPostgres?.mode !== "runtime_store") return;
  if (!envValue(env, sharedPostgres.url_env)) {
    throw new McpRuntimeError("POSTGRES_RUNTIME_STORE_URL_MISSING", `${sharedPostgres.url_env} is required when storage.shared_postgres.mode is runtime_store.`);
  }
}

export function assertPersistentStoreAvailable(storePath: string): void {
  if (storePath === ":memory:") return;
  if (fs.existsSync(storePath)) return;
  throw new McpRuntimeError(
    "LOCAL_STORE_UNAVAILABLE",
    "The local Synapsor store is temporarily unavailable. Restart the runner or recreate the store before retrying.",
  );
}
