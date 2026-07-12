import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperatorDecision, OperatorIdentityProof, StoredProposal } from "@synapsor-runner/proposal-store";

export type OperatorIdentityConfig = {
  provider: "dev_env" | "signed_key";
  actor_env?: string;
  roles_env?: string;
  apply_roles?: string[];
  operators?: Record<string, {
    public_key_path: string;
    roles: string[];
  }>;
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
