import { describe, expect, it } from "vitest";
import { authoringPermissionPresentation, type AuthoringPermissionPresentationInput } from "./authoring-permission-presentation.js";
import { executionActivationView, proposalActivationView, readActivationView } from "./authoring-activation-view.js";

const base: AuthoringPermissionPresentationInput = {
  title: "DÉCISION", prompt: "Autoriser cette opération ?", context: [],
  choices: [{ value: "back", label: "Retour" }, { value: "yes", label: "Continuer" }],
};
describe("typed permission presentation", () => {
  it.each([proposalActivationView(), executionActivationView("review.reserve"), readActivationView({ replacing: false })])(
    "uses the exact owned $kind view without interpreting prompt or first choice", (view) => {
      const request = { ...base, decisionKind: "activation" as const, activationView: view };
      const before = structuredClone(request);
      expect(authoringPermissionPresentation(request).nextQuestion).toBe(view.message);
      expect(request).toEqual(before);
    },
  );
  it("does not turn English action/activation words into proposal authority", () => {
    const result = authoringPermissionPresentation({ ...base, prompt: "Activate the proposal action?",
      decisionKind: "activation", activationView: readActivationView({ replacing: true }) });
    expect(result.nextQuestion).toBe(readActivationView({ replacing: true }).message);
    expect(result.validatedFacts.join("\n")).not.toContain("This Action activation");
  });
  it("keeps an untyped permission neutral instead of inferring execution or approval", () => {
    const result = authoringPermissionPresentation({ ...base, prompt: "Enable supervised source execution now. Approve and apply!" });
    expect(result.nextQuestion).toBe("Would you like to allow this exact Runner permission now?");
    expect(result.validatedFacts.join("\n")).not.toContain("execution-authorization gate itself");
  });
  it("does not use an activation view for a disclosure decision", () => {
    const result = authoringPermissionPresentation({ ...base, decisionKind: "disclosure", activationView: proposalActivationView() });
    expect(result.nextQuestion).toBe("Would you like to allow this exact Runner permission now?");
    expect(result.validatedFacts.join("\n")).not.toContain("This Action activation");
  });
  it("retains local-only privacy filtering and exact neutral choices", () => {
    const result = authoringPermissionPresentation({ ...base, context: ["Excluded fields: private_code", "Tenant ID: synthetic_customer", "Exact fingerprint: sha256:deadbeef", "Three reviewed resources"], explanationContext: ["password: synthetic_secret"] });
    const text = result.validatedFacts.join("\n");
    expect(text).not.toMatch(/private_code|synthetic_customer|deadbeef|synthetic_secret/);
    expect(text).toContain("Three reviewed resources");
    expect(text).toContain("Operator choice: Retour");
    expect(text).toContain("declining leaves current authority and source data unchanged");
  });
});

it("the production consent adapter supplies the typed purpose without changing default-No", async () => {
  const { createBoundaryAuthoringChat } = await import("./boundary-authoring-chat.js");
  const requests: AuthoringPermissionPresentationInput[] = [];
  const defaults: Array<string | undefined> = [];
  const view = proposalActivationView();
  const chat = createBoundaryAuthoringChat({ color: false, io: {
    read: async () => undefined, write: () => undefined, isTerminal: () => true,
    onInterrupt: () => () => undefined, close: () => undefined,
    setStatus: () => undefined, clearStatus: () => undefined, columns: () => 100,
    choose: async (choice) => { defaults.push(choice.initialValue); return "no"; },
  } });
  chat.setPermissionGuide!(async (request) => {
    requests.push(request);
    return authoringPermissionPresentation(request).nextQuestion;
  });
  try {
    expect(await chat.session.confirm("Autoriser la décision examinée ?", {
      decisionKind: "activation", activationView: view,
      context: ["Reviewed change requests only"], defaultValue: false,
    })).toBe(false);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ decisionKind: "activation", activationView: view });
    expect(authoringPermissionPresentation(requests[0]!).nextQuestion).toBe(view.message);
    expect(defaults).toEqual(["no"]);
  } finally { chat.close(); }
});
