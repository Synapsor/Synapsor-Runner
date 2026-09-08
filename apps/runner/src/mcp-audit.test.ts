import process from "node:process";
import { describe, expect, it } from "vitest";
import { fetchStdioMcpToolsCommand, formatMcpLaunchFailure } from "./mcp-audit.js";

describe("stdio launch diagnostics", () => {
  it.each([
    { error: Object.assign(new Error("private-path"), { code: "ENOENT" }), expected: "ENOENT:" },
    { error: Object.assign(new Error("private-path"), { code: "EACCES" }), expected: "EACCES:" },
    { error: new Error("tools/list timed out after 10000ms private-details"), expected: "MCP_LAUNCH_TIMEOUT:" },
    { error: { message: "private-details" }, expected: "MCP_LAUNCH_CHECK_FAILED:" },
  ])("keeps launch exceptions bounded without exposing arbitrary details (%j)", ({ error, expected }) => {
    expect(formatMcpLaunchFailure(error)).toContain(expected);
    expect(formatMcpLaunchFailure(error)).not.toContain("private-");
    expect(formatMcpLaunchFailure(error).length).toBeLessThanOrEqual(200);
  });

  it.each([
    { diagnostic: "npm error code ETARGET\nnpm error notarget No matching version found for @synapsor/runner@1.8.0.", expected: "ETARGET: The configured package version is unavailable" },
    { diagnostic: "POLICY_EXECUTION_BINDING_CHANGED: private-runtime-settings", expected: "POLICY_EXECUTION_BINDING_CHANGED" },
    { diagnostic: "unrecognized-launch-failure", expected: "MCP_LAUNCH_CHECK_FAILED" },
  ])("categorizes a failed child without exposing stderr (%j)", async ({ diagnostic, expected }) => {
    const stderr = `${"launcher warning ".repeat(50)}postgres://user:private-password@host/db\napi_key=private-api-key\n${diagnostic}`;
    const script = `process.stdin.resume(); process.stdin.on('end', () => { process.stderr.write(${JSON.stringify(stderr)}); process.exitCode = 1; });`;
    const error = await fetchStdioMcpToolsCommand(process.execPath, ["-e", script], 5000).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message.length).toBeLessThanOrEqual(200);
    expect((error as Error).message).not.toMatch(/private-|postgres:\/\/|api_key|launcher warning|unrecognized-launch-failure/);
  });

  it("only sends initialize and tools/list and preserves a successful response", async () => {
    const response = { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "app.describe_data" }] } };
    const script = `
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        const requests = input.trim().split('\\n').map(line => JSON.parse(line));
        if (JSON.stringify(requests.map(request => request.method)) !== '["initialize","tools/list"]') {
          process.exitCode = 1;
          return;
        }
        process.stdout.write(${JSON.stringify(JSON.stringify(response) + "\n")});
      });`;
    await expect(fetchStdioMcpToolsCommand(process.execPath, ["-e", script], 5000)).resolves.toEqual(response);
  });
});
