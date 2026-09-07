import type { Config, Tool, ToolArgs, ToolExecutionContext, ToolResult } from "../types";
import {
  ReadFileTool,
  ReadFileRangeTool,
  WriteFileTool,
  EditFileTool,
  DeleteFileTool,
  ListDirectoryTool,
} from "./filesystem";
import { ExecuteCommandTool, InspectErrorsTool } from "./terminal";
import { SearchCodeTool } from "./search";
import { GitStatusTool, GitDiffTool } from "./git";
import { RunTestsTool, RunBuildTool } from "./testbuild";
import { LogTool, PlanTool, StatusTool } from "./meta";

export interface AssembledTools {
  /** By-name map for dispatch. */
  byName: Map<string, Tool>;
  /** Definitions for the model. */
  definitions: import("../types").ToolDefinition[];
}

/** Build the full tool set honouring config.disabledTools. */
export function assembleTools(config: Config): AssembledTools {
  const all: Tool[] = [
    new ReadFileTool(),
    new ReadFileRangeTool(),
    new WriteFileTool(),
    new EditFileTool(),
    new DeleteFileTool(),
    new ListDirectoryTool(),
    new SearchCodeTool(),
    new ExecuteCommandTool(),
    new InspectErrorsTool(),
    new GitStatusTool(),
    new GitDiffTool(),
    new RunTestsTool(),
    new RunBuildTool(),
    new LogTool(),
    new PlanTool(),
    new StatusTool(),
  ];
  // Attach configured test/build commands where available.
  for (const t of all) {
    if (t instanceof RunTestsTool) t.configuredCommand = config.testCommand;
    if (t instanceof RunBuildTool) t.configuredCommand = config.buildCommand;
  }
  const disabled = new Set(config.disabledTools || []);
  const kept = all.filter((t) => !disabled.has(t.definition.name));
  const byName = new Map(kept.map((t) => [t.definition.name, t]));
  return { byName, definitions: kept.map((t) => t.definition) };
}

/** Execute one tool by name with args, returning a ToolResult (never throws). */
export async function runTool(
  byName: Map<string, Tool>,
  name: string,
  argsJson: string,
  ctx: ToolExecutionContext
): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) {
    return {
      tool: name,
      content: `Unknown tool '${name}'. Valid tools: ${Array.from(byName.keys()).join(", ")}.`,
      summary: `unknown tool ${name}`,
      error: true,
      data: null,
    };
  }
  let args: ToolArgs = {};
  if (argsJson && argsJson.trim()) {
    try {
      args = JSON.parse(argsJson);
    } catch {
      return {
        tool: name,
        content: `Invalid JSON arguments for tool ${name}: ${argsJson.slice(0, 200)}. Provide valid JSON object.`,
        summary: "invalid tool arguments JSON",
        error: true,
        data: null,
      };
    }
  }
  return tool.execute(args, ctx);
}
