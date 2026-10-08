import process from "node:process";
import { describe, expect, it } from "vitest";
import { fetchStdioMcpToolsCommand, formatMcpLaunchFailure } from "./mcp-audit.js";

describe("stdio launch diagnostics", () => {
  it.each([
    { error: new Error("ETARGET No matching version found timed out POLICY_EXECUTION_BINDING_CHANGED"), expected: "MCP_LAUNCH_CHECK_FAILED:" },
    { error: Object.assign(new Error("opaque 漢字"), { code: "ETARGET" }), expected: "ETARGET:" },
    { error: Object.assign(new Error("opaque 漢字"), { code: "POLICY_EXECUTION_BINDING_CHANGED" }), expected: "POLICY_EXECUTION_BINDING_CHANGED:" },
    { error: Object.assign(new Error("opaque 漢字"), { code: -32001 }), expected: "MCP_LAUNCH_TIMEOUT:" },
    { error: Object.assign(new Error("opaque 漢字"), { code: "MCP_LAUNCH_TIMEOUT" }), expected: "MCP_LAUNCH_TIMEOUT:" },
  ])("B64 NEW9 I03574 uses exact launcher codes, never diagnostic prose ($expected)", ({ error, expected }) => {
    expect(formatMcpLaunchFailure(error)).toContain(expected);
    expect(formatMcpLaunchFailure(error)).not.toContain(error.message);
  });

  it("B64 NEW9 I03574 actual failed child stderr cannot manufacture package or binding causes", async () => {
    const script = "process.stdin.once('data',()=>{process.stderr.write('ETARGET No matching version found POLICY_EXECUTION_BINDING_CHANGED',()=>process.exit(1));});";
    const error = await fetchStdioMcpToolsCommand(process.execPath, ["-e", script], 5000).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("MCP_LAUNCH_CHECK_FAILED:");
  });

  it("B64 NEW9 I03574 actual handshake timeout retains its structured local/SDK cause", async () => {
    const error = await fetchStdioMcpToolsCommand(process.execPath, ["-e", "process.stdin.resume()"], 80).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "MCP_LAUNCH_TIMEOUT" });
    expect((error as Error).message).toContain("MCP_LAUNCH_TIMEOUT:");
  });
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
    const script = `process.stdin.once('data', () => { process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(1)); });`;
    const error = await fetchStdioMcpToolsCommand(process.execPath, ["-e", script], 5000).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect((error as Error).message.length).toBeLessThanOrEqual(200);
    expect((error as Error).message).not.toMatch(/private-|postgres:\/\/|api_key|launcher warning|unrecognized-launch-failure/);
  });

  it("completes initialization before listing tools, never calls tools, and closes the server", async () => {
    const response = { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "app.describe_data", inputSchema: { type: "object" } }] } };
    const script = `
      let input = '';
      let stage = 0;
      const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result}) + '\\n');
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        input += chunk;
        while (input.includes('\\n')) {
          const newline = input.indexOf('\\n');
          const request = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1);
          if (stage === 0 && request.method === 'initialize') {
            stage = 1;
            setTimeout(() => { stage = 2; send(request.id, {protocolVersion:request.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'strict-probe', version:'1'}}); }, 30);
          } else if (stage === 2 && request.method === 'notifications/initialized') stage = 3;
          else if (stage === 3 && request.method === 'tools/list') {
            stage = 4; send(request.id, ${JSON.stringify(response.result)});
          } else process.exit(1);
        }
      });
      process.stdin.on('end', () => process.exit(stage === 4 ? 0 : 1));`;
    await expect(fetchStdioMcpToolsCommand(process.execPath, ["-e", script], 5000)).resolves.toEqual(response);
  });

  it("times out an unresponsive server and keeps the diagnostic actionable", async () => {
    await expect(fetchStdioMcpToolsCommand(process.execPath, ["-e", "process.stdin.resume()"], 80))
      .rejects.toThrow("MCP_LAUNCH_TIMEOUT:");
  });
});
