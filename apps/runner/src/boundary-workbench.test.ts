import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderBoundaryWorkbench } from "./boundary-workbench.js";

describe("Auto Boundary Workbench renderer", () => {
  it("emits executable browser JavaScript and the host-neutral guided journey", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

    expect(script).toBeTruthy();
    expect(() => new vm.Script(script!, { filename: "boundary-workbench.js" })).not.toThrow();
    expect(html).toContain("Synapsor is creating the small set of database powers your agent may use.");
    expect(html).toContain("Review security exceptions");
    expect(html).toContain("Exact database role posture");
    expect(html).toContain("Explore reviewed data");
    expect(html).toContain("Optional filter field");
    expect(html).toContain("Exact row");
    expect(html).toContain("Protect This Query");
    expect(html).toContain("Add a safe action");
    expect(html).toContain("Trace the role from IdP claim to approval and apply");
    expect(html).toContain("docs/approval-roles-and-operator-identity.md");
    expect(html).toContain("Tool (local authoring only)");
    expect(html).toContain("Finish authoring and review proposal");
    expect(html).not.toMatch(/id="protect-disable-explore" type="checkbox" checked/);
    expect(html).toContain("Generic stdio MCP");
    expect(html).toContain("Claude-compatible local MCP");
    expect(html).toContain("Codex");
    expect(html).not.toMatch(/execute_sql|raw SQL tool|approve tool|apply tool/i);
  });
});
