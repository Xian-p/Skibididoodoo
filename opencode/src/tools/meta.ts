import { BaseTool, result } from "./tool";
import type { ToolArgs, ToolExecutionContext, ToolResult, ToolDefinition } from "../types";

/**
 * Lightweight "meta" tools. They do not mutate the project; they let the model
 * record milestones (notes/plan) that are echoed back in later context so the
 * loop's working memory stays visible without bloating the transcript.
 */

export class LogTool extends BaseTool {
  definition: ToolDefinition = {
    name: "log",
    description:
      "Record a short internal note (≤ 600 chars) into the agent's working memory, e.g. a decision, root cause hypothesis, or milestone. Notes persist across the session and are shown to the model on later turns.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Note content." } },
      required: ["message"],
    },
  };
  async run(args: ToolArgs, _ctx: ToolExecutionContext): Promise<ToolResult> {
    const msg = String(args.message || "").slice(0, 600);
    if (!msg) return { tool: this.definition.name, content: "No message provided.", summary: "no message", error: true, data: null };
    return result(this.definition.name, `Logged note: ${msg}`, { note: msg }, "note logged");
  }
}

export class PlanTool extends BaseTool {
  definition: ToolDefinition = {
    name: "plan",
    description:
      "Propose an execution plan as an ordered list of steps before making multi-step changes. Call it when a task requires more than one change. The plan is echoed to the model as context and shown to the user.",
    inputSchema: {
      type: "object",
      properties: { steps: { type: "array", items: { type: "string" }, description: "Ordered plan steps." }, summary: { type: "string" } },
      required: ["steps"],
    },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const steps = Array.isArray(args.steps) ? args.steps.map(String) : [];
    if (!steps.length) return { tool: this.definition.name, content: "Provide non-empty steps.", summary: "empty plan", error: true, data: null };
    const summary = String(args.summary || "Execution plan");
    ctx.onEvent({ type: "plan", plan: [summary, ...steps] });
    const body = `${summary}\n${steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`;
    return result(this.definition.name, body, { steps });
  }
}

export class StatusTool extends BaseTool {
  definition: ToolDefinition = {
    name: "status",
    description:
      "Read the agent's current working memory: discovered architecture notes, files changed this session, recent test/build results and unresolved issues. Use to recap before deciding next action.",
    inputSchema: { type: "object", properties: {} },
  };
  async run(_args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    // The agent injects a dynamic status into the tool execution environment.
    const status = (ctx as ToolExecutionContext & { __status?: string }).__status || "No status available.";
    return result(this.definition.name, status, {});
  }
}
