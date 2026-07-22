import { createServer } from "node:http";
import {
  SignJWT,
  exportJWK,
  exportSPKI,
  generateKeyPair,
} from "jose";
import { describe, expect, it } from "vitest";
import { createJwtVerifier } from "./jwt-auth.js";

const now = () => Math.floor(Date.now() / 1000);

async function signedToken(
  privateKey: CryptoKey,
  algorithm: "RS256" | "ES256",
  kid: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  const { iss, aud, exp, ...payload } = claims;
  return new SignJWT({ tenant_id: "acme", ...payload })
    .setProtectedHeader({ alg: algorithm, kid })
    .setSubject("agent-17")
    .setIssuer(typeof iss === "string" ? iss : "https://identity.example")
    .setAudience(typeof aud === "string" ? aud : "synapsor-runner")
    .setIssuedAt()
    .setExpirationTime(typeof exp === "number" ? exp : now() + 300)
    .sign(privateKey);
}

describe("JWT verification", () => {
  it("verifies RS256 and ES256 using public-key-only PEM material", async () => {
    for (const algorithm of ["RS256", "ES256"] as const) {
      const { publicKey, privateKey } = await generateKeyPair(algorithm, { extractable: true });
      const envName = `TEST_${algorithm}_PUBLIC_KEY`;
      const verifier = createJwtVerifier({
        provider: "jwt_asymmetric",
        algorithms: [algorithm],
        public_key_env: envName,
        issuer: "https://identity.example",
        audience: "synapsor-runner",
      }, { [envName]: await exportSPKI(publicKey) });
      const verified = await verifier(await signedToken(privateKey, algorithm, `${algorithm}-1`));
      expect(verified.payload).toMatchObject({ sub: "agent-17", tenant_id: "acme" });
      expect(verified.protectedHeader).toMatchObject({ alg: algorithm, kid: `${algorithm}-1` });
    }
  });

  it("refreshes bounded JWKS verification for a rotated kid", async () => {
    const first = await generateKeyPair("RS256", { extractable: true });
    const second = await generateKeyPair("RS256", { extractable: true });
    const firstJwk = { ...await exportJWK(first.publicKey), kid: "key-1", alg: "RS256", use: "sig" };
    const secondJwk = { ...await exportJWK(second.publicKey), kid: "key-2", alg: "RS256", use: "sig" };
    let keys: Record<string, unknown>[] = [firstJwk];
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("JWKS test server did not bind");
    const verifier = createJwtVerifier({
      provider: "jwt_asymmetric",
      algorithms: ["RS256"],
      jwks_url_env: "TEST_JWKS_URL",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
      jwks_cooldown_seconds: 1,
      jwks_cache_seconds: 60,
      fetch_timeout_ms: 1000,
      max_response_bytes: 8192,
    }, { TEST_JWKS_URL: `http://127.0.0.1:${address.port}/jwks` });
    try {
      await expect(verifier(await signedToken(first.privateKey, "RS256", "key-1"))).resolves.toMatchObject({ payload: { sub: "agent-17" } });
      await expect(verifier(await signedToken(first.privateKey, "RS256", "key-1"))).resolves.toMatchObject({ payload: { sub: "agent-17" } });
      expect(requests).toBe(1);
      keys = [firstJwk, secondJwk];
      await new Promise((resolve) => setTimeout(resolve, 1100));
      await expect(verifier(await signedToken(second.privateKey, "RS256", "key-2"))).resolves.toMatchObject({ protectedHeader: { kid: "key-2" } });
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects bad claims, algorithm confusion, private PEM, redirects, and oversized JWKS", async () => {
    const rsa = await generateKeyPair("RS256", { extractable: true });
    const otherRsa = await generateKeyPair("RS256", { extractable: true });
    const ec = await generateKeyPair("ES256", { extractable: true });
    const verifier = createJwtVerifier({
      provider: "jwt_asymmetric",
      algorithms: ["RS256"],
      public_key_env: "TEST_PUBLIC_KEY",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
    }, { TEST_PUBLIC_KEY: await exportSPKI(rsa.publicKey) });
    await expect(verifier(await signedToken(rsa.privateKey, "RS256", "rsa", { iss: "https://wrong.example" }))).rejects.toThrow();
    await expect(verifier(await signedToken(rsa.privateKey, "RS256", "rsa", { aud: "wrong-audience" }))).rejects.toThrow();
    const expired = await new SignJWT({ tenant_id: "acme" })
      .setProtectedHeader({ alg: "RS256", kid: "rsa" })
      .setSubject("agent-17")
      .setIssuer("https://identity.example")
      .setAudience("synapsor-runner")
      .setExpirationTime(now() - 60)
      .sign(rsa.privateKey);
    await expect(verifier(expired)).rejects.toThrow();
    const notYetValid = await new SignJWT({ tenant_id: "acme" })
      .setProtectedHeader({ alg: "RS256", kid: "rsa" })
      .setSubject("agent-17")
      .setIssuer("https://identity.example")
      .setAudience("synapsor-runner")
      .setNotBefore(now() + 300)
      .setExpirationTime(now() + 600)
      .sign(rsa.privateKey);
    await expect(verifier(notYetValid)).rejects.toThrow();
    const missingExpiry = await new SignJWT({ tenant_id: "acme" })
      .setProtectedHeader({ alg: "RS256", kid: "rsa" })
      .setSubject("agent-17")
      .setIssuer("https://identity.example")
      .setAudience("synapsor-runner")
      .sign(rsa.privateKey);
    await expect(verifier(missingExpiry)).rejects.toThrow();
    await expect(verifier(await signedToken(otherRsa.privateKey, "RS256", "rsa"))).rejects.toThrow();
    await expect(verifier(await signedToken(ec.privateKey, "ES256", "ec"))).rejects.toThrow();

    expect(() => createJwtVerifier({
      provider: "jwt_asymmetric",
      algorithms: ["RS256"],
      public_key_env: "TEST_PRIVATE_KEY",
    }, { TEST_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" })).toThrow(/public-key-only/);

    const server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/jwks" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ keys: [], padding: "x".repeat(4096) }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("JWKS test server did not bind");
    try {
      for (const [path, pattern] of [["redirect", /redirects are not allowed/], ["jwks", /size limit/]] as const) {
        const remote = createJwtVerifier({
          provider: "jwt_asymmetric",
          algorithms: ["RS256"],
          jwks_url_env: "TEST_JWKS_URL",
          max_response_bytes: 1024,
        }, { TEST_JWKS_URL: `http://127.0.0.1:${address.port}/${path}` });
        await expect(remote(await signedToken(rsa.privateKey, "RS256", "rsa"))).rejects.toThrow(pattern);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("fails remote JWKS closed on timeout, malformed JSON, private keys, unknown kid, and unsafe URLs", async () => {
    const rsa = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = { ...await exportJWK(rsa.publicKey), kid: "known", alg: "RS256", use: "sig" };
    const privateJwk = { ...await exportJWK(rsa.privateKey), kid: "private", alg: "RS256", use: "sig" };
    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      if (request.url === "/timeout") return;
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/malformed") response.end("{not-json");
      else if (request.url === "/private") response.end(JSON.stringify({ keys: [privateJwk] }));
      else response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("JWKS test server did not bind");
    const remote = (pathname: string, timeout = 1000) => createJwtVerifier({
      provider: "jwt_asymmetric",
      algorithms: ["RS256"],
      jwks_url_env: "TEST_JWKS_URL",
      issuer: "https://identity.example",
      audience: "synapsor-runner",
      fetch_timeout_ms: timeout,
      jwks_cooldown_seconds: 1,
      max_response_bytes: 8192,
    }, { TEST_JWKS_URL: `http://127.0.0.1:${address.port}/${pathname}` });
    try {
      await expect(remote("timeout", 50)(await signedToken(rsa.privateKey, "RS256", "known"))).rejects.toThrow();
      await expect(remote("malformed")(await signedToken(rsa.privateKey, "RS256", "known"))).rejects.toThrow(/valid JSON/);
      await expect(remote("private")(await signedToken(rsa.privateKey, "RS256", "private"))).rejects.toThrow(/public verification keys only/);
      const beforeUnknown = requests;
      await expect(remote("public")(await signedToken(rsa.privateKey, "RS256", "unknown"))).rejects.toThrow();
      expect(requests - beforeUnknown).toBeLessThanOrEqual(2);
      expect(() => createJwtVerifier({
        provider: "jwt_asymmetric",
        algorithms: ["RS256"],
        jwks_url_env: "TEST_JWKS_URL",
      }, { TEST_JWKS_URL: "http://identity.example/jwks" })).toThrow(/HTTPS/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
