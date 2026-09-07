/**
 * Shared type definitions for the opencode agent.
 * Kept free of dependencies so every module can import from here.
 */

/** A structured tool call that the model requested. */
export interface ToolCall {
  /** Provider-side identifier used to correlate a tool result back. */
  id: string;
  /** Name of the tool to execute. */
  name: string;
  /** Raw JSON-stringified arguments. */
  argumentsJson: string;
}

/** Result of executing one tool. */
export interface ToolResult {
  tool: string;
  /** A short human label used by the model. */
  summary: string;
  /** Structured payload. */
  data: unknown;
  /** Error flag. */
  error: boolean;
  /** Whether the command was truncated by a timeout / size limit. */
  truncated?: boolean;
  /** Human-readable content streamed back to the model. */
  content: string;
}

/** A resolved (validated/parsed) argument object for a tool. */
export type ToolArgs = Record<string, unknown>;

/** Definition of a tool exposed to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON schema object for arguments (subset of JSON Schema). */
  inputSchema: Record<string, unknown>;
}

/** Any tool the agent can invoke. */
export interface Tool {
  definition: ToolDefinition;
  /** Execute with parsed args, returns a ToolResult. */
  execute(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult>;
}

/** Context handed to tools during execution. */
export interface ToolExecutionContext {
  /** Absolute path of the project/working directory. */
  cwd: string;
  /** Absolute path of the session/project .opencode dir. */
  opencodeDir: string;
  /** Timeout for terminal command execution, in ms. */
  commandTimeoutMs: number;
  /** Emission callback for tool lifecycle events (live status). */
  onEvent: (e: AgentEvent) => void;
  /** Set of paths this tool is allowed to touch (for writes/commands). */
  permission: PermissionsLike;
  /** Whether undo journaling is active (filesystem tools journal). */
  undo?: UndoJournalLike;
  /** Directory basenames excluded from recursive scans. */
  excludedDirs: string[];
}

/* ------------------------------- Provider ------------------------------- */

export interface ProviderChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** For assistant messages that carry tool calls (OpenAI wire format). */
  tool_calls?: ProviderToolCall[];
  /** For tool messages, correlation to the assistant tool call. */
  tool_call_id?: string;
  /** Tool name (OpenAI tool messages). */
  name?: string;
}

/** OpenAI-style function call as sent/received on the wire. */
export interface ProviderToolCall {
  id: string;
  type?: "function";
  function: { name: string; arguments: string };
}

/** Streamed completion events passed to the caller. */
export interface ProviderStreamEvent {
  type: "text" | "tool_call_delta" | "done" | "error";
  /** text delta when type === 'text' */
  text?: string;
  /** partial/accumulating tool call argument delta */
  toolCall?: ProviderToolCall;
  /** done payload */
  result?: ProviderCompletionResult;
  error?: string;
}

/** Final, normalised result of one model turn. */
export interface ProviderCompletionResult {
  text: string;
  toolCalls: ToolCall[];
  /** e.g. streamed usage hints or raw model name actually used. */
  finishReason?: string;
  model: string;
}

export interface ProviderModelMessage {
  role: "user" | "assistant";
  content: string;
}

/** Abstraction over a chat-completions style provider with streaming + tool calls. */
export interface ModelProvider {
  readonly name: string;
  readonly model: string;
  /** Stream one assistant turn. Yields ProviderStreamEvent objects. */
  streamChat(
    messages: ProviderChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal
  ): AsyncGenerator<ProviderStreamEvent>;
  /** One-shot non-streaming completion used for summarisation/compaction. */
  complete(
    messages: ProviderChatMessage[],
    opts?: { maxTokens?: number }
  ): Promise<string>;
  supportsNativeTools(): boolean;
}

/* ------------------------------- Events ------------------------------- */

export type AgentEventType =
  | "status"
  | "token"
  | "tool_start"
  | "tool_end"
  | "tool_error"
  | "text"
  | "plan"
  | "thinking"
  | "error";

export interface AgentEvent {
  type: AgentEventType;
  /** status message */
  message?: string;
  token?: string;
  tool?: string;
  args?: string;
  summary?: string;
  error?: string;
  plan?: string[];
  text?: string;
}

/* ------------------------------- Config ------------------------------- */

export type PermissionMode = "allow" | "ask" | "deny";

export interface PermissionRule {
  mode: PermissionMode;
}

export interface Config {
  /** OpenRouter model id for the primary model. */
  model: string;
  /** Ordered fallback models tried if the primary fails. */
  fallbackModels: string[];
  /** Provider base URL (defaults to OpenRouter). */
  baseUrl: string;
  /** Protocol used for tool calls: native OpenAI function calling or textual. */
  toolProtocol: "native" | "textual";
  maxIterations: number;
  /** Default timeout for executed terminal commands, in seconds. */
  commandTimeoutSec: number;
  /** Ask before file writes. */
  permissionMode: PermissionMode;
  /** Behaviour for dangerous commands. */
  dangerousMode: PermissionMode;
  /** Estimate of max context tokens before automatic compaction. */
  contextLimitTokens: number;
  /** Enable automatic compaction when context grows too large. */
  autoCompact: boolean;
  /** Directory names ignored during recursive scans/search. */
  excludedDirs: string[];
  /** If set, used to run tests; otherwise the agent guesses via run_tests tool. */
  testCommand?: string;
  /** If set, used to build; otherwise guessed. */
  buildCommand?: string;
  /** Disabled built-in tool names (model cannot invoke them). */
  disabledTools: string[];
  /** Extra deny command glob patterns. */
  denyCommands: string[];
  /** Extra allow command patterns that bypass the ask prompt. */
  allowCommands: string[];
  /** Timeout for the model HTTP request, in seconds. */
  requestTimeoutSec: number;
  /** Whether to print a thinking/status trace. */
  verbose: boolean;
  /** Max characters of tool result sent to the model (0 = unlimited). */
  toolResultLimitChars: number;
  /** Path to a working file used to auto-append transcript. */
  sessionDir: string;
}

export interface ResolvedConfig extends Config {
  /** API key resolved from env or file. */
  apiKey: string;
  /** Absolute project working directory. */
  cwd: string;
  /** Absolute path to the session .opencode dir. */
  opencodeDir: string;
}

/* ----------------------- Permissions / Undo (structural) ----------------------- */

export interface PermissionsLike {
  requireWrite(purpose: string, targetPath?: string): Promise<boolean>;
  requireCommand(command: string, cwd: string): Promise<boolean>;
  classifyRisk(command: string): { level: "safe" | "moderate" | "dangerous"; reason: string };
}

export interface UndoJournalLike {
  record(
    op: "write" | "delete" | "rename" | "mkdir",
    fromPath: string,
    backupPath?: string,
    toPath?: string
  ): Promise<void>;
}

/* ------------------------------- Misc ------------------------------- */

export interface DirectoryEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
}

export interface GitStatusEntry {
  path: string;
  status: string;
  staged: boolean;
}

export interface SessionMetadata {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectDir: string;
  model: string;
  task?: string;
  messages: number;
  filesChanged: number;
}
