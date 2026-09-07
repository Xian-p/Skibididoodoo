import * as path from "node:path";
import type {
  AgentEvent,
  ProviderChatMessage,
  ResolvedConfig,
  ToolCall,
  ToolExecutionContext,
  ToolResult,
} from "../types";
import { ModelManager, parseTextualToolCalls } from "../provider/manager";
import { assembleTools, runTool } from "../tools/registry";
import { PermissionSystem, type Risk } from "../permissions/permissions";
import { UndoManager } from "../session/undo";
import { ContextManager } from "../context/context";
import { Session } from "../session/session";
import { log } from "../util/logger";

export interface TurnResult {
  finalText: string;
  iterations: number;
  reachedLimit: boolean;
  madeEdits: boolean;
  verified: boolean;
  filesChanged: string[];
  warnings: string[];
  stoppedForLoop: boolean;
}

export interface AgentDeps {
  onEvent: (e: AgentEvent) => void;
  ask: (prompt: string, opts?: { danger?: boolean }) => Promise<boolean>;
  isInteractive: () => boolean;
}

export interface PermissionAdapter {
  requireWrite(purpose: string, targetPath?: string): Promise<boolean>;
  requireCommand(command: string, cwd: string): Promise<boolean>;
  classifyRisk(command: string): Risk;
}

const SYSTEM_BLOCK = `You are opencode, an autonomous coding agent that runs entirely inside a real terminal on the user's machine.
You accomplish tasks by reasoning and calling tools. The tools are REAL: they actually inspect, read, write and execute code, run tests and git. Treat their output as ground truth. NEVER fabricate tool output, file contents, test results, command results or git state.

WORKFLOW DISCIPLINE (use judgment, do not follow blindly):
1. First inspect the project (list_directory / read_file / search_code / git_status) before changing anything.
2. Understand the relevant code before editing. Read files or precise line ranges first.
3. For multi-step tasks, call the plan tool with ordered steps.
4. Make precise edits with edit_file when possible; use write_file only when rewriting is intended.
5. Verify your changes: run run_tests / run_build or execute_command (e.g. npm test, node script.js, pytest). Run git_diff and git_status to prove what changed.
6. If a command/test fails, call inspect_errors or read the output, diagnose, fix, then re-run until it passes.
7. Iterate on your own. Do NOT stop after the first attempt if verification failed.
8. Only claim a task succeeded after you have actually verified the result with a passing command/test.
9. Do not use git reset --hard. Do not destroy unrelated user changes.
10. Keep output reasonably concise. Explain what you did and the verified result at the end.

TOOLS YOU CAN CALL:
- plan, read_file, read_file_range, write_file, edit_file, delete_file, list_directory, search_code, execute_command, inspect_errors, git_status, git_diff, run_tests, run_build, log, status.
Do not invent other tools. Pass arguments as valid JSON matching each tool's schema.

When you are finished and everything is verified, reply with a concise final summary (no tool call).`;

function memoryBlock(ctxMgr: ContextManager): string {
  return ctxMgr.renderMemoryBlock();
}

const TOOL_RESULT_PREFIX = "Below is the real result of a tool you requested. Use it to decide your next action.";

export class Agent {
  readonly config: ResolvedConfig;
  readonly manager: ModelManager;
  private deps: AgentDeps;
  private ctx: ContextManager;
  private undo: UndoManager;
  private perms: PermissionSystem;
  private permissionsAdapter: PermissionAdapter;
  private tools: ReturnType<typeof assembleTools>;
  private session: Session;
  private messages: ProviderChatMessage[] = [];
  private changedFiles: string[] = [];

  constructor(config: ResolvedConfig, manager: ModelManager, deps: AgentDeps) {
    this.config = config;
    this.manager = manager;
    this.deps = deps;
    this.ctx = new ContextManager(config);
    this.undo = new UndoManager(config.opencodeDir);
    this.perms = new PermissionSystem(config, config.cwd, (p, o) => deps.ask(p, { danger: o?.danger }));
    this.permissionsAdapter = {
      requireWrite: (purpose, target) => this.perms.requireWrite(purpose, target),
      requireCommand: (cmd) => this.perms.requireCommand(cmd),
      classifyRisk: (cmd) => this.perms.classifyRisk(cmd),
    };
    this.session = new Session(config);
    this.tools = assembleTools(config);
    this.messages = [];
  }

  getSession(): Session {
    return this.session;
  }

  /** Build a tool execution context used for the given iteration. */
  private toolContext(): ToolExecutionContext {
    const onEvent = this.deps.onEvent;
    const ctx: ToolExecutionContext & { __status?: string } = {
      cwd: this.config.cwd,
      opencodeDir: this.config.opencodeDir,
      commandTimeoutMs: this.config.commandTimeoutSec * 1000,
      excludedDirs: this.config.excludedDirs,
      permission: this.permissionsAdapter as unknown as ToolExecutionContext["permission"],
      undo: this.undo as unknown as ToolExecutionContext["undo"],
      onEvent,
      __status: this.statusText(),
    };
    return ctx as unknown as ToolExecutionContext;
  }

  private statusText(): string {
    const edits = this.changedFiles.length;
    return `Working memory:
- Notes: ${this.ctx.getNotes().length ? this.ctx.getNotes().map((n) => `\n  * ${n}`).join("") : "none"}
- Files changed this session: ${edits ? this.changedFiles.map((f) => "\n  * " + f).join("") : "none"}
- Undo journal entries pending: ${this.undo.count()}
- Session model: ${this.manager.currentModel()}
Use tools to inspect more if needed.`;
  }

  private systemPrompt(): string {
    const mem = memoryBlock(this.ctx);
    let extra = "";
    if (mem) extra = `\n\nCONTEXT STATE:\n${mem}\n\nFiles already read are listed so you need not re-read them in full unless they changed.`;
    if (this.config.toolProtocol === "textual") {
      extra += `\n\nTOOL CALLING PROTOCOL (textual):\nYou do NOT have native function calling in this session. To request a tool, reply with ONLY a tool block in this exact JSON-on-one-idea format:\n<tool_call>{"name":"read_file","arguments":{"path":"src/main.ts"}}</tool_call>\nYou may emit several tool blocks in one message. Tool arguments must be valid JSON. After the tools run, their real results are sent back to you as the next user message. To give your FINAL answer (when finished and verified), reply with normal text and no <tool_call> block. Never invent tool results.\n\nAVAILABLE TOOL SIGNATURES (name(args) — meaning):\n${this.tools.definitions.map(formatToolRef).join("\n")}`;
    }
    return SYSTEM_BLOCK + extra;
  }

  /** Called when a file is changed by the agent so undo + tracking update. */
  private recordFileChange(p: string): void {
    const rel = path.relative(this.config.cwd, p) || p;
    if (!this.changedFiles.includes(rel)) this.changedFiles.push(rel);
    this.session.state.changedFiles = this.changedFiles;
  }

  /** Restore a prior conversation history (for --resume). */
  loadHistory(messages: ProviderChatMessage[]): void {
    this.messages = messages.map((m) => ({ ...m }));
    this.ctx.forceResetMessages();
    this.session.state.messages = this.messages;
    this.session.save();
  }

  /** Drop an unfinished tool block (messages awaiting an assistant reply) at the tail. */
  private truncateUnclosedToolBlock(): void {
    while (this.messages.length) {
      const last = this.messages[this.messages.length - 1];
      if (last.role === "tool") {
        this.messages.pop();
        continue;
      }
      if (last.role === "assistant" && last.tool_calls && last.tool_calls.length) {
        this.messages.pop();
      }
      break;
    }
  }

  async run(request: string): Promise<TurnResult> {
    const warnings: string[] = [];
    this.session.state.task = request;
    this.session.state.iteration = 0;

    // Multi-turn continuity: refresh the system context but keep history.
    this.truncateUnclosedToolBlock();
    if (this.messages.length === 0 || this.messages[0].role !== "system") {
      this.messages.unshift({ role: "system", content: this.systemPrompt() });
    } else {
      this.messages[0].content = this.systemPrompt();
    }
    // Drop a redundant trailing assistant final message? keep for context but add boundary:
    this.messages.push({ role: "user", content: request });
    this.session.state.messages = this.messages;
    this.session.save();

    let finalText = "";
    let reachedLimit = false;
    let stoppedForLoop = false;
    let lastToolKey = "";
    let lastToolRepeat = 0;
    let anyVerificationRun = false;

    this.deps.onEvent({ type: "thinking", text: request });

    for (let iteration = 0; iteration < this.config.maxIterations; iteration++) {
      this.session.state.iteration = iteration + 1;
      this.deps.onEvent({ type: "status", message: `iteration ${iteration + 1}/${this.config.maxIterations}` });
      this.ctx.countMessage();

      // Auto-compact if needed.
      if (this.ctx.needsAutoCompact()) {
        this.deps.onEvent({ type: "status", message: "context growing — auto-compacting" });
        await this.compactNow();
      }

      const textual = !this.manager.current().supportsNativeTools();
      const toolDefs = textual ? [] : this.tools.definitions;

      let assistantText = "";
      let assistantToolCalls: ToolCall[] = [];
      let providerError: string | undefined;

      try {
        for await (const { event, provider } of this.manager.streamWithFallback(
          this.buildProviderMessages(textual),
          toolDefs,
          undefined,
          (from, to, reason) => {
            this.deps.onEvent({ type: "status", message: `provider fallback: ${from} → ${to} (${reason})` });
            warnings.push(`Model provider switched ${from} → ${to}: ${reason}`);
          }
        )) {
          switch (event.type) {
            case "text":
              assistantText += event.text || "";
              this.deps.onEvent({ type: "text", text: event.text });
              break;
            case "tool_call_delta":
              break;
            case "done":
              assistantToolCalls = event.result?.toolCalls || [];
              if (event.result?.model) this.deps.onEvent({ type: "status", message: `model: ${provider}` });
              break;
            case "error":
              providerError = event.error;
              break;
          }
        }
      } catch (e) {
        providerError = (e as Error).message;
        finalText = `A provider error occurred and could not be recovered: ${providerError}`;
        this.deps.onEvent({ type: "error", error: providerError });
        this.messages.push({ role: "assistant", content: finalText });
        this.session.save();
        return this.buildResult(finalText, iteration + 1, false, warnings, reachedLimit, stoppedForLoop);
      }

      if (providerError) {
        finalText = `Provider error: ${providerError}`;
        this.deps.onEvent({ type: "error", error: providerError });
        this.messages.push({ role: "assistant", content: finalText });
        this.session.save();
        return this.buildResult(finalText, iteration + 1, false, warnings, reachedLimit, stoppedForLoop);
      }

      // If the model produced textual markers (even in native mode), merge them.
      if (textual || assistantToolCalls.length === 0) {
        const parsed = parseTextualToolCalls(assistantText);
        if (parsed.calls.length) {
          assistantToolCalls = parsed.calls;
          assistantText = parsed.cleaned;
        }
      }

      if (!assistantText && assistantToolCalls.length === 0) {
        // Empty response — treat as unusable instead of spinning until the cap.
        finalText = "The model returned an empty response. Nothing was executed this turn.";
        this.deps.onEvent({ type: "error", error: "empty model response" });
        this.messages.push({ role: "assistant", content: finalText });
        this.session.save();
        return this.buildResult(finalText, iteration + 1, false, warnings, reachedLimit, stoppedForLoop);
      }

      if (assistantText && assistantToolCalls.length === 0) {
        // Final answer text with no tools requested.
        finalText = assistantText;
        // Verification discipline check.
        if (this.changedFiles.length && !anyVerificationRun && this.editsAreCode()) {
          warnings.push(
            "The model finished after editing code but did not run a verification command (run_tests/run_build/execute_command). Its success claim is NOT independently verified — please verify manually."
          );
        }
        this.messages.push({ role: "assistant", content: assistantText });
        this.session.state.messages = this.messages;
        this.session.save();
        return this.buildResult(finalText, iteration + 1, false, warnings, reachedLimit, stoppedForLoop);
      }

      // Build assistant message carrying tool calls (and text if any), in wire format.
      // In textual mode the provider never saw native tool_calls, so omit them there.
      const assistantMsg: ProviderChatMessage = {
        role: "assistant",
        content: assistantText || null,
      };
      if (!textual && assistantToolCalls.length) {
        assistantMsg.tool_calls = assistantToolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argumentsJson },
        }));
      }
      this.messages.push(assistantMsg);

      // Execute each requested tool.
      for (const tc of assistantToolCalls) {
        const key = `${tc.name}::${tc.argumentsJson}`;
        if (key === lastToolKey) lastToolRepeat++;
        else {
          lastToolKey = key;
          lastToolRepeat = 1;
        }
        if (lastToolRepeat >= 3) {
          stoppedForLoop = true;
          finalText = `Stopped: the agent repeatedly invoked the identical tool call (${tc.name}). This usually indicates the model is stuck in a loop. Aborting to avoid running forever.`;
          this.deps.onEvent({ type: "error", error: finalText });
          this.messages.push({ role: "assistant", content: finalText });
          this.session.save();
          return this.buildResult(finalText, iteration + 1, false, warnings, reachedLimit, stoppedForLoop);
        }

        const res = await this.executeToolCall(tc);
        if (/^(run_tests|run_build|execute_command|git_diff|git_status)$/.test(tc.name)) {
          anyVerificationRun = true;
        }
        if (res.tool === "write_file" || res.tool === "edit_file" || res.tool === "delete_file" || res.tool === "rename_file") {
          // capture the changed path from the result data
          const d = res.data as { path?: string } | null;
          if (d?.path) this.recordFileChange(d.path);
        }
        if (res.error) this.deps.onEvent({ type: "tool_error", tool: tc.name, error: res.summary });

        if (textual) {
          // Embed tool result as a user message.
          this.messages.push({
            role: "user",
            content: `${TOOL_RESULT_PREFIX}\nTool: ${tc.name}\n${limitStr(res.content, this.config.toolResultLimitChars)}`,
            name: tc.name,
          });
        } else {
          this.messages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: limitStr(res.content, this.config.toolResultLimitChars),
          });
        }
      }

      this.session.state.messages = this.messages;
      this.session.save();
    }

    // Hit iteration limit without a final text-only answer.
    reachedLimit = true;
    finalText =
      `Reached the maximum iteration limit (${this.config.maxIterations}) without reaching a final answer. ` +
      (this.changedFiles.length ? `Files changed this session: ${this.changedFiles.join(", ")}. Please verify manually.` : "No files were changed. Something may be blocking the model from completing.");
    this.deps.onEvent({ type: "error", error: "iteration limit reached" });
    return this.buildResult(finalText, this.config.maxIterations, false, warnings, reachedLimit, stoppedForLoop);
  }

  private editsAreCode(): boolean {
    return this.changedFiles.some((f) => /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|rb|php|sh|css|html|json)$/.test(f) && !f.includes(".opencode"));
  }

  private async executeToolCall(tc: ToolCall): Promise<ToolResult> {
    const ctx = this.toolContext();
    const res = await runTool(this.tools.byName, tc.name, tc.argumentsJson, ctx);
    this.deps.onEvent({
      type: "tool_end",
      tool: tc.name,
      summary: res.summary,
      args: tc.argumentsJson.slice(0, 200),
    });
    // Update file-change tracking from tool data.
    if (/^(write_file|edit_file|delete_file)$/.test(tc.name)) {
      const d = res.data as { path?: string } | null;
      if (d?.path) this.recordFileChange(d.path);
    }
    return res;
  }

  private buildProviderMessages(textual: boolean): ProviderChatMessage[] {
    // Keep it simple: return current messages. (Tool messages are already mapped.)
    return this.messages;
  }

  private buildResult(
    finalText: string,
    iterations: number,
    madeEdits: boolean,
    warnings: string[],
    reachedLimit: boolean,
    stoppedForLoop: boolean
  ): TurnResult {
    return {
      finalText,
      iterations,
      reachedLimit,
      stoppedForLoop,
      madeEdits: this.changedFiles.length > 0,
      verified: false, // only the model reports specifics; we stay conservative
      filesChanged: [...this.changedFiles],
      warnings,
    };
  }

  /** Ask the model to summarise older messages to free context. */
  private async compactNow(): Promise<void> {
    try {
      const summariser = async (text: string): Promise<string> => {
        try {
          return await this.manager.complete([
            { role: "system", content: "Summarise the following agent conversation concisely but preserve all important facts: task requirements, files examined, root causes, edits made, command/test outcomes (including failures), and any unresolved issues. Do not omit error details or changed file names." },
            { role: "user", content: text },
          ]);
        } catch {
          return "";
        }
      };
      const newMessages = await this.ctx.buildCompactedHistory(this.messages, summariser);
      this.messages = newMessages;
      this.session.state.messages = this.messages;
      this.session.save();
      this.deps.onEvent({ type: "status", message: "compaction complete" });
    } catch (e) {
      log("warn", `compaction failed: ${(e as Error).message}`);
    }
  }

  /** Public: manual /compact trigger. */
  async compactManual(): Promise<string> {
    const before = this.messages.length;
    await this.compactNow();
    const after = this.messages.length;
    return `Context compacted: ${before} → ${after} message blocks. (Summary injected as system context.)`;
  }

  getChangedFiles(): string[] {
    return [...this.changedFiles];
  }

  /** /undo — rolls back this agent's own filesystem modifications safely. */
  async undoAll(): Promise<string> {
    const n = this.undo.count();
    if (n === 0) return "Nothing recorded to undo in this project session.";
    const confirm = await this.deps.ask(
      `Undo the last ${n} file operation(s) this agent performed in this session? Unrelated changes you made yourself are never touched. Continue?`
    );
    if (!confirm) return "Undo cancelled.";
    const changed = this.changedFiles;
    try {
      const report = await this.undo.undoSince(0);
      // Reset changed-file tracking since we restored originals.
      this.changedFiles = [];
      this.session.state.changedFiles = [];
      this.session.save();
      return `Undo complete.\n${report}\n\nPreviously changed: ${changed.join(", ") || "none"}`;
    } catch (e) {
      return `Undo partially failed: ${(e as Error).message}`;
    }
  }

  /** /diff — show the git diff of files this agent touched. */
  async diff(): Promise<string> {
    const { spawnSync } = require("node:child_process");
    const args = ["diff"];
    if (this.changedFiles.length) args.push("--", ...this.changedFiles.map((f) => path.join(this.config.cwd, f)));
    const r = spawnSync("git", args, { cwd: this.config.cwd, encoding: "utf8" });
    const untracked = spawnSync("git", ["status", "--short"], { cwd: this.config.cwd, encoding: "utf8" });
    const out = [
      r.status === 0 ? r.stdout.trim() : r.stderr.trim(),
      "",
      "Status:",
      untracked.status === 0 ? untracked.stdout.trim() : untracked.stderr.trim(),
    ].join("\n");
    return out || "(no diff)";
  }

  /** /plan — for a natural-language request, ask model to outline steps (read-only). */
  async plan(request: string): Promise<string> {
    try {
      const out = await this.manager.complete([
        { role: "system", content: "You are a senior engineer. Inspect/plan a task but DO NOT edit files. Return a concise ordered plan of the inspection, edits and verification steps you would take. It is OK to reference likely files but phrase as 'I would read X', do not run anything." },
        { role: "user", content: request },
      ]);
      return out || "(no plan returned)";
    } catch (e) {
      return `plan failed: ${(e as Error).message}`;
    }
  }

  currentModelLabel(): string {
    return this.manager.currentModel();
  }
}

function limitStr(s: string, max: number): string {
  if (!max || s.length <= max) return s;
  return s.slice(0, max) + `\n… (trimmed to ${max} chars)`;
}

function formatToolRef(def: { name: string; description: string; inputSchema: Record<string, unknown> }): string {
  const props = (def.inputSchema.properties as Record<string, { type?: string; description?: string }> | undefined) || {};
  const required = Array.isArray(def.inputSchema.required) ? (def.inputSchema.required as string[]) : [];
  const args = Object.entries(props)
    .map(([k, v]) => `${k}${required.includes(k) ? "" : "?"}:${v?.type || "any"}`)
    .join("; ");
  return `${def.name}(${args}) — ${def.description}`;
}
