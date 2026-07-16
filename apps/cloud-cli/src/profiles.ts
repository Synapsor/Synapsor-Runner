import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const KEYCHAIN_SERVICE = "synapsor-cli";

export type CloudProfile = {
  api_url: string;
  workspace_id?: string;
  project_id?: string;
  credential_kind?: "human" | "service";
  credential_env?: string;
  credential_file?: string;
  credential_keychain?: {
    provider: "secret-tool";
    service: string;
    account: string;
  };
};

export type ProfileDocument = {
  version: 1;
  active_profile: string;
  profiles: Record<string, CloudProfile>;
};

export type ResolvedCredential = {
  value: string;
  kind: "human" | "service";
  source: "environment" | "keychain" | "secure_file";
};

export type StoredHumanCredential =
  | { storage: "keychain"; keychain: NonNullable<CloudProfile["credential_keychain"]> }
  | { storage: "secure_file"; file: string };

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.SYNAPSOR_CONFIG_HOME || "").trim();
  if (explicit) return path.resolve(explicit);
  const xdg = String(env.XDG_CONFIG_HOME || "").trim();
  return path.resolve(xdg || path.join(os.homedir(), ".config"), "synapsor");
}

export async function readProfiles(env: NodeJS.ProcessEnv = process.env): Promise<ProfileDocument> {
  const file = path.join(configDirectory(env), "profiles.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ProfileDocument>;
    const profiles = parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {};
    return {
      version: 1,
      active_profile: safeProfileName(parsed.active_profile || "default"),
      profiles,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      version: 1,
      active_profile: "default",
      profiles: { default: { api_url: "https://dev-api.synapsor.ai" } },
    };
  }
}

export async function writeProfiles(document: ProfileDocument, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const directory = configDirectory(env);
  const file = path.join(directory, "profiles.json");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicSecureWrite(file, `${JSON.stringify(document, null, 2)}\n`);
}

export async function selectProfile(name: string, env: NodeJS.ProcessEnv = process.env): Promise<ProfileDocument> {
  const normalized = safeProfileName(name);
  const document = await readProfiles(env);
  if (!document.profiles[normalized]) throw new Error(`profile_not_found: ${normalized}`);
  document.active_profile = normalized;
  await writeProfiles(document, env);
  return document;
}

export async function upsertProfile(name: string, profile: CloudProfile, env: NodeJS.ProcessEnv = process.env): Promise<ProfileDocument> {
  const normalized = safeProfileName(name);
  const document = await readProfiles(env);
  document.profiles[normalized] = { ...document.profiles[normalized], ...profile };
  if (!document.active_profile) document.active_profile = normalized;
  await writeProfiles(document, env);
  return document;
}

export async function storeHumanCredential(profileName: string, token: string, env: NodeJS.ProcessEnv = process.env): Promise<StoredHumanCredential> {
  const normalized = safeProfileName(profileName);
  const secret = String(token || "").trim();
  if (!secret) throw new Error("empty_human_access_token");
  if (secretToolAvailable(env)) {
    await runSecretTool(
      ["store", `--label=Synapsor Cloud CLI (${normalized})`, "service", KEYCHAIN_SERVICE, "account", normalized],
      `${secret}\n`,
      env,
    );
    return {
      storage: "keychain",
      keychain: { provider: "secret-tool", service: KEYCHAIN_SERVICE, account: normalized },
    };
  }
  const directory = path.join(configDirectory(env), "credentials");
  const file = path.join(directory, `${normalized}.token`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicSecureWrite(file, `${secret}\n`);
  return { storage: "secure_file", file };
}

export async function deleteStoredCredential(profile: CloudProfile, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (profile.credential_keychain?.provider === "secret-tool" && secretToolAvailable(env)) {
    await runSecretTool(["clear", "service", profile.credential_keychain.service, "account", profile.credential_keychain.account], undefined, env);
  }
  if (profile.credential_file) await fs.rm(profile.credential_file, { force: true });
}

export async function resolveCredential(profile: CloudProfile, env: NodeJS.ProcessEnv = process.env): Promise<ResolvedCredential> {
  const apiKey = String(env.SYNAPSOR_API_KEY || "").trim();
  if (apiKey) return { value: apiKey, kind: "service", source: "environment" };
  const accessToken = String(env.SYNAPSOR_CLOUD_ACCESS_TOKEN || "").trim();
  if (accessToken) return { value: accessToken, kind: "human", source: "environment" };
  if (profile.credential_env) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(profile.credential_env)) throw new Error("credential_environment_reference_invalid");
    const referenced = String(env[profile.credential_env] || "").trim();
    if (!referenced) throw new Error(`credential_environment_value_missing: ${profile.credential_env}`);
    return { value: referenced, kind: profile.credential_kind || "service", source: "environment" };
  }
  if (profile.credential_keychain?.provider === "secret-tool") {
    if (!secretToolAvailable(env)) throw new Error("credential_keychain_unavailable: secret-tool is not installed");
    const value = (await runSecretTool(["lookup", "service", profile.credential_keychain.service, "account", profile.credential_keychain.account], undefined, env)).trim();
    if (!value) throw new Error("stored_cloud_credential_empty");
    return { value, kind: profile.credential_kind || "human", source: "keychain" };
  }
  if (!profile.credential_file) throw new Error("cloud_authentication_required");
  const stat = await fs.stat(profile.credential_file);
  if ((stat.mode & 0o077) !== 0) throw new Error(`credential_file_permissions_unsafe: ${profile.credential_file} must be mode 0600`);
  const value = (await fs.readFile(profile.credential_file, "utf8")).trim();
  if (!value) throw new Error("stored_cloud_credential_empty");
  return { value, kind: profile.credential_kind || "human", source: "secure_file" };
}

function secretToolAvailable(env: NodeJS.ProcessEnv): boolean {
  const result = spawnSync("secret-tool", ["--version"], { env, stdio: "ignore" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return false;
  return true;
}

function runSecretTool(args: string[], stdin: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("secret-tool", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`credential_keychain_failed: secret-tool exited ${code ?? "unknown"}${stderr.trim() ? ` (${stderr.trim()})` : ""}`));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export function safeProfileName(value: string): string {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error("profile_name_invalid");
  return name;
}

async function atomicSecureWrite(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}
