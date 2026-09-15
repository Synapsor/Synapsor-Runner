import { AsyncLocalStorage } from "node:async_hooks";
import { resolveAskRequestTimeoutSeconds } from "./model-ask.js";

const timeout = new AsyncLocalStorage<number>();

/** Transport configuration for one operator invocation, never model/policy state.
 * Async scope survives replacement of a drafting session/provider, while separate
 * invocations and post-activation Ask retain their own configuration.
 */
export function withAuthoringRequestTimeout<T>(seconds: number | undefined, run: () => T): T {
  return timeout.run(resolveAskRequestTimeoutSeconds(seconds ?? 120, "official_remote"), run);
}

export function authoringRequestTimeoutSeconds(): number {
  return timeout.getStore() ?? 120;
}
