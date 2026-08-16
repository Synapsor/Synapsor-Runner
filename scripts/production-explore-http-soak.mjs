import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const EXACT_TOOLS = ["app.describe_data", "app.explore_data"];
const DEFAULT_CALIBRATION_MS = 15 * 60 * 1_000;
const DEFAULT_LOAD_MS = 3 * 60 * 60 * 1_000;
const DEFAULT_RECOVERY_MS = 15 * 60 * 1_000;
const DEFAULT_MIN_INTERVAL_MS = 8_000;
const DEFAULT_MAX_INTERVAL_MS = 20_000;
const DEFAULT_BURST_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_RECONNECT_INTERVAL_MS = 8 * 60 * 1_000;
const DEFAULT_RESERVED_IDENTITIES = 25;

function integerEnv(name, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function latencySummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    min_ms: sorted[0] ?? 0,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
    max_ms: sorted.at(-1) ?? 0,
  };
}

export function processGroupSnapshot(processGroupId) {
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 1) return undefined;
  const members = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const pid = Number(entry);
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) continue;
      const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const memberProcessGroup = Number(fieldsAfterCommand[2]);
      if (memberProcessGroup !== processGroupId) continue;
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const value = (name) => Number(status.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
      members.push({
        rss_kib: value("VmRSS"),
        peak_rss_kib: value("VmHWM"),
        threads: value("Threads"),
        file_descriptors: fs.readdirSync(`/proc/${pid}/fd`).length,
      });
    } catch {
      // A process may exit between the /proc directory and file reads.
    }
  }
  if (!members.length) return undefined;
  return {
    at: new Date().toISOString(),
    processes: members.length,
    rss_kib: members.reduce((sum, member) => sum + member.rss_kib, 0),
    peak_rss_kib: members.reduce((sum, member) => sum + member.peak_rss_kib, 0),
    threads: members.reduce((sum, member) => sum + member.threads, 0),
    file_descriptors: members.reduce((sum, member) => sum + member.file_descriptors, 0),
  };
}

export function assertSoakServerAlive(input) {
  if (input.exit_state) {
    const outcome = input.exit_state.signal ?? input.exit_state.code ?? "unknown";
    throw new Error(`Production Explore server process exited during soak (${outcome}) at ${input.exit_state.at ?? "unknown time"}.`);
  }
  if (!input.process_sample) {
    throw new Error("Production Explore server process group disappeared during soak.");
  }
  if (input.expected_processes !== undefined
    && input.process_sample.processes !== input.expected_processes) {
    throw new Error(
      `Production Explore server process group changed from ${input.expected_processes} to ${input.process_sample.processes} processes during soak.`,
    );
  }
  return input.process_sample.processes;
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP result did not contain structured content.");
  return JSON.parse(text);
}

export function summarizeExploreToolCalls(toolCalls) {
  const successful = toolCalls.filter((call) =>
    call.tool === "app.explore_data" && call.status === "ok");
  const refused = toolCalls.filter((call) =>
    call.tool === "app.explore_data" && call.status === "refused");
  return {
    successful,
    refused,
    last_successful: successful.at(-1),
    last_refused: refused.at(-1),
  };
}

function safeError(error) {
  return String(error instanceof Error ? `${error.name}: ${error.message}` : error)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .slice(0, 2_000);
}

export async function closeStreamableHttpClientHandle(handle) {
  let terminationError;
  try {
    await handle.transport?.terminateSession?.();
  } catch (error) {
    terminationError = error;
  }
  try {
    await handle.client.close();
  } catch (error) {
    if (!terminationError) terminationError = error;
  }
  if (terminationError) throw terminationError;
}

export function assertExactNumericBandResult(payload, input) {
  const allExpected = new Map();
  for (const value of input.values) {
    const edgeIndex = input.edges.findIndex((edge) => value < edge);
    const label = input.labels[edgeIndex === -1 ? input.edges.length : edgeIndex];
    allExpected.set(label, (allExpected.get(label) ?? 0) + 1);
  }
  const minimumCount = input.minimum_count ?? 1;
  const expected = new Map([...allExpected].filter(([_label, count]) => count >= minimumCount));
  const expectedSuppressed = [...allExpected.values()].filter((count) => count < minimumCount).length;
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const actual = new Map(rows.map((row) => [row[input.field], Number(row.count)]));
  const matches = rows.length === actual.size
    && actual.size === expected.size
    && [...expected].every(([label, count]) => actual.get(label) === count)
    && Number(payload.privacy?.suppressed_groups ?? 0) === expectedSuppressed;
  if (!matches) {
    throw new Error(`${input.context} ${JSON.stringify({
      expected: Object.fromEntries(expected),
      expected_suppressed_groups: expectedSuppressed,
      actual: Object.fromEntries(actual),
      actual_suppressed_groups: payload.privacy?.suppressed_groups,
    })}`);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function operationByWeight(operations, random) {
  const total = operations.reduce((sum, operation) => sum + operation.weight, 0);
  let selected = random() * total;
  for (const operation of operations) {
    selected -= operation.weight;
    if (selected < 0) return operation;
  }
  return operations.at(-1);
}

async function withTimeout(promise, milliseconds, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms.`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function productionExploreSoakRequested() {
  return process.env.SYNAPSOR_PRODUCTION_EXPLORE_SOAK === "1";
}

export function assertSoakHasNoUnexpectedErrors(input) {
  if (input.requests === 0) {
    throw new Error("Hermetic production Explore soak completed without sending a request.");
  }
  if (Number(input.security_failures ?? 0) !== 0) {
    throw new Error(
      `Hermetic production Explore soak recorded ${input.security_failures} security failure(s).`,
    );
  }
  const unexpectedRate = input.unexpected_errors / input.requests;
  if (input.unexpected_errors !== 0) {
    throw new Error(
      `Hermetic production Explore soak recorded ${input.unexpected_errors} unexpected error(s) `
      + `across ${input.requests} requests (${(unexpectedRate * 100).toFixed(3)}%).`,
    );
  }
  return unexpectedRate;
}

export function assertSoakOperationCoverage(operationCounters) {
  const entries = Object.entries(operationCounters ?? {});
  if (entries.length === 0) {
    throw new Error("Hermetic production Explore soak had no configured operation coverage.");
  }
  const omitted = entries
    .filter(([_name, counter]) => Number(counter?.attempted ?? 0) < 1)
    .map(([name]) => name)
    .sort();
  if (omitted.length > 0) {
    throw new Error(`Hermetic production Explore soak did not execute: ${omitted.join(", ")}.`);
  }
  return { pass: true, operations: entries.map(([name]) => name).sort() };
}

export function expectedStandaloneQueryAuditRange(operationCounters, additionalExpectedRefusals = 0) {
  const entries = Object.values(operationCounters ?? {});
  const handlerRefusals = entries
    .filter((counter) => counter?.audit_expectation === "query_audit")
    .reduce((sum, counter) => sum + Number(counter.expected_refusals ?? 0), 0);
  const strictSchemaRefusals = entries
    .filter((counter) => counter?.audit_expectation === "pre_handler_no_query_audit")
    .reduce((sum, counter) => sum + Number(counter.expected_refusals ?? 0), 0);
  const additional = Number(additionalExpectedRefusals ?? 0);
  return {
    minimum: handlerRefusals,
    maximum: handlerRefusals + additional,
    handler_refusals: handlerRefusals,
    strict_schema_refusals: strictSchemaRefusals,
    additional_unclassified_refusals: additional,
  };
}

export function assertSoakProcessResourcesBounded(input) {
  const process = input.process;
  if (!process?.first || !process?.last || process.samples < 1) {
    throw new Error("Hermetic production Explore soak did not capture process resource samples.");
  }
  const activeClients = Number(input.active_clients ?? 0);
  const threadCeiling = process.first.threads + 8;
  const descriptorCeiling = process.first.file_descriptors + (activeClients * 3) + 32;
  const sustainedRssGrowthCeilingKib = 128 * 1_024;
  const transientRssGrowthCeilingKib = 256 * 1_024;
  const baselineRss = process.first_quarter_median_rss_kib ?? process.first.rss_kib;
  const terminalRss = process.last_quarter_median_rss_kib ?? process.last.rss_kib;
  const sustainedRssGrowthKib = terminalRss - baselineRss;
  const transientRssGrowthKib = (process.max_peak_rss_kib ?? process.max_rss_kib)
    - process.first.rss_kib;
  if (process.max_threads > threadCeiling) {
    throw new Error(
      `Production Explore soak threads reached ${process.max_threads}; the bounded ceiling is ${threadCeiling}.`,
    );
  }
  if (process.max_file_descriptors > descriptorCeiling) {
    throw new Error(
      `Production Explore soak file descriptors reached ${process.max_file_descriptors}; `
      + `the ${activeClients}-client ceiling is ${descriptorCeiling}.`,
    );
  }
  if (sustainedRssGrowthKib > sustainedRssGrowthCeilingKib) {
    throw new Error(
      `Production Explore soak sustained RSS grew by ${sustainedRssGrowthKib} KiB; `
      + `the bounded ceiling is ${sustainedRssGrowthCeilingKib} KiB.`,
    );
  }
  if (transientRssGrowthKib > transientRssGrowthCeilingKib) {
    throw new Error(
      `Production Explore soak peak RSS grew by ${transientRssGrowthKib} KiB; `
      + `the bounded ceiling is ${transientRssGrowthCeilingKib} KiB.`,
    );
  }
  return {
    pass: true,
    thread_ceiling: threadCeiling,
    descriptor_ceiling: descriptorCeiling,
    sustained_rss_growth_kib: sustainedRssGrowthKib,
    sustained_rss_growth_ceiling_kib: sustainedRssGrowthCeilingKib,
    transient_rss_growth_kib: transientRssGrowthKib,
    transient_rss_growth_ceiling_kib: transientRssGrowthCeilingKib,
  };
}

export function productionExploreSoakConfiguration() {
  const minIntervalMs = integerEnv("SYNAPSOR_SOAK_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS, 100);
  const maxIntervalMs = integerEnv("SYNAPSOR_SOAK_MAX_INTERVAL_MS", DEFAULT_MAX_INTERVAL_MS, minIntervalMs);
  return {
    calibration_ms: integerEnv("SYNAPSOR_SOAK_CALIBRATION_MS", DEFAULT_CALIBRATION_MS, 0),
    load_ms: integerEnv("SYNAPSOR_SOAK_DURATION_MS", DEFAULT_LOAD_MS, 1_000),
    recovery_ms: integerEnv("SYNAPSOR_SOAK_RECOVERY_MS", DEFAULT_RECOVERY_MS, 0),
    min_interval_ms: minIntervalMs,
    max_interval_ms: maxIntervalMs,
    burst_interval_ms: integerEnv("SYNAPSOR_SOAK_BURST_INTERVAL_MS", DEFAULT_BURST_INTERVAL_MS, 1_000),
    reconnect_interval_ms: integerEnv("SYNAPSOR_SOAK_RECONNECT_INTERVAL_MS", DEFAULT_RECONNECT_INTERVAL_MS, 5_000),
    request_timeout_ms: integerEnv("SYNAPSOR_SOAK_REQUEST_TIMEOUT_MS", 30_000, 1_000),
    progress_interval_ms: integerEnv("SYNAPSOR_SOAK_PROGRESS_INTERVAL_MS", 60_000, 1_000),
    process_sample_interval_ms: integerEnv("SYNAPSOR_SOAK_PROCESS_SAMPLE_INTERVAL_MS", 15_000, 500),
    active_clients: integerEnv("SYNAPSOR_SOAK_ACTIVE_CLIENTS", 20, 1, 100),
    max_requests_per_identity: integerEnv("SYNAPSOR_SOAK_REQUESTS_PER_IDENTITY", 30, 1, 39),
  };
}

export function productionExploreSoakIdentities() {
  const configuration = productionExploreSoakConfiguration();
  const averageInterval = (configuration.min_interval_ms + configuration.max_interval_ms) / 2;
  const normalRequests = Math.ceil((configuration.calibration_ms + configuration.load_ms) / averageInterval);
  const burstRequests = Math.ceil(configuration.load_ms / configuration.burst_interval_ms);
  const identitiesPerClient = Math.ceil(
    (normalRequests + burstRequests) / configuration.max_requests_per_identity,
  ) + 2;
  const reservedIdentities = integerEnv(
    "SYNAPSOR_SOAK_RESERVED_IDENTITIES",
    DEFAULT_RESERVED_IDENTITIES,
    1,
    100,
  );
  const count = configuration.active_clients * identitiesPerClient + reservedIdentities;
  return Array.from({ length: count }, (_unused, index) => {
    const tenantIndex = index % 5;
    const principalIndex = Math.floor(index / 5) + 1;
    return {
      tenant: `soak-tenant-${tenantIndex + 1}`,
      principal: `soak-t${tenantIndex + 1}-p${String(principalIndex).padStart(3, "0")}`,
      index,
    };
  });
}

export function applyProductionExploreSoakBudgets(candidate, runtimeConfig) {
  // Boundary privacy budgets are subtractive-only. The soak rotates principals
  // instead of widening their reviewed per-principal limits.
  void candidate;
  if (runtimeConfig) {
    runtimeConfig.production_explore.tenant_limits = {
      max_queries_per_rolling_24_hours: 100_000,
      max_extracted_cells_per_rolling_24_hours: 10_000_000,
      max_differencing_queries_per_rolling_24_hours: 10_000,
      requests_per_minute: 10_000,
      max_response_cells_per_response: 500,
    };
  }
}

export async function runProductionExploreHttpSoak(input) {
  const configuration = productionExploreSoakConfiguration();
  const startedAt = new Date();
  const calibrationEndsAt = Date.now() + configuration.calibration_ms;
  const loadEndsAt = calibrationEndsAt + configuration.load_ms;
  const progressPath = input.result_path;
  const latencies = [];
  const processSamples = [];
  const sourceConnectionSamples = [];
  const operationCounters = Object.fromEntries(input.operations.map((operation) => [operation.name, {
    attempted: 0,
    succeeded: 0,
    expected_refusals: 0,
    session_capacity_refusals: 0,
    unexpected_errors: 0,
    audit_expectation: operation.expected_refusal
      ? operation.audit_expectation ?? "query_audit"
      : operation.name === "catalog" ? "none" : "evidence_bundle",
    latency_ms: [],
  }]));
  const state = {
    engine: input.engine,
    phase: configuration.calibration_ms > 0 ? "calibration" : "load",
    started_at: startedAt.toISOString(),
    completed_at: undefined,
    configuration,
    identities: input.identities.length,
    active_clients: configuration.active_clients,
    requests: 0,
    successes: 0,
    expected_refusals: 0,
    session_capacity_refusals: 0,
    unexpected_errors: 0,
    reconnects: 0,
    bursts: 0,
    security_failures: 0,
    errors: [],
  };
  if (input.identities.length < configuration.active_clients) {
    throw new Error(`Soak requires at least ${configuration.active_clients} identities.`);
  }
  let nextIdentity = configuration.active_clients;
  const clients = input.identities.slice(0, configuration.active_clients).map((identity, index) => ({
    identity,
    index,
    handle: undefined,
    connected_at: 0,
    random: seededRandom(0x51a7_0000 + index),
    tail: Promise.resolve(),
    requests_for_identity: 0,
  }));
  let stopping = false;
  let fatal;
  let expectedServerProcesses;

  const snapshot = () => {
    const processRss = processSamples.map((sample) => sample.rss_kib);
    const processPeakRss = processSamples.map((sample) => sample.peak_rss_kib);
    const sourceConnections = sourceConnectionSamples.map((sample) => sample.count);
    const quarterSize = Math.max(1, Math.floor(processRss.length / 4));
    const firstQuarterRss = processRss.slice(0, quarterSize).sort((left, right) => left - right);
    const lastQuarterRss = processRss.slice(-quarterSize).sort((left, right) => left - right);
    return {
      schema_version: "synapsor.production-explore-soak.v1",
      ...state,
      operation_counters: Object.fromEntries(Object.entries(operationCounters).map(([name, counter]) => [name, {
        attempted: counter.attempted,
        succeeded: counter.succeeded,
        expected_refusals: counter.expected_refusals,
        session_capacity_refusals: counter.session_capacity_refusals,
        unexpected_errors: counter.unexpected_errors,
        audit_expectation: counter.audit_expectation,
        latency: latencySummary(counter.latency_ms),
      }])),
      latency: latencySummary(latencies),
      process: {
        samples: processSamples.length,
        first: processSamples[0],
        last: processSamples.at(-1),
        first_quarter_median_rss_kib: percentile(firstQuarterRss, 0.5),
        last_quarter_median_rss_kib: percentile(lastQuarterRss, 0.5),
        min_rss_kib: processRss.length ? Math.min(...processRss) : 0,
        max_rss_kib: processRss.length ? Math.max(...processRss) : 0,
        max_peak_rss_kib: processPeakRss.length ? Math.max(...processPeakRss) : 0,
        max_processes: processSamples.length
          ? Math.max(...processSamples.map((sample) => sample.processes)) : 0,
        max_threads: processSamples.length ? Math.max(...processSamples.map((sample) => sample.threads)) : 0,
        max_file_descriptors: processSamples.length
          ? Math.max(...processSamples.map((sample) => sample.file_descriptors)) : 0,
      },
      source_connections: {
        samples: sourceConnectionSamples.length,
        maximum: sourceConnections.length ? Math.max(...sourceConnections) : 0,
        configured_ceiling: input.source_connection_ceiling,
      },
    };
  };

  const persist = () => writeJsonAtomic(progressPath, snapshot());

  const closeClient = async (clientState) => {
    const handle = clientState.handle;
    clientState.handle = undefined;
    clientState.connected_at = 0;
    if (handle) await closeStreamableHttpClientHandle(handle);
  };

  const rotateClientIdentity = async (clientState) => {
    if (clientState.requests_for_identity < configuration.max_requests_per_identity) return;
    if (nextIdentity >= input.identities.length) {
      throw new Error("The deterministic soak identity pool was exhausted before load completed.");
    }
    await closeClient(clientState);
    clientState.identity = input.identities[nextIdentity];
    nextIdentity += 1;
    clientState.requests_for_identity = 0;
  };

  const connectClient = async (clientState) => {
    await closeClient(clientState);
    const handle = await input.create_client(clientState.identity);
    await withTimeout(handle.client.connect(handle.transport), configuration.request_timeout_ms, "MCP connect");
    const listed = await withTimeout(handle.client.listTools(), configuration.request_timeout_ms, "MCP listTools");
    const names = listed.tools.map((tool) => tool.name);
    if (JSON.stringify(names) !== JSON.stringify(EXACT_TOOLS)) {
      await closeStreamableHttpClientHandle(handle).catch(() => undefined);
      state.security_failures += 1;
      throw new Error(`Tool-surface lock failed: ${JSON.stringify(names)}.`);
    }
    clientState.handle = handle;
    clientState.connected_at = Date.now();
    state.reconnects += 1;
  };

  const invoke = async (clientState, operation, burst = false) => {
    if (fatal || stopping) return;
    const counter = operationCounters[operation.name];
    counter.attempted += 1;
    state.requests += 1;
    const began = performance.now();
    try {
      if (!clientState.handle
        || Date.now() - clientState.connected_at >= configuration.reconnect_interval_ms) {
        await connectClient(clientState);
      }
      const request = operation.request(clientState.identity);
      const result = await withTimeout(
        clientState.handle.client.callTool(request),
        configuration.request_timeout_ms,
        `${operation.name} callTool`,
      );
      const elapsed = Math.round((performance.now() - began) * 100) / 100;
      latencies.push(elapsed);
      counter.latency_ms.push(elapsed);
      if (operation.expected_refusal) {
        if (result.isError !== true || !operation.validate_refusal(result, clientState.identity)) {
          state.security_failures += 1;
          throw new Error(`${operation.name} was not refused with the expected fail-closed response.`);
        }
        state.expected_refusals += 1;
        counter.expected_refusals += 1;
        return;
      }
      const payload = resultPayload(result);
      if (result.isError === true || payload.ok === false) {
        throw new Error(`${operation.name} returned an unexpected refusal: ${JSON.stringify(payload).slice(0, 1_000)}`);
      }
      const serialized = JSON.stringify(payload);
      if (/\b(?:SELECT|INSERT|UPDATE|DELETE)\s/i.test(serialized)
        || /operator-only|synthetic kept-out|@example\.invalid/i.test(serialized)) {
        state.security_failures += 1;
        throw new Error(`${operation.name} disclosed SQL or a fixture-only kept-out marker.`);
      }
      try {
        operation.validate(payload, clientState.identity);
      } catch (error) {
        state.security_failures += 1;
        throw new Error(`Exact scoped result validation failed for ${operation.name}: ${safeError(error)}`);
      }
      state.successes += 1;
      counter.succeeded += 1;
    } catch (error) {
      const message = safeError(error);
      if (/principal_session_capacity_exhausted/i.test(message)) {
        counter.session_capacity_refusals += 1;
        state.session_capacity_refusals += 1;
        await closeClient(clientState);
        return;
      }
      counter.unexpected_errors += 1;
      state.unexpected_errors += 1;
      state.errors.push({
        at: new Date().toISOString(),
        operation: operation.name,
        principal: clientState.identity.principal,
        burst,
        message,
      });
      state.errors = state.errors.slice(-100);
      await closeClient(clientState);
      if (state.security_failures > 0 || /Tool-surface lock failed|disclosed SQL|scope isolation|exact scoped/i.test(message)) {
        fatal = error;
        stopping = true;
      }
    }
  };

  const schedule = (clientState, operation, burst = false) => {
    const scheduled = clientState.tail.then(async () => {
      await rotateClientIdentity(clientState);
      await invoke(clientState, operation, burst);
      clientState.requests_for_identity += 1;
    });
    clientState.tail = scheduled.catch(() => undefined);
    return scheduled;
  };

  const monitor = async () => {
    while (!stopping && Date.now() < loadEndsAt) {
      const processSample = processGroupSnapshot(input.server_pid);
      try {
        expectedServerProcesses = assertSoakServerAlive({
          exit_state: input.server_exit_state?.(),
          process_sample: processSample,
          expected_processes: expectedServerProcesses,
        });
      } catch (error) {
        fatal = error;
        stopping = true;
        state.errors.push({
          at: new Date().toISOString(),
          operation: "server_process",
          burst: false,
          message: safeError(error),
        });
        persist();
        break;
      }
      processSamples.push(processSample);
      if (input.source_connection_count) {
        const count = await input.source_connection_count();
        sourceConnectionSamples.push({ at: new Date().toISOString(), count });
        if (count > input.source_connection_ceiling) {
          state.security_failures += 1;
          fatal = new Error(`Source connections reached ${count}, above the configured ceiling ${input.source_connection_ceiling}.`);
          stopping = true;
          break;
        }
      }
      await sleep(configuration.process_sample_interval_ms);
    }
  };

  const progress = async () => {
    while (!stopping && Date.now() < loadEndsAt) {
      await sleep(configuration.progress_interval_ms);
      if (Date.now() >= calibrationEndsAt) state.phase = "load";
      persist();
      process.stderr.write(`[soak:${input.engine}] ${state.phase} requests=${state.requests} ok=${state.successes} expected_refusals=${state.expected_refusals} session_capacity=${state.session_capacity_refusals} unexpected=${state.unexpected_errors}\n`);
    }
  };

  const clientLoop = async (clientState) => {
    await sleep(Math.floor(clientState.random() * Math.min(2_000, configuration.min_interval_ms)));
    while (!stopping && Date.now() < loadEndsAt) {
      const operation = operationByWeight(input.operations, clientState.random);
      await schedule(clientState, operation);
      const wait = configuration.min_interval_ms
        + Math.floor(clientState.random() * (configuration.max_interval_ms - configuration.min_interval_ms + 1));
      await sleep(wait);
    }
  };

  const bursts = async () => {
    let nextBurst = calibrationEndsAt + configuration.burst_interval_ms;
    while (!stopping && nextBurst < loadEndsAt) {
      await sleep(Math.min(1_000, Math.max(0, nextBurst - Date.now())));
      if (Date.now() < nextBurst) continue;
      state.bursts += 1;
      const calls = clients.map((clientState) => {
        const legal = input.operations.filter((operation) => !operation.expected_refusal);
        return schedule(clientState, legal[clientState.index % legal.length], true);
      });
      await Promise.all(calls);
      if (input.source_connection_count) {
        for (let sample = 0; sample < 10; sample += 1) {
          const count = await input.source_connection_count();
          sourceConnectionSamples.push({ at: new Date().toISOString(), count, burst: state.bursts });
          if (count > input.source_connection_ceiling) {
            state.security_failures += 1;
            fatal = new Error(`Burst source connections reached ${count}, above ceiling ${input.source_connection_ceiling}.`);
            stopping = true;
            break;
          }
          await sleep(10);
        }
      }
      nextBurst += configuration.burst_interval_ms;
    }
  };

  persist();
  try {
    await Promise.all([
      ...clients.map(clientLoop),
      monitor(),
      progress(),
      bursts(),
    ]);
  } finally {
    stopping = true;
    await Promise.allSettled(clients.map(closeClient));
  }
  if (fatal) throw fatal;
  state.phase = "completed";
  state.completed_at = new Date().toISOString();
  const completed = snapshot();
  const unexpectedRate = assertSoakHasNoUnexpectedErrors(state);
  completed.operation_coverage = assertSoakOperationCoverage(completed.operation_counters);
  completed.process_resource_gate = assertSoakProcessResourcesBounded({
    process: completed.process,
    active_clients: configuration.active_clients,
  });
  if (completed.source_connections.maximum > input.source_connection_ceiling) {
    throw new Error("The source connection ceiling was exceeded.");
  }
  completed.pass = true;
  completed.unexpected_error_rate = unexpectedRate;
  writeJsonAtomic(progressPath, completed);
  return completed;
}

export async function runProductionExploreRecovery(input) {
  const configuration = productionExploreSoakConfiguration();
  const startedAt = Date.now();
  const samples = [];
  let requests = 0;
  while (Date.now() - startedAt < configuration.recovery_ms || requests === 0) {
    const handle = await input.create_client(input.identity);
    try {
      await withTimeout(handle.client.connect(handle.transport), configuration.request_timeout_ms, "recovery connect");
      const tools = await handle.client.listTools();
      if (JSON.stringify(tools.tools.map((tool) => tool.name)) !== JSON.stringify(EXACT_TOOLS)) {
        throw new Error("Recovery server exposed an unexpected MCP tool surface.");
      }
      const result = await handle.client.callTool(input.request(input.identity));
      if (result.isError === true) throw new Error(`Recovery request was refused: ${JSON.stringify(result)}`);
      const payload = resultPayload(result);
      input.validate(payload, input.identity);
      requests += 1;
      samples.push({
        at: new Date().toISOString(),
        latency: "accepted",
        process: processGroupSnapshot(input.server_pid),
        source_connections: input.source_connection_count ? await input.source_connection_count() : undefined,
      });
    } finally {
      await closeStreamableHttpClientHandle(handle);
    }
    if (Date.now() - startedAt < configuration.recovery_ms) {
      await sleep(Math.min(30_000, configuration.recovery_ms - (Date.now() - startedAt)));
    }
  }
  const result = {
    schema_version: "synapsor.production-explore-recovery.v1",
    engine: input.engine,
    started_at: new Date(startedAt).toISOString(),
    completed_at: new Date().toISOString(),
    requests,
    samples,
    pass: true,
  };
  const maximumSourceConnections = Math.max(
    0,
    ...samples.map((sample) => Number(sample.source_connections ?? 0)),
  );
  result.maximum_source_connections = maximumSourceConnections;
  if (input.source_connection_ceiling !== undefined
    && maximumSourceConnections > input.source_connection_ceiling) {
    throw new Error(
      `Recovery exceeded the source connection ceiling: ${maximumSourceConnections} > ${input.source_connection_ceiling}.`,
    );
  }
  writeJsonAtomic(input.result_path, result);
  return result;
}

export async function waitForSourceConnectionQuiescence(input) {
  const deadline = Date.now() + (input.timeout_ms ?? 15_000);
  let count = await input.source_connection_count();
  while (count > (input.maximum ?? 0) && Date.now() < deadline) {
    await sleep(100);
    count = await input.source_connection_count();
  }
  if (count > (input.maximum ?? 0)) {
    throw new Error(
      `${input.engine} source connections did not quiesce after server shutdown: ${count} remain.`,
    );
  }
}

export async function verifyProductionExploreAuditSink(input) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.schema)) {
    throw new Error("Audit verification requires a safe control-schema identifier.");
  }
  const table = `"${input.schema}".production_explore_audit_events`;
  const summaryResult = await input.control.query(`
    SELECT
      COUNT(*) FILTER (WHERE event_kind = 'evidence_bundle')::int AS evidence_bundles,
      COUNT(*) FILTER (WHERE event_kind = 'query_audit')::int AS query_audits,
      COUNT(*) FILTER (
        WHERE event_kind = 'evidence_bundle'
          AND payload_json #>> '{evidence_bundle,tenant_id}' ~ '^keyed:[a-f0-9]{64}$'
      )::int AS keyed_tenant_bundles,
      COUNT(*) FILTER (
        WHERE event_kind = 'evidence_bundle'
          AND payload_json #>> '{evidence_bundle,payload,principal}' ~ '^keyed:[a-f0-9]{64}$'
      )::int AS keyed_principal_bundles,
      COUNT(*) FILTER (
        WHERE event_kind = 'evidence_bundle'
          AND payload_json #>> '{evidence_bundle,payload,result_fingerprint}' ~ '^hmac-sha256:[a-f0-9]{64}$'
          AND payload_json #>> '{evidence_bundle,payload,result_values_persisted}' = 'false'
          AND payload_json #>> '{evidence_bundle,payload,trusted_scope,values_persisted}' = 'false'
          AND payload_json #>> '{evidence_bundle,payload,source_database_changed}' = 'false'
      )::int AS redacted_evidence_bundles,
      COUNT(*) FILTER (
        WHERE event_kind = 'evidence_bundle'
          AND jsonb_array_length(payload_json #> '{evidence_bundle,query_audit}') = 1
          AND payload_json #>> '{evidence_bundle,query_audit,0,payload,result_values_persisted}' = 'false'
          AND payload_json #>> '{evidence_bundle,query_audit,0,payload,trusted_scope_values_persisted}' = 'false'
          AND payload_json #>> '{evidence_bundle,query_audit,0,payload,source_database_changed}' = 'false'
      )::int AS redacted_embedded_query_audits,
      COUNT(*) FILTER (
        WHERE event_kind = 'query_audit'
          AND payload_json #>> '{query_audit,tenant_id}' ~ '^keyed:[a-f0-9]{64}$'
          AND payload_json #>> '{query_audit,principal}' ~ '^keyed:[a-f0-9]{64}$'
      )::int AS keyed_scope_query_audits,
      COUNT(*) FILTER (
        WHERE event_kind = 'query_audit'
          AND payload_json #>> '{query_audit,payload,result_values_persisted}' = 'false'
          AND payload_json #>> '{query_audit,payload,trusted_scope_values_persisted}' = 'false'
          AND payload_json #>> '{query_audit,payload,source_database_changed}' = 'false'
      )::int AS redacted_query_audits
    FROM ${table}
  `);
  const summary = summaryResult.rows[0] ?? {};
  const expectedExploreSuccesses = Object.entries(input.soak.operation_counters)
    .filter(([name]) => name !== "catalog")
    .reduce((sum, [_name, counter]) => sum + Number(counter.succeeded ?? 0), 0)
    + Number(input.additional_successful_explore_queries ?? 0);
  const expectedRefusals = Number(input.soak.expected_refusals ?? 0)
    + Number(input.additional_expected_refusals ?? 0);
  const expectedStandaloneAudits = expectedStandaloneQueryAuditRange(
    input.soak.operation_counters,
    input.additional_expected_refusals,
  );
  if (Number(summary.evidence_bundles) !== expectedExploreSuccesses) {
    throw new Error(
      `Audit sink contains ${summary.evidence_bundles} evidence bundles for ${expectedExploreSuccesses} accepted Explore queries: ${JSON.stringify(summary)}.`,
    );
  }
  if (Number(summary.keyed_tenant_bundles) !== Number(summary.evidence_bundles)
    || Number(summary.keyed_principal_bundles) !== Number(summary.evidence_bundles)
    || Number(summary.redacted_evidence_bundles) !== Number(summary.evidence_bundles)
    || Number(summary.redacted_embedded_query_audits) !== Number(summary.evidence_bundles)) {
    throw new Error(
      `One or more production evidence bundles lacked keyed scope, a result fingerprint, or redaction invariants: ${JSON.stringify(summary)}.`,
    );
  }
  if (Number(summary.query_audits) < expectedStandaloneAudits.minimum
    || Number(summary.query_audits) > expectedStandaloneAudits.maximum
    || Number(summary.keyed_scope_query_audits) !== Number(summary.query_audits)
    || Number(summary.redacted_query_audits) !== Number(summary.query_audits)) {
    throw new Error(
      `Production standalone query-audit rows did not match the expected handler-refusal range `
      + `${expectedStandaloneAudits.minimum}-${expectedStandaloneAudits.maximum}, or lacked metadata-only persistence invariants: `
      + `${JSON.stringify(summary)}; accepted Explore queries=${expectedExploreSuccesses}; expected refusals=${expectedRefusals}.`,
    );
  }
  const budgetResult = await input.control.query(`
    SELECT
      COUNT(DISTINCT reservation_id)::int AS reservations,
      COUNT(*)::int AS scope_rows,
      COUNT(*) FILTER (WHERE status = 'released')::int AS released_scope_rows,
      COUNT(*) FILTER (
        WHERE scope_fingerprint !~ '^sha256:[a-f0-9]{64}$'
          OR variant_fingerprint !~ '^sha256:[a-f0-9]{64}$'
      )::int AS malformed_fingerprints
    FROM "${input.schema}".production_explore_budget_reservations
  `);
  const budgets = budgetResult.rows[0] ?? {};
  if (Number(budgets.reservations) !== expectedExploreSuccesses
    || Number(budgets.scope_rows) !== expectedExploreSuccesses * 2
    || Number(budgets.released_scope_rows) !== expectedExploreSuccesses * 2
    || Number(budgets.malformed_fingerprints) !== 0) {
    throw new Error(`Durable budget reservations did not reconcile with accepted Explore queries: ${JSON.stringify(budgets)}.`);
  }
  for (const forbidden of input.forbidden_values) {
    const leaked = await input.control.query(`
      SELECT COUNT(*)::int AS count
      FROM ${table}
      WHERE payload_json::text ILIKE $1
    `, [`%${forbidden}%`]);
    if (Number(leaked.rows[0]?.count ?? 0) !== 0) {
      throw new Error(`Production audit payload persisted forbidden raw material matching ${JSON.stringify(forbidden)}.`);
    }
  }
  const result = {
    schema_version: "synapsor.production-explore-audit-verification.v1",
    engine: input.engine,
    verified_at: new Date().toISOString(),
    accepted_explore_queries: expectedExploreSuccesses,
    evidence_bundles: Number(summary.evidence_bundles),
    query_audits: Number(summary.query_audits),
    standalone_query_audit_expected_range: {
      minimum: expectedStandaloneAudits.minimum,
      maximum: expectedStandaloneAudits.maximum,
    },
    handler_refusals_audited: expectedStandaloneAudits.handler_refusals,
    strict_mcp_schema_refusals_without_query_audit: expectedStandaloneAudits.strict_schema_refusals,
    budget_reservations: Number(budgets.reservations),
    budget_scope_rows: Number(budgets.scope_rows),
    keyed_scope_only: true,
    result_values_persisted: false,
    trusted_scope_values_persisted: false,
    result_fingerprints_present: true,
    pass: true,
  };
  writeJsonAtomic(input.result_path, result);
  return result;
}


export function verifyProductionExploreOperatorLedger(input) {
  const invoke = (args) => {
    const result = input.invoke(args);
    if (result.status !== 0) {
      throw new Error(`Production ledger command failed: ${args.join(" ")}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
    return result;
  };
  const readJson = (args) => {
    const result = invoke(args);
    try {
      return { result, payload: JSON.parse(result.stdout) };
    } catch {
      throw new Error(`Production ledger command returned invalid JSON: ${args.join(" ")}\n${result.stdout ?? ""}`);
    }
  };
  const expectCommandFailure = (args, expected) => {
    const result = input.invoke(args);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (result.status === 0 || !expected.test(output)) {
      throw new Error(`Production ledger command did not fail as expected: ${args.join(" ")}\n${output}`);
    }
    if (/Could not read shared PostgreSQL ledger/i.test(output)) {
      throw new Error(`A command/argument error was mislabeled as a shared-ledger connectivity failure: ${args.join(" ")}\n${output}`);
    }
    return output;
  };
  const configArgs = ["--config", input.config_path];
  const evidenceList = readJson(["evidence", "list", ...configArgs, "--json"]);
  const evidence = evidenceList.payload.evidence ?? [];
  if (evidenceList.payload.ledger_source?.kind !== "shared_postgres"
    || evidenceList.payload.ledger_source?.schema !== input.schema
    || evidence.length === 0) {
    throw new Error(`Production evidence CLI did not read shared PostgreSQL schema ${input.schema}: ${evidenceList.result.stdout}`);
  }
  const identityArgs = [
    ...(input.tenant ? ["--tenant", input.tenant] : []),
    ...(input.principal ? ["--principal", input.principal] : []),
  ];
  const identityList = identityArgs.length
    ? readJson(["evidence", "list", ...configArgs, "--json", ...identityArgs, "--limit", "200"])
    : evidenceList;
  const identityEvidence = identityList.payload.evidence ?? [];
  if (identityArgs.length && identityEvidence.length === 0) {
    throw new Error(`Production evidence CLI could not resolve the plaintext tenant/principal through the configured HMAC key: ${identityList.result.stdout}`);
  }
  const selectedEvidence = identityEvidence.find((item) => item.source_id === input.source_id)
    ?? evidence.find((item) => item.source_id === input.source_id)
    ?? identityEvidence[0]
    ?? evidence[0];
  if (!selectedEvidence?.evidence_bundle_id || !selectedEvidence?.source_table || !selectedEvidence?.tenant_id) {
    throw new Error(`Production evidence CLI returned an incomplete evidence record: ${JSON.stringify(selectedEvidence)}`);
  }
  const boundaryDigest = selectedEvidence.payload?.boundary_digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(String(boundaryDigest ?? ""))) {
    throw new Error(`Production evidence CLI omitted the exact boundary digest: ${JSON.stringify(selectedEvidence)}`);
  }
  const since = new Date(Date.parse(selectedEvidence.created_at) - 1_000).toISOString();
  const evidenceFilteredResult = readJson([
    "evidence", "list", ...configArgs, "--json",
    ...identityArgs,
    "--resource", selectedEvidence.source_table,
    "--boundary", boundaryDigest,
    "--capability", "app.explore_data",
    "--outcome", "ok",
    "--since", since,
    "--limit", "5",
  ]);
  const evidenceFiltered = evidenceFilteredResult.payload.evidence ?? [];
  if (!evidenceFiltered.some((item) => item.evidence_bundle_id === selectedEvidence.evidence_bundle_id)) {
    throw new Error(`Production evidence CLI filters did not retain the matching shared-store record.\nSelected: ${JSON.stringify(selectedEvidence)}\nFiltered: ${evidenceFilteredResult.result.stdout}`);
  }
  const evidenceShow = invoke([
    "evidence", "show", selectedEvidence.evidence_bundle_id, ...configArgs, "--details",
  ]);
  if (!evidenceShow.stdout.includes(`Ledger: shared PostgreSQL schema ${input.schema}`)
    || !evidenceShow.stdout.includes(selectedEvidence.evidence_bundle_id)
    || !evidenceShow.stdout.includes("Boundary digest:")
    || !evidenceShow.stdout.includes("Generation lock:")
    || !evidenceShow.stdout.includes("Role posture:")
    || !evidenceShow.stdout.includes("Result fingerprint:")
    || !evidenceShow.stdout.includes("Execution duration:")
    || !evidenceShow.stdout.includes("Normalized reviewed plan:")) {
    throw new Error(`Production evidence show did not identify the shared ledger: ${evidenceShow.stdout}`);
  }

  const auditList = readJson([
    "query-audit", "list", ...configArgs, "--json",
    ...identityArgs,
    "--resource", selectedEvidence.source_table,
    "--boundary", boundaryDigest,
    "--capability", "app.explore_data",
    "--outcome", "ok",
    "--since", since,
    "--limit", "5",
  ]);
  const audits = auditList.payload.query_audit ?? [];
  if (auditList.payload.ledger_source?.kind !== "shared_postgres" || audits.length === 0) {
    throw new Error(`Production query-audit CLI did not read the dedicated shared-store records: ${auditList.result.stdout}`);
  }
  const selectedAudit = audits.find((item) => item.evidence_bundle_id === selectedEvidence.evidence_bundle_id) ?? audits[0];
  const auditShow = invoke(["query-audit", "show", String(selectedAudit.audit_id), ...configArgs, "--details"]);
  if (!auditShow.stdout.includes(`Ledger: shared PostgreSQL schema ${input.schema}`)
    || !auditShow.stdout.includes("Payload:")
    || !auditShow.stdout.includes("normalized_plan")) {
    throw new Error(`Production query-audit show was incomplete: ${auditShow.stdout}`);
  }

  const refusedAudit = readJson([
    "query-audit", "list", ...configArgs, "--json",
    "--outcome", "refused",
    "--limit", "200",
  ]);
  const refusedRows = refusedAudit.payload.query_audit ?? [];
  if (refusedRows.length === 0
    || refusedRows.some((row) => !String(row.payload?.status ?? "").startsWith("refused_"))) {
    throw new Error(`Production query-audit refusal search did not return only recorded refusals: ${refusedAudit.result.stdout}`);
  }

  expectCommandFailure(
    ["evidence", "show", "ev_explore_missing", ...configArgs, "--details"],
    /evidence bundle not found: ev_explore_missing/i,
  );
  expectCommandFailure(
    ["evidence", "list", ...configArgs, "--outcome", "refused"],
    /query-audit list --outcome refused/i,
  );
  expectCommandFailure(
    ["query-audit", "list", ...configArgs, "--tenant", "keyed:not-a-fingerprint"],
    /--tenant keyed fingerprints must use keyed:/i,
  );

  const serialized = [
    evidenceList.result.stdout,
    identityList.result.stdout,
    evidenceFilteredResult.result.stdout,
    evidenceShow.stdout,
    auditList.result.stdout,
    auditShow.stdout,
    refusedAudit.result.stdout,
  ].join("\n");
  for (const forbidden of [
    ...(input.forbidden_values ?? []),
    input.tenant,
    input.principal,
  ]) {
    if (forbidden && serialized.includes(forbidden)) {
      throw new Error("Production ledger operator output exposed a forbidden value.");
    }
  }
  return {
    ledger_source: evidenceList.payload.ledger_source,
    evidence_records: evidence.length,
    query_audit_records: audits.length,
    filters_verified: ["tenant", "principal", "resource", "boundary", "capability", "outcome", "since", "limit"],
    refusal_records: refusedRows.length,
    command_errors_preserved: true,
    read_only: true,
  };
}

export function verifyLocalExploreAuditRecords(input) {
  if (input.evidence.length !== input.expected_successes) {
    throw new Error(`Local Explore stored ${input.evidence.length} evidence bundles for ${input.expected_successes} successful queries.`);
  }
  if (input.audits.length !== input.expected_successes + input.expected_refusals) {
    throw new Error(`Local Explore stored ${input.audits.length} audit rows; expected ${input.expected_successes + input.expected_refusals}.`);
  }
  const serialized = JSON.stringify({ evidence: input.evidence, audits: input.audits });
  for (const forbidden of input.forbidden_values) {
    if (serialized.includes(forbidden)) {
      throw new Error(`Local Explore audit/evidence persisted forbidden raw material matching ${JSON.stringify(forbidden)}.`);
    }
  }
  for (const evidence of input.evidence) {
    const text = JSON.stringify(evidence);
    if (!/"result_fingerprint":"hmac-sha256:[a-f0-9]{64}"/i.test(text)
      || !text.includes('"result_values_persisted":false')
      || !text.includes('"values_persisted":false')
      || !text.includes('"source_database_changed":false')) {
      throw new Error("A local Explore evidence bundle lacks a result fingerprint or redaction invariant.");
    }
  }
  const refusalAudits = input.audits.filter((audit) => audit.payload?.status === "refused_before_source_execution");
  if (refusalAudits.length !== input.expected_refusals
    || refusalAudits.some((audit) => audit.payload?.source_execution_started !== false
      || audit.payload?.evidence_bundle_created !== false
      || audit.payload?.result_values_persisted !== false)) {
    throw new Error("A local pre-execution refusal was not recorded as a metadata-only, no-source audit event.");
  }
  if (input.audits.some((audit) => audit.payload?.result_values_persisted !== false
    || audit.payload?.source_database_changed !== false)) {
    throw new Error("A local Explore query-audit row persisted result values or reported a source mutation.");
  }
  const result = {
    schema_version: "synapsor.local-explore-audit-verification.v1",
    engine: input.engine,
    verified_at: new Date().toISOString(),
    evidence_bundles: input.evidence.length,
    query_audits: input.audits.length,
    refusal_audits: refusalAudits.length,
    result_values_persisted: false,
    trusted_scope_values_persisted: false,
    refusals_executed_source_query: false,
    result_fingerprints_present: true,
    pass: true,
  };
  writeJsonAtomic(input.result_path, result);
  return result;
}
