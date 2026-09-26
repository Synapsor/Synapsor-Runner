import process from "node:process";
import { type Writable } from "node:stream";

type OutputFailure = { stream: "stdout" | "stderr"; error: Error };

/** Record finite-command write errors without interrupting the command's work. */
export function runCliEntrypoint(run: () => Promise<number>): void {
  let finishing = false;
  let outputFailed = false;
  const finish = (code: number) => {
    if (finishing) return;
    finishing = true;
    completeCliOutput(code).then((result) => {
      process.exit(result === 0 && outputFailed ? 1 : result);
    }).catch(() => process.exit(1));
  };
  const onOutputError = () => {
    outputFailed = true;
  };
  process.stdout.on("error", onOutputError);
  process.stderr.on("error", onOutputError);
  // Completion begins only after the command settles; output cannot cancel it.
  run().then(finish).catch(() => finish(1));
}

/** Flush only after the command returns; servers retain their existing lifetime. */
export async function completeCliOutput(
  code: number,
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr,
): Promise<number> {
  const results = await Promise.all([
    flushOutput(stdout),
    flushOutput(stderr),
  ]);
  const failures = results.flatMap((error, index): OutputFailure[] => error
    ? [{ stream: index === 0 ? "stdout" : "stderr", error }]
    : []);
  if (!failures.length) return code;

  if (!results[1]) {
    const failedStreams = failures.map(({ stream, error }) => {
      const errorCode = "code" in error && typeof error.code === "string"
        && /^[A-Z0-9_]{1,40}$/u.test(error.code) ? ` (${error.code})` : "";
      return `${stream}${errorCode}`;
    }).join(", ");
    try {
      stderr.write(`CLI output write failed on ${failedStreams}; output may be incomplete.\n`);
      await flushOutput(stderr);
    } catch {
      // The diagnostic stream can itself close between its barrier and this write.
    }
  }
  return code === 0 ? 1 : code;
}

function flushOutput(stream: Writable): Promise<Error | undefined> {
  if (stream.errored) return Promise.resolve(stream.errored);
  if (stream.destroyed) return Promise.resolve(new Error("Output stream closed"));
  if (stream.writableFinished) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      resolve(error ?? undefined);
    };
    const onError = (error: Error) => finish(error);
    stream.once("error", onError);
    try {
      // A callback on a final empty write follows every previously queued write.
      // It does not end the process-owned stream or change its buffering mode.
      stream.write("", (error?: Error | null) => {
        if (!error) stream.off("error", onError);
        finish(error);
      });
    } catch (error) {
      stream.off("error", onError);
      finish(error instanceof Error ? error : new Error("Output write failed"));
    }
  });
}
