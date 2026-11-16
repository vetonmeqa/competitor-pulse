import Anthropic from "@anthropic-ai/sdk";
import { type CompletionRequest, LlmError, type LlmProvider } from "./llm-provider.js";

export interface AnthropicOptions {
  /** When absent, the SDK reads ANTHROPIC_API_KEY from the environment. */
  apiKey?: string | undefined;
  /** When absent, the SDK uses the public Anthropic API. */
  baseUrl?: string | undefined;
  model: string;
}

/** Room for the model's thinking as well as the short answer. */
const MAX_TOKENS = 16_000;

/** Claude through the official Anthropic SDK (Messages API). */
export class AnthropicProvider implements LlmProvider {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicOptions) {
    this.client = new Anthropic({
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
      // The SDK retries twice by default. Every attempt counts against the daily cap,
      // and the summariser already retries with backoff, so retries are off here.
      maxRetries: 0,
    });
    this.model = options.model;
    this.name = `anthropic (${options.model})`;
  }

  async complete({ system, user, signal }: CompletionRequest): Promise<string> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          system,
          messages: [{ role: "user", content: user }],
          // A two-sentence summary of a small diff does not need deep reasoning.
          output_config: { effort: "low" },
        },
        { signal },
      );
    } catch (error) {
      throw toLlmError(error, signal);
    }

    // A refusal or a cut-off answer arrives as a normal 200, so check before reading text.
    if (response.stop_reason === "refusal") {
      throw new LlmError("invalid_response", "The model declined to answer");
    }
    if (response.stop_reason === "max_tokens") {
      throw new LlmError("invalid_response", "The model's answer was cut off");
    }

    return response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
  }
}

function toLlmError(error: unknown, signal: AbortSignal): LlmError {
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError) {
    return new LlmError("aborted", "The LLM call was aborted", { cause: error });
  }
  // Checked before APIError: in this SDK a connection error is a subclass of it.
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError("unreachable", "The LLM could not be reached", { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmError("http", `The LLM answered with HTTP ${error.status ?? "error"}`, {
      cause: error,
    });
  }
  return new LlmError("unreachable", "The LLM call failed unexpectedly", { cause: error });
}
