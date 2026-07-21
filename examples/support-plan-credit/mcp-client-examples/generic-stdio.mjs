import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: [
    "-y", "-p", "@synapsor/runner", "synapsor-runner", "mcp", "serve",
    "--config", "./examples/support-plan-credit/synapsor.runner.json",
    "--store", "./tmp/support-plan-credit/local.db",
  ],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "synapsor-generic-stdio", version: "1.0.0" });

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
