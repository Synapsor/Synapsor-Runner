import { Agent, MCPServerStreamableHttp, run } from "@openai/agents";

// Start Runner with --alias-mode openai so model-visible tool names are valid OpenAI function names.
const token = process.env.SYNAPSOR_RUNNER_HTTP_TOKEN;
if (!token) throw new Error("set SYNAPSOR_RUNNER_HTTP_TOKEN in the launching environment");

const synapsor = new MCPServerStreamableHttp({
  name: "Synapsor Runner",
  url: "http://127.0.0.1:8766/mcp",
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

await synapsor.connect();
try {
  const agent = new Agent({
    name: "Support operations agent",
    instructions: "Use only the listed Synapsor business tools. Inspect evidence before proposing a plan credit. Never request approval or apply authority; stop for human review outside the agent.",
    mcpServers: [synapsor],
  });
  const result = await run(agent, "Inspect customer CUS-3001 and propose a $25 plan credit for SLA outage ticket SUP-481.");
  console.log(result.finalOutput);
} finally {
  await synapsor.close();
}
