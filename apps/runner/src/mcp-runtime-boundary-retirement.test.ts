import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as runtimeApi from "@synapsor-runner/mcp-server";
import { inspectMcpToolBoundary } from "./mcp-runtime.js";
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
it.each(["example.approve_draft", "example.commitment", "example.execute_sql_training", "example.policy_recommendation_history"])("checks typed read authority independently of descriptive name %s", async name => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "b64-tool-authority-")); roots.push(root);
  const config = JSON.parse(await fs.readFile("examples/mcp-postgres-support/synapsor.runner.json", "utf8"));
  config.capabilities = [{ ...config.capabilities[0], name }];
  const configPath = path.join(root, "runner.json"); await fs.writeFile(configPath, JSON.stringify(config));
  const result = await inspectMcpToolBoundary(["--config", configPath, "--store", ":memory:"]);
  expect(result.names).toContain(name);
  expect(result.checks.filter(check => ["execute_sql absent", "approval tools absent", "commit tools absent", "policy recommendation tools absent"].includes(check.name))).toEqual(expect.arrayContaining([expect.objectContaining({ ok: true })]));
  expect(result.checks.filter(check => ["execute_sql absent", "approval tools absent", "commit tools absent", "policy recommendation tools absent"].includes(check.name)).every(check => check.ok)).toBe(true);
});

it.each(["unbound", "wrong_kind", "unsafe_annotation"])("refuses unproven runtime interface %s even with a neutral name", async variant => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "b64-tool-authority-negative-")); roots.push(root);
  const config = JSON.parse(await fs.readFile("examples/mcp-postgres-support/synapsor.runner.json", "utf8"));
  config.capabilities = [{ ...config.capabilities[0], name: "example.inspect" }];
  const configPath = path.join(root, "runner.json"); await fs.writeFile(configPath, JSON.stringify(config));
  const original = runtimeApi.createMcpRuntime;
  vi.spyOn(runtimeApi, "createMcpRuntime").mockImplementation((...args) => {
    const runtime = original(...args), list = runtime.listTools;
    runtime.listTools = () => list().map(tool => ({ ...tool,
      ...(variant === "unbound" ? { name: "example.other" } : {}),
      ...(variant === "wrong_kind" ? { kind: "proposal" as const } : {}),
      ...(variant === "unsafe_annotation" ? { annotations: { ...tool.annotations, raw_sql_exposed: true } } : {}),
    }));
    return runtime;
  });
  const result = await inspectMcpToolBoundary(["--config", configPath, "--store", ":memory:"]);
  expect(result.checks.find(check => check.name === "execute_sql absent")?.ok).toBe(false);
});
