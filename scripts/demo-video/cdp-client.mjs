import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function removeDirectoryWithRetries(directory, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(attempt * 150);
    }
  }
  throw lastError;
}

export async function launchChrome({ userDataDir, width = 1920, height = 1080 }) {
  await removeDirectoryWithRetries(userDataDir);
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });

  const child = spawn("google-chrome", [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--font-render-hinting=none",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 32_000) stderr = stderr.slice(-32_000);
  });

  const portFile = path.join(userDataDir, "DevToolsActivePort");
  let port = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [rawPort] = (await readFile(portFile, "utf8")).trim().split(/\r?\n/);
      port = Number(rawPort);
      if (port > 0) break;
    } catch {
      // Chrome has not written the port yet.
    }
    if (child.exitCode !== null) throw new Error(`Chrome exited before CDP was ready.\n${stderr}`);
    await sleep(100);
  }
  if (!port) {
    child.kill("SIGTERM");
    throw new Error(`Chrome CDP port was not created.\n${stderr}`);
  }

  return {
    child,
    port,
    stderr: () => stderr,
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(3000)]);
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await Promise.race([exited, sleep(2000)]);
      }
      await sleep(300);
    },
  };
}

export async function createPage(port, url = "about:blank") {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  if (!response.ok) throw new Error(`Could not create Chrome target: HTTP ${response.status}`);
  const target = await response.json();
  return connectCdp(target.webSocketDebuggerUrl);
}

export async function connectCdp(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
    if (message.id) {
      const promise = pending.get(message.id);
      if (!promise) return;
      pending.delete(message.id);
      if (message.error) promise.reject(new Error(`${message.error.message}: ${JSON.stringify(message.error.data ?? {})}`));
      else promise.resolve(message.result ?? {});
      return;
    }
    const waiters = listeners.get(message.method) ?? [];
    listeners.delete(message.method);
    for (const resolve of waiters) resolve(message.params ?? {});
  });

  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function waitFor(method, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for CDP event ${method}`)), timeoutMs);
      const wrapped = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      listeners.set(method, [...(listeners.get(method) ?? []), wrapped]);
    });
  }

  return {
    send,
    waitFor,
    close() {
      socket.close();
    },
  };
}

export async function configurePage(page, width, height) {
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  });
  await page.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
  await page.send("Emulation.setLocaleOverride", { locale: "en-US" });
}

export async function navigateAndWait(page, url, timeoutMs = 30_000) {
  const loaded = page.waitFor("Page.loadEventFired", timeoutMs);
  await page.send("Page.navigate", { url });
  await loaded;
  await page.send("Runtime.evaluate", {
    expression: "Promise.all([document.fonts?.ready, ...Array.from(document.images).map((image) => image.complete ? null : new Promise((resolve) => { image.onload = image.onerror = resolve; }))])",
    awaitPromise: true,
    returnByValue: true,
  });
}

export async function waitForExpression(page, expression, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await page.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.result?.value === true) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for browser expression: ${expression}`);
}

export async function captureScreenshot(page, outputPath, { format = "png", quality = 90 } = {}) {
  const result = await page.send("Page.captureScreenshot", {
    format,
    ...(format === "jpeg" ? { quality } : {}),
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, Buffer.from(result.data, "base64")));
}
