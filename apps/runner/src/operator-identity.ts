import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { createJwtVerifier, type JwtAlgorithm } from "@synapsor-runner/mcp-server";
import type { OperatorDecision, OperatorIdentityProof, StoredProposal } from "@synapsor-runner/proposal-store";

export type OperatorIdentityConfig = {
  provider: "dev_env" | "signed_key" | "jwt_oidc";
  actor_env?: string;
  roles_env?: string;
  apply_roles?: string[];
  operators?: Record<string, {
    public_key_path: string;
    roles: string[];
  }>;
  token_env?: string;
  token_file_env?: string;
  token_stdin?: boolean;
  roles_claim?: string;
  subject_claim?: string;
  attestation_secret_env?: string;
  algorithms?: JwtAlgorithm[];
  jwks_url_env?: string;
  public_key_env?: string;
  public_key_path?: string;
  issuer?: string;
  audience?: string;
  clock_skew_seconds?: number;
  jwks_cache_seconds?: number;
  jwks_cooldown_seconds?: number;
  fetch_timeout_ms?: number;
  max_response_bytes?: number;
};

export type ResolveOperatorIdentityInput = {
  config?: OperatorIdentityConfig;
  configPath?: string;
  proposal: StoredProposal;
  action: OperatorDecision["action"];
  reason?: string;
  actor?: string;
  identity?: string;
  privateKeyPath?: string;
  requiredRole?: string;
  env?: NodeJS.ProcessEnv;
  now?: string;
  tokenInput?: Readable;
};

export async function resolveOperatorIdentity(input: ResolveOperatorIdentityInput): Promise<OperatorIdentityProof> {
  const env = input.env ?? process.env;
  const config = input.config;
  if (!config || config.provider === "dev_env") {
    const actorEnv = config?.actor_env ?? "USER";
    const rolesEnv = config?.roles_env ?? "SYNAPSOR_OPERATOR_ROLES";
    const subject = input.actor?.trim() || env[actorEnv]?.trim() || "local_operator";
    const configuredRoles = splitRoles(env[rolesEnv]);
    const roles = configuredRoles.length > 0
      ? configuredRoles
      : !config && input.requiredRole
        ? [input.requiredRole]
        : [];
    assertRole(subject, roles, input.requiredRole);
    const decision = operatorDecision(input, subject);
    const decisionHash = sha256(stableJson(decision));
    const core = {
      provider: "dev_env" as const,
      verified: false,
      subject,
      roles,
      decision,
      decision_hash: decisionHash,
    };
    return { ...core, integrity_hash: sha256(stableJson(core)) };
  }

  if (config.provider === "jwt_oidc") {
    const token = await operatorToken(config, env, input.tokenInput ?? process.stdin);
    const configDir = path.dirname(path.resolve(input.configPath ?? "synapsor.runner.json"));
    const verifier = createJwtVerifier({
      provider: "jwt_asymmetric",
      algorithms: config.algorithms,
      jwks_url_env: config.jwks_url_env,
      public_key_env: config.public_key_env,
      public_key_path: config.public_key_path,
      issuer: config.issuer,
      audience: config.audience,
      clock_skew_seconds: config.clock_skew_seconds,
      jwks_cache_seconds: config.jwks_cache_seconds,
      jwks_cooldown_seconds: config.jwks_cooldown_seconds,
      fetch_timeout_ms: config.fetch_timeout_ms,
      max_response_bytes: config.max_response_bytes,
    }, env, { baseDir: configDir });
    const verified = await verifier(token);
    const subject = safeIdentityClaim(verified.payload[config.subject_claim ?? "sub"]);
    if (!subject) throw new Error("verified operator JWT is missing a safe subject claim");
    const roles = rolesFromClaim(verified.payload[config.roles_claim ?? "roles"]);
    assertRole(subject, roles, input.requiredRole);
    const attestationSecretEnv = config.attestation_secret_env ?? "SYNAPSOR_OPERATOR_ATTESTATION_SECRET";
    const attestationSecret = env[attestationSecretEnv]?.trim();
    if (!attestationSecret || Buffer.byteLength(attestationSecret) < 32) {
      throw new Error(`${attestationSecretEnv} must contain at least 32 bytes of operator decision attestation key material`);
    }
    const decision = operatorDecision(input, subject);
    const decisionHash = sha256(stableJson(decision));
    const unsigned = {
      provider: "jwt_oidc" as const,
      verified: true,
      subject,
      roles,
      key_id: verified.protectedHeader.kid,
      algorithm: verified.protectedHeader.alg,
      issuer: typeof verified.payload.iss === "string" ? verified.payload.iss : undefined,
      decision,
      decision_hash: decisionHash,
    };
    const signature = hmacAttestation(unsigned, attestationSecret);
    const core = { ...unsigned, signature };
    return { ...core, integrity_hash: sha256(stableJson(core)) };
  }

  const subject = input.identity?.trim() || env.SYNAPSOR_OPERATOR_ID?.trim();
  if (!subject) throw new Error("signed operator identity requires --identity <operator> or SYNAPSOR_OPERATOR_ID");
  const operator = config.operators?.[subject];
  if (!operator) throw new Error(`operator ${subject} is not present in operator_identity.operators`);
  assertRole(subject, operator.roles, input.requiredRole);
  const privateKeyPath = input.privateKeyPath?.trim() || env.SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH?.trim();
  if (!privateKeyPath) throw new Error("signed operator identity requires --identity-key <private-key.pem> or SYNAPSOR_OPERATOR_PRIVATE_KEY_PATH");
  const configDir = path.dirname(path.resolve(input.configPath ?? "synapsor.runner.json"));
  const publicKeyPath = path.resolve(configDir, operator.public_key_path);
  const resolvedPrivateKeyPath = path.resolve(privateKeyPath);
  const [publicKey, privateKey] = await Promise.all([
    fs.readFile(publicKeyPath, "utf8"),
    fs.readFile(resolvedPrivateKeyPath, "utf8"),
  ]);
  const decision = operatorDecision(input, subject);
  const canonical = stableJson(decision);
  const decisionHash = sha256(canonical);
  const signature = crypto.sign("sha256", Buffer.from(canonical), privateKey).toString("base64url");
  if (!crypto.verify("sha256", Buffer.from(canonical), publicKey, Buffer.from(signature, "base64url"))) {
    throw new Error(`private key does not match the reviewed public key for operator ${subject}`);
  }
  const core = {
    provider: "signed_key" as const,
    verified: true,
    subject,
    roles: [...new Set(operator.roles)].sort(),
    key_id: subject,
    algorithm: "SHA256",
    decision,
    decision_hash: decisionHash,
    signature,
  };
  return { ...core, integrity_hash: sha256(stableJson(core)) };
}

export function verifyJwtOperatorProof(proof: OperatorIdentityProof, attestationSecret: string): boolean {
  if (proof.provider !== "jwt_oidc" || !proof.verified || !proof.signature) return false;
  const canonical = stableJson(proof.decision);
  if (proof.decision_hash !== sha256(canonical)) return false;
  const { integrity_hash: _integrity, signature, ...unsigned } = proof;
  const expected = hmacAttestation(unsigned, attestationSecret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return false;
  const core = { ...unsigned, signature };
  return proof.integrity_hash === sha256(stableJson(core));
}

export function verifySignedOperatorProof(proof: OperatorIdentityProof, publicKey: string): boolean {
  if (proof.provider !== "signed_key" || !proof.verified || !proof.signature) return false;
  const canonical = stableJson(proof.decision);
  if (proof.decision_hash !== sha256(canonical)) return false;
  const { integrity_hash: _integrity, ...core } = proof;
  if (proof.integrity_hash !== sha256(stableJson(core))) return false;
  return crypto.verify("sha256", Buffer.from(canonical), publicKey, Buffer.from(proof.signature, "base64url"));
}

function operatorDecision(input: ResolveOperatorIdentityInput, subject: string): OperatorDecision {
  return {
    schema_version: "synapsor.operator-decision.v1",
    action: input.action,
    proposal_id: input.proposal.proposal_id,
    proposal_version: input.proposal.proposal_version,
    proposal_hash: input.proposal.proposal_hash,
    subject,
    issued_at: input.now ?? new Date().toISOString(),
    ...(input.reason ? { reason: input.reason } : {}),
  };
}

function assertRole(subject: string, roles: string[], requiredRole: string | undefined): void {
  if (requiredRole && !roles.includes(requiredRole)) {
    throw new Error(`operator ${subject} lacks required role ${requiredRole}`);
  }
}

function splitRoles(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(/[\s,]+/).map((role) => role.trim()).filter(Boolean))].sort();
}

async function operatorToken(config: OperatorIdentityConfig, env: NodeJS.ProcessEnv, input: Readable): Promise<string> {
  const tokenEnv = config.token_env ?? (!config.token_file_env && config.token_stdin !== true ? "SYNAPSOR_OPERATOR_TOKEN" : undefined);
  const tokenFileEnv = config.token_file_env;
  const inline = tokenEnv ? env[tokenEnv]?.trim() : undefined;
  const filePath = tokenFileEnv ? env[tokenFileEnv]?.trim() : undefined;
  const selected = [Boolean(inline), Boolean(filePath), config.token_stdin === true].filter(Boolean).length;
  if (selected > 1) throw new Error("operator JWT must come from exactly one of env, token file, or stdin");
  if (inline) return inline;
  if (filePath) {
    const token = (await fs.readFile(path.resolve(filePath), "utf8")).trim();
    if (token) return token;
  }
  if (config.token_stdin === true) {
    let value = "";
    for await (const chunk of input) value += String(chunk);
    const token = value.trim();
    if (token) return token;
    throw new Error("operator JWT stdin was empty");
  }
  throw new Error(`operator JWT requires ${tokenEnv ?? "a configured token source"}${tokenFileEnv ? ` or a token file path in ${tokenFileEnv}` : ""}`);
}

function safeIdentityClaim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 256 && /^[A-Za-z0-9@._:/+-]+$/.test(trimmed) ? trimmed : undefined;
}

function rolesFromClaim(value: unknown): string[] {
  const candidates = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,]+/) : [];
  const roles = candidates
    .filter((role): role is string => typeof role === "string")
    .map((role) => role.trim())
    .filter((role) => /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(role));
  return [...new Set(roles)].sort();
}

function hmacAttestation(value: unknown, secret: string): string {
  return crypto.createHmac("sha256", secret).update(stableJson(value)).digest("base64url");
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
