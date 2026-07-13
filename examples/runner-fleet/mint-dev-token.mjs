import crypto from "node:crypto";

const tenant = process.argv[2] ?? "acme";
const subject = process.argv[3] ?? "fleet-demo-agent";
const secret = "synthetic-fleet-session-secret-change-before-use-0001";
const now = Math.floor(Date.now() / 1000);
const header = { alg: "HS256", typ: "JWT" };
const payload = {
  sub: subject,
  tenant_id: tenant,
  iss: "https://fleet.example.invalid",
  aud: "synapsor-runner-fleet",
  iat: now,
  exp: now + 600,
};
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const unsigned = `${encode(header)}.${encode(payload)}`;
const signature = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
process.stdout.write(`${unsigned}.${signature}\n`);
