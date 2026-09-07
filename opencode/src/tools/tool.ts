import type {
  Tool,
  ToolArgs,
  ToolDefinition,
  ToolResult,
  ToolExecutionContext,
  ToolCall,
} from "../types";

/** Base text-returning tool; executes args and converts errors to ToolResults. */
export abstract class BaseTool implements Tool {
  abstract definition: ToolDefinition;

  abstract run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult>;

  async execute(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    ctx.onEvent({ type: "tool_start", tool: this.definition.name });
    try {
      const res = await this.run(args, ctx);
      ctx.onEvent({ type: "tool_end", tool: this.definition.name, summary: res.summary });
      return res;
    } catch (e) {
      const err = (e as Error).message;
      ctx.onEvent({ type: "tool_error", tool: this.definition.name, error: err });
      return { tool: this.definition.name, summary: err, error: true, content: `Error: ${err}`, data: null };
    }
  }
}

export function result(tool: string, content: string, data: unknown, summary?: string): ToolResult {
  return { tool, content, data, summary: summary || firstLine(content), error: false };
}

function firstLine(s: string): string {
  const t = s.trim();
  const nl = t.indexOf("\n");
  return nl >= 0 ? t.slice(0, nl) + " …" : t;
}

export { Tool, ToolDefinition, ToolArgs, ToolResult, ToolExecutionContext, ToolCall };
