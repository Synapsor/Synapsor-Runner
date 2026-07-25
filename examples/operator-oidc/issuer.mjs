#!/usr/bin/env node

import crypto from "node:crypto";
import http from "node:http";

const issuer = process.env.SYNAPSOR_EXAMPLE_OIDC_ISSUER
  ?? "https://identity.example.test/oidc";
const audience = process.env.SYNAPSOR_EXAMPLE_OIDC_AUDIENCE
  ?? "synapsor-operators";
const host = "127.0.0.1";
const requestedPort = Number(process.env.SYNAPSOR_EXAMPLE_OIDC_PORT ?? "0");

const primary = rsaSigner("fitflow-key-1");
const rotated = rsaSigner("fitflow-key-2");
const untrusted = rsaSigner("untrusted-key");
let rotationEnabled = false;

const tokenCases = {
  reviewer: () => token(primary, {
    sub: "reviewer@example.test",
    groups: ["membership_reviewer"],
  }),
  applier: () => token(rotated, {
    sub: "writeback@example.test",
    groups: ["writeback_operator"],
  }),
  missing_role: () => token(primary, {
    sub: "trainer@example.test",
    groups: ["trainer"],
  }),
  similar_role: () => token(primary, {
    sub: "reviewer-backup@example.test",
    groups: ["membership_reviewer_backup"],
  }),
  bad_signature: () => token(untrusted, {
    sub: "attacker@example.test",
    groups: ["membership_reviewer"],
  }, { kid: primary.kid }),
  unknown_key: () => token(untrusted, {
    sub: "unknown-key@example.test",
    groups: ["membership_reviewer"],
  }),
  expired: () => token(primary, {
    sub: "expired@example.test",
    groups: ["membership_reviewer"],
  }, { expiresAt: epoch() - 60 }),
  not_yet_valid: () => token(primary, {
    sub: "future@example.test",
    groups: ["membership_reviewer"],
  }, { notBefore: epoch() + 600 }),
  wrong_issuer: () => token(primary, {
    sub: "wrong-issuer@example.test",
    groups: ["membership_reviewer"],
    iss: "https://wrong.example.test/oidc",
  }),
  wrong_audience: () => token(primary, {
    sub: "wrong-audience@example.test",
    groups: ["membership_reviewer"],
    aud: "another-service",
  }),
  unsafe_subject: () => token(primary, {
    sub: "unsafe subject with spaces",
    groups: ["membership_reviewer"],
  }),
  malformed_roles: () => token(primary, {
    sub: "malformed-roles@example.test",
    groups: { membership_reviewer: true },
  }),
  missing_expiry: () => token(primary, {
    sub: "missing-expiry@example.test",
    groups: ["membership_reviewer"],
  }, { omitExpiry: true }),
};

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`);
  response.setHeader("cache-control", "no-store");

  if (request.method === "GET" && url.pathname === "/jwks") {
    return json(response, 200, {
      keys: rotationEnabled ? [primary.publicJwk, rotated.publicJwk] : [primary.publicJwk],
    });
  }

  if (request.method === "POST" && url.pathname === "/rotate") {
    rotationEnabled = true;
    return json(response, 200, {
      ok: true,
      active_kids: [primary.kid, rotated.kid],
    });
  }

  const match = request.method === "GET"
    ? url.pathname.match(/^\/token\/([a-z_]+)$/)
    : undefined;
  const mint = match ? tokenCases[match[1]] : undefined;
  if (mint) {
    return json(response, 200, {
      access_token: mint(),
      token_type: "Bearer",
      expires_in: 300,
    });
  }

  return json(response, 404, { error: "not_found" });
});

server.listen(requestedPort, host, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    process.stderr.write("OIDC fixture did not bind a TCP port.\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify({
    fixture: "synapsor.operator-oidc.v1",
    base_url: `http://${host}:${address.port}`,
    jwks_url: `http://${host}:${address.port}/jwks`,
    issuer,
    audience,
    approval_role: "membership_reviewer",
    apply_role: "writeback_operator",
    group_mapping: {
      "example-membership-reviewers": "membership_reviewer",
      "example-writeback-operators": "writeback_operator",
    },
  })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function rsaSigner(kid) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  return {
    kid,
    privateKey,
    publicJwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    },
  };
}

function token(signer, claims, options = {}) {
  const now = epoch();
  const header = {
    alg: "RS256",
    kid: options.kid ?? signer.kid,
    typ: "JWT",
  };
  const payload = {
    iss: issuer,
    aud: audience,
    iat: now,
    nbf: options.notBefore ?? now - 1,
    ...(!options.omitExpiry ? { exp: options.expiresAt ?? now + 300 } : {}),
    ...claims,
  };
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), signer.privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function epoch() {
  return Math.floor(Date.now() / 1000);
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}
