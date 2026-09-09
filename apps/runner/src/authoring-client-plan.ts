/** A setup preference, never authority, identity or proof of client behavior. */
export const authoringClientChoices = [
  { value: "claude-code", label: "Claude Code", detail: "Local MCP; Runner prepares the project configuration and launch check." },
  { value: "vscode", label: "VS Code", detail: "Local MCP; Runner prepares the project configuration and launch check." },
  { value: "cursor", label: "Cursor", detail: "Local MCP; Runner prepares the project configuration and launch check." },
  { value: "later", label: "Another client / decide later", detail: "Keep client setup pending; continue reviewing the same job." },
] as const;
export type AuthoringClientPlan = typeof authoringClientChoices[number]["value"];
export function isAuthoringClientPlan(value: unknown): value is AuthoringClientPlan {
  return authoringClientChoices.some((choice) => choice.value === value);
}
export function authoringClientLabel(client?: AuthoringClientPlan): string {
  return authoringClientChoices.find((choice) => choice.value === client && client !== "later")?.label ?? "Your client";
}
export function authoringClientSetupFacts(client?: AuthoringClientPlan): string[] {
  return client && client !== "later" ? [
    `${authoringClientLabel(client)} will launch the local MCP server from a generated project configuration; no custom code is needed for configuration and the connection check.`,
    "After authority review, Runner opens that client's installer, collects the trusted local test identity, and offers a connection check of the four fixed tools.",
    "The client asks which record/change the user wants and reports the returned status. Runner verifies scope and business rules; only a successful execution receipt means completed.",
    "Configuration and a successful handshake do not verify those client behaviors. Check them before customer use. Production identity must come from an authenticated application session.",
    "When automatic completion is requested, execution consent, writer verification and a separately confirmed worker launch are still required.",
  ] : [
    "Choose a supported local MCP client during setup, or review your custom application's integration. Client selection does not authenticate a customer or enable execution.",
    "The client captures the user's chosen record/change and displays Runner's statuses and receipts accurately; Runner keeps enforcing the database rules.",
    "Assignment records the planned owner, not verified client behavior. Configuration, identity and connection checks remain outstanding.",
  ];
}
