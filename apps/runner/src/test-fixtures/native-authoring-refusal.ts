import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { secureAskJsonRequest, type ProviderHttpInput } from "../model-ask.js";

/** Synthetic complete HTTP refusal, read by the real adapter. It does not mint
 * transport provenance or turn an injected exception into a provider response. */
export async function nativeAuthoringRefusal(input: ProviderHttpInput, status = 401) {
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the exact local request. */ }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "Synthetic complete provider refusal." } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    return await secureAskJsonRequest({ ...input, headers: {}, scope: "custom_loopback",
      endpoint: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/responses`) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
