import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const token = process.env.SYNAPSOR_RUNNER_HTTP_TOKEN;
if (!token) throw new Error("set SYNAPSOR_RUNNER_HTTP_TOKEN in the launching environment");

const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8766/mcp"), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});
const client = new Client({ name: "synapsor-generic-http", version: "1.0.0" });

await client.connect(transport);
try {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  const forbidden = names.filter((name) => /sql|approve|apply|commit|activate|revert/i.test(name));
  if (forbidden.length) throw new Error(`unsafe model-facing tools: ${forbidden.join(", ")}`);

  const result = await client.callTool({
    name: "support.propose_plan_credit",
    arguments: {
      customer_id: "CUS-3001",
      credit_cents: 2500,
      reason: "SLA outage ticket SUP-481",
    },
  });
  console.log(JSON.stringify(result, null, 2));
  console.error("Proposal only. Review and apply outside the model-facing MCP client.");
} finally {
  await client.close();
}
