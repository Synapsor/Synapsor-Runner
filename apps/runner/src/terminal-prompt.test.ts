import { PassThrough } from "node:stream";
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
