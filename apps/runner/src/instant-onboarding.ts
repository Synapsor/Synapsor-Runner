import fs from "node:fs/promises";
import path from "node:path";
import type { ReadStream, WriteStream } from "node:tty";
import { parseEnv } from "node:util";

const MAX_ENV_FILE_BYTES = 1024 * 1024;
const MAX_DATABASE_URL_BYTES = 16 * 1024;
const databaseEnvironmentName = /^(?:DATABASE_URL|POSTGRES(?:QL)?_URL|MYSQL_URL|DB_URL|SYNAPSOR_DATABASE_READ_URL)$/;
const preferredEnvironmentNames = [
  "DATABASE_URL",
  "SYNAPSOR_DATABASE_READ_URL",
  "POSTGRES_URL",
  "POSTGRESQL_URL",
  "MYSQL_URL",
  "DB_URL",
];

export type InstantDatabaseInput = {
  environmentVariable: string;
  value: string;
  source: "project_env" | "session_paste";
  sourceLabel: string;
};

export async function discoverProjectEnvFiles(projectRoot: string): Promise<string[]> {
  const root = path.resolve(projectRoot);
  const found: string[] = [];
  for (const name of [".env.local", ".env"]) {
    const filePath = path.join(root, name);
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
      if (stat.size > MAX_ENV_FILE_BYTES) continue;
      found.push(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return found;
}

export async function readDatabaseUrlFromProjectEnv(filePathInput: string): Promise<InstantDatabaseInput> {
  const filePath = path.resolve(filePathInput);
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error("The selected environment file must be a regular file, not a symlink.");
  }
  if (stat.size > MAX_ENV_FILE_BYTES) {
    throw new Error("The selected environment file is too large to use for guided onboarding.");
  }
  const parsed = parseEnv(await fs.readFile(filePath, "utf8"));
  const available = Object.entries(parsed)
    .filter(([name, value]) => databaseEnvironmentName.test(name) && typeof value === "string" && value.trim())
    .map(([name]) => name);
  const environmentVariable = preferredEnvironmentNames.find((name) => available.includes(name))
    ?? available[0];
  if (!environmentVariable) {
    throw new Error("The selected environment file has no supported read database URL variable.");
  }
  const value = validateDatabaseUrl(parsed[environmentVariable] ?? "");
  return {
    environmentVariable,
    value,
    source: "project_env",
    sourceLabel: path.basename(filePath),
  };
}

export function sessionDatabaseInput(value: string): InstantDatabaseInput {
  return {
    environmentVariable: "DATABASE_URL",
    value: validateDatabaseUrl(value),
    source: "session_paste",
    sourceLabel: "hidden terminal input",
  };
}

export function validateDatabaseUrl(valueInput: string): string {
  const value = valueInput.trim();
  if (!value || Buffer.byteLength(value, "utf8") > MAX_DATABASE_URL_BYTES) {
    throw new Error("Database URL is empty or exceeds the safe onboarding input limit.");
  }
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes("${")) {
    throw new Error("Database URL contains a control character or unresolved environment placeholder.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Database URL must be a valid postgres://, postgresql://, or mysql:// URL.");
  }
  if (!["postgres:", "postgresql:", "mysql:"].includes(parsed.protocol)) {
    throw new Error("Database URL must use postgres://, postgresql://, or mysql://.");
  }
  if (!parsed.hostname) throw new Error("Database URL must include a hostname.");
  return value;
}

export async function readHiddenDatabaseUrl(
  prompt: string,
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Hidden database URL input requires an interactive terminal.");
  }
  output.write(prompt);
  const wasRaw = input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  input.setEncoding("utf8");
  input.setRawMode(true);
  input.resume();
  let value = "";
  try {
    return await new Promise<string>((resolve, reject) => {
      const finish = (error?: Error) => {
        input.off("data", onData);
        output.write("\n");
        if (error) reject(error);
        else resolve(validateDatabaseUrl(value));
      };
      const onData = (chunk: string | Buffer) => {
        const text = String(chunk);
        for (const character of text) {
          if (character === "\u0003") {
            finish(new Error("Database URL input cancelled."));
            return;
          }
          if (character === "\r" || character === "\n") {
            finish();
            return;
          }
          if (character === "\u007f" || character === "\b") {
            value = [...value].slice(0, -1).join("");
            continue;
          }
          if (/[\u0000-\u001f]/.test(character)) continue;
          value += character;
          if (Buffer.byteLength(value, "utf8") > MAX_DATABASE_URL_BYTES) {
            finish(new Error("Database URL exceeds the safe onboarding input limit."));
            return;
          }
        }
      };
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(wasRaw);
    if (!wasFlowing) input.pause();
  }
}
