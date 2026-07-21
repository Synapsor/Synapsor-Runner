import { MultiServerMCPClient } from "@langchain/mcp-adapters";

const client = new MultiServerMCPClient({
  synapsor: {
    transport: "stdio",
    command: "npx",
    args: [
      "-y", "-p", "@synapsor/runner", "synapsor-runner", "mcp", "serve",
      "--config", "./examples/support-plan-credit/synapsor.runner.json",
      "--store", "./tmp/support-plan-credit/local.db",
    ],
  },
});

const tools = await client.getTools();
const names = tools.map((tool) => tool.name);
const forbidden = names.filter((name) => /sql|approve|apply|commit|activate|revert/i.test(name));
if (forbidden.length) throw new Error(`unsafe model-facing tools: ${forbidden.join(", ")}`);

const proposal = tools.find((tool) => tool.name === "support.propose_plan_credit");
if (!proposal) throw new Error(`proposal tool missing; available: ${names.join(", ")}`);

const result = await proposal.invoke({
  customer_id: "CUS-3001",
  credit_cents: 2500,
  reason: "SLA outage ticket SUP-481",
});
console.log(result);
console.error("Proposal only. Review and apply outside the model-facing LangChain/LangGraph agent.");
