import { describe, expect, it } from "vitest";
import { hydrateManagedSecrets } from "./secrets-manager.js";

describe("managed secrets hydration", () => {
  it("hydrates target env vars from an env-json secret map without overwriting existing values", async () => {
    const env: NodeJS.ProcessEnv = {
      SYNAPSOR_SECRET_MAP: JSON.stringify({
        SYNAPSOR_DATABASE_WRITE_URL: "runner/db#write_url",
        SYNAPSOR_RUNNER_HTTP_TOKEN: "runner/http#token",
        SYNAPSOR_ALREADY_SET: "runner/http#token",
      }),
      SYNAPSOR_SECRET_VALUES: JSON.stringify({
        "runner/db": { write_url: "postgresql://writer:secret@127.0.0.1/app" },
        "runner/http": { token: "runner-token" },
      }),
      SYNAPSOR_ALREADY_SET: "keep-me",
    };

    const result = await hydrateManagedSecrets({ provider: "env-json", env });

    expect(result).toEqual({
      provider: "env-json",
      loaded: ["SYNAPSOR_DATABASE_WRITE_URL", "SYNAPSOR_RUNNER_HTTP_TOKEN"],
      skipped: ["SYNAPSOR_ALREADY_SET"],
    });
    expect(env.SYNAPSOR_DATABASE_WRITE_URL).toBe("postgresql://writer:secret@127.0.0.1/app");
    expect(env.SYNAPSOR_RUNNER_HTTP_TOKEN).toBe("runner-token");
    expect(env.SYNAPSOR_ALREADY_SET).toBe("keep-me");
  });

  it("hydrates target env vars from AWS Secrets Manager through the AWS CLI provider", async () => {
    const env: NodeJS.ProcessEnv = {
      AWS_REGION: "us-west-2",
      SYNAPSOR_SECRET_MAP: JSON.stringify({
        SYNAPSOR_SESSION_JWT_SECRET: "runner/session#jwt_secret",
      }),
    };
    const calls: Array<{ command: string; args: string[] }> = [];
    const execFile = async (command: string, args: readonly string[]) => {
      calls.push({ command, args: [...args] });
      return { stdout: JSON.stringify({ jwt_secret: "a-production-length-session-secret-32-bytes" }), stderr: "" };
    };

    const result = await hydrateManagedSecrets({ provider: "aws-secretsmanager-cli", env, execFile });

    expect(result?.loaded).toEqual(["SYNAPSOR_SESSION_JWT_SECRET"]);
    expect(env.SYNAPSOR_SESSION_JWT_SECRET).toBe("a-production-length-session-secret-32-bytes");
    expect(calls).toEqual([{
      command: "aws",
      args: [
        "secretsmanager",
        "get-secret-value",
        "--secret-id",
        "runner/session",
        "--query",
        "SecretString",
        "--output",
        "text",
        "--region",
        "us-west-2",
      ],
    }]);
  });
});
