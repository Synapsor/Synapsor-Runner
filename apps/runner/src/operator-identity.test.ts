import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { StoredProposal } from "@synapsor-runner/proposal-store";
import { resolveOperatorIdentity, verifySignedOperatorProof } from "./operator-identity.js";

const proposal = {
  proposal_id: "wrp_identity",
  proposal_version: 1,
  proposal_hash: "sha256:proposal",
  action: "fleet.propose_repair",
  state: "pending_review",
  tenant_id: "norhaul",
  business_object: "work_orders",
  object_id: "wo_1001",
  source_kind: "external_postgres",
  source_id: "fleet_postgres",
  source_schema: "public",
  source_table: "work_orders",
  source_database_mutated: false,
  change_set: { approval: { required_role: "fleet_manager" } },
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
} as unknown as StoredProposal;

describe("operator identity", () => {
  it("signs and independently verifies an operator decision", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-operator-key-"));
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicPath = path.join(tempDir, "operator.pub.pem");
    const privatePath = path.join(tempDir, "operator.pem");
    const configPath = path.join(tempDir, "synapsor.runner.json");
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    await fs.writeFile(publicPath, publicPem, "utf8");
    await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });

    const proof = await resolveOperatorIdentity({
      config: {
        provider: "signed_key",
        operators: { alice: { public_key_path: "./operator.pub.pem", roles: ["fleet_manager"] } },
      },
      configPath,
      proposal,
      action: "approve",
      reason: "reviewed evidence",
      identity: "alice",
      privateKeyPath: privatePath,
      requiredRole: "fleet_manager",
      now: "2026-07-12T01:02:03.000Z",
    });

    expect(proof).toMatchObject({
      provider: "signed_key",
      verified: true,
      subject: "alice",
      roles: ["fleet_manager"],
      decision: { action: "approve", proposal_id: "wrp_identity", reason: "reviewed evidence" },
    });
    expect(verifySignedOperatorProof(proof, publicPem)).toBe(true);
    expect(verifySignedOperatorProof({ ...proof, decision: { ...proof.decision, proposal_id: "wrp_tampered" } }, publicPem)).toBe(false);
  });

  it("enforces trusted roles and keeps explicit env identity marked as unverified dev mode", async () => {
    await expect(resolveOperatorIdentity({
      config: { provider: "signed_key", operators: { bob: { public_key_path: "./bob.pub.pem", roles: ["mechanic"] } } },
      proposal,
      action: "approve",
      identity: "bob",
      privateKeyPath: "./bob.pem",
      requiredRole: "fleet_manager",
    })).rejects.toThrow(/lacks required role fleet_manager/);

    const dev = await resolveOperatorIdentity({
      config: { provider: "dev_env", actor_env: "TEST_ACTOR", roles_env: "TEST_ROLES" },
      proposal,
      action: "reject",
      reason: "not safe",
      requiredRole: "fleet_manager",
      env: { TEST_ACTOR: "dev-reviewer", TEST_ROLES: "fleet_manager, auditor" },
      now: "2026-07-12T01:02:03.000Z",
    });
    expect(dev).toMatchObject({ provider: "dev_env", verified: false, subject: "dev-reviewer", roles: ["auditor", "fleet_manager"] });
  });
});
