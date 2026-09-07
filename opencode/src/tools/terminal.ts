import { BaseTool, result } from "./tool";
import type { ToolArgs, ToolExecutionContext, ToolResult, ToolDefinition } from "../types";
import { runShellCommand } from "./runner";

export class ExecuteCommandTool extends BaseTool {
  definition: ToolDefinition = {
    name: "execute_command",
    description:
      "Run a terminal command inside the project directory and return its combined output and exit code. Use for builds, tests, git, package installs and one-off inspection. Output is truncated to the last ~12000 chars per stream.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        timeoutSec: { type: "number", description: "Optional override of the configured timeout in seconds." },
      },
      required: ["command"],
    },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const command = String(args.command);
    const timeoutSec = Number(args.timeoutSec) || Math.round(ctx.commandTimeoutMs / 1000);
    if (!(await ctx.permission.requireCommand(command, ctx.cwd))) {
      return {
        tool: this.definition.name,
        content: `Permission denied: command not allowed.`,
        summary: "command denied",
        error: true,
        data: null,
      };
    }
    ctx.onEvent({ type: "status", message: `$ ${command}` });
    const r = await runShellCommand(command, { cwd: ctx.cwd, timeoutMs: timeoutSec * 1000 });
    const merged = `${r.stdout}${r.stderr ? (r.stdout ? "\n" : "") + r.stderr : ""}`.trim();
    const tail = (r.timedOut ? `\n[timed out after ${timeoutSec}s — process was killed]\n` : "") +
      merged +
      (r.truncatedOut ? "\n… (output truncated)" : "");
    const status =
      r.timedOut ? "timeout" : r.exitCode === 0 ? "exit 0 (OK)" : `exit ${r.exitCode} (FAILED)`;
    const content = `Command: ${command}\nStatus: ${status}\n${tail || "(no output)"}`;
    return result(this.definition.name, content, { exitCode: r.exitCode, timedOut: r.timedOut, stdout: r.stdout, stderr: r.stderr }, status);
  }
}

export class InspectErrorsTool extends BaseTool {
  definition: ToolDefinition = {
    name: "inspect_errors",
    description:
      "Parse the most recent command/test failure output for error lines, stack traces, and failing assertions, and suggest likely files. Call after a failing command to get a focused error report.",
    inputSchema: {
      type: "object",
      properties: {
        output: { type: "string", description: "The raw command/test output that failed." },
      },
      required: ["output"],
    },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const raw = String(args.output || "");
    if (!raw.trim()) return { tool: this.definition.name, content: "No output to inspect.", summary: "no output", error: false, data: null };
    const lines = raw.split(/\r?\n/);
    const errorLines: string[] = [];
    const fileRefs: string[] = [];
    const reFile = /(?:at\s+|Error:|\.\w+\(| in )?\s*([A-Za-z0-9_\-./\\]+\.(?:ts|tsx|js|jsx|py|rb|go|rs|java|json|yaml|yml|c|cpp|h|css))(?::(\d+)(?::(\d+))?)?/g;
    for (const ln of lines) {
      const t = ln.trim();
      if (/error|failed|exception|traceback|cannot|undefined|is not a function|SyntaxError|TypeError|AssertionError|FAILED|Error:/i.test(t) && t.length > 3 && t.length < 400) {
        errorLines.push(t);
      }
      let m: RegExpExecArray | null;
      reFile.lastIndex = 0;
      while ((m = reFile.exec(ln)) !== null) {
        const loc = m[1].includes("/") || m[1].includes("\\") ? m[1] : undefined;
        if (loc) fileRefs.push(`${loc}${m[2] ? ":" + m[2] : ""}`);
      }
    }
    const uniqRefs = Array.from(new Set(fileRefs)).slice(0, 15);
    const report = [
      `Inspection of command output (${lines.length} lines):`,
      "",
      "Likely error/assertion lines:",
      ...(errorLines.slice(0, 20).map((e) => `  ✖ ${e}`) || ["  (none matched heuristically)"]),
      "",
      "Referenced source locations:",
      ...(uniqRefs.length ? uniqRefs.map((f) => `  → ${f}`) : ["  (none)" ]),
    ].join("\n");
    return result(this.definition.name, report, { errorLines: errorLines.slice(0, 20), fileRefs: uniqRefs });
  }
}
