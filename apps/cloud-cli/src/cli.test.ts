import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { main } from "./cli.js";
import { readProfiles, resolveCredential } from "./profiles.js";

describe("@synapsor/cli", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([["--version"], ["-v"], ["version"]])("prints the exact package version for %s", async (flag) => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await expect(main([flag])).resolves.toBe(0);
    expect(output.join("")).toBe("0.1.0-beta.1\n");
  });

  it("renders compact top-level and command-specific help from the real command tree", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await expect(main(["--help"])).resolves.toBe(0);
    expect(output.join("")).toContain("Use synapsor-runner for the local MCP/database safety boundary.");
    expect(output.join("")).toContain("contracts      Author, validate, version, push, activate, and pull contracts");
    expect(output.join("")).toContain("runners        Manage separately scoped Runner connections and bundles");

    output.length = 0;
    await expect(main(["contracts", "push", "--help"])).resolves.toBe(0);
    expect(output.join("")).toContain("synapsor contracts push");
    expect(output.join("")).toContain("synapsor contracts push <path> [--dry-run]");
    expect(output.join("")).toContain("--idempotency-key <id>");
    expect(output.join("")).toContain("Secrets are accepted only through secure references");

    output.length = 0;
    await expect(main(["runners", "--help"])).resolves.toBe(0);
    expect(output.join("")).toContain("synapsor runners create --sources <csv> --secret-file <path>");
    expect(output.join("")).toContain("synapsor runners bundle download <contract/version> --source <id> --out <path>");
  });

  it("downloads a Runner bundle only with an explicit source binding", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-bundle-"));
    const out = path.join(directory, "runner-bundle.zip");
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_API_KEY", "syn_api_bundle_test_never_print_123456789");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await main([
      "auth", "configure-service", "--profile", "ci", "--api-url", "https://api.example.test",
      "--project", "project-1", "--credential-env", "SYNAPSOR_API_KEY",
    ]);
    let requested = "";
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      requested = String(input);
      return new Response(new Uint8Array([80, 75, 3, 4]), { status: 200, headers: { "content-type": "application/zip" } });
    }));

    await expect(main(["runners", "bundle", "download", "contract-1/version-2", "--source", "src_pg_1", "--out", out])).resolves.toBe(0);
    expect(new URL(requested).pathname).toBe("/v1/control/projects/project-1/agent-contracts/contract-1/versions/version-2/runner-bundle");
    expect(new URL(requested).searchParams.get("download")).toBe("1");
    expect(new URL(requested).searchParams.get("source_id")).toBe("src_pg_1");
    expect(await fs.readFile(out)).toEqual(Buffer.from([80, 75, 3, 4]));
    await expect(main(["runners", "bundle", "download", "contract-1/version-2", "--out", out])).rejects.toThrow(/--source/);
  });

  it("keeps the checked-in Cloud CLI reference aligned with every command group", async () => {
    const reference = await fs.readFile(path.resolve("docs/cloud-cli.md"), "utf8");
    for (const group of [
      "auth", "status", "entitlements", "billing", "workspaces", "projects", "sources",
      "contracts", "contexts", "capabilities", "workflows", "api-keys", "runners",
      "proposals", "activity", "evidence", "receipts", "replay", "exports",
    ]) {
      expect(reference, `missing ${group} in docs/cloud-cli.md`).toMatch(new RegExp(`^${group}\\s`, "m"));
    }
  });

  it("authors trusted principal scope through canonical local contract mutations", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-author-"));
    const contractPath = path.join(directory, "contract.json");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });

    await main(["contracts", "init", contractPath, "--name", "hospital-cases"]);
    await main([
      "contexts", "create", "case_manager", "--contract", contractPath,
      "--binding-source", "http_claim", "--tenant-binding", "tenant_id",
      "--principal-binding", "principal", "--tenant-key", "hospital_id", "--principal-key", "sub",
    ]);
    await main([
      "capabilities", "create", "care.inspect_assigned_patient", "--contract", contractPath,
      "--kind", "read", "--context", "case_manager", "--source", "hospital_postgres",
      "--schema", "public", "--table", "patients", "--primary-key", "id",
      "--tenant-key", "hospital_id", "--principal-scope-key", "assigned_to",
      "--visible-fields", "id,hospital_id,status", "--kept-out-fields", "ssn,clinical_notes",
    ]);
    await main([
      "workflows", "create", "care.assigned_patient_review", "--contract", contractPath,
      "--context", "case_manager", "--capabilities", "care.inspect_assigned_patient",
    ]);
    output.length = 0;
    await main(["capabilities", "preview", "care.inspect_assigned_patient", "--contract", contractPath, "--json"]);

    const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
    expect(contract.contexts.find((item: { name: string }) => item.name === "case_manager")).toMatchObject({
      tenant_binding: "tenant_id",
      principal_binding: "principal",
    });
    expect(contract.capabilities.find((item: { name: string }) => item.name === "care.inspect_assigned_patient")?.subject).toMatchObject({
      tenant_key: "hospital_id",
      principal_scope_key: "assigned_to",
    });
    expect(contract.workflows.find((item: { name: string }) => item.name === "care.assigned_patient_review")?.allowed_capabilities).toEqual([
      "care.inspect_assigned_patient",
    ]);
    expect(JSON.parse(output.join("")).capability.principal_scope).toMatchObject({ column: "assigned_to", composition: "AND tenant", trusted: true });
    await expect(fs.access(`${contractPath}.bak`)).resolves.toBeUndefined();
  });

  it.each(["contract.synapsor", "contract.synapsor.sql"])("initializes valid DSL for %s", async (fileName) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-dsl-init-"));
    const contractPath = path.join(directory, fileName);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(main(["contracts", "init", contractPath, "--name", "hospital-cases"])).resolves.toBe(0);
    const source = await fs.readFile(contractPath, "utf8");
    expect(source).toContain("-- Synapsor contract: hospital-cases");
    expect(source).toContain("CREATE AGENT CONTEXT local_operator");
    expect(source).toContain("CREATE CAPABILITY example.inspect_record");
    await expect(main(["contracts", "validate", contractPath])).resolves.toBe(0);
  });

  it("fails closed when removing a referenced context", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-reference-"));
    const contractPath = path.join(directory, "contract.json");
    await fs.writeFile(contractPath, JSON.stringify({
      spec_version: "0.1",
      kind: "SynapsorContract",
      contexts: [{ name: "ctx", bindings: [{ name: "tenant", source: "session", key: "tenant", required: true }], tenant_binding: "tenant" }],
      capabilities: [{ name: "billing.inspect", kind: "read", context: "ctx", source: "pg", subject: { schema: "public", table: "invoices", primary_key: "id", tenant_key: "tenant_id" }, args: { invoice_id: { type: "string", required: true, max_length: 128 } }, lookup: { id_from_arg: "invoice_id" }, visible_fields: ["id"], kept_out_fields: [], evidence: { required: true }, max_rows: 1 }],
      workflows: [],
      policies: [],
    }));
    await expect(main(["contexts", "remove", "ctx", "--contract", contractPath])).rejects.toThrow(/definition_still_referenced.*billing\.inspect/);
  });

  it("pushes contracts with the shared canonical digest and scoped service credential", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-push-"));
    const contractPath = path.join(directory, "contract.json");
    await main(["contracts", "init", contractPath, "--name", "empty"]);
    const contract = JSON.parse(await fs.readFile(contractPath, "utf8"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_API_KEY", "syn_api_never_print");
    const requests: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      requests.push({ url: String(input), body, auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ ok: true, contract_id: "act_1", contract_version_id: "actv_1", digest: body.local_digest, status: "draft" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await main(["contracts", "push", contractPath, "--project", "project-1", "--api-url", "https://api.example.test", "--json"]);
    const result = JSON.parse(output.join(""));
    expect(result.local_digest).toBe(canonicalJsonDigest(contract));
    expect(requests[0]).toMatchObject({ url: "https://api.example.test/v1/control/projects/project-1/agent-contracts", auth: "Bearer syn_api_never_print" });
    expect(requests[0]?.body.source).toBe("cli");
    expect(output.join("")).not.toContain("syn_api_never_print");
  });

  it("keeps Cloud CLI and Runner contract push behaviorally compatible", async () => {
    const runnerModuleUrl = pathToFileURL(path.resolve("apps/runner/src/cli.ts")).href;
    const runnerModule = await import(/* @vite-ignore */ runnerModuleUrl) as { main(args: string[]): Promise<number> };
    const contractPath = path.resolve("packages/spec/examples/guarded-writeback.contract.json");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-push-parity-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_API_KEY", "syn_api_push_parity_never_print");
    const requests: Array<{ url: string; auth: string | null; kind: string | null; idempotency: string | null; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const body = JSON.parse(String(init?.body || "{}"));
      const headers = new Headers(init?.headers);
      requests.push({
        url: String(input),
        auth: headers.get("authorization"),
        kind: headers.get("x-synapsor-credential-kind"),
        idempotency: headers.get("idempotency-key"),
        body,
      });
      return new Response(JSON.stringify({
        ok: true,
        contract_id: "contract-parity",
        contract_version_id: "version-parity",
        digest: body.local_digest,
        status: "draft",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(main([
      "contracts", "push", contractPath,
      "--project", "project-parity",
      "--api-url", "https://api.example.test",
      "--idempotency-key", "push-parity",
      "--json",
    ])).resolves.toBe(0);
    await expect(runnerModule.main([
      "cloud", "push", contractPath,
      "--workspace", "project-parity",
      "--api-url", "https://api.example.test",
      "--idempotency-key", "push-parity",
      "--json",
    ])).resolves.toBe(0);

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(requests[1]?.url);
    expect(requests[0]?.url).toBe("https://api.example.test/v1/control/projects/project-parity/agent-contracts");
    expect(requests[0]?.auth).toBe("Bearer syn_api_push_parity_never_print");
    expect(requests[1]?.auth).toBe("Bearer syn_api_push_parity_never_print");
    expect(requests[0]?.kind).toBe("service");
    expect(requests[1]?.kind).toBe("service");
    expect(requests[0]?.idempotency).toBe("push-parity");
    expect(requests[1]?.idempotency).toBe("push-parity");
    expect(requests[0]?.body.local_digest).toBe(requests[1]?.body.local_digest);
    expect(requests[0]?.body.contract).toEqual(requests[1]?.body.contract);
  });

  it("denies service principals before proposal approval reaches the network", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-approve-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_API_KEY", "syn_api_test");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(main(["proposals", "approve", "wrp_1", "--project", "project-1", "--api-url", "https://api.example.test", "--yes"])).rejects.toMatchObject({ errorCode: "human_identity_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Runner-machine tokens before any Cloud CLI request", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-runner-auth-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_API_KEY", "syn_run_dev_machine_token_must_not_reach_control_routes");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(main([
      "contracts", "list", "--project", "project-1", "--api-url", "https://api.example.test", "--json",
    ])).rejects.toMatchObject({ errorCode: "runner_token_not_cloud_cli_credential", exitCode: 3 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("inspects a narrowly scoped service identity without requiring project:read", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-narrow-whoami-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_API_KEY", "syn_api_contract_writer_never_print");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      urls.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({
        ok: true,
        context: {
          principal_type: "service",
          key_id: "ak_contract_writer",
          project_id: "project-1",
          scopes: ["contracts:write"],
          entitlements: { plan: "builder", entitlement_status: "active" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    await expect(main([
      "auth", "whoami", "--project", "project-1", "--api-url", "https://api.example.test", "--json",
    ])).resolves.toBe(0);
    expect(urls).toEqual(["/v1/control/sessions/self"]);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      identity: { key_id: "ak_contract_writer", scopes: ["contracts:write"] },
      entitlements: { plan: "builder", entitlement_status: "active" },
    });
    expect(stdout.join("")).not.toContain("syn_api_contract_writer_never_print");
  });

  it("writes one-time API key material only to a mode-0600 file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-key-"));
    const secretFile = path.join(directory, "ci.key");
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_CLOUD_ACCESS_TOKEN", "human_session_never_print");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, api_key: { key_id: "ak_1", token_prefix: "syn_dev_" }, token: "syn_api_one_time_secret" }), { status: 200, headers: { "content-type": "application/json" } })));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await main(["api-keys", "create", "--project", "project-1", "--api-url", "https://api.example.test", "--name", "ci", "--scopes", "contracts:read,contracts:write", "--expires-at", "2099-01-01", "--secret-file", secretFile, "--json"]);
    expect(await fs.readFile(secretFile, "utf8")).toBe("syn_api_one_time_secret\n");
    expect((await fs.stat(secretFile)).mode & 0o777).toBe(0o600);
    expect(output.join("")).not.toContain("syn_api_one_time_secret");
    expect(JSON.parse(output.join("")).token).toBe("[REDACTED]");
  });

  it("writes the Runner-token secret field rather than serializing public token metadata", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-runner-token-"));
    const secretFile = path.join(directory, "runner.key");
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_CLOUD_ACCESS_TOKEN", "human_session_never_print");
    const requestBodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({
        ok: true,
        token: { token_id: "rnt_1", token_prefix: "syn_run_dev_", source_ids: ["source_1"] },
        runner_token: "syn_run_dev_one_time_secret_123456789",
        secret_available: true,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await main([
      "runners", "create", "--project", "project-1", "--api-url", "https://api.example.test",
      "--sources", "source_1", "--secret-file", secretFile, "--json",
    ]);
    expect(await fs.readFile(secretFile, "utf8")).toBe("syn_run_dev_one_time_secret_123456789\n");
    expect(requestBodies).toEqual([{ name: "Runner", source_ids: ["source_1"] }]);
    expect(output.join("")).not.toContain("syn_run_dev_one_time_secret_123456789");
    expect(JSON.parse(output.join(""))).toMatchObject({
      token: { token_id: "rnt_1", token_prefix: "syn_run_dev_", source_ids: ["source_1"] },
      runner_token: "[REDACTED]",
    });
  });

  it("stores only non-secret profile metadata", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-profile-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", directory);
    await main(["projects", "use", "project-1", "--profile", "default"]);
    const profiles = await readProfiles();
    expect(profiles.profiles.default?.project_id).toBe("project-1");
    expect(JSON.stringify(profiles)).not.toMatch(/token|password|secret/i);
    expect((await fs.stat(path.join(directory, "profiles.json"))).mode & 0o777).toBe(0o600);
  });

  it("uses the browser device flow and a protected credential fallback without printing the token", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-device-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", directory);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = new URL(String(input));
      requests.push(url.pathname);
      if (url.pathname.endsWith("/device-authorizations")) {
        return new Response(JSON.stringify({
          ok: true,
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://synapsor.ai/device",
          expires_in: 600,
          interval: 1,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("/device-authorizations/token")) {
        return new Response(JSON.stringify({ ok: true, access_token: "human_device_token_never_print" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
    vi.useFakeTimers();
    const login = main(["auth", "login", "--profile", "device", "--api-url", "https://api.example.test", "--json"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(login).resolves.toBe(0);
    const document = await readProfiles();
    const profile = document.profiles.device!;
    expect(profile.credential_kind).toBe("human");
    expect(profile.credential_file).toBeTruthy();
    expect((await fs.stat(profile.credential_file!)).mode & 0o777).toBe(0o600);
    expect(await resolveCredential(profile)).toMatchObject({ value: "human_device_token_never_print", kind: "human", source: "secure_file" });
    expect(JSON.stringify(document)).not.toContain("human_device_token_never_print");
    expect(stdout.join("") + stderr.join("")).not.toContain("human_device_token_never_print");
    expect(requests).toEqual(["/v1/control/device-authorizations", "/v1/control/device-authorizations/token"]);
  });

  it("configures a service profile by environment reference without storing the API key", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-service-profile-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", directory);
    vi.stubEnv("ACME_SYNAPSOR_KEY", "syn_service_value_never_store_12345");
    await main([
      "auth", "configure-service", "--profile", "ci", "--api-url", "https://api.example.test",
      "--project", "project-1", "--credential-env", "ACME_SYNAPSOR_KEY", "--json",
    ]);
    const document = await readProfiles();
    expect(document.profiles.ci).toMatchObject({
      api_url: "https://api.example.test",
      project_id: "project-1",
      credential_kind: "service",
      credential_env: "ACME_SYNAPSOR_KEY",
    });
    expect(JSON.stringify(document)).not.toContain("syn_service_value_never_store_12345");
    await expect(resolveCredential(document.profiles.ci!)).resolves.toMatchObject({
      value: "syn_service_value_never_store_12345",
      kind: "service",
      source: "environment",
    });
  });

  it("requires explicit least-privilege scopes when creating an API key", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-key-scopes-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_CLOUD_ACCESS_TOKEN", "human_session_never_print");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(main([
      "api-keys", "create", "--project", "project-1", "--api-url", "https://api.example.test", "--name", "ci",
    ])).rejects.toMatchObject({ errorCode: "usage_error" });
    await expect(main([
      "api-keys", "create", "--project", "project-1", "--api-url", "https://api.example.test", "--name", "ci",
      "--scopes", "contracts:read",
    ])).rejects.toMatchObject({ errorCode: "usage_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles an idempotent one-time-secret replay without minting or printing another secret", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-key-replay-"));
    const secretFile = path.join(directory, "replayed.key");
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_CLOUD_ACCESS_TOKEN", "human_session_never_print");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      idempotent: true,
      secret_available: false,
      api_key: { key_id: "ak_existing", token_prefix: "syn_dev_" },
      message: "The original one-time secret was already issued.",
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await expect(main([
      "api-keys", "create", "--project", "project-1", "--api-url", "https://api.example.test", "--name", "ci",
      "--scopes", "contracts:read", "--idempotency-key", "same-request", "--secret-file", secretFile, "--json",
    ])).resolves.toBe(0);
    const parsed = JSON.parse(output.join(""));
    expect(parsed).toMatchObject({ idempotent: true, secret_available: false });
    expect(output.join("")).not.toContain("human_session_never_print");
  });

  it("keeps safe URLs visible while redacting credential-bearing URLs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-redaction-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_CLOUD_ACCESS_TOKEN", "human_session_never_print");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      session: {
        actor: "account:test",
        url: "https://synapsor.ai/docs",
        callback_url: "https://user:password@example.test/callback",
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await main(["auth", "whoami", "--api-url", "https://api.example.test", "--json"]);
    const parsed = JSON.parse(output.join(""));
    expect(parsed.identity.url).toBe("https://synapsor.ai/docs");
    expect(parsed.identity.callback_url).not.toContain("user:password");
    expect(output.join("")).not.toContain("human_session_never_print");
  });

  it("follows cursors for --all with a bounded aggregate result", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-pagination-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_API_KEY", "syn_service_pagination_never_print_123");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      const cursor = url.searchParams.get("cursor");
      const body = cursor
        ? { ok: true, projects: [{ project_id: "project-2", name: "Two" }], next_cursor: null }
        : { ok: true, projects: [{ project_id: "project-1", name: "One" }], next_cursor: "page-2" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true; });
    await main(["projects", "list", "--api-url", "https://api.example.test", "--all", "--limit", "1", "--json"]);
    const result = JSON.parse(output.join(""));
    expect(result.projects.map((item: { project_id: string }) => item.project_id)).toEqual(["project-1", "project-2"]);
    expect(result).toMatchObject({ fetched_all: true, next_cursor: null });
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("cursor=page-2");
  });

  it("routes remote mutations with human identity, idempotency, and protected one-time secrets", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-mutations-"));
    const apiKeyFile = path.join(directory, "rotated-api-key");
    const runnerTokenFile = path.join(directory, "rotated-runner-token");
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_CLOUD_ACCESS_TOKEN", "human_mutation_session_never_print_123");
    const requests: Array<{
      path: string;
      method: string;
      idempotencyKey: string | null;
      credentialKind: string | null;
      body: Record<string, unknown>;
    }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({
        path: url.pathname,
        method: init?.method || "GET",
        idempotencyKey: headers.get("idempotency-key"),
        credentialKind: headers.get("x-synapsor-credential-kind"),
        body,
      });
      let response: Record<string, unknown> = { ok: true };
      if (url.pathname.endsWith("/activate") || url.pathname.endsWith("/rollback")) {
        response = { ok: true, version: { contract_version_id: "version-1", status: "active" } };
      } else if (url.pathname === "/v1/control/api-keys/rotate") {
        response = {
          ok: true,
          api_key: { key_id: "ak-2", token_prefix: "syn_dev_", status: "active" },
          token: "syn_api_rotated_one_time_secret_123456789",
          secret_available: true,
        };
      } else if (url.pathname === "/v1/control/api-keys/revoke") {
        response = { ok: true, api_key: { key_id: "ak-2", status: "revoked" } };
      } else if (url.pathname.endsWith("/runner-tokens/rnt-1/rotate")) {
        response = {
          ok: true,
          token: { token_id: "rnt-2", token_prefix: "syn_run_dev_", status: "active" },
          runner_token: "syn_run_dev_rotated_one_time_secret_123456789",
          secret_available: true,
        };
      } else if (url.pathname.endsWith("/runner-tokens/rnt-2/revoke")) {
        response = { ok: true, token: { token_id: "rnt-2", status: "revoked" } };
      } else if (url.pathname.endsWith("/approve") || url.pathname.endsWith("/reject")) {
        response = { ok: true, proposal: { proposal_id: url.pathname.includes("proposal-approve") ? "proposal-approve" : "proposal-reject", status: url.pathname.endsWith("/approve") ? "approved" : "rejected" } };
      } else if (url.pathname === "/v1/control/audit-export") {
        response = { ok: true, export: { export_id: "export-1", status: "ready", format: "jsonl" } };
      }
      return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    const run = async (command: string[]) => {
      stdout.length = 0;
      await expect(main([
        ...command,
        "--project", "project-1",
        "--api-url", "https://api.example.test",
        "--idempotency-key", `idempotency-${requests.length + 1}`,
        "--json",
      ])).resolves.toBe(0);
      expect(stdout.join(""))
        .not.toContain("human_mutation_session_never_print_123");
    };

    await run(["contracts", "activate", "contract-1/version-1", "--reason", "reviewed", "--yes"]);
    await run(["contracts", "rollback", "contract-1/version-1", "--reason", "rollback test", "--yes"]);
    await run(["api-keys", "rotate", "ak-1", "--secret-file", apiKeyFile]);
    await run(["api-keys", "revoke", "ak-2", "--yes"]);
    await run(["runners", "rotate-token", "rnt-1", "--secret-file", runnerTokenFile]);
    await run(["runners", "revoke-token", "rnt-2", "--yes"]);
    await run(["proposals", "approve", "proposal-approve", "--reason", "reviewed", "--yes"]);
    await run(["proposals", "reject", "proposal-reject", "--reason", "unsafe", "--yes"]);
    await run(["exports", "create", "--format", "jsonl", "--from", "2026-01-01", "--to", "2026-01-31"]);

    expect(await fs.readFile(apiKeyFile, "utf8")).toBe("syn_api_rotated_one_time_secret_123456789\n");
    expect((await fs.stat(apiKeyFile)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(runnerTokenFile, "utf8")).toBe("syn_run_dev_rotated_one_time_secret_123456789\n");
    expect((await fs.stat(runnerTokenFile)).mode & 0o777).toBe(0o600);
    expect(stdout.join(""))
      .not.toContain("one_time_secret");
    expect(requests).toHaveLength(9);
    expect(requests.every((request) => request.method === "POST")).toBe(true);
    expect(requests.every((request) => request.idempotencyKey?.startsWith("idempotency-"))).toBe(true);
    expect(requests.every((request) => request.credentialKind === "human")).toBe(true);
    expect(requests.map((request) => request.path)).toEqual([
      "/v1/control/projects/project-1/agent-contracts/contract-1/versions/version-1/activate",
      "/v1/control/projects/project-1/agent-contracts/contract-1/versions/version-1/rollback",
      "/v1/control/api-keys/rotate",
      "/v1/control/api-keys/revoke",
      "/v1/control/projects/project-1/runner-tokens/rnt-1/rotate",
      "/v1/control/projects/project-1/runner-tokens/rnt-2/revoke",
      "/v1/control/external-writebacks/proposals/proposal-approve/approve",
      "/v1/control/external-writebacks/proposals/proposal-reject/reject",
      "/v1/control/audit-export",
    ]);
    expect(requests[6]?.body).toMatchObject({ project_id: "project-1", reason: "reviewed" });
    expect(requests[7]?.body).toMatchObject({ project_id: "project-1", reason: "unsafe" });
  });

  it("maps every remote read command group to project-scoped Cloud APIs without dropping scalar IDs", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-cloud-cli-groups-"));
    vi.stubEnv("SYNAPSOR_CONFIG_HOME", path.join(directory, "config"));
    vi.stubEnv("SYNAPSOR_API_KEY", "syn_service_group_test_never_print_123");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = new URL(String(input));
      urls.push(`${url.pathname}${url.search}`);
      let body: Record<string, unknown> = { ok: true };
      if (url.pathname.endsWith("/sessions/self")) body = { ok: true, context: { key_id: "ak_group", project_id: "project-1", scopes: ["project:read"], entitlements: { plan: "builder", entitlement_status: "active" } } };
      else if (url.pathname.endsWith("/status")) body = { ok: true, status: "ready" };
      else if (url.pathname.endsWith("/entitlements")) body = { ok: true, entitlements: { plan: "builder", entitlement_status: "active" }, billing: { status: "active" } };
      else if (url.pathname.endsWith("/accounts")) body = { ok: true, accounts: [{ account_id: "workspace-1", name: "Workspace", status: "active" }] };
      else if (url.pathname === "/v1/control/projects") body = { ok: true, projects: [{ project_id: "project-1", name: "Project", plan: "builder", status: "active" }] };
      else if (url.pathname.endsWith("/projects/project-1")) body = { ok: true, project: { project_id: "project-1", name: "Project", plan: "builder", status: "active" } };
      else if (url.pathname === "/v1/control/external-sources") body = { ok: true, sources: [{ source_id: "source-1", name: "Postgres", kind: "postgres", status: "ready" }] };
      else if (url.pathname.endsWith("/external-sources/source-1")) body = { ok: true, source: { source_id: "source-1", name: "Postgres", kind: "postgres", status: "ready" } };
      else if (url.pathname.endsWith("/agent-contracts")) body = { ok: true, contracts: [{ contract_id: "contract-1", current_version_number: 1, name: "Contract", status: "active", digest: `sha256:${"a".repeat(64)}` }] };
      else if (url.pathname.endsWith("/agent-contracts/contract-1")) body = { ok: true, contract: { contract_id: "contract-1", name: "Contract" }, versions: [{ contract_version_id: "version-1", version_number: 1, status: "active", digest: `sha256:${"a".repeat(64)}` }] };
      else if (url.pathname === "/v1/control/api-keys") body = { ok: true, api_keys: [{ key_id: "ak_1", name: "CI", scopes: ["contracts:read", "contracts:write"], status: "active", token_prefix: "syn_api_" }] };
      else if (url.pathname.endsWith("/runners")) body = { ok: true, runners: [{ runner_id: "runner-1", status: "online", runner_version: "1.4.122", last_seen_at: "now" }] };
      else if (url.pathname.endsWith("/runners/runner-1")) body = { ok: true, runner: { runner_id: "runner-1", status: "online" } };
      else if (url.pathname.endsWith("/runner-activity")) body = { ok: true, events: [{ event_id: "event-1", event_type: "proposal.pending", proposal_id: "proposal-1", capability: "billing.propose", status: "pending_review", tenant_id: "acme", principal: `sha256:${"b".repeat(64)}` }] };
      else if (url.pathname.endsWith("/runner-activity/proposal-1")) body = {
        ok: true,
        proposal: { proposal_id: "proposal-1", evidence_metadata: { bundle_ids: ["ev_1"], payload_uploaded: false } },
        events: [{ event_id: "event-1", event_type: "evidence.recorded", evidence_ids: ["ev_1"], receipt_id: "receipt-1", replay_id: "replay-1", status: "applied" }],
        integrity: { ok: true, digest: `sha256:${"c".repeat(64)}` },
      };
      else if (url.pathname.endsWith("/audit-export/export-1")) body = { ok: true, export: { export_id: "export-1", status: "ready" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
    const runJson = async (command: string[]) => {
      stdout.length = 0;
      await expect(main([...command, "--project", "project-1", "--api-url", "https://api.example.test", "--json"])).resolves.toBe(0);
      return JSON.parse(stdout.join(""));
    };

    const whoami = await runJson(["auth", "whoami"]);
    expect(whoami).toMatchObject({ credential_kind: "service", selected_project: "project-1" });
    expect(whoami.identity).toMatchObject({ key_id: "ak_group", scopes: ["project:read"] });
    expect(whoami.entitlements).toMatchObject({ plan: "builder", entitlement_status: "active" });
    const status = await runJson(["status"]);
    expect(status.entitlements.entitlements).toMatchObject({ plan: "builder", entitlement_status: "active" });
    await runJson(["entitlements", "show"]);
    await runJson(["billing", "status"]);
    await runJson(["workspaces", "list"]);
    await runJson(["projects", "list"]);
    await runJson(["projects", "show", "project-1"]);
    await runJson(["sources", "list"]);
    await runJson(["sources", "show", "source-1"]);
    await runJson(["contracts", "list"]);
    await runJson(["contracts", "show", "contract-1"]);
    await runJson(["contracts", "history", "contract-1"]);
    const keys = await runJson(["api-keys", "list"]);
    expect(keys.api_keys[0].scopes).toEqual(["contracts:read", "contracts:write"]);
    await runJson(["runners", "list"]);
    await runJson(["runners", "show", "runner-1"]);
    await runJson(["proposals", "list"]);
    await runJson(["proposals", "show", "proposal-1"]);
    await runJson(["proposals", "decisions", "proposal-1"]);
    await runJson(["activity", "search"]);
    await runJson(["activity", "show", "proposal-1"]);
    const evidence = await runJson(["evidence", "show", "proposal-1"]);
    expect(evidence.evidence).toMatchObject({ bundle_ids: ["ev_1"], payload_uploaded: false });
    await runJson(["receipts", "show", "proposal-1"]);
    await runJson(["replay", "show", "proposal-1"]);
    await runJson(["replay", "verify", "proposal-1"]);
    await runJson(["exports", "status", "export-1"]);

    expect(urls).toContain("/v1/control/projects/project-1/entitlements");
    expect(urls).toContain("/v1/control/projects/project-1/runner-activity/proposal-1");
    expect(urls.join("\n")).not.toContain("syn_service_group_test_never_print_123");
  });
});
