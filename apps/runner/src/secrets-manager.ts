import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
type SecretExecFile = (command: string, args: string[], options: { env: NodeJS.ProcessEnv; maxBuffer: number }) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export type ManagedSecretsProvider = "aws-secretsmanager-cli" | "env-json";

export type ManagedSecretsOptions = {
  provider?: ManagedSecretsProvider;
  mapEnv?: string;
  valuesEnv?: string;
  regionEnv?: string;
  overwrite?: boolean;
  env?: NodeJS.ProcessEnv;
  awsCommand?: string;
  execFile?: SecretExecFile;
};

export type ManagedSecretLoadResult = {
  provider: ManagedSecretsProvider;
  loaded: string[];
  skipped: string[];
};

export async function hydrateManagedSecrets(options: ManagedSecretsOptions = {}): Promise<ManagedSecretLoadResult | undefined> {
  const provider = options.provider;
  if (!provider) return undefined;
  const env = options.env ?? process.env;
  const mapEnv = options.mapEnv ?? "SYNAPSOR_SECRET_MAP";
  const map = parseSecretMap(env[mapEnv], mapEnv);
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const [targetEnv, reference] of Object.entries(map)) {
    assertEnvName(targetEnv, `secret map target ${targetEnv}`);
    const targetExists = typeof env[targetEnv] === "string" && env[targetEnv]!.trim().length > 0;
    if (targetExists && options.overwrite !== true) {
      skipped.push(targetEnv);
      continue;
    }
    const value = provider === "env-json"
      ? secretFromEnvJson(reference, env, options.valuesEnv ?? "SYNAPSOR_SECRET_VALUES")
      : await secretFromAwsCli(reference, { env, regionEnv: options.regionEnv ?? "AWS_REGION", awsCommand: options.awsCommand ?? "aws", execFile: options.execFile ?? execFileAsync });
    env[targetEnv] = value;
    loaded.push(targetEnv);
  }
  return { provider, loaded, skipped };
}

function parseSecretMap(value: string | undefined, envName: string): Record<string, string> {
  if (!value?.trim()) throw new Error(`${envName} must contain a JSON object mapping target env names to secret references.`);
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) throw new Error(`${envName} must be a non-empty JSON object.`);
  const map: Record<string, string> = {};
  for (const [target, reference] of Object.entries(parsed)) {
    if (typeof reference !== "string" || !reference.trim()) throw new Error(`${envName}.${target} must be a non-empty secret reference.`);
    map[target] = reference.trim();
  }
  return map;
}

function secretFromEnvJson(reference: string, env: NodeJS.ProcessEnv, valuesEnv: string): string {
  const raw = env[valuesEnv];
  if (!raw?.trim()) throw new Error(`${valuesEnv} must contain a JSON object for --secrets-provider env-json.`);
  const values = JSON.parse(raw) as unknown;
  if (!isRecord(values)) throw new Error(`${valuesEnv} must be a JSON object.`);
  const value = readReference(values, reference);
  if (typeof value !== "string" || !value.trim()) throw new Error(`secret reference ${reference} did not resolve to a non-empty string.`);
  return value.trim();
}

async function secretFromAwsCli(
  reference: string,
  options: { env: NodeJS.ProcessEnv; regionEnv: string; awsCommand: string; execFile: SecretExecFile },
): Promise<string> {
  const parsed = parseSecretReference(reference);
  const args = ["secretsmanager", "get-secret-value", "--secret-id", parsed.secretId, "--query", "SecretString", "--output", "text"];
  const region = options.env[options.regionEnv]?.trim();
  if (region) args.push("--region", region);
  const { stdout } = await options.execFile(options.awsCommand, args, { env: options.env, maxBuffer: 1024 * 1024 });
  const secretString = String(stdout).trim();
  if (!secretString) throw new Error(`AWS Secrets Manager returned an empty SecretString for ${parsed.secretId}.`);
  if (!parsed.key) return secretString;
  let decoded: unknown;
  try {
    decoded = JSON.parse(secretString);
  } catch {
    throw new Error(`secret ${parsed.secretId} must be JSON when using #${parsed.key}.`);
  }
  const value = readReference(decoded, parsed.key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`secret ${parsed.secretId}#${parsed.key} did not resolve to a non-empty string.`);
  return value.trim();
}

function parseSecretReference(reference: string): { secretId: string; key?: string } {
  const [secretId, key] = reference.split("#", 2);
  if (!secretId?.trim()) throw new Error("secret reference must include a secret id.");
  return { secretId: secretId.trim(), key: key?.trim() || undefined };
}

function readReference(value: unknown, reference: string): unknown {
  const parsed = parseSecretReference(reference);
  if (!parsed.key) {
    if (isRecord(value) && parsed.secretId in value) return value[parsed.secretId];
    return value;
  }
  const source = isRecord(value) && parsed.secretId in value ? value[parsed.secretId] : value;
  if (!isRecord(source)) return undefined;
  return parsed.key.split(".").reduce<unknown>((current, segment) => isRecord(current) ? current[segment] : undefined, source);
}

function assertEnvName(value: string, label: string): void {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) throw new Error(`${label} must be an uppercase environment variable name.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
