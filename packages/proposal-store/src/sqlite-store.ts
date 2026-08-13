import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  ProposalStoreSchemaMethods,
  ProposalStoreProposalMethods,
  ProposalStoreWritebackMethods,
  ProposalStoreWorkerMethods,
  ProposalStoreMetricsPolicyMethods,
  ProposalStoreAttentionMethods,
  ProposalStoreCloudControlMethods,
  ProposalStoreShadowMethods,
} from "./sqlite-method-signatures.js";
import { proposalStoreSchemaMethods } from "./sqlite-schema-methods.js";
import { proposalStoreProposalsMethods } from "./sqlite-proposal-methods.js";
import { proposalStoreWritebackMethods } from "./sqlite-writeback-methods.js";
import { proposalStoreWorkersMethods } from "./sqlite-worker-methods.js";
import { proposalStoreMetricsPolicyMethods } from "./sqlite-metrics-policy-methods.js";
import { proposalStoreAttentionMethods } from "./sqlite-attention-methods.js";
import { proposalStoreCloudControlMethods } from "./sqlite-cloud-control-methods.js";
import { proposalStoreShadowMethods } from "./sqlite-shadow-methods.js";
import { proposalStoreInternalsMethods } from "./sqlite-core-methods.js";
import { installProposalStoreMethods } from "./sqlite-method-installer.js";

const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export class ProposalStore {
  readonly db: DatabaseSync;

  readonly path: string;

  constructor(path = ":memory:") {
    this.path = path;
    if (path !== ":memory:") {
      mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    // MCP servers and trusted workers may share one local spool. Wait through
    // short SQLite writer contention, while keeping persistent lock failures bounded.
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    if (path !== ":memory:" && process.platform !== "win32") {
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        process.stderr.write(`warning: unable to restrict Synapsor store permissions to 0600: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    this.migrate();
  }
}

export interface ProposalStore
  extends ProposalStoreSchemaMethods,
    ProposalStoreProposalMethods,
    ProposalStoreWritebackMethods,
    ProposalStoreWorkerMethods,
    ProposalStoreMetricsPolicyMethods,
    ProposalStoreAttentionMethods,
    ProposalStoreCloudControlMethods,
    ProposalStoreShadowMethods {
  transaction<T>(fn: () => T): T;
}

installProposalStoreMethods(
  ProposalStore.prototype,
  proposalStoreSchemaMethods,
  proposalStoreProposalsMethods,
  proposalStoreWritebackMethods,
  proposalStoreWorkersMethods,
  proposalStoreMetricsPolicyMethods,
  proposalStoreAttentionMethods,
  proposalStoreCloudControlMethods,
  proposalStoreShadowMethods,
  proposalStoreInternalsMethods,
);
