import * as fs from "node:fs";
import * as path from "node:path";
import type { Config, ProviderChatMessage } from "../types";

/** Rough token estimator (chars / 4). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Tracks which file paths the model has already seen so we never re-send a full
 * file that is already in context (the model can request a targeted range if it
 * needs more). Keeps metadata and content caches to make repeated reads cheap.
 */
export class ContextManager {
  private config: Config;
  private seenFiles = new Map<string, { size: number; mtimeMs: number }>();
  private contentCache = new Map<string, string>();
  private cacheBytes = 0;
  private cacheMaxBytes = 4 * 1024 * 1024;

  /** Simple rolling message budget that triggers auto-compaction. */
  private messageCount = 0;
  private lastCompactionAt = 0;
  private compactCount = 0;

  /** Working-memory notes (from the log tool / agent). */
  notes: string[] = [];

  constructor(config: Config) {
    this.config = config;
  }

  /** Register a file as seen by the model with its size/mtime. */
  markSeen(filePath: string, size: number, mtimeMs: number): void {
    this.seenFiles.set(filePath, { size, mtimeMs });
  }

  hasSeen(filePath: string): boolean {
    return this.seenFiles.has(filePath);
  }

  seenSize(filePath: string): number {
    return this.seenFiles.get(filePath)?.size || 0;
  }

  /** List of file paths currently considered "in context". */
  seenPaths(): string[] {
    return Array.from(this.seenFiles.keys());
  }

  /** Retrieve cached content if the file on disk is unchanged. */
  getCached(filePath: string): string | undefined {
    try {
      const st = fs.statSync(filePath);
      const seen = this.seenFiles.get(filePath);
      if (seen && seen.mtimeMs === st.mtimeMs && st.size === seen.size) {
        return this.contentCache.get(filePath);
      }
    } catch {
      /* ignore */
    }
    return undefined;
  }

  /** Cache file content (bounded LRU-ish by byte budget). */
  cache(filePath: string, content: string): void {
    const prev = this.contentCache.get(filePath);
    if (prev) this.cacheBytes -= Buffer.byteLength(prev);
    this.contentCache.set(filePath, content);
    this.cacheBytes += Buffer.byteLength(content);
    // Evict oldest until under budget.
    if (this.cacheBytes > this.cacheMaxBytes) {
      const keys = this.contentCache.keys();
      let k = keys.next();
      while (this.cacheBytes > this.cacheMaxBytes && !k.done) {
        const old = this.contentCache.get(k.value);
        if (old !== undefined) this.cacheBytes -= Buffer.byteLength(old);
        this.contentCache.delete(k.value);
        k = keys.next();
      }
    }
  }

  getCachedBytes(): number {
    return this.cacheBytes;
  }

  addNote(note: string): void {
    this.notes.push(note);
    if (this.notes.length > 30) this.notes = this.notes.slice(-30);
  }

  getNotes(): string[] {
    return [...this.notes];
  }

  /** Serialise notes + seen files into a compact "memory" block for the model. */
  renderMemoryBlock(): string {
    const parts: string[] = [];
    if (this.notes.length) {
      parts.push("WORKING NOTES (log/plan/decisions):\n" + this.notes.map((n) => " - " + n).join("\n"));
    }
    if (this.seenFiles.size) {
      const list = this.seenPaths();
      const shown = list.slice(0, 60).map((p) => path.basename(path.dirname(p)) + "/" + path.basename(p)).join(", ");
      parts.push(`FILES ALREADY READ (avoid re-reading in full unless changed): ${list.length} file(s).`);
    }
    return parts.join("\n\n");
  }

  /** Increment the message counter; auto-compact when over budget. */
  countMessage(): void {
    this.messageCount++;
  }

  getMessageCount(): number {
    return this.messageCount;
  }

  needsAutoCompact(): boolean {
    return (
      this.config.autoCompact &&
      this.messageCount - this.lastCompactionAt > this.config.contextLimitTokens / 1500 &&
      this.compactCount < 20
    );
  }

  /**
   * Compact by summarising the older messages. Called by the agent with a
   * summarisation function backed by a model completion. Returns true if it ran.
   */
  async compact(
    messages: ProviderChatMessage[],
    summarise: (text: string) => Promise<string>
  ): Promise<{ ok: boolean; summary: string }> {
    // Keep system, the last exchange, and tool result references; summarise the middle.
    const keepTail = Math.min(8, messages.length);
    const head = messages[0]?.role === "system" ? [messages[0]] : [];
    const tail = messages.slice(Math.max(1, messages.length - keepTail));
    const middle = messages.slice(head.length, messages.length - tail.length);
    const toSummarise = middle
      .filter((m) => m.content)
      .map((m) => `${m.role}: ${(m.content || "").slice(0, 4000)}`)
      .join("\n---\n");
    if (!toSummarise) {
      this.lastCompactionAt = this.messageCount;
      return { ok: false, summary: "" };
    }
    const summary = await summarise(toSummarise).catch(() => "");
    this.compactCount++;
    this.lastCompactionAt = this.messageCount;
    if (summary) {
      // Reduce message history tracking.
      this.messageCount = Math.max(0, this.messageCount - (middle.length - 2));
      return { ok: true, summary };
    }
    return { ok: false, summary: "" };
  }

  forceResetMessages(): void {
    this.messageCount = 0;
    this.lastCompactionAt = 0;
  }

  /** Build the summarised history block that the agent injects as context. */
  async buildCompactedHistory(
    messages: ProviderChatMessage[],
    summarise: (text: string) => Promise<string>
  ): Promise<ProviderChatMessage[]> {
    const { ok, summary } = await this.compact(messages, summarise);
    if (!ok) return messages;
    const head = messages[0]?.role === "system" ? [messages[0]] : [];
    const tail = messages.slice(Math.max(1, messages.length - 8));
    const injected: ProviderChatMessage = {
      role: "system",
      content:
        "Earlier conversation was compacted to save context. Summary of what was done so far:\n" + summary,
    };
    return [...head, injected, ...tail];
  }
}
