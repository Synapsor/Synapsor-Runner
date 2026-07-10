import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configurePage, createPage, launchChrome, navigateAndWait, waitForExpression } from "./cdp-client.mjs";

const [htmlPath, framesDir, rawFps = "8", rawDuration = "177"] = process.argv.slice(2);
const fps = Number(rawFps);
const duration = Number(rawDuration);
if (!htmlPath || !framesDir || !Number.isInteger(fps) || fps < 1 || !Number.isInteger(duration) || duration < 1) {
  throw new Error("usage: capture-frames.mjs <deck.html> <frames-dir> <fps> <duration-seconds>");
}

await rm(framesDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true, mode: 0o700 });
const profileDir = path.join(path.dirname(framesDir), "render-chrome-profile");
const chrome = await launchChrome({ userDataDir: profileDir, width: 1920, height: 1080 });

try {
  const page = await createPage(chrome.port);
  await configurePage(page, 1920, 1080);
  await navigateAndWait(page, pathToFileURL(path.resolve(htmlPath)).href);
  await waitForExpression(page, "window.__DEMO_READY === true", 10_000);

  const frameCount = fps * duration;
  const digits = String(frameCount).length;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const milliseconds = Math.round(((frame + 0.5) / fps) * 1000);
    await page.send("Runtime.evaluate", {
      expression: `window.__setDemoTime(${milliseconds})`,
      returnByValue: true,
    });
    const screenshot = await page.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 88,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const output = path.join(framesDir, `frame-${String(frame + 1).padStart(digits, "0")}.jpg`);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(output, Buffer.from(screenshot.data, "base64")));
    if ((frame + 1) % 100 === 0 || frame + 1 === frameCount) {
      console.log(`Captured ${frame + 1}/${frameCount} frames.`);
    }
  }
  page.close();
} finally {
  await chrome.close();
  await rm(profileDir, { recursive: true, force: true });
}
