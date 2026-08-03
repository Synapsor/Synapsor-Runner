# Host-Neutral TypeScript MCP Client

This example shows the narrow integration boundary between an
application-owned model loop and Synapsor Runner. It uses the official MCP
TypeScript client SDK to:

1. connect over local stdio or authenticated Streamable HTTP;
2. discover the reviewed tools and their input/output schemas;
3. read safe, digest-pinned analytical catalog metadata when available;
4. give only those schemas to the application's model layer;
5. forward one typed tool decision;
6. consume authoritative `structuredContent` plus serialized compatibility
   content.

It contains no SQL, database credential, tenant/principal argument, approval,
apply, chart, dashboard, or duplicated policy logic.

The package includes readable `client.ts` source and a generated `client.mjs`
that Node 22 runs directly. Consumers do not need `tsx`, a global compiler, or
a build step.

## Local Stdio

From a project where `@synapsor/runner` is installed:

```bash
node node_modules/@synapsor/runner/examples/host-neutral-typescript-client/client.mjs \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db
```

The first call only discovers the reviewed surface. To forward a deterministic
typed decision from the example's application-owned model layer:

```bash
node node_modules/@synapsor/runner/examples/host-neutral-typescript-client/client.mjs \
  --config ./synapsor.runner.json \
  --store ./.synapsor/local.db \
  --call analytics.weekly_churn \
  --arguments '{"region":"north"}'
```

Replace only `applicationOwnedModelLayer()` with your OpenAI, Anthropic, local
model, or other orchestration code. Runner remains the authority and validates
every returned tool name and typed argument.

## Streamable HTTP

Put the Runner-issued bearer credential in an environment variable. The
example reads that variable locally and never prints it:

```bash
export SYNAPSOR_MCP_TOKEN='<operator-provisioned-token>'

node node_modules/@synapsor/runner/examples/host-neutral-typescript-client/client.mjs \
  --url https://runner.example.com/mcp \
  --bearer-token-env SYNAPSOR_MCP_TOKEN
```

Plain HTTP is refused except on loopback. Redirects are refused so a bearer
credential cannot be forwarded to another origin.

Approval, apply, activation, and production write credentials remain outside
this model-facing client in every transport.
