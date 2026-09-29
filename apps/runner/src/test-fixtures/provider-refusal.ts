import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { secureAskJsonRequest, type ProviderHttpInput } from "../model-ask.js";

/** A complete, local native HTTP refusal; no fabricated transport observations. */
export async function localProviderRefusal(request: ProviderHttpInput, status = 401) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "DERIVED credential=do-not-display" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    return await secureAskJsonRequest({ ...request, headers: {}, scope: "custom_loopback",
      endpoint: new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
