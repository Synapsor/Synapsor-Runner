import type { RuntimeSupervisedWorkerPolicy } from "@synapsor-runner/mcp-server";
import type { WorkerQueueItem } from "@synapsor-runner/proposal-store";

export function workerCancellationRequiredRole(input: {
  queue: WorkerQueueItem;
  exactCurrentPolicy: RuntimeSupervisedWorkerPolicy | undefined;
  production: boolean;
}): string | undefined {
  if (input.queue.cancellation_control_role !== undefined) {
    return input.queue.cancellation_control_role ?? undefined;
  }
  if (input.exactCurrentPolicy !== undefined) return input.exactCurrentPolicy.control_role;
  if (input.production && input.queue.execution_mode === "supervised_worker" && input.queue.contract_digest !== undefined) {
    throw new Error(
      "WORKER_CANCEL_PRIOR_AUTHORITY_UNAVAILABLE: this legacy queued request has a retired worker digest without a cancellation-role snapshot. Re-run worker cancel with the original reviewed worker --config that still contains this exact digest and its signed operator identity; if that historical configuration is unavailable, production cancellation is refused.",
    );
  }
  return undefined;
}
