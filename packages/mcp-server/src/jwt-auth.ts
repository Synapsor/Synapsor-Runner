import fs from "node:fs";
import path from "node:path";
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  importSPKI,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyOptions,
  type ProtectedHeaderParameters,
} from "jose";

export type JwtAlgorithm = "HS256" | "RS256" | "ES256";

export type JwtVerificationConfig = {
  provider: "jwt_hs256" | "jwt_asymmetric";
  secret_env?: string;
  previous_secret_env?: string;
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

export type VerifiedJwt = {
  payload: JWTPayload;
  protectedHeader: ProtectedHeaderParameters;
};

export type JwtVerifier = (token: string) => Promise<VerifiedJwt>;

export function createJwtVerifier(
  config: JwtVerificationConfig,
  env: NodeJS.ProcessEnv,
  options: { baseDir?: string } = {},
): JwtVerifier {
  const algorithms = verifiedAlgorithms(config);
  const verifyOptions: JWTVerifyOptions = {
    algorithms,
    ...(config.issuer ? { issuer: config.issuer } : {}),
    ...(config.audience ? { audience: config.audience } : {}),
    clockTolerance: config.clock_skew_seconds ?? 30,
    requiredClaims: ["exp"],
  };

  if (config.provider === "jwt_hs256") {
    const secrets = [config.secret_env, config.previous_secret_env]
      .filter((name): name is string => Boolean(name))
      .map((name) => trimmedEnv(env, name))
      .filter((value): value is string => Boolean(value));
    if (secrets.length === 0 || secrets.some((secret) => Buffer.byteLength(secret) < 32)) {
      throw new Error("HS256 verification requires configured HMAC key material of at least 32 bytes");
    }
    const keys = secrets.map((secret) => new TextEncoder().encode(secret));
    return async (token) => {
      let lastError: unknown;
      for (const key of keys) {
        try {
          const verified = await jwtVerify(token, key, verifyOptions);
          return { payload: verified.payload, protectedHeader: verified.protectedHeader };
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("JWT verification failed");
    };
  }

  const keySources = [config.jwks_url_env, config.public_key_env, config.public_key_path].filter(Boolean);
  if (keySources.length !== 1) throw new Error("asymmetric JWT verification requires exactly one public key source");

  if (config.jwks_url_env) {
    const rawUrl = trimmedEnv(env, config.jwks_url_env);
    if (!rawUrl) throw new Error(`${config.jwks_url_env} is required for JWKS verification`);
    const url = safeJwksUrl(rawUrl);
    const maxBytes = config.max_response_bytes ?? 1_048_576;
    const remote = createRemoteJWKSet(url, {
      timeoutDuration: config.fetch_timeout_ms ?? 3000,
      cooldownDuration: (config.jwks_cooldown_seconds ?? 30) * 1000,
      cacheMaxAge: (config.jwks_cache_seconds ?? 600) * 1000,
      [customFetch]: async (resource, init) => boundedJwksFetch(resource, init, maxBytes),
    });
    return async (token) => {
      const verified = await jwtVerify(token, remote, verifyOptions);
      return { payload: verified.payload, protectedHeader: verified.protectedHeader };
    };
  }

  const pem = config.public_key_env
    ? trimmedEnv(env, config.public_key_env)
    : fs.readFileSync(path.resolve(options.baseDir ?? process.cwd(), config.public_key_path!), "utf8").trim();
  if (!pem || /PRIVATE KEY/.test(pem)) throw new Error("asymmetric JWT verification requires public-key-only PEM material");
  const imported = new Map<string, Promise<CryptoKey>>();
  return async (token) => {
    const header = decodeProtectedHeader(token);
    const algorithm = header.alg;
    if (!algorithm || !algorithms.includes(algorithm as JwtAlgorithm)) throw new Error("JWT algorithm is not allowed");
    let key = imported.get(algorithm);
    if (!key) {
      key = importSPKI(pem, algorithm);
      imported.set(algorithm, key);
    }
    const verified = await jwtVerify(token, await key, verifyOptions);
    return { payload: verified.payload, protectedHeader: verified.protectedHeader };
  };
}

function verifiedAlgorithms(config: JwtVerificationConfig): JwtAlgorithm[] {
  const algorithms = config.provider === "jwt_hs256" ? (config.algorithms ?? ["HS256"]) : config.algorithms;
  if (!algorithms?.length) throw new Error("JWT algorithms must be explicitly configured");
  const allowed = config.provider === "jwt_hs256" ? new Set<JwtAlgorithm>(["HS256"]) : new Set<JwtAlgorithm>(["RS256", "ES256"]);
  if (algorithms.some((algorithm) => !allowed.has(algorithm))) throw new Error("JWT algorithm is not valid for the configured provider");
  return [...new Set(algorithms)];
}

function safeJwksUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("JWKS URL must use HTTPS (HTTP is allowed only for loopback development)");
  }
  if (url.username || url.password || url.hash) throw new Error("JWKS URL must not contain credentials or fragments");
  return url;
}

async function boundedJwksFetch(
  resource: string,
  init: { headers: Headers; method: "GET"; redirect: "manual"; signal: AbortSignal },
  maxBytes: number,
): Promise<Response> {
  const response = await fetch(resource, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new Error("JWKS redirects are not allowed");
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > maxBytes) throw new Error("JWKS response exceeds configured size limit");
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("JWKS response exceeds configured size limit");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function trimmedEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}
