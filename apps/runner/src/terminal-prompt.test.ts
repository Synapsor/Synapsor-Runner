import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import type { ReadStream } from "node:tty";
import type { WriteStream } from "node:tty";
import { describe, expect, it } from "vitest";
import {
  createInPlaceTerminalRenderer,
  fitTerminalFrameToRows,
  withAlternateTerminalScreen,
  withRawTerminalScreen,
  withTerminalProgress,
} from "./terminal-prompt.js";

describe("terminal text input lifecycle", () => {
  it("preserves exact submitted operator evidence only when explicitly requested", () => {
    const script = `
      import { PassThrough } from 'node:stream';
      import { readTerminalTextWithEscape } from './apps/runner/src/terminal-prompt.ts';
      const input = new PassThrough(); const output = new PassThrough(); output.resume();
      Object.assign(input, {isTTY:true,isRaw:false,setRawMode(value){this.isRaw=value;}});
      Object.assign(output,{isTTY:true,columns:100,rows:30});
      const pending=readTerminalTextWithEscape('Meaning',input,output,{preserveWhitespace:true});
      input.write('  Waiting 😀  \\r');
      console.log(JSON.stringify({answer:await pending})); input.pause();
    `;
    const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type", "module", "--eval", script], {
      cwd: new URL("../../../", import.meta.url), env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000,
    });
    expect(JSON.parse(result).answer).toBe("  Waiting 😀  ");
  });
  // A child isolates uncaught readline errors, so a crashed adapter cannot
  // look like a fulfilled cancellation. This is a real readline component
  // check; installed OS-PTY controls separately cover actual terminal devices.
  it.each(["input-error", "end-raw-error", "blank", "value", "escape"])(
    "settles %s without crashing or applying a cancelled default",
    (scenario) => {
      const script = `
        import { PassThrough } from 'node:stream';
        import { readTerminalTextWithEscape } from './apps/runner/src/terminal-prompt.ts';
        const input = new PassThrough();
        const output = new PassThrough();
        output.resume();
        Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) {
          this.isRaw = value;
          if (!value && ${JSON.stringify(scenario)} === 'end-raw-error') {
            this.emit('error', Object.assign(new Error('Detached terminal'), { code: 'EIO' }));
          }
        }});
        Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
        const result = readTerminalTextWithEscape('Prompt', input, output, { defaultValue: 'source_db' });
        switch (${JSON.stringify(scenario)}) {
          case 'input-error': input.destroy(new Error('Owned input failure')); break;
          case 'end-raw-error': input.end(); break;
          case 'blank': input.write('\\r'); break;
          case 'value': input.write(' requested \\r'); break;
          case 'escape': input.emit('keypress', '\\u001b', { name: 'escape', sequence: '\\u001b' }); break;
        }
        const value = await result;
        input.pause();
        console.log(JSON.stringify({ value: value ?? null, errorListeners: input.listenerCount('error'),
          endListeners: input.listenerCount('end'), keypressListeners: input.listenerCount('keypress') }));
      `;
      const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type", "module", "--eval", script], {
        cwd: new URL("../../../", import.meta.url),
        env: { PATH: process.env.PATH },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(JSON.parse(output)).toEqual({
        value: scenario === "blank" ? "source_db" : scenario === "value" ? "requested" : null,
        errorListeners: 0,
        endListeners: 0,
        keypressListeners: 0,
      });
    },
  );
});

describe("terminal confirmation input lifecycle", () => {
  it.each(["boolean", "activation"])("cancels %s on a detached input without restoring its dead TTY", (kind) => {
    const script = `
      import { PassThrough } from 'node:stream';
      import { readTerminalBooleanConfirmation, readTerminalActivationConfirmation } from './apps/runner/src/terminal-prompt.ts';
      const input = new PassThrough();
      const output = new PassThrough();
      output.resume();
      Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) {
        if (!value && this.readableEnded) throw Object.assign(new Error('Detached terminal'), { code: 'EIO' });
        this.isRaw = value;
      }});
      Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
      const result = ${kind === "boolean" ? "readTerminalBooleanConfirmation" : "readTerminalActivationConfirmation"}('Prompt', input, output);
      input.end();
      const value = await result;
      console.log(JSON.stringify({ value: value ?? null, paused: input.isPaused(),
        errorListeners: input.listenerCount('error'), endListeners: input.listenerCount('end'),
        keypressListeners: input.listenerCount('keypress') }));
    `;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type", "module", "--eval", script], {
      cwd: new URL("../../../", import.meta.url), env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000,
    });
    expect(JSON.parse(output)).toEqual({ value: null, paused: true, errorListeners: 0, endListeners: 0, keypressListeners: 0 });
  });

  it.each(["healthy-EIO", "ended-EINVAL"])("does not suppress unrelated cleanup failure: %s", (scenario) => {
    const script = `
      import { PassThrough } from 'node:stream';
      import { readTerminalBooleanConfirmation } from './apps/runner/src/terminal-prompt.ts';
      const input = new PassThrough(); const output = new PassThrough(); output.resume();
      Object.assign(input, { isTTY: true, isRaw: false, setRawMode(value) {
        if (!value) throw Object.assign(new Error('Owned cleanup failure'), { code: '${scenario === "healthy-EIO" ? "EIO" : "EINVAL"}' });
        this.isRaw = value;
      }});
      Object.assign(output, { isTTY: true, columns: 100, rows: 30 });
      const result = readTerminalBooleanConfirmation('Prompt', input, output);
      ${scenario === "healthy-EIO" ? "input.emit('keypress', 'n', { name: 'n', sequence: 'n' });" : "input.end();"}
      let code; try { await result; } catch(error) { code = error.code; }
      console.log(JSON.stringify({ code, paused: input.isPaused(), errorListeners: input.listenerCount('error') }));
    `;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type", "module", "--eval", script], {
      cwd: new URL("../../../", import.meta.url), env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000,
    });
    expect(JSON.parse(output)).toEqual({ code: scenario === "healthy-EIO" ? "EIO" : "EINVAL", paused: true, errorListeners: 0 });
  });
});

describe("in-place terminal rendering", () => {
  it("never paints a custom background on the alternate terminal screen", async () => {
    const output = new PassThrough() as WriteStream & PassThrough;
    Object.assign(output, { isTTY: true });
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));

    await withAlternateTerminalScreen(output, async () => {
      output.write("Runner frame");
    });

    const rendered = chunks.join("");
    expect(rendered).toContain("\u001b[?1049h");
    expect(rendered).toContain("Runner frame");
    expect(rendered).not.toMatch(/\u001b\[(?:4[0-9]|48;)/u);
  });

  it("animates long terminal work and always restores the cursor", async () => {
    const output = new PassThrough() as WriteStream & PassThrough;
    Object.assign(output, { isTTY: true });
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    let finish: (() => void) | undefined;
    const operation = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const pending = withTerminalProgress(
      output,
      "Loading reviewed SQL",
      () => operation,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 195));
    finish?.();
    await pending;

    const rendered = chunks.join("");
    expect(rendered).toContain("| Loading reviewed SQL");
    expect(rendered).toContain("/ Loading reviewed SQL");
    expect(rendered).toContain("- Loading reviewed SQL");
    expect(rendered).toMatch(/\r\u001b\[2K\u001b\[\?25h$/u);
  });

  it("does not append a scrolling newline after the final frame row", () => {
    const output = new PassThrough() as WriteStream & PassThrough;
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const renderer = createInPlaceTerminalRenderer(output);

    renderer.render(["first", "second", "third"]);
    renderer.render(["FIRST", "SECOND", "THIRD"]);
    renderer.clear();

    const rendered = chunks.join("");
    expect(rendered).toContain("third\u001b[2F");
    expect(rendered).toContain("THIRD\u001b[2F\u001b[0J");
    expect(rendered).not.toContain("third\n");
    expect(rendered).not.toContain("THIRD\n");
    expect(rendered.match(/\r\n/gu)).toHaveLength(4);
  });

  it("clears rows left behind when a later frame is shorter", () => {
    const output = new PassThrough() as WriteStream & PassThrough;
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const renderer = createInPlaceTerminalRenderer(output);

    renderer.render(["one", "two", "three"]);
    const secondFrameStart = chunks.join("").length;
    renderer.render(["one"]);

    const secondFrame = chunks.join("").slice(secondFrameStart);
    expect(secondFrame).toBe(
      "\u001b[2F\u001b[2Kone\r\n\u001b[2K\r\n\u001b[2K",
    );
  });

  it("tracks the input cursor above a shrinking popup through repaint and clear", () => {
    const output = new PassThrough() as WriteStream & PassThrough;
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const renderer = createInPlaceTerminalRenderer(output);
    renderer.render(["you> /", "attach", "details", "help"], { row: 0, column: 6 });
    expect(chunks.join("")).toMatch(/\u001b\[3F\u001b\[7G$/u);
    chunks.length = 0;
    renderer.render(["you> /a", "attach"], { row: 0, column: 7 });
    expect(chunks.join("")).toBe(
      "\r\u001b[2Kyou> /a\r\n\u001b[2Kattach\r\n\u001b[2K\r\n\u001b[2K\u001b[3F\u001b[8G",
    );
    chunks.length = 0;
    renderer.render(["you> first line", "     second line"], { row: 1, column: 9 });
    expect(chunks.join("")).toMatch(/\u001b\[2F\u001b\[10G$/u);
    chunks.length = 0;
    renderer.clear();
    expect(chunks.join("")).toBe("\u001b[1F\u001b[0J");
  });

  it("keeps an oversized frame inside the terminal while retaining focus and controls", () => {
    const lines = [
      "TITLE",
      "Explanation",
      "",
      ...Array.from({ length: 12 }, (_, index) =>
        `${index === 8 ? ">" : " "} item ${index + 1}`),
      "",
      "Up/Down Select",
      "Enter Choose",
      "Esc Back",
    ];

    const fitted = fitTerminalFrameToRows(lines, 12);

    expect(fitted).toHaveLength(12);
    expect(fitted[0]).toBe("TITLE");
    expect(fitted).toContain("> item 9");
    expect(fitted).toContain("Enter Choose");
    expect(fitted.at(-1)).toBe("Esc Back");
    expect(fitted.join("\n")).toContain("rows hidden");
  });

  it("pages through an oversized frame without dropping its fixed header and controls", () => {
    const lines = [
      "TITLE",
      ...Array.from({ length: 16 }, (_, index) => `Context ${index + 1}`),
      "",
      "> Confirm",
      "Choice detail",
      "",
      "Enter Select",
      "PgUp/PgDn Scroll hidden details",
    ];

    const firstPage = fitTerminalFrameToRows(lines, 12);
    const secondPage = fitTerminalFrameToRows(lines, 12, 4);

    expect(firstPage).toContain("Context 1");
    expect(firstPage).not.toContain("Context 6");
    expect(secondPage).toContain("Context 6");
    expect(secondPage[0]).toBe("TITLE");
    expect(secondPage).toContain("> Confirm");
    expect(secondPage.at(-1)).toBe("PgUp/PgDn Scroll hidden details");
  });

  it("never writes more physical rows than a live terminal reports", () => {
    const output = new PassThrough() as WriteStream & PassThrough & { rows: number };
    output.rows = 8;
    const chunks: string[] = [];
    output.on("data", (chunk) => chunks.push(String(chunk)));
    const renderer = createInPlaceTerminalRenderer(output, {
      maxRows: () => output.rows,
    });

    renderer.render(Array.from({ length: 20 }, (_, index) =>
      `${index === 14 ? ">" : " "} row ${index + 1}`));

    const rendered = chunks.join("");
    expect((rendered.match(/\r\n/gu) ?? []).length + 1).toBeLessThanOrEqual(8);
    expect(rendered).toContain("> row 15");
    expect(rendered.endsWith("\n")).toBe(false);
  });

  it("honors every reported terminal height", () => {
    const lines = Array.from({ length: 30 }, (_, index) =>
      `${index === 17 ? ">" : " "} row ${index + 1}`);

    for (let rows = 1; rows <= 24; rows += 1) {
      const fitted = fitTerminalFrameToRows(lines, rows);
      expect(fitted.length, `rows=${rows}`).toBeLessThanOrEqual(rows);
    }
  });

  it("restores a fresh terminal stream and visible cursor after Escape", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(value: boolean): void;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (value: boolean) => {
      input.isRaw = value;
    };
    const output = new PassThrough() as WriteStream & PassThrough;
    Object.assign(output, { isTTY: true, columns: 100, rows: 24 });

    expect(input.readableFlowing).toBeNull();
    const interaction = withRawTerminalScreen(
      input as unknown as ReadStream,
      output,
      async (nextKey, render) => {
        render(["Evidence browser", "Esc Back"]);
        return nextKey();
      },
    );
    input.emit("keypress", "\u001b", { name: "escape", sequence: "\u001b" });

    await expect(interaction).resolves.toMatchObject({ name: "escape" });
    expect(input.isRaw).toBe(false);
    expect(input.isPaused()).toBe(true);
    expect(input.readableFlowing).toBe(false);
    const rendered = output.read()?.toString() ?? "";
    expect(rendered).toContain("\u001b[?25l");
    expect(rendered).toContain("\u001b[?25h");
  });

  it("uses the full live width instead of wrapping raw screens at 116 columns", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(value: boolean): void;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (value: boolean) => {
      input.isRaw = value;
    };
    const output = new PassThrough() as WriteStream & PassThrough;
    Object.assign(output, { isTTY: true, columns: 180, rows: 24 });
    const wideLine = [
      "This reviewed authority summary should remain on one line in a wide terminal",
      "instead of wrapping at the former fixed one-hundred-and-sixteen-column boundary.",
    ].join(" ");

    const interaction = withRawTerminalScreen(
      input as unknown as ReadStream,
      output,
      async (nextKey, render) => {
        render(["WIDE REVIEW", wideLine, "Esc Back"]);
        return nextKey();
      },
    );
    const initial = output.read()?.toString() ?? "";
    expect(initial).toContain(wideLine);

    input.emit("keypress", "\u001b", { name: "escape", sequence: "\u001b" });
    await expect(interaction).resolves.toMatchObject({ name: "escape" });
    expect(input.isRaw).toBe(false);
  });

  it("handles Page Down inside every raw-screen interaction before returning normal keys", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(value: boolean): void;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (value: boolean) => {
      input.isRaw = value;
    };
    const output = new PassThrough() as WriteStream & PassThrough;
    Object.assign(output, { isTTY: true, columns: 100, rows: 12 });

    const interaction = withRawTerminalScreen(
      input as unknown as ReadStream,
      output,
      async (nextKey, render) => {
        render([
          "LONG REVIEW",
          ...Array.from({ length: 16 }, (_, index) => `Context ${index + 1}`),
          "",
          "> Confirm",
          "Choice detail",
          "",
          "Enter Select   Esc Back",
        ]);
        return nextKey();
      },
    );
    const initial = output.read()?.toString() ?? "";
    expect(initial).toContain("Context 1");
    expect(initial).not.toContain("Context 6");
    expect(initial).toContain("PgUp/PgDn Scroll hidden details");

    input.emit("keypress", "", { name: "pagedown", sequence: "\u001b[6~" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const paged = output.read()?.toString() ?? "";
    expect(paged).toContain("Context 6");

    input.emit("keypress", "\u001b", { name: "escape", sequence: "\u001b" });
    await expect(interaction).resolves.toMatchObject({ name: "escape" });
    expect(input.isRaw).toBe(false);
  });

  it("does not accumulate a no-op page offset at the end of a focused review", async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode(value: boolean): void;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (value: boolean) => {
      input.isRaw = value;
    };
    const output = new PassThrough() as WriteStream & PassThrough;
    Object.assign(output, { isTTY: true, columns: 100, rows: 12 });

    const interaction = withRawTerminalScreen(
      input as unknown as ReadStream,
      output,
      async (nextKey, render) => {
        render([
          "FOCUSED REVIEW",
          ...Array.from({ length: 18 }, (_, index) => `Context ${index + 1}`),
          "",
          "> Use recommended policy",
          "Choice detail",
          "  Keep human approval",
          "Choice detail",
          "  Open advanced design",
          "Choice detail",
          "  Back",
          "",
          "Enter Select   Esc Back",
        ]);
        return nextKey();
      },
    );
    const initial = output.read()?.toString() ?? "";
    expect(initial).toContain("Use recommended policy");

    let bottomPage = "";
    for (let page = 0; page < 4; page += 1) {
      input.emit("keypress", "", { name: "pagedown", sequence: "\u001b[6~" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      bottomPage = output.read()?.toString() ?? "";
    }

    input.emit("keypress", "", { name: "pageup", sequence: "\u001b[5~" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const pagedBack = output.read()?.toString() ?? "";
    expect(pagedBack).not.toBe(bottomPage);

    input.emit("keypress", "\u001b", { name: "escape", sequence: "\u001b" });
    await expect(interaction).resolves.toMatchObject({ name: "escape" });
    expect(input.isRaw).toBe(false);
  });
});
