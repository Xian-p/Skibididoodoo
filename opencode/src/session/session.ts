import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderChatMessage, ProviderToolCall, SessionMetadata, ResolvedConfig } from "../types";
import { log } from "../util/logger";

export interface SessionState {
  id: string;
  projectDir: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  task?: string;
  messages: ProviderChatMessage[];
  /** Files this agent changed (absolute paths). */
  changedFiles: string[];
  /** Summary of latest tool activity for display. */
  lastAction?: string;
  iteration: number;
  /** The most recent turn summary so /compact has a hook. */
  lastSummary?: string;
}

/** Serializable model of a chat message. */
interface SerializedChatMessage {
  role: string;
  content: string | null;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
  name?: string;
}

export class Session {
  readonly state: SessionState;
  readonly sessionDir: string;
  private file: string;

  constructor(config: ResolvedConfig, id?: string) {
    this.sessionDir = config.sessionDir || path.join(config.opencodeDir, "sessions");
    fs.mkdirSync(this.sessionDir, { recursive: true });
    const sid = id || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.state = {
      id: sid,
      projectDir: config.cwd,
      model: config.model,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      changedFiles: [],
      iteration: 0,
    };
    this.file = path.join(this.sessionDir, `${sid}.json`);
  }

  static load(config: ResolvedConfig, id: string): Session | null {
    const f = path.join(config.sessionDir || path.join(config.opencodeDir, "sessions"), `${id}.json`);
    try {
      const raw = JSON.parse(fs.readFileSync(f, "utf8")) as SessionState & {
        messages?: SerializedChatMessage[];
      };
      const s = new Session(config, id);
      // Rehydrate fields.
      s.state.projectDir = raw.projectDir || config.cwd;
      s.state.model = raw.model || config.model;
      s.state.createdAt = raw.createdAt || new Date().toISOString();
      s.state.updatedAt = raw.updatedAt || new Date().toISOString();
      s.state.task = raw.task;
      s.state.changedFiles = raw.changedFiles || [];
      s.state.lastAction = raw.lastAction;
      s.state.iteration = raw.iteration || 0;
      s.state.lastSummary = raw.lastSummary;
      s.state.messages = (raw.messages || []).map(deserialize);
      s.save();
      return s;
    } catch (e) {
      log("warn", `failed to load session ${id}: ${(e as Error).message}`);
      return null;
    }
  }

  static list(config: ResolvedConfig): SessionMetadata[] {
    const dir = config.sessionDir || path.join(config.opencodeDir, "sessions");
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      const metas: SessionMetadata[] = [];
      for (const f of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SessionState & { messages?: SerializedChatMessage[] };
          metas.push({
            id: j.id,
            createdAt: j.createdAt,
            updatedAt: j.updatedAt,
            projectDir: j.projectDir,
            model: j.model,
            task: j.task,
            messages: (j.messages || []).length,
            filesChanged: (j.changedFiles || []).length,
          });
        } catch {
          /* skip corrupt */
        }
      }
      return metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    } catch {
      return [];
    }
  }

  save(): void {
    this.state.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(this.sessionDir, { recursive: true });
      const out = {
        ...this.state,
        messages: this.state.messages.map(serialize),
      };
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
    } catch (e) {
      log("warn", `failed to save session: ${(e as Error).message}`);
    }
  }

  touch(lastAction?: string): void {
    if (lastAction) this.state.lastAction = lastAction;
    this.save();
  }
}

function serialize(m: ProviderChatMessage): SerializedChatMessage {
  return {
    role: m.role,
    content: m.content,
    tool_calls: (m as { tool_calls?: ProviderToolCall[] }).tool_calls,
    tool_call_id: (m as { tool_call_id?: string }).tool_call_id,
    name: (m as { name?: string }).name,
  };
}

function deserialize(m: SerializedChatMessage): ProviderChatMessage {
  return {
    role: m.role as ProviderChatMessage["role"],
    content: m.content,
    tool_calls: m.tool_calls,
    tool_call_id: m.tool_call_id,
    name: m.name,
  };
}
