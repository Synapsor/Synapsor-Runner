import { afterEach, expect, it, vi } from "vitest";
import { contractCommand } from "./contract-commands.js";
import { runContractTests } from "./contract-testing.js";
vi.mock("./contract-testing.js", () => ({ runContractTests: vi.fn(async () => ({ ok: true })), formatContractTestReport: () => "report\n" }));
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
it("forwards only exact repeated operator Source declarations separately from remote override", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const args = ["test", "--contract", "contract.json", "--tests", "tests.json", "--config", "runner.json", "--live", "--disposable-source", "a", "--disposable-source", "b"];
  expect(await contractCommand(args)).toBe(0);
  expect(runContractTests).toHaveBeenLastCalledWith(expect.objectContaining({ live: true, disposableSources: ["a", "b"], allowRemote: false }));
  expect(await contractCommand([...args, "--allow-remote"])).toBe(0);
  expect(runContractTests).toHaveBeenLastCalledWith(expect.objectContaining({ disposableSources: ["a", "b"], allowRemote: true }));
});
