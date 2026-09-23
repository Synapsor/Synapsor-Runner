import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { outgoingToolSchemaIssue } from "@synapsor-runner/protocol";

export function mcpToolInputJsonSchema(schema: z.ZodTypeAny): Tool["inputSchema"] {
  return { ...zodToJsonSchema(schema, { $refStrategy: "none" }), type: "object" } as Tool["inputSchema"];
}

/** Portable declaration of the existing flat discovery operations, NOT their
 * canonical validator. Root unions are rejected by some native MCP consumers.
 * Project their closed object branches into one closed object, preserving each
 * field's alternatives and only universally required keys. Cross-field branch
 * exclusions remain host enforced. Nested value/plan grammar is left intact.
 * Refuse an unsupported root instead of silently publishing an untyped schema.
 */
export function portableDiscoveryInputJsonSchema(schema: z.ZodTypeAny): Tool["inputSchema"] {
  const canonical = mcpToolInputJsonSchema(schema);
  type ObjectSchema = Record<string, unknown> & {
    properties: Record<string, unknown>; required?: string[];
  };
  const branches: ObjectSchema[] = [];
  const collect = (node: Record<string, unknown>): void => {
    const allowed = ["type", "properties", "required", "additionalProperties", "description", "$schema", "anyOf"];
    if (Object.keys(node).some(key => !allowed.includes(key))) throw new Error("Unsupported discovery schema root");
    if (Array.isArray(node.anyOf)) {
      for (const option of node.anyOf) collect(option as Record<string, unknown>);
    } else {
      if (node.type !== "object" || node.additionalProperties !== false || !node.properties) {
        throw new Error("Discovery operations must be closed typed objects");
      }
      branches.push(node as ObjectSchema);
    }
  };
  collect(canonical);
  if (!branches.length) throw new Error("Discovery operations are unavailable");
  const fields = new Map<string, unknown[]>();
  for (const branch of branches) for (const [key, value] of Object.entries(branch.properties)) {
    const variants = fields.get(key) ?? [];
    if (!variants.some(existing => JSON.stringify(existing) === JSON.stringify(value))) variants.push(value);
    fields.set(key, variants);
  }
  const required = (branches[0]!.required ?? []).filter(key => branches.every(branch => branch.required?.includes(key)));
  return {
    type: "object",
    properties: Object.fromEntries([...fields].map(([key, variants]) => [key, variants.length === 1 ? variants[0] : { anyOf: variants }])),
    additionalProperties: false,
    ...(required.length ? { required } : {}),
    ...(canonical.description ? { description: canonical.description } : {}),
  } as Tool["inputSchema"];
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
        const emitted = replacement ? { ...tool, inputSchema: replacement } : tool;
        const issue = outgoingToolSchemaIssue(emitted.inputSchema, "mcp_portable", 131_072);
        if (issue) throw new Error(`MCP_TOOL_DECLARATION_INVALID: ${tool.name} tools/list mcp_portable ${issue.path} ${issue.code}; no incomplete tools/list was published.`);
        return emitted;
      }) };
    });
  };
}
