import type {
  Config,
  ModelProvider,
  ProviderChatMessage,
  ProviderCompletionResult,
  ProviderStreamEvent,
  ProviderToolCall,
  ToolCall,
  ToolDefinition,
} from "../types";
import { log } from "../util/logger";

/** Max characters we accumulate for one tool-call arguments string before aborting. */
const MAX_ARG_CHARS = 20000;

/**
 * OpenAI-compatible streaming SSE parser over an async iterable of decoded lines.
 */
export async function* iterateSSE(
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = getReader(stream);
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value as Uint8Array, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    // trailing
    if (buffer.length && buffer.startsWith("data:")) yield buffer.slice(5).trim();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

type WebReader = ReadableStreamDefaultReader<Uint8Array>;
type NodeReader = import("node:stream").Readable;

function getReader(stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>): {
  read: () => Promise<{ value: Uint8Array | undefined; done: boolean }>;
  releaseLock: () => void;
} {
  const anyS = stream as unknown as Record<string, unknown>;
  if (typeof anyS.getReader === "function") {
    const web = stream as ReadableStream<Uint8Array>;
    const r = web.getReader() as WebReader;
    return {
      read: () => r.read(),
      releaseLock: () => r.releaseLock(),
    };
  }
  const node = stream as NodeJS.ReadableStream as NodeReader;
  return {
    read: () =>
      new Promise((resolve, reject) => {
        const chunk = node.read();
        if (chunk !== null) return resolve({ value: chunk as Uint8Array, done: false });
        node.once("readable", () => {
          const c2 = node.read();
          resolve({ value: (c2 as Uint8Array) || undefined, done: c2 === null });
        });
        node.once("error", reject);
      }),
    releaseLock: () => node.destroy(),
  };
}

interface PendingToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/** Sends a chat completion with tool support and streams the deltas. */
export class OpenRouterProvider implements ModelProvider {
  readonly name = "openrouter";
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly config: Config;
  private currentModel: string;

  constructor(model: string, apiKey: string, config: Config, baseUrl?: string) {
    this.apiKey = apiKey;
    this.config = config;
    this.currentModel = model;
    this.baseUrl = (baseUrl || config.baseUrl || "").replace(/\/+$/, "");
  }

  supportsNativeTools(): boolean {
    return this.config.toolProtocol !== "textual";
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "HTTP-Referer": "https://github.com/opencode-agent/opencode",
      "X-Title": "opencode",
    };
  }

  private buildTools(tools: ToolDefinition[]): Record<string, unknown>[] {
    return tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  /**
   * Streams a turn. If native tools are enabled the request includes the `tools`
   * array and deltas accumulate into tool calls. Otherwise the model is expected
   * to emit its own JSON tool-call markers in the text (parsed by the caller).
   */
  async *streamChat(
    messages: ProviderChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent> {
    const useNative = this.supportsNativeTools() && tools.length > 0;
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };
    if (useNative) {
      body.tools = this.buildTools(tools);
      body.tool_choice = "auto";
    }

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const timeoutMs = this.config.requestTimeoutSec * 1000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        let msg = `OpenRouter HTTP ${res.status}`;
        try {
          const j = JSON.parse(detail);
          if (j?.error?.message) msg = `${msg}: ${j.error.message}`;
        } catch {
          if (detail) msg = `${msg}: ${detail.slice(0, 400)}`;
        }
        yield { type: "error", error: msg };
        return;
      }
      if (!res.body) {
        yield { type: "error", error: "Empty response body from provider." };
        return;
      }

      const pending: PendingToolCall[] = [];
      let text = "";
      let finishReason: string | undefined;

      for await (const dataLine of iterateSSE(res.body)) {
        if (dataLine === "" || dataLine === "[DONE]") continue;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(dataLine);
        } catch {
          continue;
        }
        const choices = json.choices as Array<Record<string, unknown>> | undefined;
        if (!choices || choices.length === 0) continue;
        const choice = choices[0];
        if (choice.finish_reason) finishReason = String(choice.finish_reason);
        const delta = (choice.delta || {}) as Record<string, unknown>;
        const content = delta.content as string | undefined;
        if (typeof content === "string" && content.length) {
          text += content;
          yield { type: "text", text: content };
        }
        const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(tcs)) {
          for (const tc of tcs) {
            const idx = Number(tc.index ?? 0);
            const fn = (tc.function || {}) as Record<string, unknown>;
            const name = typeof fn.name === "string" ? fn.name : "";
            const args = typeof fn.arguments === "string" ? fn.arguments : "";
            let p = pending[idx];
            if (!p) {
              p = { index: idx, id: String(tc.id || `call_${idx}`), name, arguments: "" };
              pending[idx] = p;
            }
            if (name) p.name = name;
            if (tc.id) p.id = String(tc.id);
            if (args) {
              p.arguments = (p.arguments + args).slice(0, MAX_ARG_CHARS);
            }
          }
        }
      }

      const toolCalls: ToolCall[] = pending
        .sort((a, b) => a.index - b.index)
        .map((p) => ({ id: p.id || `call_${p.index}`, name: p.name, argumentsJson: p.arguments }))
        .filter((tc) => tc.name && tc.name.length);

      // Textual fallback: the model may also have embedded JSON tool markers.
      if (!useNative) {
        // leave textual marker extraction to the agent layer
      }

      const result: ProviderCompletionResult = {
        text,
        toolCalls,
        finishReason,
        model: this.model,
      };
      yield { type: "done", result };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async complete(
    messages: ProviderChatMessage[],
    opts?: { maxTokens?: number }
  ): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.config.requestTimeoutSec * 1000);
    const body: Record<string, unknown> = { model: this.model, messages, stream: false };
    if (opts?.maxTokens) body.max_tokens = opts.maxTokens;
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const d = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${d.slice(0, 300)}`);
      }
      const j = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = j.choices?.[0]?.message?.content;
      return (content || "").trim();
    } finally {
      clearTimeout(timer);
    }
  }

  get model(): string {
    return this.currentModel;
  }
}

/** Convenience tool to extract native tool calls into the ToolCall shape. */
export function toToolCalls(tcs: ProviderToolCall[] | undefined): ToolCall[] {
  if (!tcs) return [];
  return tcs
    .filter((t) => t.function?.name)
    .map((t) => ({ id: t.id, name: t.function.name, argumentsJson: t.function.arguments || "{}" }));
}

/** Quiet helper used across providers. */
export function debugProvider(model: string): void {
  log("debug", `provider model: ${model}`);
}
