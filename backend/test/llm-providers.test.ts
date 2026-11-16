import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProvider } from "../src/summarizer/anthropic-provider.js";
import { createProvider } from "../src/summarizer/create-provider.js";
import { LlmError, type LlmProvider } from "../src/summarizer/llm-provider.js";
import { OpenAiCompatibleProvider } from "../src/summarizer/openai-compatible-provider.js";

interface SeenRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: unknown;
}

type Reply = (res: ServerResponse) => void;

let server: Server | undefined;
let seen: SeenRequest[] = [];

/** Starts a stub LLM endpoint that records each request and answers with `reply`. */
async function startLlm(reply: Reply): Promise<string> {
  seen = [];
  const started = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: raw === "" ? null : (JSON.parse(raw) as unknown),
      });
      reply(res);
    });
  });
  server = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  const { port } = started.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  const running = server;
  server = undefined;
  if (!running) {
    return;
  }
  running.closeAllConnections();
  await new Promise<void>((resolve) => {
    running.close(() => {
      resolve();
    });
  });
});

const json =
  (status: number, body: unknown): Reply =>
  (res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

const never: Reply = () => undefined;
const noTimeout = new AbortController().signal;

const ask = (provider: LlmProvider, signal: AbortSignal = noTimeout) =>
  provider.complete({ system: "You write change notes.", user: "price $39 -> $29", signal });

async function failureOf(call: Promise<string>): Promise<LlmError> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError);
    return error as LlmError;
  }
  throw new Error("expected the call to fail");
}

describe("OpenAiCompatibleProvider", () => {
  const chatCompletion = (content: unknown) => ({
    id: "mock-chatcmpl-1",
    object: "chat.completion",
    model: "mock-llm",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  });
  const provider = (baseUrl: string) =>
    new OpenAiCompatibleProvider({ baseUrl, apiKey: "test-key", model: "mock-llm" });

  it("posts a chat completion and returns the message text", async () => {
    const baseUrl = await startLlm(json(200, chatCompletion("Price dropped to $29/mo.")));

    expect(await ask(provider(`${baseUrl}/v1`))).toBe("Price dropped to $29/mo.");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: {
        model: "mock-llm",
        messages: [
          { role: "system", content: "You write change notes." },
          { role: "user", content: "price $39 -> $29" },
        ],
      },
    });
  });

  it("tolerates a trailing slash on the base URL", async () => {
    const baseUrl = await startLlm(json(200, chatCompletion("ok")));
    await ask(provider(`${baseUrl}/v1/`));
    expect(seen[0]?.url).toBe("/v1/chat/completions");
  });

  it("reports an error status, and does not retry on its own", async () => {
    const baseUrl = await startLlm(json(500, { error: { message: "injected failure" } }));
    const error = await failureOf(ask(provider(`${baseUrl}/v1`)));
    expect(error.kind).toBe("http");
    expect(error.message).toBe("The LLM answered with HTTP 500");
    expect(seen).toHaveLength(1);
  });

  it.each<[string, Reply]>([
    ["a body that is not JSON", (res) => res.end("<html>oops</html>")],
    ["JSON without choices", json(200, { id: "x" })],
    ["an empty choices list", json(200, { choices: [] })],
    ["null content", json(200, chatCompletion(null))],
    ["content that is not text", json(200, chatCompletion({ parts: [] }))],
  ])("reports %s as an invalid response", async (_label, reply) => {
    const baseUrl = await startLlm(reply);
    expect((await failureOf(ask(provider(`${baseUrl}/v1`)))).kind).toBe("invalid_response");
  });

  it("returns an empty string as it is, for the caller to judge", async () => {
    const baseUrl = await startLlm(json(200, chatCompletion("")));
    expect(await ask(provider(`${baseUrl}/v1`))).toBe("");
  });

  it("stops waiting when the caller's timeout fires", async () => {
    const baseUrl = await startLlm(never);
    const startedAt = Date.now();
    const error = await failureOf(ask(provider(`${baseUrl}/v1`), AbortSignal.timeout(150)));
    expect(error.kind).toBe("aborted");
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("reports an endpoint that cannot be reached", async () => {
    const error = await failureOf(ask(provider("http://127.0.0.1:1/v1")));
    expect(error.kind).toBe("unreachable");
  });
});

describe("AnthropicProvider", () => {
  const message = (overrides: Record<string, unknown> = {}) => ({
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "Price dropped to $29/mo." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 20, output_tokens: 9 },
    ...overrides,
  });
  const provider = (baseUrl: string) =>
    new AnthropicProvider({ baseUrl, apiKey: "test-key", model: "claude-opus-5-5" });

  it("sends a Messages request through the SDK and returns the text", async () => {
    const baseUrl = await startLlm(json(200, message()));

    expect(await ask(provider(baseUrl))).toBe("Price dropped to $29/mo.");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: "/v1/messages",
      body: {
        model: "claude-opus-5-5",
        system: "You write change notes.",
        messages: [{ role: "user", content: "price $39 -> $29" }],
        output_config: { effort: "low" },
      },
    });
    // Which header carries the key is the SDK's business; it must be sent, with a version.
    expect(JSON.stringify(seen[0]?.headers)).toContain("test-key");
    expect(seen[0]?.headers["anthropic-version"]).toBeDefined();
  });

  it("does not send parameters that current models reject", async () => {
    const baseUrl = await startLlm(json(200, message()));
    await ask(provider(baseUrl));
    const body = seen[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      ["max_tokens", "messages", "model", "output_config", "system"].sort(),
    );
  });

  it("joins the text blocks and skips thinking blocks", async () => {
    const baseUrl = await startLlm(
      json(
        200,
        message({
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "text", text: "Price dropped " },
            { type: "text", text: "to $29/mo." },
          ],
        }),
      ),
    );
    expect(await ask(provider(baseUrl))).toBe("Price dropped to $29/mo.");
  });

  it.each([
    ["a refusal", "refusal", "The model declined to answer"],
    ["a cut-off answer", "max_tokens", "The model's answer was cut off"],
  ])("reports %s as an invalid response", async (_label, stopReason, expected) => {
    const baseUrl = await startLlm(json(200, message({ stop_reason: stopReason, content: [] })));
    const error = await failureOf(ask(provider(baseUrl)));
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toBe(expected);
  });

  it.each([429, 500, 529])(
    "reports HTTP %i once, without the SDK's built-in retries",
    async (status) => {
      const baseUrl = await startLlm(
        json(status, { type: "error", error: { type: "api_error", message: "nope" } }),
      );
      const error = await failureOf(ask(provider(baseUrl)));
      expect(error.kind).toBe("http");
      expect(error.message).toBe(`The LLM answered with HTTP ${status}`);
      // Every attempt counts against the daily cap, so exactly one request must go out.
      expect(seen).toHaveLength(1);
    },
  );

  it("stops waiting when the caller's timeout fires", async () => {
    const baseUrl = await startLlm(never);
    const startedAt = Date.now();
    const error = await failureOf(ask(provider(baseUrl), AbortSignal.timeout(150)));
    expect(error.kind).toBe("aborted");
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(seen).toHaveLength(1);
  });

  it("reports an endpoint that cannot be reached", async () => {
    const error = await failureOf(ask(provider("http://127.0.0.1:1")));
    expect(error.kind).toBe("unreachable");
  });
});

describe("createProvider", () => {
  it("uses the mock LLM when nothing is configured", () => {
    const provider = createProvider({
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: undefined,
      LLM_API_KEY: undefined,
      LLM_MODEL: undefined,
    });
    expect(provider).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(provider.name).toBe("openai-compatible (mock-llm)");
  });

  it("uses the configured OpenAI-compatible endpoint and model", async () => {
    const baseUrl = await startLlm(
      json(200, { choices: [{ message: { role: "assistant", content: "ok" } }] }),
    );
    const provider = createProvider({
      LLM_PROVIDER: "openai-compatible",
      LLM_BASE_URL: `${baseUrl}/v1`,
      LLM_API_KEY: "sk-real",
      LLM_MODEL: "gpt-x",
    });
    await ask(provider);
    expect(seen[0]).toMatchObject({
      headers: { authorization: "Bearer sk-real" },
      body: { model: "gpt-x" },
    });
  });

  it("builds the Anthropic provider with its default model", () => {
    const provider = createProvider({
      LLM_PROVIDER: "anthropic",
      LLM_BASE_URL: undefined,
      LLM_API_KEY: "sk-ant-test",
      LLM_MODEL: undefined,
    });
    expect(provider).toBeInstanceOf(AnthropicProvider);
    expect(provider.name).toBe("anthropic (claude-opus-5-5)");
  });
});
