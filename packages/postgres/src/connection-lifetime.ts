import type { EventEmitter } from "node:events";

const observedClients = new WeakSet<object>();
const connectionErrors = new WeakMap<object, unknown>();

/** pg removes its idle listener on checkout. Keep one error owner for the
 * complete client lifetime so native query rejection can classify the Source
 * outcome instead of an unhandled EventEmitter error terminating the process.
 * Other listeners and the original query rejection remain intact. */
export function observePostgresClientErrors(client: Pick<EventEmitter, "on">): void {
  if (observedClients.has(client)) return;
  observedClients.add(client);
  client.on("error", (error: unknown) => {
    if (!connectionErrors.has(client)) connectionErrors.set(client, error);
  });
}

/** A failed connection must never return to the pool as a reusable client. */
export function postgresClientConnectionFailed(client: object): boolean {
  return connectionErrors.has(client);
}
