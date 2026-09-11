export type HostedProvider = "openai" | "anthropic" | "openrouter";

export const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-terra";
export const OPENROUTER_EGRESS = "OpenRouter and a serving provider selected by OpenRouter (provider fallback disabled; providers permitting data collection excluded)";

export function defaultHostedModel(provider: string): string {
  if (provider === "openrouter") return DEFAULT_OPENROUTER_MODEL;
  return provider === "anthropic" ? DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL : DEFAULT_TERMINAL_OPENAI_ASK_MODEL;
}

export function defaultProviderKeyEnv(provider: string): string {
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
}

export function isHostedProvider(provider: string): provider is HostedProvider {
  return provider === "openai" || provider === "anthropic" || provider === "openrouter";
}

export function isFixedOpenRouterModel(model: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]{0,159}$/iu.test(model)
    && !/^openrouter\//iu.test(model)
    && !/:(?:online|batch)$/iu.test(model);
}
import { DEFAULT_TERMINAL_OPENAI_ASK_MODEL, DEFAULT_TERMINAL_ANTHROPIC_ASK_MODEL } from "./terminal-ask-defaults.js";
