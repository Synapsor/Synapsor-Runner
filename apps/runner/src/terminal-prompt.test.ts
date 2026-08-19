import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import { describe, expect, it } from "vitest";
import {
  createInPlaceTerminalRenderer,
  fitTerminalFrameToRows,
} from "./terminal-prompt.js";

describe("in-place terminal rendering", () => {
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
});
