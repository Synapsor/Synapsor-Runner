import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { main } from "./cli.js";

describe("attention and notification CLI", () => {
  afterEach(() => vi.restoreAllMocks());

  it("browses and acknowledges the highest-priority item without copied ids or authority", async () => {
    const fixture = await createFixture();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main(["attention", "list", "--store", fixture.storePath])).resolves.toBe(0);
      expect(output.join("")).toContain("Proposal needs human review");
      expect(output.join("")).toContain("Next: synapsor-runner attention show");

      output.length = 0;
      await expect(main(["attention", "show", "--store", fixture.storePath])).resolves.toBe(0);
      expect(output.join("")).toContain("Acknowledging this item does not approve");
      expect(output.join("")).toContain("Source database changed: no");

      output.length = 0;
      await expect(main([
        "attention",
        "acknowledge",
        "--store",
        fixture.storePath,
        "--actor",
        "local_reviewer",
        "--json",
      ])).resolves.toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        attention: { status: "acknowledged", acknowledged_by: "local_reviewer" },
        approval_created: false,
        source_database_changed: false,
      });

      const store = new ProposalStore(fixture.storePath);
      try {
        expect(store.stats()).toMatchObject({ proposals: 0, approvals: 0, writeback_receipts: 0 });
      } finally {
        store.close();
      }
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("tests and dispatches a JSONL sink while keeping normal success traffic quiet", async () => {
    const fixture = await createFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    try {
      await expect(main([
        "notifications",
        "test",
        "--config",
        fixture.configPath,
        "--sink",
        "development",
      ])).resolves.toBe(0);
      const testEnvelope = JSON.parse(stdout.join(""));
      expect(testEnvelope).toMatchObject({
        specversion: "1.0",
        data: {
          summary: "Synapsor notification test. No database information is included.",
          details: { synthetic_test: true, source_database_changed: false },
        },
      });
      expect(stderr.join("")).toContain("No database information was sent");

      stdout.length = 0;
      stderr.length = 0;
      await expect(main([
        "notifications",
        "dispatch",
        "--config",
        fixture.configPath,
        "--store",
        fixture.storePath,
        "--sink",
        "development",
      ])).resolves.toBe(0);
      const deliveredEnvelope = JSON.parse(stdout.join(""));
      expect(deliveredEnvelope).toMatchObject({
        type: "ai.synapsor.proposal.review_required",
        data: {
          proposal_id: "wrp_attention",
          capability: "billing.propose_credit",
        },
      });
      expect(stderr.join("")).toContain("1 delivered");

      stdout.length = 0;
      stderr.length = 0;
      await expect(main([
        "notifications",
        "status",
        "--config",
        fixture.configPath,
        "--store",
        fixture.storePath,
        "--json",
      ])).resolves.toBe(0);
      expect(JSON.parse(stdout.join(""))).toMatchObject({
        enabled: true,
        sinks: [{
          id: "development",
          health: "healthy",
          counts: { delivered: 2 },
        }],
        open_attention: 1,
        source_database_changed: false,
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires and stores an exact signed operator decision for production acknowledgement", async () => {
    const fixture = await createFixture("production");
    const publicPath = path.join(fixture.root, "alice.pub.pem");
    const privatePath = path.join(fixture.root, "alice.pem");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
    await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const config = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    config.operator_identity = {
      provider: "signed_key",
      operators: {
        alice: {
          public_key_path: "./alice.pub.pem",
          roles: ["runner_operator"],
        },
      },
    };
    await fs.writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    try {
      await expect(main([
        "attention",
        "acknowledge",
        "--config",
        fixture.configPath,
        "--store",
        fixture.storePath,
        "--actor",
        "alice",
      ])).rejects.toThrow(/signed operator identity/i);

      await expect(main([
        "attention",
        "acknowledge",
        "--config",
        fixture.configPath,
        "--store",
        fixture.storePath,
        "--identity",
        "alice",
        "--identity-key",
        privatePath,
        "--json",
      ])).resolves.toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        attention: {
          status: "acknowledged",
          acknowledgement_identity: {
            provider: "signed_key",
            verified: true,
            subject: "alice",
            decision: { action: "attention_acknowledge" },
          },
        },
        approval_created: false,
        source_database_changed: false,
      });
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("requires an exact signed operator decision to replay only a dead-letter notification", async () => {
    const fixture = await createFixture("production");
    const publicPath = path.join(fixture.root, "alice.pub.pem");
    const privatePath = path.join(fixture.root, "alice.pem");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
    await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const config = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    config.operator_identity = {
      provider: "signed_key",
      operators: {
        alice: {
          public_key_path: "./alice.pub.pem",
          roles: ["runner_operator"],
        },
      },
    };
    await fs.writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

    const store = new ProposalStore(fixture.storePath);
    let deliveryId = "";
    try {
      const [event] = store.listAttentionEvents({ event_type: "proposal.review_required" });
      const [attention] = store.listAttentionItems({ status: "open" });
      const delivery = store.enqueueNotificationDelivery({
        sink_id: "development",
        event_id: event!.event_id,
        attention_id: attention!.attention_id,
        max_attempts: 1,
        now: "2026-07-24T12:01:00.000Z",
      });
      const [claimed] = store.claimNotificationDeliveries({
        owner: "dispatcher_failed",
        sink_id: "development",
        now: "2026-07-24T12:01:01.000Z",
      });
      const deadLetter = store.failNotificationDelivery({
        delivery_id: delivery.delivery_id,
        owner: "dispatcher_failed",
        lease_id: claimed!.lease_id!,
        error_code: "WEBHOOK_DESTINATION_BLOCKED",
        retryable: false,
        now: "2026-07-24T12:01:02.000Z",
      });
      deliveryId = deadLetter.delivery_id;
    } finally {
      store.close();
    }

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });
    const reason = "Webhook destination repaired and synthetic test passed";
    try {
      await expect(main([
        "notifications",
        "replay",
        "latest",
        "--yes",
        "--reason",
        reason,
        "--config",
        fixture.configPath,
        "--store",
        fixture.storePath,
      ])).rejects.toThrow(/signed operator identity/i);

      await expect(main([
        "notifications",
        "replay",
        "latest",
        "--yes",
        "--reason",
        reason,
        "--config",
        fixture.configPath,
        "--store",
        fixture.storePath,
        "--identity",
        "alice",
        "--identity-key",
        privatePath,
        "--json",
      ])).resolves.toBe(0);
      expect(JSON.parse(output.join(""))).toMatchObject({
        delivery: {
          delivery_id: deliveryId,
          status: "pending",
          attempts: 0,
        },
        operator: {
          subject: "alice",
          provider: "signed_key",
        },
        approval_replayed: false,
        mutation_replayed: false,
        source_database_changed: false,
      });

      const after = new ProposalStore(fixture.storePath);
      try {
        expect(after.stats()).toMatchObject({ proposals: 0, approvals: 0, writeback_receipts: 0 });
        expect(after.listAttentionEvents({ event_type: "notification.replayed" })).toEqual([
          expect.objectContaining({
            details: expect.objectContaining({
              delivery_id: deliveryId,
              operator_subject: "alice",
              approval_replayed: false,
              mutation_replayed: false,
              source_database_changed: false,
            }),
          }),
        ]);
      } finally {
        after.close();
      }
    } finally {
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createFixture(environment = "development"): Promise<{
  root: string;
  storePath: string;
  configPath: string;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-notification-cli-"));
  const storePath = path.join(root, "local.db");
  const configPath = path.join(root, "synapsor.runner.json");
  const store = new ProposalStore(storePath);
  try {
    store.recordAttentionEvent({
      event_type: "proposal.review_required",
      severity: "warning",
      environment,
      proposal_id: "wrp_attention",
      capability: "billing.propose_credit",
      attention_key: `${environment}:billing.propose_credit:manager-review`,
      source_event_key: "notification-cli-review",
      workbench_path: "/attention/review",
      details: { source_database_changed: false },
      now: "2026-07-24T12:00:00.000Z",
    });
    store.recordAttentionEvent({
      event_type: "proposal.applied",
      severity: "informational",
      environment,
      proposal_id: "wrp_success",
      capability: "billing.propose_credit",
      source_event_key: "notification-cli-success",
      details: { source_database_changed: true },
      now: "2026-07-24T12:00:01.000Z",
    });
  } finally {
    store.close();
  }
  await fs.writeFile(configPath, `${JSON.stringify({
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: storePath },
    sources: {
      app_postgres: {
        engine: "postgres",
        read_url_env: "APP_POSTGRES_READ_URL",
        read_only: true,
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: "SYNAPSOR_TENANT_ID",
        principal_env: "SYNAPSOR_PRINCIPAL",
      },
    },
    capabilities: [],
    notifications: {
      enabled: true,
      sinks: [{
        id: "development",
        type: "jsonl",
        destination: "stdout",
        minimum_severity: "informational",
        delivery: "immediate",
      }],
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, storePath, configPath };
}
