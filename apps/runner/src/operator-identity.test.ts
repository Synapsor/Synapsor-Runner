import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import type { StoredProposal } from "@synapsor-runner/proposal-store";
import { hasVerifiedRecoveryControlActor, operatorPublicKeyFingerprint, resolveAuthorizedOperatorIdentity, resolveOperatorIdentity, signedOperatorKeyAlgorithm,
  verifyJwtOperatorProof, verifySignedOperatorProof } from "./operator-identity.js";
import { applyAuthorizationLogMetadata } from "./guarded-apply.js";

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
  it("attributes a scoped APPLY audit to its exact grant rather than a legacy global role", () => {
    const config = {
      operator_identity: {
        provider: "signed_key",
        apply_roles: ["recovery_operator"],
        operators: { worker: { authority_kind: "scoped_apply" }, control: { authority_kind: "legacy" } },
      },
    } as unknown as Parameters<typeof applyAuthorizationLogMetadata>[0];
    expect(applyAuthorizationLogMetadata(config, "worker")).toEqual({ authority_kind: "scoped_apply" });
    expect(applyAuthorizationLogMetadata(config, "control")).toEqual({ required_role: "recovery_operator" });
  });

  it("keeps tagged scoped APPLY distinct from approval, recovery and unscoped legacy fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-scoped-apply-"));
    try {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const publicPath = path.join(root, "worker.pub.pem"), privatePath = path.join(root, "worker.pem");
      await fs.writeFile(publicPath, publicPem, { mode: 0o600 });
      await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      const config = { provider: "signed_key" as const, roster_version: 2 as const,
        apply_roles: ["recovery_operator"], operators: { worker: {
          public_key_path: "./worker.pub.pem", public_key_fingerprint: operatorPublicKeyFingerprint(publicPem),
          roles: [], authority_kind: "scoped_apply" as const,
          apply_outcomes: ["fleet.propose_repair", "fleet.close_repair"],
        } } };
      const base = { config, configPath: path.join(root, "runner.json"), proposal,
        identity: "worker", privateKeyPath: privatePath };
      const proof = await resolveAuthorizedOperatorIdentity({ ...base, action: "apply" });
      expect(proof.verified).toBe(true);
      expect(verifySignedOperatorProof(proof, publicPem)).toBe(true);
      expect((await resolveAuthorizedOperatorIdentity({ ...base, action: "apply",
        proposal: { ...proposal, action: "fleet.close_repair" } })).verified).toBe(true);
      for (const action of ["approve", "reject", "reconcile", "worker_requeue", "worker_discard", "worker_cancel"] as const) {
        await expect(resolveAuthorizedOperatorIdentity({ ...base, action })).rejects.toMatchObject({ code: "OPERATOR_SCOPED_APPLY_NOT_AUTHORIZED" });
      }
      await expect(resolveAuthorizedOperatorIdentity({ ...base, action: "apply",
        proposal: { ...proposal, action: "fleet.unrelated" } })).rejects.toMatchObject({ code: "OPERATOR_SCOPED_APPLY_NOT_AUTHORIZED" });
      const revoked = structuredClone(config);
      revoked.operators.worker.apply_outcomes = [];
      await expect(resolveAuthorizedOperatorIdentity({ ...base, config: revoked, action: "apply" }))
        .rejects.toMatchObject({ code: "OPERATOR_SCOPED_APPLY_NOT_AUTHORIZED" });
      const stripped = structuredClone(config);
      delete (stripped.operators.worker as { authority_kind?: string }).authority_kind;
      await expect(resolveAuthorizedOperatorIdentity({ ...base, config: stripped, action: "apply" }))
        .rejects.toMatchObject({ code: "OPERATOR_AUTHORITY_KIND_MISSING" });
      await expect(resolveAuthorizedOperatorIdentity({ ...base, action: "apply", privateKeyPath: path.join(root, "missing.pem") }))
        .rejects.toMatchObject({ code: "OPERATOR_SIGNING_MATERIAL_UNAVAILABLE" });
      expect(await hasVerifiedRecoveryControlActor({ config, configPath: base.configPath,
        env: { SYNAPSOR_OPERATOR_ID: "worker", SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH: privatePath } })).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("checks a prospective signed recovery actor without creating an operator decision", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-recovery-role-"));
    try {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const publicPath = path.join(root, "operator.pub.pem"), privatePath = path.join(root, "operator.pem");
      const wrongPath = path.join(root, "wrong.pem"), configPath = path.join(root, "synapsor.runner.json");
      await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }));
      await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      await fs.writeFile(wrongPath, other.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      const config = { provider: "signed_key" as const, apply_roles: ["recovery_operator"],
        operators: { alice: { public_key_path: "./operator.pub.pem", roles: ["recovery_operator"] },
          bob: { public_key_path: "./operator.pub.pem", roles: ["business_reviewer"] } } };
      const check = (env: NodeJS.ProcessEnv, selected = config) => hasVerifiedRecoveryControlActor({ config: selected, configPath, env });
      expect(await check({ SYNAPSOR_OPERATOR_ID: "alice", SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH: privatePath })).toBe(true);
      expect(await check({ SYNAPSOR_OPERATOR_ID: "bob", SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH: privatePath })).toBe(false);
      expect(await check({ SYNAPSOR_OPERATOR_ID: "alice", SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH: wrongPath })).toBe(false);
      expect(await check({ SYNAPSOR_OPERATOR_ID: "alice" })).toBe(false);
      expect(await check({ SYNAPSOR_OPERATOR_ID: "alice", SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH: privatePath },
        { ...config, apply_roles: ["different_role"] })).toBe(false);
      expect(await hasVerifiedRecoveryControlActor({ config: { provider: "dev_env", apply_roles: ["recovery_operator"] },
        configPath, env: { SYNAPSOR_OPERATOR_ROLES: "recovery_operator" } })).toBe(false);
      expect((await fs.readdir(root)).sort()).toEqual(["operator.pem", "operator.pub.pem", "wrong.pem"]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

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
    const pinnedConfig = { provider: "signed_key" as const,
      operators: { alice: { public_key_path: "./operator.pub.pem", public_key_fingerprint: operatorPublicKeyFingerprint(publicPem),
        roles: ["fleet_manager"] } } };
    expect((await resolveOperatorIdentity({ config: pinnedConfig, configPath, proposal, action: "approve",
      identity: "alice", privateKeyPath: privatePath, requiredRole: "fleet_manager" })).verified).toBe(true);
    await fs.writeFile(publicPath, crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }));
    await expect(resolveOperatorIdentity({ config: pinnedConfig, configPath, proposal, action: "approve",
      identity: "alice", privateKeyPath: privatePath, requiredRole: "fleet_manager" }))
      .rejects.toMatchObject({ code: "OPERATOR_PUBLIC_KEY_CHANGED" });
  });

  it("signs and verifies Ed25519 decisions while keeping RSA's existing proof format", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ed25519-operator-"));
    try {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const publicPath = path.join(root, "reviewer.pub.pem"), privatePath = path.join(root, "reviewer.pem");
      await fs.writeFile(publicPath, publicPem, { mode: 0o600 });
      await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      const config = { provider: "signed_key" as const, apply_roles: ["fleet_manager"], operators: { reviewer: {
        public_key_path: "./reviewer.pub.pem", roles: ["fleet_manager"], outcomes: ["fleet.propose_repair"],
        public_key_fingerprint: operatorPublicKeyFingerprint(publicPem),
      } } };
      const configPath = path.join(root, "synapsor.runner.json");
      expect(signedOperatorKeyAlgorithm(publicPem)).toBe("ed25519");
      const proof = await resolveOperatorIdentity({ config, configPath, proposal, action: "approve",
        identity: "reviewer", privateKeyPath: privatePath, requiredRole: "fleet_manager" });
      expect(proof.algorithm).toBe("ed25519");
      expect(verifySignedOperatorProof(proof, publicPem)).toBe(true);
      expect(verifySignedOperatorProof({ ...proof, algorithm: "SHA256" }, publicPem)).toBe(false);
      expect(verifySignedOperatorProof(proof, crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false);
      expect(await hasVerifiedRecoveryControlActor({ config, configPath,
        env: { SYNAPSOR_OPERATOR_ID: "reviewer", SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH: privatePath } })).toBe(true);
      expect(await hasVerifiedRecoveryControlActor({ config, configPath,
        env: { SYNAPSOR_OPERATOR_ID: "reviewer", SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH: path.join(root, "missing.pem") } })).toBe(false);
      const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      expect(signedOperatorKeyAlgorithm(rsa.publicKey.export({ type: "spki", format: "pem" }))).toBe("SHA256");
      expect(() => signedOperatorKeyAlgorithm(crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey
        .export({ type: "spki", format: "pem" }))).toThrow("OPERATOR_SIGNING_KEY_UNSUPPORTED");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("confines a shared approval role to the reviewed Action outcome", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-outcome-key-"));
    try {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const publicPath = path.join(root, "reviewer.pub.pem"), privatePath = path.join(root, "reviewer.pem");
      await fs.writeFile(publicPath, publicPem, { mode: 0o600 });
      await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
      const config = { provider: "signed_key" as const, operators: { alice: {
        public_key_path: "./reviewer.pub.pem", public_key_fingerprint: operatorPublicKeyFingerprint(publicPem),
        roles: ["fleet_manager"], outcomes: ["fleet.propose_repair"],
      } } };
      const decision = { config, configPath: path.join(root, "synapsor.runner.json"),
        action: "approve" as const, identity: "alice", privateKeyPath: privatePath, requiredRole: "fleet_manager" };
      expect((await resolveOperatorIdentity({ ...decision, proposal })).verified).toBe(true);
      await expect(resolveOperatorIdentity({ ...decision, proposal: { ...proposal, action: "fleet.close_repair" } }))
        .rejects.toMatchObject({ code: "OPERATOR_OUTCOME_NOT_AUTHORIZED" });
      await expect(resolveOperatorIdentity({ ...decision, proposal, action: "worker_cancel" }))
        .rejects.toMatchObject({ code: "OPERATOR_OUTCOME_NOT_AUTHORIZED" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
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

  it("verifies OIDC roles and attests the decision without retaining the bearer token", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
    const token = await new SignJWT({ roles: ["fleet_manager", "auditor"] })
      .setProtectedHeader({ alg: "RS256", kid: "operator-key-1" })
      .setSubject("alice@example.com")
      .setIssuer("https://identity.example")
      .setAudience("synapsor-operators")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(privateKey);
    const attestationSecret = "operator-attestation-secret-at-least-32-bytes";
    const env = {
      TEST_OPERATOR_TOKEN: token,
      TEST_OPERATOR_PUBLIC_KEY: await exportSPKI(publicKey),
      TEST_ATTESTATION_SECRET: attestationSecret,
    };
    const config = {
      provider: "jwt_oidc" as const,
      token_env: "TEST_OPERATOR_TOKEN",
      roles_claim: "roles",
      subject_claim: "sub",
      attestation_secret_env: "TEST_ATTESTATION_SECRET",
      algorithms: ["RS256" as const],
      public_key_env: "TEST_OPERATOR_PUBLIC_KEY",
      issuer: "https://identity.example",
      audience: "synapsor-operators",
    };
    const proof = await resolveOperatorIdentity({
      config,
      proposal,
      action: "approve",
      requiredRole: "fleet_manager",
      env,
      now: "2026-07-12T01:02:03.000Z",
    });
    expect(proof).toMatchObject({
      provider: "jwt_oidc",
      verified: true,
      subject: "alice@example.com",
      roles: ["auditor", "fleet_manager"],
      key_id: "operator-key-1",
      algorithm: "RS256",
      issuer: "https://identity.example",
    });
    expect(verifyJwtOperatorProof(proof, attestationSecret)).toBe(true);
    expect(verifyJwtOperatorProof({ ...proof, roles: ["fleet_manager"] }, attestationSecret)).toBe(false);
    expect(JSON.stringify(proof)).not.toContain(token);

    const recoveryConfig = { ...config, apply_roles: ["fleet_manager"] };
    expect(await hasVerifiedRecoveryControlActor({ config: recoveryConfig, configPath: "synapsor.runner.json", env })).toBe(true);
    expect(await hasVerifiedRecoveryControlActor({ config: { ...recoveryConfig, apply_roles: ["finance_lead"] },
      configPath: "synapsor.runner.json", env })).toBe(false);
    expect(await hasVerifiedRecoveryControlActor({ config: recoveryConfig, configPath: "synapsor.runner.json",
      env: { ...env, TEST_ATTESTATION_SECRET: "" } })).toBe(false);
    expect(await hasVerifiedRecoveryControlActor({ config: { ...recoveryConfig, token_env: undefined, token_stdin: true },
      configPath: "synapsor.runner.json", env })).toBe(false);

    const stdinProof = await resolveOperatorIdentity({
      config: { ...config, token_env: undefined, token_stdin: true },
      proposal,
      action: "approve",
      requiredRole: "fleet_manager",
      env: {
        TEST_OPERATOR_PUBLIC_KEY: env.TEST_OPERATOR_PUBLIC_KEY,
        TEST_ATTESTATION_SECRET: attestationSecret,
      },
      tokenInput: Readable.from([`${token}\n`]),
    });
    expect(stdinProof).toMatchObject({ provider: "jwt_oidc", verified: true, subject: "alice@example.com" });
    expect(JSON.stringify(stdinProof)).not.toContain(token);

    const requestProof = await resolveOperatorIdentity({
      config,
      proposal,
      action: "apply",
      env: {
        TEST_OPERATOR_PUBLIC_KEY: env.TEST_OPERATOR_PUBLIC_KEY,
        TEST_ATTESTATION_SECRET: attestationSecret,
      },
      token,
    });
    expect(requestProof).toMatchObject({
      provider: "jwt_oidc",
      verified: true,
      subject: "alice@example.com",
      decision: { action: "apply" },
    });
    expect(JSON.stringify(requestProof)).not.toContain(token);

    await expect(resolveOperatorIdentity({
      config,
      proposal,
      action: "approve",
      requiredRole: "finance_lead",
      env,
    })).rejects.toThrow(/lacks required role finance_lead/);
  });
});
