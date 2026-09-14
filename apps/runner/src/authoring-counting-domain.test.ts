import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { ProposalStore, migrateSharedPostgresRuntimeStore, type ProposalRuntimeStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { withCountingOutcomeDomain } from "./authoring-counting-domain.js";
import { migrateProjectControlPolicies, createProjectRuntimeStore } from "./control-policy-store.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import type { ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";

const saved = JSON.parse(readFileSync(new URL("./fixtures/attached-policy-reconciliation.json", import.meta.url), "utf8"))[0];
const proposed = saved.authority as ActionRuleAuthorityDraftV1;
async function automatic(store: ProposalRuntimeStore, id: string, outcome: string) {
  const input = JSON.parse(readFileSync(new URL("../../../fixtures/protocol/change-set.late-fee-waiver.v1.json", import.meta.url), "utf8"));
  input.proposal_id = id; input.action = outcome; input.integrity.proposal_hash = `sha256:${id}`;
  const p = await store.createProposal(input);
  const result = await store.approveProposalByPolicy(p.proposal_id, { policy: "owned-diagnostic", proposal_hash: p.proposal_hash,
    proposal_version: p.proposal_version, reason: "Synthetic history diagnostic", action_boundary: {
      name: proposed.authority.action_boundary.name, digest: proposed.authority.action_boundary.digest, limits: [] } });
  expect(result.approved).toBe(true);
}

describe("authoring counting domain uses the selected existing store", () => {
  for (const backend of ["sqlite", "postgres"] as const) {
    it.skipIf(backend === "postgres" && !process.env.SYNAPSOR_TEST_POSTGRES_URL)(`${backend}: inspects retained history, rejects relocation and releases locks on failure`, async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-counting-domain-"));
      const config = JSON.parse(readFileSync(new URL("../../../examples/reference-support-billing-app/synapsor.runner.json", import.meta.url), "utf8")) as RuntimeConfig;
      config.capabilities = config.capabilities!.filter(capability => capability.kind === "read").slice(0, 1);
      config.storage = { sqlite_path: ".synapsor/local.db", ...(backend === "postgres" ? { shared_postgres: {
        mode: "runtime_store", url_env: "SYNAPSOR_TEST_POSTGRES_URL", schema: `counting_${Date.now()}_${Math.random().toString(16).slice(2,8)}` } } : {}) };
      let store: ProposalRuntimeStore | undefined;
      try {
        await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify(config));
        if (backend === "sqlite") new ProposalStore(path.join(root, ".synapsor/local.db")).close();
        const migrated = await migrateProjectControlPolicies({ projectRoot: root, config, storePath: path.join(root, ".synapsor/local.db"),
          actor: "owned-test-operator", readLegacySnapshot: async () => ({ revisions: [], active: [], drafts: [], provenance: [] }), validateSnapshot: async () => {} });
        await migrated.binding.close();
        if (backend === "postgres") {
          const pool = new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL });
          try { await migrateSharedPostgresRuntimeStore(pool, config.storage!.shared_postgres!.schema); }
          finally { await pool.end(); }
        }
        const read = () => withCountingOutcomeDomain(root, proposed, async domain => domain);
        const before = await read();
        expect(before).toMatchObject({ proposed_outcomes: [proposed.authority.rules[0]!.rule.outcome], current_revision: null,
          current_outcomes: [], retained_automatic_outcomes: [], complete: true });
        expect(policyCoverageDraft({ read: saved.read, actions: [], authority: proposed, decisions: [], countingDomain: before })
          .runner_evidence.runtime_contract.approval_counter_selection.outcome_domain).toEqual(before);
        const changed = { ...before, proposed_revision: canonicalJsonDigest("other") };
        expect(policyCoverageDraft({ read: saved.read, actions: [], authority: proposed, decisions: [], countingDomain: changed })
          .runner_evidence.runtime_contract.approval_counter_selection.outcome_domain).toBeNull();
        store = await createProjectRuntimeStore({ projectRoot: root, config, storePath: path.join(root, ".synapsor/local.db") });
        await automatic(store, "wrp_domain_first", proposed.authority.rules[0]!.rule.outcome);
        const one = await read();
        expect(one.retained_automatic_outcomes).toEqual(before.proposed_outcomes);
        expect(one.complete).toBe(true);
        await automatic(store, "wrp_domain_second", "diagnostic.other");
        const multiple = await read();
        expect(multiple.complete).toBe(false);
        expect(multiple.retained_automatic_outcomes).toHaveLength(2);
        await expect(withCountingOutcomeDomain(root, proposed, async () => { throw new Error("owned save fault"); })).rejects.toThrow("owned save fault");
        expect(await read()).toEqual(multiple);
        await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify({ ...config, storage: { sqlite_path: ".synapsor/different.db" } }));
        await expect(read()).rejects.toThrow();
        await expect(fs.stat(path.join(root, ".synapsor/different.db"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally { await store?.close(); await fs.rm(root, { recursive: true, force: true }); }
    }, 20_000);
  }

  it("does not create an empty ledger when configuration or the selected ledger is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-counting-missing-"));
    try {
      await expect(withCountingOutcomeDomain(root, proposed, async domain => domain)).rejects.toThrow();
      const config = JSON.parse(readFileSync(new URL("../../../examples/reference-support-billing-app/synapsor.runner.json", import.meta.url), "utf8"));
      config.storage = { sqlite_path: ".synapsor/local.db" };
      await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify(config));
      await expect(withCountingOutcomeDomain(root, proposed, async domain => domain)).rejects.toThrow();
      await expect(fs.stat(path.join(root, ".synapsor/local.db"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
