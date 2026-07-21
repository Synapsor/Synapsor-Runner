import os

from google.adk.agents import LlmAgent
from google.adk.tools.mcp_tool import McpToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StdioConnectionParams
from mcp import StdioServerParameters


root_agent = LlmAgent(
    model=os.environ["GOOGLE_ADK_MODEL"],
    name="synapsor_support_agent",
    instruction=(
        "List your Synapsor tools. Call support.propose_plan_credit with "
        "customer_id CUS-3001, credit_cents 2500, and reason "
        "'SLA outage ticket SUP-481'. Confirm source_database_changed is false "
        "and stop for human review outside the model-facing agent."
    ),
    tools=[
        McpToolset(
            connection_params=StdioConnectionParams(
                server_params=StdioServerParameters(
                    command="npx",
                    args=[
                        "-y", "-p", "@synapsor/runner", "synapsor-runner",
                        "mcp", "serve", "--config",
                        "./examples/support-plan-credit/synapsor.runner.json",
                        "--store", "./tmp/support-plan-credit/local.db",
                    ],
                )
            ),
            tool_filter=[
                "support.inspect_customer",
                "support.propose_plan_credit",
            ],
        )
    ],
)

# Run root_agent with your normal ADK runner. Approval, apply, commit,
# activation, and revert are intentionally not MCP tools.
