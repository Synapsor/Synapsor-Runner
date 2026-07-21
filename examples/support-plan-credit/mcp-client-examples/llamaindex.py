import asyncio

from llama_index.tools.mcp import BasicMCPClient


async def main() -> None:
    client = BasicMCPClient(
        "npx",
        args=[
            "-y", "-p", "@synapsor/runner", "synapsor-runner", "mcp", "serve",
            "--config", "./examples/support-plan-credit/synapsor.runner.json",
            "--store", "./tmp/support-plan-credit/local.db",
        ],
    )
    tools = await client.list_tools()
    names = [tool.name for tool in tools.tools]
    forbidden = [name for name in names if any(part in name.lower() for part in (
        "sql", "approve", "apply", "commit", "activate", "revert"
    ))]
    if forbidden:
        raise RuntimeError(f"unsafe model-facing tools: {forbidden}")

    result = await client.call_tool(
        "support.propose_plan_credit",
        {
            "customer_id": "CUS-3001",
            "credit_cents": 2500,
            "reason": "SLA outage ticket SUP-481",
        },
    )
    print(result)
    print("Proposal only. Review and apply outside the model-facing LlamaIndex agent.")


if __name__ == "__main__":
    asyncio.run(main())
