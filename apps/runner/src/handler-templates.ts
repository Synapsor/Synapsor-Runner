import fs from "node:fs/promises";
import path from "node:path";
import { cliCommandName } from "./cli-command-meta.js";
import { writeFileGuarded } from "./cli-files.js";

export const handlerSecurityWarning = [
  "IMPORTANT: your app handler owns the final business write.",
  "Runner creates the proposal and calls your handler only after approval, but your handler must still enforce:",
  "- tenant/scope check;",
  "- expected-version or conflict guard;",
  "- idempotency key;",
  "- allowed business action;",
  "- transaction/rollback;",
  "- safe error receipt.",
  "",
  "If you skip those checks, you can reintroduce cross-tenant writes, lost updates, or duplicate writes.",
  "Use the generated template/helper pattern and keep handler credentials out of MCP.",
].join("\n");

export const handlerTemplateDefinitions = {
  "node-fastify": {
    aliases: ["node", "fastify"],
    fileName: "synapsor-writeback-handler.mjs",
    description: "HTTP handler template for a Node/Fastify application service.",
    content: `import Fastify from "fastify";

const port = Number(process.env.PORT || 8787);
const expectedToken = process.env.SYNAPSOR_APP_WRITEBACK_TOKEN || "dev-handler-token";

const app = Fastify({ logger: true });

app.post("/synapsor/writeback", async (request, reply) => {
  const auth = request.headers.authorization || "";
  if (auth !== \`Bearer \${expectedToken}\`) {
    return reply.code(401).send({ status: "failed", safe_error_code: "UNAUTHORIZED" });
  }

  const body = request.body || {};
  const changeSet = body.change_set || {};

  if (!body.proposal_id || !body.idempotency_key || !changeSet.scope?.tenant_id) {
    return reply.code(400).send({ status: "failed", safe_error_code: "BAD_WRITEBACK_REQUEST" });
  }

  if (body.dry_run) {
    return {
      status: "applied",
      rows_affected: 0,
      source_database_mutated: false,
      details: { dry_run: true },
    };
  }

  /*
   * IMPORTANT: your app handler owns the final business write.
   * Runner creates the proposal and calls your handler only after approval,
   * but your handler must still enforce tenant/scope, expected-version or
   * conflict guard, idempotency key, allowed business action,
   * transaction/rollback, and safe error receipt.
   *
   * If you skip those checks, you can reintroduce cross-tenant writes,
   * lost updates, or duplicate writes. Keep handler credentials out of MCP.
   *
   * Put your app-owned transaction here.
   *
   * Examples:
   * - insert a refund_review row;
   * - insert an account_credit row;
   * - open a support_ticket row;
   * - update multiple related rows in one app transaction.
   *
   * Re-check tenant/principal authorization, idempotency, row/version guards,
   * and business policy before mutating application state.
   */

  return {
    status: "applied",
    rows_affected: 1,
    previous_version: String(changeSet.guards?.expected_version?.value || ""),
    new_version: new Date().toISOString(),
    source_database_mutated: true,
  };
});

app.listen({ host: "127.0.0.1", port });
`,
  },
  "python-fastapi": {
    aliases: ["python", "fastapi"],
    fileName: "synapsor_writeback_handler.py",
    description: "HTTP handler template for a Python/FastAPI application service.",
    content: `import os
from datetime import datetime, timezone

from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
expected_token = os.getenv("SYNAPSOR_APP_WRITEBACK_TOKEN", "dev-handler-token")


@app.post("/synapsor/writeback")
async def synapsor_writeback(body: dict, authorization: str | None = Header(default=None)):
    if authorization != f"Bearer {expected_token}":
        raise HTTPException(status_code=401, detail={"status": "failed", "safe_error_code": "UNAUTHORIZED"})

    change_set = body.get("change_set") or {}
    scope = change_set.get("scope") or {}
    if not body.get("proposal_id") or not body.get("idempotency_key") or not scope.get("tenant_id"):
        raise HTTPException(status_code=400, detail={"status": "failed", "safe_error_code": "BAD_WRITEBACK_REQUEST"})

    if body.get("dry_run"):
        return {
            "status": "applied",
            "rows_affected": 0,
            "source_database_mutated": False,
            "details": {"dry_run": True},
        }

    # Put your app-owned transaction here.
    #
    # IMPORTANT: your app handler owns the final business write.
    # Runner creates the proposal and calls your handler only after approval,
    # but your handler must still enforce tenant/scope, expected-version or
    # conflict guard, idempotency key, allowed business action,
    # transaction/rollback, and safe error receipt.
    #
    # If you skip those checks, you can reintroduce cross-tenant writes,
    # lost updates, or duplicate writes. Keep handler credentials out of MCP.
    #
    # Examples:
    # - insert a refund_review row;
    # - insert an account_credit row;
    # - open a support_ticket row;
    # - update multiple related rows in one app transaction.
    #
    # Re-check tenant/principal authorization, idempotency, row/version guards,
    # and business policy before mutating application state.

    expected_version = ((change_set.get("guards") or {}).get("expected_version") or {}).get("value", "")
    return {
        "status": "applied",
        "rows_affected": 1,
        "previous_version": str(expected_version),
        "new_version": datetime.now(timezone.utc).isoformat(),
        "source_database_mutated": True,
    }
`,
  },
  command: {
    aliases: ["script", "local-command"],
    fileName: "synapsor-command-handler.mjs",
    description: "Local command handler template for scripts or job runners.",
    content: `#!/usr/bin/env node

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);

const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
const changeSet = request.change_set || {};

if (!request.proposal_id || !request.idempotency_key || !changeSet.scope?.tenant_id) {
  process.stdout.write(JSON.stringify({
    status: "failed",
    safe_error_code: "BAD_WRITEBACK_REQUEST",
    source_database_mutated: false,
  }));
  process.exit(0);
}

if (request.dry_run) {
  process.stdout.write(JSON.stringify({
    status: "applied",
    rows_affected: 0,
    source_database_mutated: false,
    details: { dry_run: true },
  }));
  process.exit(0);
}

/*
 * IMPORTANT: your app handler owns the final business write.
 * Runner creates the proposal and calls your handler only after approval,
 * but your handler must still enforce tenant/scope, expected-version or
 * conflict guard, idempotency key, allowed business action,
 * transaction/rollback, and safe error receipt.
 *
 * If you skip those checks, you can reintroduce cross-tenant writes,
 * lost updates, or duplicate writes. Keep handler credentials out of MCP.
 *
 * Put your app-owned command transaction here.
 *
 * Examples:
 * - call an internal service;
 * - enqueue a review job;
 * - run an app script that uses your normal ORM.
 *
 * Re-check tenant/principal authorization, idempotency, row/version guards,
 * and business policy before mutating application state.
 */

process.stdout.write(JSON.stringify({
  status: "applied",
  rows_affected: 1,
  previous_version: String(changeSet.guards?.expected_version?.value || ""),
  new_version: new Date().toISOString(),
  source_database_mutated: true,
}));
`,
  },
} as const;

export type HandlerTemplateName = keyof typeof handlerTemplateDefinitions;


export async function writeHandlerTemplateFile(name: HandlerTemplateName, output: string, force: boolean): Promise<void> {
  const definition = handlerTemplateDefinitions[name];
  await writeFileGuarded(output, definition.content, force);
  if (name === "command" || output.endsWith(".mjs") || output.endsWith(".js")) {
    await fs.chmod(path.resolve(output), 0o755).catch(() => undefined);
  }
}


export function formatHandlerTemplateList(): string {
  return [
    "Synapsor app-owned writeback handler templates",
    "",
    ...Object.entries(handlerTemplateDefinitions).map(([name, definition]) => `- ${name}: ${definition.description}`),
    "",
    handlerSecurityWarning,
    "",
    "Examples:",
    `  ${cliCommandName()} handler template node-fastify --output ./synapsor-writeback-handler.mjs`,
    `  ${cliCommandName()} handler template python-fastapi --output ./synapsor_writeback_handler.py`,
    `  ${cliCommandName()} handler template command --output ./synapsor-command-handler.mjs`,
    "",
  ].join("\n");
}


export function resolveHandlerTemplateName(value: string): HandlerTemplateName {
  const normalized = value.trim().toLowerCase();
  for (const [name, definition] of Object.entries(handlerTemplateDefinitions) as Array<[HandlerTemplateName, typeof handlerTemplateDefinitions[HandlerTemplateName]]>) {
    if (normalized === name || (definition.aliases as readonly string[]).includes(normalized)) return name;
  }
  throw new Error(`unknown handler template: ${value}. Use ${cliCommandName()} handler template --list`);
}
