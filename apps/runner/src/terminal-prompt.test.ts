import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import { describe, expect, it } from "vitest";
import { createInPlaceTerminalRenderer } from "./terminal-prompt.js";

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
});
