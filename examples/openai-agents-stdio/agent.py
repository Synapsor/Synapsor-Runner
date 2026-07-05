import asyncio
import os
import sys

try:
    from agents import Agent, Runner
    from agents.mcp import MCPServerStdio
except ImportError as exc:
    raise SystemExit(
        "This example requires the OpenAI Agents SDK with MCP stdio support. "
        "Install with: pip install -r requirements.txt"
    ) from exc


async def main() -> None:
    config_path = os.environ.get("SYNAPSOR_CONFIG", "./synapsor.runner.json")
    store_path = os.environ.get("SYNAPSOR_STORE", "./.synapsor/local.db")
    invoice_id = os.environ.get("SYNAPSOR_INVOICE_ID", "INV-3001")

    required = ["OPENAI_API_KEY", "DATABASE_URL", "SYNAPSOR_TENANT_ID", "SYNAPSOR_PRINCIPAL"]
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise SystemExit(f"Missing required environment variables: {', '.join(missing)}")

    params = {
        "command": "npx",
        "args": [
            "-y",
            "-p",
            "@synapsor/runner",
            "synapsor-runner",
            "mcp",
            "serve",
            "--config",
            config_path,
            "--store",
            store_path,
            "--alias-mode",
            "openai",
        ],
        "env": {
            **os.environ,
            "DATABASE_URL": os.environ["DATABASE_URL"],
            "SYNAPSOR_TENANT_ID": os.environ["SYNAPSOR_TENANT_ID"],
            "SYNAPSOR_PRINCIPAL": os.environ["SYNAPSOR_PRINCIPAL"],
        },
    }

    async with MCPServerStdio(params=params) as mcp_server:
        agent = Agent(
            name="Synapsor stdio MCP demo agent",
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
