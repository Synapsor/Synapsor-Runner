export async function withPreservedCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let operationFailed = false;
  let operationError: unknown;
  let result: T | undefined;

  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  try {
    await cleanup();
  } catch (cleanupError) {
    if (!operationFailed) throw cleanupError;
  }

  if (operationFailed) throw operationError;
  return result as T;
}

export async function runAllCleanups(
  cleanups: Array<() => void | Promise<void>>,
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(
    cleanups.map(async (cleanup) => { await cleanup(); }),
  );
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, message);
}
