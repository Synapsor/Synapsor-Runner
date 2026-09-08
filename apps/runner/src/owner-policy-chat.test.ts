import { describe, expect, it, vi } from "vitest";
import { chooseOwnerScope } from "./owner-policy-chat.js";
import type { OwnerPolicyReviewIo } from "./owner-policy-review-ui.js";

const owner = (tenant_id: string) => ({ scope: { level: "principal" as const, tenant_id, principal: "maya" },
  label: `${tenant_id} / Maya`, permissions: ["inspect", "draft"] as Array<"inspect" | "draft" | "audit">, agent_count: 2 });
const page = (tenants: string[], next?: string) => ({ epoch: 1, total: tenants.length + (next ? 1 : 0), scopes: tenants.map(owner), ...(next ? { next } : {}) });
function terminal(choices: Array<string | undefined>, answers: Array<string | undefined> = []) {
  const output: string[] = [];
  const io: OwnerPolicyReviewIo = { columns: () => 60, write: (value) => { output.push(value); },
    read: vi.fn(async () => answers.shift()), choose: vi.fn(async () => choices.shift()) };
  return { io, output };
}

describe("authorized owner-rule chat picker", () => {
  it("uses a sole authorized owner without an extra menu and returns a detached scope", async () => {
    const response = page(["Acme"]), { io, output } = terminal([]);
    const selected = await chooseOwnerScope(io, async () => response);
    expect(selected).toEqual(response.scopes[0]!.scope);
    expect(selected).not.toBe(response.scopes[0]!.scope);
    expect(io.choose).not.toHaveBeenCalled();
    expect(output.join("").replace(/\s+/gu, " ")).toContain("grants no access");
    expect(output.join("").replace(/\s+/gu, " ")).toContain("until human review");
    expect(output.join("").split("\n").every((line) => line.length <= 60)).toBe(true);
  });

  it("separates identical principal names across owners and uses only listed scopes", async () => {
    const { io } = terminal(["scope:1"]);
    expect(await chooseOwnerScope(io, async () => page(["Acme", "Beta"]))).toEqual(owner("Beta").scope);
    expect(io.choose).toHaveBeenCalledWith(expect.objectContaining({ options: expect.arrayContaining([
      expect.objectContaining({ label: "Acme / Maya" }), expect.objectContaining({ label: "Beta / Maya" }),
    ]) }));
  });

  it("supports bounded paging and a new filtered search without reusing an old cursor", async () => {
    const { io } = terminal(["next", "search", "scope:0"], [" Acme "]);
    const list = vi.fn().mockResolvedValueOnce(page(["Beta", "Gamma"], "opaque-next"))
      .mockResolvedValueOnce(page(["Delta", "Epsilon"]))
      .mockResolvedValueOnce(page(["Acme"]));
    expect(await chooseOwnerScope(io, list)).toEqual(owner("Acme").scope);
    expect(list.mock.calls.map((args) => args[0])).toEqual([
      { query: "", limit: 10 }, { query: "", limit: 10, after: "opaque-next" }, { query: "Acme", limit: 10 },
    ]);
  });

  it.each(["POLICY_PAGE_EPOCH_STALE", "POLICY_SCOPE_CURSOR_INVALID"])("recovers a %s page by reauthorizing from the first page", async (code) => {
    const { io, output } = terminal(["next", "cancel"]);
    const list = vi.fn().mockResolvedValueOnce(page(["Beta", "Gamma"], "old-page"))
      .mockRejectedValueOnce(Object.assign(new Error("page expired"), { code }))
      .mockResolvedValueOnce(page(["Beta", "Gamma"]));
    expect(await chooseOwnerScope(io, list)).toBeUndefined();
    expect(list.mock.calls[2]![0]).toEqual({ query: "", limit: 10 });
    expect(output.join("").replace(/\s+/gu, " ")).toContain("current authorized owners");
  });

  it("does not replay the consumed page cursor after an overlong search", async () => {
    const { io } = terminal(["next", "search", "cancel"], ["x".repeat(257)]);
    const list = vi.fn().mockResolvedValueOnce(page(["Beta", "Gamma"], "one-use-page"))
      .mockResolvedValueOnce(page(["Delta", "Epsilon"]))
      .mockResolvedValueOnce(page(["Beta", "Gamma"]));
    expect(await chooseOwnerScope(io, list)).toBeUndefined();
    expect(list.mock.calls[2]![0]).toEqual({ query: "", limit: 10 });
  });

  it("does not recover an authorization failure as a stale page or display untrusted error text", async () => {
    const { io, output } = terminal(["next"]);
    const error = Object.assign(new Error("private diagnostic"), { code: "POLICY_MANAGEMENT_FORBIDDEN" });
    const list = vi.fn().mockResolvedValueOnce(page(["Beta", "Gamma"], "next")).mockRejectedValueOnce(error);
    await expect(chooseOwnerScope(io, list)).rejects.toBe(error);
    expect(list).toHaveBeenCalledTimes(2);
    expect(output.join("")).not.toContain("private diagnostic");
  });

  it("keeps inspection-only access truthful and has a number-input fallback", async () => {
    const { io, output } = terminal([], ["2"]);
    delete io.choose;
    const response = page(["Acme", "Beta"]);
    response.scopes[1]!.permissions = ["inspect"];
    expect(await chooseOwnerScope(io, async () => response)).toEqual(owner("Beta").scope);
    expect(output.join("").replace(/\s+/gu, " ")).toContain("inspect, not edit");
  });

  it.each([undefined, "cancel", "scope:999"])("leaves on %s without choosing another owner", async (answer) => {
    const { io } = terminal([answer]);
    expect(await chooseOwnerScope(io, async () => page(["Acme", "Beta"]))).toBeUndefined();
  });
});
