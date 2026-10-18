import { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Anything that can answer a chat with JSON. The pipeline only knows this
 * interface, so a hosted model (or a fake in tests) is a drop-in replacement.
 * Implementations throw on transport errors (server down, timeout); they never
 * judge the content. Validation is the caller's job.
 */
export interface LlmClient {
  readonly name: string;
  chat(messages: ChatMessage[], options: { jsonSchema: object }): Promise<string>;
}

// Ollama's reply is an external input too.
const OllamaResponse = z.object({ message: z.object({ content: z.string() }) });

export class OllamaClient implements LlmClient {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, model: string, timeoutMs = 300_000) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.name = `ollama:${model}`;
  }

  async chat(messages: ChatMessage[], options: { jsonSchema: object }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        format: options.jsonSchema, // constrains the output to the schema
        options: {
          temperature: 0, // same input → (nearly) same output; no creativity wanted
          num_ctx: 8192, // Ollama's default window is smaller; long emails would be cut off silently
        },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Ollama returned HTTP ${res.status}`);
    }
    return OllamaResponse.parse(await res.json()).message.content;
  }
}
