import type {
  Config,
  ModelProvider,
  ProviderChatMessage,
  ProviderStreamEvent,
  ToolDefinition,
  ToolCall,
} from "../types";
import { OpenRouterProvider } from "./openrouter";
import { log } from "../util/logger";

/** Errors that indicate the model/provider is unusable → should try fallback. */
export class ProviderUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnusableError";
  }
}

/**
 * Wraps the primary model and any configured fallback models.
 * On a hard provider failure (auth/limit/model-unavailable/transport) it swaps to
 * the next model and transparently streams with it, so the agent keeps working.
 */
export class ModelManager {
  readonly config: Config;
  readonly apiKey: string;
  private providers: ModelProvider[] = [];
  private currentIndex = 0;

  constructor(config: Config, apiKey: string) {
    this.config = config;
    this.apiKey = apiKey;
    this.rebuild(config.model, config.fallbackModels);
  }

  /** (Re)create the provider list from a primary model and fallbacks. */
  rebuild(primary: string, fallbacks: string[] = this.config.fallbackModels): void {
    const models = [primary, ...fallbacks].filter(Boolean);
    this.providers = models.map(
      (m) => new OpenRouterProvider(m, this.apiKey, this.config, this.config.baseUrl)
    );
    this.currentIndex = 0;
  }

  /** Active (current) provider. */
  current(): ModelProvider {
    return this.providers[Math.min(this.currentIndex, this.providers.length - 1)];
  }

  currentModel(): string {
    return this.current().model;
  }

  setPrimary(model: string): void {
    this.rebuild(model);
  }

  setModels(primary: string, fallbacks: string[]): void {
    this.rebuild(primary, fallbacks);
  }

  getProviderList(): string[] {
    return this.providers.map((p) => p.model);
  }

  /**
   * Stream one assistant turn across primary + fallbacks. If the active provider
   * hard-fails we advance to the next fallback and continue streaming from there.
   * Returns the provider that ultimately served the turn.
   */
  async *streamWithFallback(
    messages: ProviderChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    onProviderSwitch?: (from: string, to: string, reason: string) => void
  ): AsyncGenerator<{ event: ProviderStreamEvent; provider: string }> {
    let attempt = 0;
    let started = false;
    while (attempt < this.providers.length) {
      const idx = Math.min(this.currentIndex + attempt, this.providers.length - 1);
      const provider = this.providers[idx];
      const from = this.current().model;
      try {
        for await (const ev of provider.streamChat(messages, tools, signal)) {
          started = true;
          yield { event: ev, provider: provider.model };
          if (ev.type === "error") {
            // Hard error mid- or pre-stream → fallback.
            const to = this.nextCandidate(provider);
            if (to) {
              log("warn", `provider ${provider.model} failed (${ev.error}); switching to ${to}`);
              onProviderSwitch?.(provider.model, to, ev.error || "provider error");
              this.currentIndex = idx + 1;
              attempt++;
              started = false;
              break; // restart loop with next provider
            }
            throw new ProviderUnusableError(ev.error || "provider error");
          }
          if (ev.type === "done") {
            // Success path: lock in this provider as current for the session.
            this.currentIndex = idx;
            return;
          }
        }
        // Stream ended without a 'done' and without error → abnormal; treat as fallback.
        if (!started) {
          const to = this.nextCandidate(provider);
          if (to) {
            this.currentIndex = idx + 1;
            attempt++;
            started = false;
            continue;
          }
        }
        // If we broke out of inner loop due to a normal provider EOF without done,
        // avoid an infinite outer loop by checking whether we already advanced.
        if (attempt >= this.providers.length) break;
        if (this.currentIndex <= idx) {
          // No fallback left.
          if (this.currentIndex === idx && idx === this.providers.length - 1) {
            throw new ProviderUnusableError("provider stream ended without a usable response");
          }
        }
        break;
      } catch (e) {
        const msg = (e as Error).message;
        const to = this.nextCandidate(provider);
        if (to) {
          log("warn", `provider ${provider.model} threw (${msg}); switching to ${to}`);
          onProviderSwitch?.(provider.model, to, msg);
          this.currentIndex = idx + 1;
          attempt++;
          started = false;
          continue;
        }
        throw e;
      }
    }
    throw new ProviderUnusableError("all configured models failed");
  }

  private nextCandidate(current: ModelProvider): string | undefined {
    for (let i = this.providers.length - 1; i >= 0; i--) {
      const p = this.providers[i];
      if (p.model === current.model) {
        return this.providers[i + 1] ? this.providers[i + 1].model : undefined;
      }
    }
    return undefined;
  }

  /** One-shot completion for compaction, using the current active model. */
  async complete(messages: ProviderChatMessage[]): Promise<string> {
    return this.current().complete(messages, { maxTokens: 800 });
  }
}

/** Convenience to normalise textual tool markers if ever used. */
export function parseTextualToolCalls(text: string): { cleaned: string; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let cleaned = text.replace(re, (_m, inner) => {
    try {
      const obj = JSON.parse(inner) as { name: string; arguments?: Record<string, unknown>; id?: string };
      calls.push({
        id: obj.id || `txt_${calls.length}`,
        name: String(obj.name),
        argumentsJson: JSON.stringify(obj.arguments || {}),
      });
    } catch {
      /* ignore malformed */
    }
    return "";
  });
  cleaned = cleaned.trim();
  return { cleaned, calls };
}
