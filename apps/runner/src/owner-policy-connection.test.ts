import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, generatePrimeSync, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { policyManagementParentSchema, resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ProposalStore, type ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import { validateOwnerPolicyParent } from "../../../packages/mcp-server/src/owner-policy-compiler.js";
import { buildAutoBoundary, AUTO_BOUNDARY_OVERRIDES_VERSION, explorationBoundaryCandidateDigest, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { recommendedBoundaryReviewCandidate } from "./boundary-candidate.js";
import { buildActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { encodeOperatorAuthority, validateOperatorPolicySnapshot } from "./control-policy-authority-codec.js";
import { encodeOperatorExecutionPolicy, executionBindingDigest, readOperatorExecutionConfig } from "./control-policy-execution.js";
import { OPERATOR_APPROVER_IDENTITY_KEY, OPERATOR_EXECUTION_POLICY_KEY } from "./control-policy-record.js";
import { migrateProjectControlPolicies, openProjectControlPolicies, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import { readRuntimeConfig } from "./cli-project.js";
import { inspectMcpToolBoundary, mcpConfigure, readLocalExploreRuntimeConfig, readMcpLaunchConfig } from "./mcp-runtime.js";
import { ownerPolicyCommand } from "./owner-policy-commands.js";
import { prepareOwnerConnectionReview } from "./owner-policy-connection.js";
import { prepareApproverPolicyConfiguration } from "./approver-policy-configuration.js";
import { operatorPublicKeyFingerprint, verifySignedOperatorProof } from "./operator-identity.js";
import type { OwnerPolicyReviewIo } from "./owner-policy-review-ui.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

const postgresUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
const operator = { level: "operator" } as const;
const parentKey = { scope: operator, kind: "parent", name: "agent_settings" } as const;
type Connections = Pick<NonNullable<RuntimeConfig["action_rules"]>, "owner_management" | "owner_delegation">;
type Backend = "sqlite" | "postgres";

function ownerConnections(): Connections {
  return {
    owner_management: { parent_name: parentKey.name, policy_name: "my_rules", scope: "personal", credential_env: "OWNER_ASSISTANT_TOKEN",
      authentication: { provider: "jwt_hs256", issuer: "https://identity.example", audience: "owner-assistant", secret_env: "OWNER_SIGNING_KEY" },
      human_review: { credential_env: "OWNER_HUMAN_TOKEN", audience: "owner-human-review" } },
    owner_delegation: { parent_name: parentKey.name, credential_env: "OWNER_WORKLOAD_TOKEN",
      authentication: { provider: "jwt_hs256", issuer: "https://identity.example", audience: "owner-workload", secret_env: "OWNER_WORKLOAD_KEY" } },
  };
}

function reviewedRead(root: string) {
  const inspection: SchemaInspection = {
    engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: "2026-09-08T00:00:00.000Z",
    schemas: ["inventory"], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false,
      read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    tables: [{ schema: "inventory", name: "requests", type: "table", writable: false,
      columns: ["id", "tenant_id", "principal_id", "quantity", "version"].map((name, ordinal_position) => ({ name,
        data_type: ["quantity", "version"].includes(name) ? "integer" : "uuid", ordinal_position, nullable: false, generated: false,
        suggestions: { tenant: name === "tenant_id", conflict: name === "version", sensitive: false, immutable: name.endsWith("id"), large_or_binary: false } })),
      primary_key: ["id"], unique_constraints: [{ name: "requests_pkey", columns: ["id"] }], check_constraints: [], foreign_keys: [],
      row_level_security: false, indexes: [], role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["tenant_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["quantity"] } }],
  };
  const decision = (value: string) => ({ value, actor: "fixture_operator", reason: "Reviewed fixture identity binding.", decided_at: "2026-09-08T00:00:00.000Z" });
  const build = buildAutoBoundary({ inspection, inspectedSchema: "inventory", sourceEnv: "READER_URL", deploymentProfile: "staging",
    overrides: { schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: { "inventory.requests": {
      tenant_key: decision("tenant_id"), principal_key: decision("principal_id") } } },
    project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["READER_URL"] } });
  const candidate = recommendedBoundaryReviewCandidate(build.exploration_boundary);
  const active: ActivatedExplorationBoundary = { ...candidate, activation: { state: "active", digest: explorationBoundaryCandidateDigest(candidate),
    actor: "fixture_operator", activated_at: "2026-09-08T00:00:00.000Z", generation_lock_fingerprint: candidate.generation_lock_fingerprint, reviewed_decisions: [] } };
  return { build, candidate, active };
}

function pointer({ scope, kind, name, revision_id }: ControlPolicyRevision) { return { scope, kind, name, revision_id }; }
function parentRevision(content: unknown): ControlPolicyRevision {
  return { ...parentKey, revision_id: randomUUID(), content, content_digest: canonicalJsonDigest(content), authority_digest: canonicalJsonDigest(content) };
}
function event() { return { event_id: randomUUID(), actor: "connection-test-operator", occurred_at: new Date().toISOString(), receipt: { operation: "fixture_parent_change" } }; }

async function withFixture(backend: Backend, run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: { execution?: boolean; initialOwners?: boolean; initialApplySigner?: boolean; initialApplySignerPinned?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-owner-connection-"));
  const schema = `owner_connection_${randomUUID().replaceAll("-", "")}`;
  const admin = backend === "postgres" ? new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 3000 }) : undefined;
  let fixture: Awaited<ReturnType<typeof setup>> | undefined;
  try { fixture = await setup(root, schema, backend, options); await run(fixture); }
  finally {
    if (fixture) { for (const review of fixture.reviews) await review.close(); await fixture.binding.close(); }
    if (admin) { try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); } }
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function setup(root: string, schema: string, backend: Backend, options: { execution?: boolean; initialOwners?: boolean; initialApplySigner?: boolean; initialApplySignerPinned?: boolean }) {
  const f = ownerPolicyTestFixture(), read = reviewedRead(root);
  const draft = buildActionRuleAuthorityDraft({ name: "inventory_actions", action_boundary_name: "inventory_changes",
    catalog: { schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: f.compiled.generation_lock_fingerprint,
      resources: [f.compiled.target_resource], relationships: [] },
    rules: [{ read_boundary_name: read.active.pack.name, read_boundary_digest: read.active.activation.digest,
      rule: f.compiled.rule, verification_boundary: f.compiled.verification_boundary, effect_envelope: f.compiled.effect_envelope }],
    reviews: [{ outcome: f.compiled.outcome, when: "Requested units are allowed.", then: "Adjust requested units.", refused: ["Unavailable request."],
      human_review: "Inventory reviewer.", examples: [{ kind: "eligible", scenario: "Routine request", result: "Create a proposal" }] }],
    now: "2026-09-08T00:00:00.000Z" });
  const activeAction = encodeOperatorAuthority({ type: "action", authority: { schema_version: "synapsor.action-rule-authority-activation.v1", state: "active",
    authority: draft.authority, digest: draft.digest, reviews: draft.reviews, actor: "fixture_operator", activated_at: draft.created_at } });
  const readActive = encodeOperatorAuthority({ type: "read", boundary: read.active, generation_lock: read.build.lock });
  const readDraft = encodeOperatorAuthority({ type: "read", boundary: read.candidate, generation_lock: read.build.lock });
  const actionDraft = encodeOperatorAuthority({ type: "action", authority: draft });
  const selection = encodeOperatorAuthority({ type: "read_selection", selected_name: read.active.pack.name });
  const storePath = path.join(root, "control.db"), configPath = path.join(root, "synapsor.runner.json");
  let applySignerFingerprint: string | undefined;
  if (options.initialApplySigner) {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    await fs.writeFile(path.join(root, "recovery.pub.pem"), publicKey, { mode: 0o600 });
    if (options.initialApplySignerPinned) applySignerFingerprint = operatorPublicKeyFingerprint(publicKey);
  }
  const config: RuntimeConfig = { version: 1, mode: "review", capabilities: [], trusted_context: { provider: "environment" },
    sources: { local_postgres: { engine: "postgres", read_only: false, read_url_env: "READER_URL", write_url_env: "WRITER_URL", receipts: { authority: "runner_ledger" } } },
    action_rules: { project_root: root, ...(options.initialOwners ? ownerConnections() : {}) },
    storage: backend === "postgres" ? { shared_postgres: { mode: "runtime_store", schema, url_env: "OWNER_CONNECTION_PG_URL" } } : { sqlite_path: storePath },
    ...(options.initialApplySigner ? { operator_identity: { provider: "signed_key", apply_roles: ["recovery_operator"],
      operators: { recovery_operator: { public_key_path: "./recovery.pub.pem", roles: ["recovery_operator"],
        ...(applySignerFingerprint ? { public_key_fingerprint: applySignerFingerprint } : {}) } } } } : {}),
    ...(options.execution === false ? {} : { supervised_worker: { enabled: true, profile: "staging", capabilities: [], outcomes: [{
      outcome: f.compiled.outcome, action_boundary_digest: draft.authority.action_boundary.digest, mode: "supervised_worker", concurrency: 1,
      queue_limit: 20, lease_seconds: 60, max_attempts: 3, proposal_ttl_seconds: 300, rate_limit: { executions: 10, window_seconds: 60 }, write_url_env: "WRITER_URL" }] } }),
  };
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(configPath, configText, { mode: 0o600 });
  const parent = parentRevision(policyManagementParentSchema.parse({ schema_version: "synapsor.policy-management-parent.v1", delegation: f.parent,
    agent_owners: [{ agent: "agent-a", scope: { level: "principal", tenant_id: "acme", principal: "maya" } }],
    managers: [{ subject: "maya-login", actor_kind: "human", tenant_id: "acme", scope: { mode: "personal" }, permissions: ["inspect", "draft", "activate", "revoke", "audit"] }] }));
  const execution = encodeOperatorExecutionPolicy(config);
  const snapshot: ControlPolicyMigrationSnapshot = { revisions: [readActive, readDraft, activeAction, actionDraft, selection, ...(execution ? [execution] : [])],
    active: [readActive, activeAction, selection, ...(execution ? [execution] : [])].map(pointer), drafts: [readDraft, actionDraft].map(pointer), provenance: [] };
  const env = { OWNER_CONNECTION_PG_URL: postgresUrl,
    OWNER_ASSISTANT_TOKEN: "private-assistant-token-never-print", OWNER_HUMAN_TOKEN: "private-human-token-never-print",
    OWNER_WORKLOAD_TOKEN: "private-workload-token-never-print", OWNER_SIGNING_KEY: "private-signing-key-never-print",
    OWNER_WORKLOAD_KEY: "private-workload-key-never-print" };
  const { binding } = await migrateProjectControlPolicies({ projectRoot: root, config, storePath, env, actor: "fixture_operator",
    readLegacySnapshot: async () => structuredClone(snapshot), validateSnapshot: async (value) => validateOperatorPolicySnapshot(value, { runtimeConfig: config }) });
  validateOwnerPolicyParent({ parent: f.parent, rules: [f.compiled] });
  await binding.repository.commit({ deployment_id: binding.deployment_id, expected_epoch: 1, revisions: [parent], active: [pointer(parent)], event: event() });
  const reviews: Array<Awaited<ReturnType<typeof prepareOwnerConnectionReview>>> = [];
  const input = { projectRoot: root, configPath, storePath, env, actor: "connection-test-operator" };
  const prepare = async (extra: Partial<Parameters<typeof prepareOwnerConnectionReview>[0]> = {}) => {
    const review = await prepareOwnerConnectionReview({ ...input, ...extra }); reviews.push(review); return review;
  };
  const writeConfig = async (value: RuntimeConfig) => fs.writeFile(configPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  const added = (): RuntimeConfig => ({ ...structuredClone(config), action_rules: { ...config.action_rules!, ...ownerConnections() } });
  const state = () => binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id, scope: operator,
    kinds: ["read", "action", "execution", "parent", "management", "delegation"] });
  return { root, schema, config, configPath, configText, storePath, env, input, parent, execution, snapshot, binding, reviews, prepare, writeConfig, added, state };
}

function ui(answers: string[]) {
  const output: string[] = [], details: string[] = [];
  const io: OwnerPolicyReviewIo = { read: async () => answers.shift(), write: (text) => output.push(text), columns: () => 100,
    choose: vi.fn(async () => answers.shift()), review: vi.fn(async (_title, lines) => { details.push(...lines); }), isTerminal: () => false };
  return { io, output, details };
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", `'\\''`)}'`; }

function rsaPublicPemAtBits(bits: number): string {
  const exponent = 65537n;
  const gcd = (left: bigint, right: bigint): bigint => {
    while (right) [left, right] = [right, left % right];
    return left;
  };
  let modulus: bigint, p: bigint, q: bigint;
  do {
    p = generatePrimeSync(Math.ceil(bits / 2), { bigint: true });
    q = generatePrimeSync(Math.floor(bits / 2), { bigint: true });
    modulus = p * q;
  } while (modulus.toString(2).length !== bits || gcd(exponent, (p - 1n) * (q - 1n)) !== 1n);
  let hex = modulus.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return createPublicKey({ key: { kty: "RSA", n: Buffer.from(hex, "hex").toString("base64url"), e: "AQAB" },
    format: "jwk" }).export({ type: "spki", format: "pem" }).toString();
}

async function installedApproverCli(args: string[], env: NodeJS.ProcessEnv, confirm: boolean) {
  const command = [path.resolve("bin/synapsor-runner"), ...args].map(shellQuote).join(" ");
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: path.resolve("."), env: { PATH: process.env.PATH, HOME: env.HOME, NO_COLOR: "1", TERM: "xterm",
      COLUMNS: "100", LINES: "30", ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", answered = false;
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (confirm && !answered && output.includes("Leave unchanged")) {
      answered = true;
      child.stdin.write("\u001b[A\u001b[A\r"); // Move from default cancel to explicit confirm.
    }
  });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const status = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`installed policy approver timed out: ${output}`)); }, 20_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => { clearTimeout(timeout); resolve(code); });
  });
  return { status, output, answered };
}

async function reviewerIdentity(root: string) {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  await fs.writeFile(path.join(root, "reviewer.pub.pem"), publicKey, { mode: 0o600 });
  return { provider: "signed_key" as const, operators: { reviewer_one: { public_key_path: "./reviewer.pub.pem",
    roles: ["action_reviewer"], outcomes: ["inventory.adjust"] } } };
}

for (const backend of ["sqlite", "postgres"] as const) describe.skipIf(backend === "postgres" && !postgresUrl)(`${backend} scoped approver transition`, () => {
  it("adds an exact approval reviewer while retaining the existing signed recovery operator", async () => {
    await withFixture(backend, async (f) => {
      const reviewer = await reviewerIdentity(f.root);
      const identity = { ...reviewer, apply_roles: ["recovery_operator"], operators: {
        recovery_operator: { public_key_path: "./recovery.pub.pem", roles: ["recovery_operator"] },
        ...reviewer.operators,
      } };
      const before = await f.state();
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, identity });
      f.reviews.push(prepared as never);
      expect(prepared.review.roster).toEqual(expect.arrayContaining([
        expect.objectContaining({ subject: "recovery_operator", roles: ["recovery_operator"], outcomes: [] }),
        expect.objectContaining({ subject: "reviewer_one", roles: ["action_reviewer"], outcomes: ["inventory.adjust"] }),
      ]));
      expect(await f.state()).toEqual(before);
      await prepared.confirm(prepared.review.digest);
      const saved = await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath });
      expect(saved.operator_identity?.operators?.recovery_operator).toMatchObject(identity.operators.recovery_operator);
      expect(saved.operator_identity?.operators?.reviewer_one).toMatchObject(identity.operators.reviewer_one);
      expect(saved.supervised_worker?.enabled).toBe(false);
      expect((await f.state()).epoch).toBe(before.epoch + 1);
    }, { initialApplySigner: true });
  });

  it("refuses to replace an existing apply signer during approver enrollment", async () => {
    await withFixture(backend, async (f) => {
      const reviewer = await reviewerIdentity(f.root);
      const identity = { ...reviewer, apply_roles: ["recovery_operator"] };
      const before = await f.state();
      await expect(prepareApproverPolicyConfiguration({ ...f.input, identity }))
        .rejects.toMatchObject({ code: "POLICY_APPROVER_APPLY_SIGNER_CHANGED" });
      expect(await f.state()).toEqual(before);
    }, { initialApplySigner: true });
  });

  it("accepts an Ed25519 reviewer key and refuses unsupported EC keys before saving", async () => {
    await withFixture(backend, async (f) => {
      const keyFile = path.join(f.root, "reviewer.pub.pem");
      const identity = await reviewerIdentity(f.root);
      const before = await f.state(), configBefore = await fs.readFile(f.configPath, "utf8");
      await fs.writeFile(keyFile, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey
        .export({ type: "spki", format: "pem" }), { mode: 0o600 });
      await expect(prepareApproverPolicyConfiguration({ ...f.input, identity }))
        .rejects.toMatchObject({ code: "POLICY_APPROVER_KEY_UNSUPPORTED" });
      expect(await f.state()).toEqual(before);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(configBefore);

      await fs.writeFile(keyFile, generateKeyPairSync("ed25519").publicKey
        .export({ type: "spki", format: "pem" }), { mode: 0o600 });
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, identity });
      f.reviews.push(prepared as never);
      await prepared.confirm(prepared.review.digest);
      expect((await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath }))
        .operator_identity?.operators?.reviewer_one?.public_key_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect((await f.state()).epoch).toBe(before.epoch + 1);
    });
  });

  it("refuses importable RSA keys too small for SHA-256 signing while admitting the first usable size", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root), keyFile = path.join(f.root, "reviewer.pub.pem");
      const before = await f.state(), beforeConfig = await fs.readFile(f.configPath, "utf8");
      await fs.writeFile(keyFile, rsaPublicPemAtBits(488), { mode: 0o600 });
      await expect(prepareApproverPolicyConfiguration({ ...f.input, identity }))
        .rejects.toMatchObject({ code: "POLICY_APPROVER_KEY_UNUSABLE" });
      expect(await f.state()).toEqual(before);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(beforeConfig);
      await fs.writeFile(keyFile, rsaPublicPemAtBits(489), { mode: 0o600 });
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, identity });
      try { expect(prepared.review.roster[0]?.public_key_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u); }
      finally { await prepared.close(); }
      expect(await f.state()).toEqual(before);
    });
  });

  it("refuses a changed pinned recovery key even when the proposed roster omits its fingerprint", async () => {
    await withFixture(backend, async (f) => {
      const reviewer = await reviewerIdentity(f.root);
      const identity = { ...reviewer, apply_roles: ["recovery_operator"], operators: {
        recovery_operator: { public_key_path: "./recovery.pub.pem", roles: ["recovery_operator"] },
        ...reviewer.operators,
      } };
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      await fs.writeFile(path.join(f.root, "recovery.pub.pem"), publicKey, { mode: 0o600 });
      const before = await f.state();
      await expect(prepareApproverPolicyConfiguration({ ...f.input, identity }))
        .rejects.toMatchObject({ code: "POLICY_APPROVER_APPLY_SIGNER_CHANGED" });
      expect(await f.state()).toEqual(before);
    }, { initialApplySigner: true, initialApplySignerPinned: true });
  });

  it("reviews a new key, keeps execution disabled, retains old authority and requires separate enable review", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root), before = await f.state();
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, identity });
      f.reviews.push(prepared as never);
      expect(prepared.review).toMatchObject({ execution_was_enabled: true, execution_enabled_after: false,
        roster: [{ subject: "reviewer_one", roles: ["action_reviewer"], outcomes: ["inventory.adjust"] }] });
      expect(prepared.review.roster[0]!.public_key_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(await f.state()).toEqual(before);
      await prepared.confirm(prepared.review.digest);
      const after = await f.state(), oldExecution = before.active.find((entry) => entry.kind === "execution")!;
      const current = await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath });
      expect(current.operator_identity).toMatchObject(identity);
      expect(current.operator_identity?.operators?.reviewer_one?.public_key_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(current.supervised_worker?.enabled).toBe(false);
      expect(after.epoch).toBe(before.epoch + 1);
      expect(after.active.filter((entry) => entry.kind !== "execution" && entry.name !== "approver_identity"))
        .toEqual(before.active.filter((entry) => entry.kind !== "execution"));
      const trustRevision = await f.binding.repository.active(f.binding.deployment_id, OPERATOR_APPROVER_IDENTITY_KEY);
      expect(trustRevision?.content).toMatchObject({ type: "approver_identity",
        identity_digest: canonicalJsonDigest(current.operator_identity),
        public_keys: [{ subject: "reviewer_one", roles: ["action_reviewer"], outcomes: ["inventory.adjust"] }] });
      expect(await f.binding.repository.revision(f.binding.deployment_id, OPERATOR_EXECUTION_POLICY_KEY, oldExecution.revision_id)).toEqual(oldExecution);
      expect(after.active.find((entry) => entry.kind === "execution")?.revision_id).not.toBe(oldExecution.revision_id);
      const reopened = await openProjectControlPolicies({ projectRoot: f.root, config: current,
        storePath: f.storePath, env: f.env });
      expect(reopened).toBeDefined();
      try {
        expect(await reopened!.repository.active(reopened!.deployment_id, OPERATOR_APPROVER_IDENTITY_KEY)).toEqual(trustRevision);
        expect(await reopened!.repository.active(reopened!.deployment_id, OPERATOR_EXECUTION_POLICY_KEY))
          .toEqual(await f.binding.repository.active(f.binding.deployment_id, OPERATOR_EXECUTION_POLICY_KEY));
      } finally { await reopened?.close(); }
      await expect(prepared.confirm(prepared.review.digest)).rejects.toMatchObject({ code: "POLICY_APPROVER_CONFIRMATION_REQUIRED" });
    });
  });

  it("default cancellation leaves exact config and authority unchanged", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root), file = path.join(f.root, "approver-roster.json");
      await fs.writeFile(file, JSON.stringify({ operator_identity: identity }), { mode: 0o600 });
      const before = await f.state(), screen = ui(["cancel"]);
      expect(await ownerPolicyCommand(["approver", "--config", f.configPath, "--input", file], { io: screen.io, env: f.env })).toBe(0);
      expect(await f.state()).toEqual(before);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
    });
  });

  it("pins a reviewer key relative to the selected nested Action configuration", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root);
      identity.operators.reviewer_one.public_key_path = "../reviewer.pub.pem";
      const directory = path.join(f.root, "owned-config");
      await fs.mkdir(directory, { mode: 0o700 });
      const configPath = path.join(directory, "synapsor.actions.runner.json");
      await fs.rename(f.configPath, configPath);
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, configPath, identity });
      f.reviews.push(prepared as never);
      await prepared.confirm(prepared.review.digest);
      const selected = await readRuntimeConfig(configPath, { env: f.env, storePath: f.storePath });
      expect(selected.operator_identity?.operators?.reviewer_one?.public_key_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(selected.supervised_worker?.enabled).toBe(false);
    });
  });

  it("CLI explicit confirmation stages the reviewed roster without enabling execution", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root), file = path.join(f.root, "approver-roster.json");
      await fs.writeFile(file, JSON.stringify({ operator_identity: identity }), { mode: 0o600 });
      const screen = ui(["confirm"]), before = await f.state();
      expect(await ownerPolicyCommand(["approver", "--config", f.configPath, "--input", file], { io: screen.io, env: f.env })).toBe(0);
      expect(screen.io.choose).toHaveBeenCalledOnce();
      const output = screen.output.join("");
      expect(output).toContain("local deployment-operator");
      expect(output).toContain("execution remains disabled");
      expect(output).toMatch(/public key\s+sha256:[a-f0-9]{64}/u);
      const after = await f.state();
      expect(after.epoch).toBe(before.epoch + 1);
      expect((await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath })).supervised_worker?.enabled).toBe(false);
    });
  });

  for (const keyType of ["rsa", "ed25519"] as const) it.skipIf(backend === "postgres")(
    `installed CLI enrolls and verifies one ${keyType} signed approval`, async () => {
      await withFixture(backend, async (f) => {
        const keys = keyType === "rsa" ? generateKeyPairSync("rsa", { modulusLength: 2048 })
          : generateKeyPairSync("ed25519");
        const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
        const privatePath = path.join(f.root, "reviewer.pem");
        await fs.writeFile(path.join(f.root, "reviewer.pub.pem"), publicPem, { mode: 0o600 });
        await fs.writeFile(privatePath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
        const identity = await reviewerIdentity(f.root);
        // reviewerIdentity supplies the mandate; keep the selected key under that exact path.
        await fs.writeFile(path.join(f.root, "reviewer.pub.pem"), publicPem, { mode: 0o600 });
        const rosterPath = path.join(f.root, "approver-roster.json");
        await fs.writeFile(rosterPath, JSON.stringify({ operator_identity: identity }), { mode: 0o600 });
        const before = await f.state();
        const enrolled = await installedApproverCli(["policy", "approver", "--config", f.configPath,
          "--store", f.storePath, "--input", rosterPath], { ...f.env, HOME: f.root }, true);
        expect(enrolled.status, enrolled.output).toBe(0);
        expect(enrolled.answered).toBe(true);
        expect(enrolled.output).toMatch(/Approver configuration\s+reviewed and saved/u);
        expect((await f.state()).epoch).toBe(before.epoch + 1);

        const proposalId = `wrp_installed_${keyType}`;
        const store = new ProposalStore(f.storePath);
        store.createProposal({
          schema_version: "synapsor.change-set.v1", proposal_id: proposalId, proposal_version: 1,
          action: "inventory.adjust", mode: "review_required", principal: { id: "maya", source: "trusted_session" },
          scope: { tenant_id: "acme", business_object: "inventory.requests", object_id: "req-1" },
          source: { kind: "external_postgres", source_id: "local_postgres", schema: "inventory", table: "requests",
            primary_key: { column: "id", value: "req-1" } },
          before: { quantity: 1, version: 1 }, patch: { quantity: 2, version: 2 }, after: { quantity: 2, version: 2 },
          guards: { tenant: { column: "tenant_id", value: "acme" }, allowed_columns: ["quantity", "version"],
            expected_version: { column: "version", value: 1 } },
          evidence: { bundle_id: "ev_installed", query_fingerprint: "sha256:evidence", items: [] },
          approval: { status: "pending", required_role: "action_reviewer" },
          writeback: { status: "not_applied", mode: "trusted_worker_required" },
          source_database_mutated: false, integrity: { proposal_hash: "sha256:proposal" },
          created_at: "2026-09-25T00:00:00.000Z",
        } as Parameters<typeof store.createProposal>[0]);
        store.close();
        const approved = spawnSync(path.resolve("bin/synapsor-runner"), ["proposals", "approve", proposalId,
          "--yes", "--config", f.configPath, "--store", f.storePath,
          "--identity", "reviewer_one", "--identity-key", privatePath, "--reason", "Reviewed current evidence"], {
          cwd: path.resolve("."), encoding: "utf8", timeout: 20_000,
          env: { PATH: process.env.PATH, HOME: f.root, NO_COLOR: "1", ...f.env },
        });
        expect(approved.error).toBeUndefined();
        expect(approved.status, approved.stderr).toBe(0);
        const checked = new ProposalStore(f.storePath);
        try {
          const approvals = checked.approvals(proposalId);
          expect(approvals).toHaveLength(1);
          expect(approvals[0]?.identity?.algorithm).toBe(keyType === "ed25519" ? "ed25519" : "SHA256");
          expect(verifySignedOperatorProof(approvals[0]!.identity!, publicPem)).toBe(true);
        } finally { checked.close(); }
      });
    }, 45_000);

  it.skipIf(backend === "postgres")("installed CLI rejects unsupported approver keys before saving", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root), rosterPath = path.join(f.root, "approver-roster.json");
      await fs.writeFile(path.join(f.root, "reviewer.pub.pem"), generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
      await fs.writeFile(rosterPath, JSON.stringify({ operator_identity: identity }), { mode: 0o600 });
      const before = await f.state(), beforeConfig = await fs.readFile(f.configPath, "utf8");
      const refused = await installedApproverCli(["policy", "approver", "--config", f.configPath,
        "--store", f.storePath, "--input", rosterPath], { ...f.env, HOME: f.root }, false);
      expect(refused.status).toBe(1);
      expect(refused.output).toContain("POLICY_APPROVER_KEY_UNSUPPORTED");
      expect(await f.state()).toEqual(before);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(beforeConfig);
      await fs.writeFile(path.join(f.root, "reviewer.pub.pem"), rsaPublicPemAtBits(488), { mode: 0o600 });
      const tooSmall = await installedApproverCli(["policy", "approver", "--config", f.configPath,
        "--store", f.storePath, "--input", rosterPath], { ...f.env, HOME: f.root }, false);
      expect(tooSmall.status).toBe(1);
      expect(tooSmall.output).toContain("POLICY_APPROVER_KEY_UNUSABLE");
      expect(await f.state()).toEqual(before);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(beforeConfig);
    });
  }, 45_000);

  it("refuses a new role outside the active approval mandate", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root);
      identity.operators.reviewer_one.roles = ["worker_admin"];
      const before = await f.state();
      await expect(prepareApproverPolicyConfiguration({ ...f.input, identity })).rejects.toMatchObject({ code: "POLICY_APPROVER_ROLE_OUT_OF_SCOPE" });
      expect(await f.state()).toEqual(before);
    });
  });

  it("recovers only a proven prior execution binding after an identity-only file edit", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root), previous = path.join(f.root, "previous-actions.json");
      await fs.writeFile(previous, f.configText, { mode: 0o600 });
      await f.writeConfig({ ...f.config, operator_identity: identity });
      await expect(prepareApproverPolicyConfiguration({ ...f.input })).rejects.toMatchObject({ code: "POLICY_APPROVER_PREVIOUS_BINDING_REQUIRED" });
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, previousConfigPath: previous });
      f.reviews.push(prepared as never);
      expect(prepared.review.recovery).toBe(true);
      await prepared.confirm(prepared.review.digest);
      expect((await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath })).supervised_worker?.enabled).toBe(false);
    });
  });

  it("does not accept changed public-key material or unrelated runtime fields after preview", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root);
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, identity });
      f.reviews.push(prepared as never);
      const before = await f.state();
      await fs.writeFile(path.join(f.root, "reviewer.pub.pem"), generateKeyPairSync("rsa", { modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey, { mode: 0o600 });
      await expect(prepared.confirm(prepared.review.digest)).rejects.toMatchObject({ code: "POLICY_APPROVER_KEY_CHANGED" });
      expect(await f.state()).toEqual(before);
    });
  });

  it("refuses a held approver preview after a competing configuration edit or policy epoch", async () => {
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root);
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, identity });
      f.reviews.push(prepared as never);
      const changed = structuredClone(f.config);
      changed.sources!.local_postgres!.statement_timeout_ms = 1234;
      await f.writeConfig(changed);
      const before = await f.state();
      await expect(prepared.confirm(prepared.review.digest)).rejects.toMatchObject({ code: "POLICY_APPROVER_REVIEW_STALE" });
      expect(await f.state()).toEqual(before);
    });
    await withFixture(backend, async (f) => {
      const identity = await reviewerIdentity(f.root);
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, identity });
      f.reviews.push(prepared as never);
      const before = await f.state();
      await f.binding.repository.commit({ deployment_id: f.binding.deployment_id, expected_epoch: before.epoch,
        revisions: [], active: [], event: event() });
      const advanced = await f.state();
      await expect(prepared.confirm(prepared.review.digest)).rejects.toMatchObject({ code: "POLICY_APPROVER_REVIEW_STALE" });
      expect(await f.state()).toEqual(advanced);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
    });
  });

  it("retains the prior public verification key when rotating and revoking a scoped reviewer", async () => {
    await withFixture(backend, async (f) => {
      const first = await reviewerIdentity(f.root);
      const enrolled = await prepareApproverPolicyConfiguration({ ...f.input, identity: first });
      f.reviews.push(enrolled as never);
      await enrolled.confirm(enrolled.review.digest);
      const oldRevision = (await f.binding.repository.active(f.binding.deployment_id, OPERATOR_APPROVER_IDENTITY_KEY))!;
      const oldPem = (oldRevision.content as { public_keys: Array<{ public_key_pem: string }> }).public_keys[0]!.public_key_pem;
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      await fs.writeFile(path.join(f.root, "replacement.pub.pem"), publicKey, { mode: 0o600 });
      const replacement = { provider: "signed_key" as const,
        operators: { reviewer_two: { public_key_path: "./replacement.pub.pem", roles: ["action_reviewer"], outcomes: ["inventory.adjust"] } } };
      const rotated = await prepareApproverPolicyConfiguration({ ...f.input, identity: replacement });
      f.reviews.push(rotated as never);
      await rotated.confirm(rotated.review.digest);
      const active = (await f.binding.repository.active(f.binding.deployment_id, OPERATOR_APPROVER_IDENTITY_KEY))!;
      expect(active.revision_id).not.toBe(oldRevision.revision_id);
      expect(await f.binding.repository.revision(f.binding.deployment_id, OPERATOR_APPROVER_IDENTITY_KEY, oldRevision.revision_id)).toEqual(oldRevision);
      expect((oldRevision.content as { public_keys: Array<{ public_key_pem: string }> }).public_keys[0]!.public_key_pem).toBe(oldPem);
      expect((active.content as { public_keys: Array<{ subject: string }> }).public_keys).toMatchObject([{ subject: "reviewer_two" }]);
      const current = await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath });
      expect(current.operator_identity?.operators?.reviewer_one).toBeUndefined();
      expect(current.supervised_worker?.enabled).toBe(false);
    });
  });

  it.each(["missing", "swapped"])("recovers local management after the old reviewer key is %s without admitting runtime", async (mode) => {
    await withFixture(backend, async (f) => {
      const first = await reviewerIdentity(f.root);
      const enrolled = await prepareApproverPolicyConfiguration({ ...f.input, identity: first });
      f.reviews.push(enrolled as never);
      await enrolled.confirm(enrolled.review.digest);
      const oldRevision = (await f.binding.repository.active(f.binding.deployment_id, OPERATOR_APPROVER_IDENTITY_KEY))!;
      const oldPath = path.join(f.root, "reviewer.pub.pem");
      if (mode === "missing") await fs.unlink(oldPath);
      else await fs.writeFile(oldPath, generateKeyPairSync("rsa", { modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } }).publicKey);
      await expect(readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath })).rejects.toThrow();
      const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      await fs.writeFile(path.join(f.root, "new-reviewer.pub.pem"), publicKey, { mode: 0o600 });
      const replacement = { provider: "signed_key" as const,
        operators: { reviewer_two: { public_key_path: "./new-reviewer.pub.pem", roles: ["action_reviewer"],
          outcomes: ["inventory.adjust"] } } };
      const prepared = await prepareApproverPolicyConfiguration({ ...f.input, identity: replacement });
      f.reviews.push(prepared as never);
      await prepared.confirm(prepared.review.digest);
      expect((await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath })).supervised_worker?.enabled).toBe(false);
      expect(await f.binding.repository.revision(f.binding.deployment_id, OPERATOR_APPROVER_IDENTITY_KEY, oldRevision.revision_id)).toEqual(oldRevision);
    });
  });
});

for (const backend of ["sqlite", "postgres"] as const) describe.skipIf(backend === "postgres" && !postgresUrl)(`${backend} owner connection exact execution recovery`, () => {
  it.each(["management_only", "management_and_workload"])("recovers only added owner fields with independent exact execution consent and preserves immutable policies: %s", async (mode) => {
    await withFixture(backend, async (f) => {
      const added = f.added();
      if (mode === "management_only") delete added.action_rules!.owner_delegation;
      const expectedConnections = { owner_management: added.action_rules!.owner_management,
        ...(added.action_rules!.owner_delegation ? { owner_delegation: added.action_rules!.owner_delegation } : {}) };
      await f.writeConfig(added);
      await expect(readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath })).rejects.toMatchObject({ code: "POLICY_EXECUTION_BINDING_CHANGED" });
      const before = await f.state(), text = await fs.readFile(f.configPath, "utf8"), prepared = await f.prepare();
      const history = (key: ControlPolicyRevision) => f.binding.repository.history({ deployment_id: f.binding.deployment_id, key });
      const retained = before.active.filter((entry) => entry.kind !== "execution");
      const retainedHistory = await Promise.all(retained.map(history));
      expect(prepared.review).toMatchObject({ recovery: true, execution_enabled: true, before: {}, after: expectedConnections, execution: f.config.supervised_worker });
      expect(await f.state()).toEqual(before); expect(await fs.readFile(f.configPath, "utf8")).toBe(text);
      await expect(prepared.confirm({ connectionDigest: prepared.review.digest })).rejects.toMatchObject({ code: "POLICY_CONNECTION_CONFIRMATION_REQUIRED" });
      expect(await f.state()).toEqual(before); expect(await fs.readFile(f.configPath, "utf8")).toBe(text);
      await prepared.confirm({ connectionDigest: prepared.review.digest, executionDigest: prepared.review.digest });
      const after = await f.state(), oldExecution = before.active.find((entry) => entry.kind === "execution")!, nextExecution = after.active.find((entry) => entry.kind === "execution")!;
      expect(after.epoch).toBe(before.epoch + 1);
      expect(nextExecution.revision_id).not.toBe(oldExecution.revision_id);
      expect(nextExecution.content).toMatchObject({ policy: f.config.supervised_worker, runtime_binding_digest: executionBindingDigest(resolveRuntimeConfig(added, f.root)) });
      expect((nextExecution.content as { policy: unknown }).policy).toEqual(f.config.supervised_worker);
      expect(oldExecution.content).toMatchObject({ runtime_binding_digest: executionBindingDigest(f.config) });
      expect(await f.binding.repository.revision(f.binding.deployment_id, OPERATOR_EXECUTION_POLICY_KEY, oldExecution.revision_id)).toEqual(oldExecution);
      expect(await history(nextExecution)).toEqual([{ epoch: after.epoch, revision: nextExecution }, { epoch: 1, revision: oldExecution }]);
      expect(after.active.filter((entry) => entry.kind !== "execution")).toEqual(before.active.filter((entry) => entry.kind !== "execution"));
      expect(after.drafts).toEqual(before.drafts);
      expect(await Promise.all(retained.map(history))).toEqual(retainedHistory);
      expect(await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath })).toMatchObject({ supervised_worker: f.config.supervised_worker, action_rules: expectedConnections });
      await expect(prepared.confirm({ connectionDigest: prepared.review.digest, executionDigest: prepared.review.digest })).rejects.toMatchObject({ code: "POLICY_CONNECTION_CONFIRMATION_REQUIRED" });
      expect(await f.state()).toEqual(after);
    });
  });

  it("keeps caller-owned input mutations outside the confirmed connection binding", async () => {
    await withFixture(backend, async (f) => {
      const supplied = ownerConnections(), prepared = await f.prepare({ connections: supplied });
      const reviewed = structuredClone(prepared.review);
      supplied.owner_management!.authentication.audience = "unreviewed-audience-after-prepare";
      expect(prepared.review).toEqual(reviewed);
      await prepared.confirm({ connectionDigest: reviewed.digest, executionDigest: reviewed.digest });
      const stored = JSON.parse(await fs.readFile(f.configPath, "utf8")) as RuntimeConfig;
      expect(stored.action_rules!.owner_management).toEqual(reviewed.after.owner_management);
      const execution = await f.binding.repository.active(f.binding.deployment_id, OPERATOR_EXECUTION_POLICY_KEY);
      expect(execution!.content).toMatchObject({ runtime_binding_digest: executionBindingDigest({ ...f.config,
        action_rules: { ...f.config.action_rules!, ...reviewed.after } }) });
    });
  });

  it("preserves confirmed policy, bindings and receipt against in-flight public review mutation under the held lock", async () => {
    await withFixture(backend, async (f) => {
      const input = { ...f.input, connections: ownerConnections() };
      const prepared = await prepareOwnerConnectionReview(input), before = await f.state();
      f.reviews.push(prepared);
      const reviewed = structuredClone(prepared.review), expectedConfig = f.added();
      expect(reviewed.execution!.outcomes![0]!.rate_limit.executions).toBe(10);
      let entered!: () => void, release!: () => void;
      const locked = new Promise<void>((resolve) => { entered = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const holder = withProjectAuthorityMutation(f.root, async () => { entered(); await released; });
      let confirmation: Promise<void> | undefined;
      try {
        await Promise.race([locked, holder]);
        confirmation = prepared.confirm({ connectionDigest: reviewed.digest, executionDigest: reviewed.digest });
        void confirmation.catch(() => undefined);
        prepared.review.execution!.outcomes![0]!.rate_limit.executions = 999;
        prepared.review.execution_enabled = false;
        prepared.review.after.owner_management!.authentication.audience = "unreviewed-in-flight-audience";
        input.actor = "unreviewed-in-flight-actor";
        expect(await f.state()).toEqual(before);
        expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
      } finally {
        release();
        try { await holder; } finally { await confirmation; }
      }
      const after = await f.state(), expectedBinding = executionBindingDigest(resolveRuntimeConfig(expectedConfig, f.root));
      expect(after.epoch).toBe(before.epoch + 1);
      const active = after.active.find((entry) => entry.kind === "execution")!;
      expect(active.content).toMatchObject({ policy: reviewed.execution, runtime_binding_digest: expectedBinding });
      expect((active.content as { policy: unknown }).policy).toEqual(reviewed.execution);
      expect(JSON.parse(await fs.readFile(f.configPath, "utf8"))).toEqual(expectedConfig);
      const admitted = await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath });
      expect(admitted.supervised_worker).toEqual(reviewed.execution);
      expect(admitted.action_rules).toEqual(expectedConfig.action_rules);
      expect(after.active.filter((entry) => entry.kind !== "execution")).toEqual(before.active.filter((entry) => entry.kind !== "execution"));
      expect(after.drafts).toEqual(before.drafts);

      // Locate the actual saved event, then read it through the repository API.
      let eventId: string;
      if (backend === "postgres") {
        const db = new Pool({ connectionString: postgresUrl, connectionTimeoutMillis: 3000 });
        try {
          const result = await db.query<{ event_id: string }>(`SELECT event_id FROM "${f.schema}".control_policy_events WHERE deployment_id = $1 AND epoch = $2`,
            [f.binding.deployment_id, after.epoch]);
          expect(result.rows).toHaveLength(1);
          eventId = result.rows[0]!.event_id;
        } finally { await db.end(); }
      } else {
        const db = new DatabaseSync(f.storePath, { readOnly: true });
        try {
          const rows = db.prepare("SELECT event_id FROM control_policy_events WHERE deployment_id = ? AND epoch = ?").all(f.binding.deployment_id, after.epoch);
          expect(rows).toHaveLength(1);
          eventId = String(rows[0]!.event_id);
        } finally { db.close(); }
      }
      const recorded = await f.binding.repository.event(f.binding.deployment_id, eventId);
      expect(recorded).toMatchObject({ epoch: after.epoch, actor: f.input.actor });
      expect(recorded!.receipt).toEqual({ operation: "review_owner_connection", confirmation_digest: reviewed.digest,
        execution_confirmation_digest: reviewed.digest, before_binding: executionBindingDigest(f.config),
        after_binding: expectedBinding, source_database_changed: false });
    });
  });

  it.each(["connection_digest", "execution_digest", "tamper", "expired"])("rejects invalid confirmation without mutation: %s", async (mode) => {
    await withFixture(backend, async (f) => {
      const prepared = await f.prepare({ connections: ownerConnections() }), before = await f.state();
      const digest = prepared.review.digest;
      if (mode === "tamper") prepared.review.after.owner_management!.authentication.audience = "changed-audience";
      const clock = mode === "expired" ? vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300_001) : undefined;
      try {
        await expect(prepared.confirm({ connectionDigest: mode === "connection_digest" ? canonicalJsonDigest("wrong") : digest,
          executionDigest: mode === "execution_digest" ? canonicalJsonDigest("wrong") : digest })).rejects.toMatchObject({ code: "POLICY_CONNECTION_CONFIRMATION_REQUIRED" });
      } finally { clock?.mockRestore(); }
      expect(await f.state()).toEqual(before); expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
    });
  });

  it.each(["cancel", "details", "execution_decline"])("CLI decline leaves runtime, authority and drafts unchanged: %s", async (mode) => {
    await withFixture(backend, async (f) => {
      const inputPath = path.join(f.root, "owner-connections.json"); await fs.writeFile(inputPath, JSON.stringify(ownerConnections()));
      const before = await f.state(), screen = ui(mode === "cancel" ? ["cancel"] : mode === "details" ? ["details", "cancel"] : ["confirm", "details", "cancel"]);
      expect(await ownerPolicyCommand(["connection", "--config", f.configPath, "--input", inputPath], { io: screen.io, env: f.env })).toBe(0);
      expect(await f.state()).toEqual(before); expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
      if (mode !== "cancel") expect(screen.io.review).toHaveBeenCalledOnce();
      for (const value of Object.values(f.env).filter((value): value is string => value !== undefined)) {
        expect([...screen.output, ...screen.details].join("\n")).not.toContain(value);
      }
    });
  });

  it("CLI accepts input through two decisions and exposes names without token or key values", async () => {
    await withFixture(backend, async (f) => {
      const inputPath = path.join(f.root, "owner-connections.json"); await fs.writeFile(inputPath, JSON.stringify(ownerConnections()));
      const screen = ui(["details", "confirm", "details", "confirm"]), before = await f.state();
      expect(await ownerPolicyCommand(["connection", "--config", f.configPath, "--input", inputPath], { io: screen.io, env: f.env })).toBe(0);
      expect(screen.io.choose).toHaveBeenCalledTimes(4); expect(screen.io.review).toHaveBeenCalledTimes(2);
      expect(screen.output.join("")).toContain("Configured, not authenticated");
      const after = await f.state(); expect(after.epoch).toBe(before.epoch + 1); expect(after.drafts).toEqual(before.drafts);
      for (const value of Object.values(f.env).filter((value): value is string => value !== undefined)) {
        expect([...screen.output, ...screen.details, JSON.stringify(after)].join("\n")).not.toContain(value);
      }
    });
  });

  it("rejects configuration edits after preparation without overwriting the newer file", async () => {
    await withFixture(backend, async (f) => {
      const prepared = await f.prepare({ connections: ownerConnections() }), before = await f.state();
      const changed = f.added(); changed.sources!.local_postgres!.read_url_env = "NEW_READER_URL"; await f.writeConfig(changed);
      const text = await fs.readFile(f.configPath, "utf8");
      await expect(prepared.confirm({ connectionDigest: prepared.review.digest, executionDigest: prepared.review.digest })).rejects.toMatchObject({ code: "POLICY_CONNECTION_REVIEW_STALE" });
      expect(await fs.readFile(f.configPath, "utf8")).toBe(text); expect(await f.state()).toEqual(before);
    });
  });

  it("rejects a newer parent epoch without changing configuration or execution", async () => {
    await withFixture(backend, async (f) => {
      const prepared = await f.prepare({ connections: ownerConnections() });
      const parent = parentRevision(f.parent.content);
      await f.binding.repository.commit({ deployment_id: f.binding.deployment_id, expected_epoch: prepared.review.epoch, revisions: [parent], active: [pointer(parent)], event: event() });
      const newer = await f.state();
      await expect(prepared.confirm({ connectionDigest: prepared.review.digest, executionDigest: prepared.review.digest })).rejects.toThrow();
      expect(await f.state()).toEqual(newer);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
    });
  });

  it.each(["source", "context", "store"])("refuses genuine unrelated changes: %s", async (mode) => {
    await withFixture(backend, async (f) => {
      const previousConfigPath = path.join(f.root, "previous.json"); await fs.writeFile(previousConfigPath, f.configText);
      const changed = f.added();
      if (mode === "source") changed.sources!.local_postgres!.read_url_env = "OTHER_READER_URL";
      if (mode === "context") changed.trusted_context = { provider: "static_dev", values: { tenant_id: "different-tenant" } };
      if (mode === "store") {
        if (backend === "sqlite") changed.storage!.sqlite_path = path.join(f.root, "other.db");
        else changed.storage!.shared_postgres!.schema = `${f.schema}_other`;
      }
      await f.writeConfig(changed); const before = await f.state(), text = await fs.readFile(f.configPath, "utf8");
      await expect(f.prepare({ previousConfigPath, ...(mode === "store" && backend === "sqlite" ? { storePath: changed.storage!.sqlite_path } : {}) }))
        .rejects.toMatchObject({ code: mode === "store" ? "POLICY_STORE_SELECTION_CHANGED" : "POLICY_CONNECTION_UNRELATED_CHANGE" });
      expect(await f.state()).toEqual(before); expect(await fs.readFile(f.configPath, "utf8")).toBe(text);
    });
  });

  it("accepts a previous configuration only when it proves the exact stored old binding", async () => {
    await withFixture(backend, async (f) => {
      const changed = f.added(); changed.action_rules!.owner_management!.authentication.audience = "new-owner-assistant";
      await f.writeConfig(changed);
      await expect(f.prepare()).rejects.toMatchObject({ code: "POLICY_CONNECTION_PREVIOUS_BINDING_REQUIRED" });
      const previousConfigPath = path.join(f.root, "previous.json"), wrong = structuredClone(f.config);
      wrong.action_rules!.owner_management!.authentication.audience = "unreviewed-old-audience";
      await fs.writeFile(previousConfigPath, JSON.stringify(wrong));
      await expect(f.prepare({ previousConfigPath })).rejects.toMatchObject({ code: "POLICY_CONNECTION_PREVIOUS_BINDING_REQUIRED" });
      await fs.writeFile(previousConfigPath, f.configText);
      const prepared = await f.prepare({ previousConfigPath });
      expect(prepared.review.before).toEqual(ownerConnections()); expect(prepared.review.recovery).toBe(true);
      await prepared.confirm({ connectionDigest: prepared.review.digest, executionDigest: prepared.review.digest });
      expect((await readRuntimeConfig(f.configPath, { env: f.env, storePath: f.storePath })).supervised_worker).toEqual(f.config.supervised_worker);
    }, { initialOwners: true });
  });

  it("uses stored execution policy when the editable export tries to disable it", async () => {
    await withFixture(backend, async (f) => {
      const changed = f.added(); changed.supervised_worker!.enabled = false; await f.writeConfig(changed);
      const prepared = await f.prepare(); expect(prepared.review.execution_enabled).toBe(true); expect(prepared.review.execution).toEqual(f.config.supervised_worker);
      await expect(prepared.confirm({ connectionDigest: prepared.review.digest })).rejects.toMatchObject({ code: "POLICY_CONNECTION_CONFIRMATION_REQUIRED" });
    });
  });

  it("connects without inventing execution when no execution policy was migrated", async () => {
    await withFixture(backend, async (f) => {
      const before = await f.state(), prepared = await f.prepare({ connections: ownerConnections() });
      expect(prepared.review).toMatchObject({ recovery: false, execution: null, execution_enabled: false });
      await prepared.confirm({ connectionDigest: prepared.review.digest });
      const after = await f.state(); expect(after.active).toEqual(before.active); expect(after.drafts).toEqual(before.drafts);
      expect(JSON.parse(await fs.readFile(f.configPath, "utf8"))).not.toHaveProperty("supervised_worker");
      expect((await readOperatorExecutionConfig({ projectRoot: f.root, config: f.added(), policyStore: f.binding })).config.supervised_worker).toBeUndefined();
    }, { execution: false });
  });

  it("CLI requires only connection consent when there is no stored execution", async () => {
    await withFixture(backend, async (f) => {
      const inputPath = path.join(f.root, "owner-connections.json"); await fs.writeFile(inputPath, JSON.stringify(ownerConnections()));
      const screen = ui(["confirm"]);
      await ownerPolicyCommand(["connection", "--config", f.configPath, "--input", inputPath], { io: screen.io, env: f.env });
      expect(screen.io.choose).toHaveBeenCalledOnce();
      expect((await f.state()).active.some((entry) => entry.kind === "execution")).toBe(false);
      const saved = JSON.parse(await fs.readFile(f.configPath, "utf8"));
      expect(saved).not.toHaveProperty("supervised_worker");
    }, { execution: false });
  });

  it("admits the migrated Action companion before the distinct generated Read configuration", async () => {
    await withFixture(backend, async (f) => {
      const actionPath = path.join(f.root, "synapsor.actions.runner.json");
      await fs.rename(f.configPath, actionPath);
      const readConfig = structuredClone(f.config);
      readConfig.mode = "read_only";
      delete readConfig.supervised_worker;
      delete readConfig.action_rules!.owner_management;
      delete readConfig.action_rules!.owner_delegation;
      readConfig.sources!.local_postgres!.read_only = true;
      delete readConfig.sources!.local_postgres!.write_url_env;
      await f.writeConfig(readConfig);
      const before = await f.state(), text = await fs.readFile(f.configPath, "utf8");
      await expect(readRuntimeConfig(f.configPath, { env: f.env })).rejects.toMatchObject({ code: "POLICY_EXECUTION_BINDING_CHANGED" });
      const selected = await readLocalExploreRuntimeConfig(f.root, undefined, f.env);
      expect(selected!.supervised_worker).toEqual(f.config.supervised_worker);
      expect(selected!.action_rules).toEqual(f.config.action_rules);
      expect(executionBindingDigest(selected!)).toBe(executionBindingDigest(f.config));
      expect(await f.state()).toEqual(before);
      expect(await fs.readFile(f.configPath, "utf8")).toBe(text);
      expect(await fs.readFile(actionPath, "utf8")).toBe(f.configText);
    }, { initialOwners: true });
  });

  it("previews and configures four tools from the generated primary after execution migration", async () => {
    await withFixture(backend, async (f) => {
      await fs.rename(f.configPath, path.join(f.root, "synapsor.actions.runner.json"));
      const readConfig = structuredClone(f.config);
      readConfig.mode = "read_only";
      readConfig.capabilities = [];
      delete readConfig.action_rules;
      delete readConfig.supervised_worker;
      readConfig.sources!.local_postgres!.read_only = true;
      delete readConfig.sources!.local_postgres!.write_url_env;
      await f.writeConfig(readConfig);
      const before = await f.state();
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const preview = await inspectMcpToolBoundary(["--config", f.configPath, "--store", ":memory:"]);
        expect(preview.surface).toBe("local_explore");
        expect(preview.names).toEqual(["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"]);
        const direct = await inspectMcpToolBoundary(["--config", path.join(f.root, "synapsor.actions.runner.json"), "--store", ":memory:"]);
        expect(direct.surface).toBe("semantic_actions");
        expect(direct.names).toEqual(["app.describe_actions", "app.request_change"]);
        expect((await readMcpLaunchConfig(f.configPath, f.env)).localExploreProjectRoot).toBe(f.root);
        await expect(mcpConfigure(["--client", "claude-code", "--config", f.configPath])).resolves.toBe(0);
        expect(JSON.parse(stdout.mock.calls.at(-1)![0] as string).mcpServers.synapsor.args).toContain("--authoring");
        expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain("four fixed tools");
        expect(await f.state()).toEqual(before);
      } finally { stdout.mockRestore(); stderr.mockRestore(); }
    });
  });

  it.each(["source", "context", "authentication"])("default local launch rejects a changed Action %s binding without falling back to Read", async (field) => {
    await withFixture(backend, async (f) => {
      const actionPath = path.join(f.root, "synapsor.actions.runner.json");
      await fs.rename(f.configPath, actionPath);
      const readConfig = structuredClone(f.config);
      readConfig.mode = "read_only"; readConfig.capabilities = [];
      delete readConfig.action_rules; delete readConfig.supervised_worker;
      readConfig.sources!.local_postgres!.read_only = true;
      delete readConfig.sources!.local_postgres!.write_url_env;
      await f.writeConfig(readConfig);
      const changed = structuredClone(f.config);
      if (field === "source") changed.sources!.local_postgres!.read_url_env = "CHANGED_READER";
      else if (field === "authentication") changed.action_rules!.owner_management!.authentication.audience = "changed-audience";
      else changed.trusted_context = { provider: "static_dev", values: { tenant_id: "different-tenant" } };
      await fs.writeFile(actionPath, JSON.stringify(changed));
      const before = await f.state();
      await expect(readMcpLaunchConfig(f.configPath, f.env)).rejects.toMatchObject({ code: "POLICY_EXECUTION_BINDING_CHANGED" });
      expect(await f.state()).toEqual(before);
      expect(await fs.readFile(actionPath, "utf8")).toBe(JSON.stringify(changed));
    }, { initialOwners: true });
  });

  it("rejects tampered Action authentication even when the primary fallback independently admits", async () => {
    await withFixture(backend, async (f) => {
      const actionPath = path.join(f.root, "synapsor.actions.runner.json");
      const changed = structuredClone(f.config);
      changed.action_rules!.owner_management!.authentication.audience = "unreviewed-action-audience";
      await fs.writeFile(actionPath, JSON.stringify(changed));
      const before = await f.state();
      // A valid primary distinguishes refusal from silently falling back after
      // Action admission fails; two invalid configurations would not prove that.
      expect((await readRuntimeConfig(f.configPath, { env: f.env })).supervised_worker).toEqual(f.config.supervised_worker);
      await expect(readLocalExploreRuntimeConfig(f.root, f.configPath, f.env)).rejects.toMatchObject({ code: "POLICY_EXECUTION_BINDING_CHANGED" });
      expect(await f.state()).toEqual(before);
      expect(await fs.readFile(actionPath, "utf8")).toBe(JSON.stringify(changed));
      expect(await fs.readFile(f.configPath, "utf8")).toBe(f.configText);
    }, { initialOwners: true });
  });

  it("refuses an independently valid migrated Action configuration belonging to another project", async () => {
    await withFixture(backend, async (f) => {
      await withFixture(backend, async (other) => {
        const actionPath = path.join(f.root, "synapsor.actions.runner.json");
        await fs.writeFile(actionPath, other.configText);
        const before = await f.state(), otherBefore = await other.state();
        expect((await readRuntimeConfig(actionPath, { env: f.env })).supervised_worker).toEqual(other.config.supervised_worker);
        await expect(readLocalExploreRuntimeConfig(f.root, f.configPath, f.env)).rejects.toThrow("POLICY_RUNTIME_PROJECT_CHANGED");
        expect(await f.state()).toEqual(before); expect(await other.state()).toEqual(otherBefore);
        expect(await fs.readFile(actionPath, "utf8")).toBe(other.configText);
      });
    });
  });
});
