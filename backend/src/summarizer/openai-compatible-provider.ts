import { z } from "zod";
import { type CompletionRequest, LlmError, type LlmProvider } from "./llm-provider.js";

export interface OpenAiCompatibleOptions {
  /** Up to and including the version segment, e.g. "http://localhost:4001/v1". */
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** The part of a Chat Completions response that we rely on. */
const chatCompletion = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
    .min(1),
});

/**
 * Talks to any endpoint that speaks the OpenAI Chat Completions shape: the provided mock
 * LLM, OpenAI, Ollama, and most gateways.
 *
 * Written with plain `fetch` on purpose. The request sends only `model` and `messages`,
 * which every such endpoint accepts; sampling and length parameters differ between them.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name: string;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(options: OpenAiCompatibleOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.name = `openai-compatible (${options.model})`;
  }

  async complete({ system, user, signal }: CompletionRequest): Promise<string> {
    let response: Response;
    let body: string;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal,
      });
      body = await response.text();
    } catch (error) {
      throw signal.aborted
        ? new LlmError("aborted", "The LLM call was aborted", { cause: error })
        : new LlmError("unreachable", "The LLM could not be reached", { cause: error });
    }

    if (!response.ok) {
      throw new LlmError("http", `The LLM answered with HTTP ${response.status}`);
    }

    const parsed = chatCompletion.safeParse(parseJson(body));
    const content = parsed.success ? parsed.data.choices[0]?.message.content : undefined;
    if (content === undefined || content === null) {
      throw new LlmError("invalid_response", "The LLM response has no message content");
    }
    return content;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
