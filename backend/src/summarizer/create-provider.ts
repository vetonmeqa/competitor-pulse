import type { Config } from "../config.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import type { LlmProvider } from "./llm-provider.js";
import { OpenAiCompatibleProvider } from "./openai-compatible-provider.js";

type LlmConfig = Pick<Config, "LLM_PROVIDER" | "LLM_BASE_URL" | "LLM_API_KEY" | "LLM_MODEL">;

/** With no LLM settings at all, the system talks to the provided mock LLM. */
const MOCK_DEFAULTS = {
  baseUrl: "http://localhost:4001/v1",
  apiKey: "mock",
  model: "mock-llm",
};

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** Builds the provider selected by `LLM_PROVIDER`, filling in that provider's defaults. */
export function createProvider(config: LlmConfig): LlmProvider {
  switch (config.LLM_PROVIDER) {
    case "openai-compatible":
      return new OpenAiCompatibleProvider({
        baseUrl: config.LLM_BASE_URL ?? MOCK_DEFAULTS.baseUrl,
        apiKey: config.LLM_API_KEY ?? MOCK_DEFAULTS.apiKey,
        model: config.LLM_MODEL ?? MOCK_DEFAULTS.model,
      });
    case "anthropic":
      // LLM_BASE_URL is deliberately not used here. It points at an OpenAI-compatible
      // endpoint (in Docker, the mock LLM), and Claude requests must never go there by
      // accident. The SDK uses the Anthropic API, or ANTHROPIC_BASE_URL if that is set.
      return new AnthropicProvider({
        apiKey: config.LLM_API_KEY,
        model: config.LLM_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      });
  }
}
