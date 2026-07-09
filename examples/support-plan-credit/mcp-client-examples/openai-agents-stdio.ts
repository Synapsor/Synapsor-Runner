import { Agent, MCPServerStdio, run } from "@openai/agents";

const synapsor = new MCPServerStdio({
  name: "Synapsor Runner",
  fullCommand: "npx -y -p @synapsor/runner synapsor-runner mcp serve --config examples/support-plan-credit/synapsor.runner.json --store ./tmp/support-plan-credit/local.db",
});

await synapsor.connect();
try {
  const agent = new Agent({
    name: "Support operations agent",
    instructions: "Use only Synapsor business tools. Inspect evidence before proposing a plan credit.",
    mcpServers: [synapsor],
  });
  const result = await run(agent, "Inspect customer CUS-3001 and propose a $25 plan credit for SLA outage ticket SUP-481.");
  console.log(result.finalOutput);
} finally {
  await synapsor.close();
}
