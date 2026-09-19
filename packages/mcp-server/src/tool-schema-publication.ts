import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";

export function mcpToolInputJsonSchema(schema: z.ZodTypeAny): Tool["inputSchema"] {
  return { ...zodToJsonSchema(schema, { $refStrategy: "none" }), type: "object" } as Tool["inputSchema"];
}

/** SDK 1.29 publishes only top-level Zod objects, although it validates unions.
 * Decorate its tools/list handler at registration time, preserving the SDK's
 * live registry, metadata, enablement and output schemas. No tools are added.
 * Install before the first registerTool; restore the public registration method
 * immediately after capturing the SDK handler. Calls still use normal validation.
 */
export function publishToolInputContracts(
  server: McpServer,
  inputSchema: (name: string) => Tool["inputSchema"] | undefined,
): void {
  const protocol = server.server;
  const original = protocol.setRequestHandler;
  const register = original.bind(protocol);
  protocol.setRequestHandler = (schema, handler) => {
    if ((schema as unknown) !== ListToolsRequestSchema) return register(schema, handler);
    protocol.setRequestHandler = original;
    return register(schema, async (request, extra) => {
      const result = await handler(request, extra);
      if (!("tools" in result) || !Array.isArray(result.tools)) return result;
      return { ...result, tools: result.tools.map((tool: Tool) => {
        const replacement = inputSchema(tool.name);
        return replacement ? { ...tool, inputSchema: replacement } : tool;
      }) };
    });
  };
}
