import { Agent, MCPServerStreamableHttp, run } from "@openai/agents";

const synapsor = new MCPServerStreamableHttp({
  name: "Synapsor Runner",
  url: "http://127.0.0.1:8766/mcp",
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
