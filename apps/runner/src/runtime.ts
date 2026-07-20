import {
  serveStdio,
  startHttpMcpServer,
  startStreamableHttpMcpServer,
  type TenantCredentialResolver as InternalTenantCredentialResolver,
} from "@synapsor-runner/mcp-server";

export type TenantCredentialResolver = {
  id: string;
  resolve(input: {
    source_name: string;
    engine: "postgres" | "mysql";
    access: "read" | "write";
    tenant_id: string;
    principal: string;
  }): Promise<{
    connection_url: string;
    credential_id: string;
    expires_at?: string;
  }>;
};

export type RunnerStdioOptions = {
  configPath?: string;
  storePath?: string;
  credentialResolver: TenantCredentialResolver;
};

export type RunnerHttpOptions = RunnerStdioOptions & {
  host?: string;
  port?: number;
  authTokenEnv?: string;
  devNoAuth?: boolean;
  corsOrigin?: string;
  env?: Record<string, string | undefined>;
};

export type RunnerHttpServerHandle = {
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
};

/**
 * Embed Runner's stdio MCP transport with an application-owned tenant
 * credential broker. The CLI intentionally does not load executable resolver
 * modules.
 */
export async function serveRunnerStdio(options: RunnerStdioOptions): Promise<void> {
  await serveStdio({
    configPath: options.configPath,
    storePath: options.storePath,
    credentialResolver: options.credentialResolver as InternalTenantCredentialResolver,
  });
}

/**
 * Embed the spec-compatible Streamable HTTP transport with an
 * application-owned tenant credential broker.
 */
export async function startRunnerStreamableHttp(
  options: RunnerHttpOptions,
): Promise<RunnerHttpServerHandle> {
  return startStreamableHttpMcpServer({
    ...options,
    credentialResolver: options.credentialResolver as InternalTenantCredentialResolver,
  });
}

/**
 * Embed the legacy JSON-RPC HTTP bridge. Prefer Streamable HTTP for new MCP
 * clients.
 */
export async function startRunnerJsonRpcHttp(
  options: RunnerHttpOptions,
): Promise<RunnerHttpServerHandle> {
  return startHttpMcpServer({
    ...options,
    credentialResolver: options.credentialResolver as InternalTenantCredentialResolver,
  });
}
