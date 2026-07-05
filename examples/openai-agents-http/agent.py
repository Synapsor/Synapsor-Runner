import asyncio
import os
import sys

try:
    from agents import Agent, Runner
    from agents.mcp import MCPServerStreamableHttp
except ImportError as exc:
    raise SystemExit(
        "This example requires the OpenAI Agents SDK with Streamable HTTP MCP support. "
        "Install with: pip install -r requirements.txt"
    ) from exc


async def main() -> None:
    required = ["OPENAI_API_KEY", "SYNAPSOR_RUNNER_HTTP_URL", "SYNAPSOR_RUNNER_HTTP_TOKEN"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"Missing required environment variables: {', '.join(missing)}")

    invoice_id = os.environ.get("SYNAPSOR_INVOICE_ID", "INV-3001")
    mcp_url = os.environ["SYNAPSOR_RUNNER_HTTP_URL"]
    token = os.environ["SYNAPSOR_RUNNER_HTTP_TOKEN"]

    async with MCPServerStreamableHttp(
        params={
            "url": mcp_url,
            "headers": {"Authorization": f"Bearer {token}"},
            "timeout": 15,
        }
    ) as mcp_server:
        agent = Agent(
            name="Synapsor Streamable HTTP MCP demo agent",
            instructions=(
                "Use Synapsor MCP tools to inspect scoped database data. "
                "Do not claim that you can run SQL, approve proposals, or commit writes."
            ),
            mcp_servers=[mcp_server],
        )
        result = await Runner.run(
            agent,
            (
                f"Inspect invoice {invoice_id} using Synapsor. "
                "Explain what you saw and whether you have write authority."
            ),
        )
        print(result.final_output)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(130)
