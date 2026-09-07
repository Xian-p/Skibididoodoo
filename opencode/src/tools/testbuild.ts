import * as fs from "node:fs";
import { BaseTool, result } from "./tool";
import type { ToolArgs, ToolExecutionContext, ToolResult, ToolDefinition } from "../types";
import { runShellCommand } from "./runner";

/** Detect likely test/build commands from project files. */
export function detectCommands(cwd: string): { test?: string; build?: string } {
  const out: { test?: string; build?: string } = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(`${cwd}/package.json`, "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts) {
      out.test = pkg.scripts["test:ci"] || pkg.scripts["test"] || undefined;
      out.build = pkg.scripts["build"] || undefined;
    }
  } catch {
    /* not a node package */
  }
  if (fs.existsSync(`${cwd}/Makefile`)) out.build = out.build || "make";
  if (fs.existsSync(`${cwd}/pyproject.toml`) || fs.existsSync(`${cwd}/requirements.txt`))
    out.test = out.test || "pytest -q";
  if (fs.existsSync(`${cwd}/Cargo.toml`)) {
    out.test = out.test || "cargo test";
    out.build = out.build || "cargo build";
  }
  if (fs.existsSync(`${cwd}/go.mod`)) {
    out.test = out.test || "go test ./...";
    out.build = out.build || "go build ./...";
  }
  return out;
}

abstract class VerifyTool extends BaseTool {
  abstract kind: "test" | "build";
  /** Configured explicit command (optional). */
  configuredCommand?: string;

  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const explicit = args.command ? String(args.command) : undefined;
    const detected = detectCommands(ctx.cwd);
    const configured = this.configuredCommand;
    const fallbackDetected = this.kind === "test" ? detected.test : detected.build;
    const command =
      explicit ||
      configured ||
      fallbackDetected ||
      (this.kind === "test" ? `echo "[run_tests] no test command detected; run one manually"` : `echo "[run_build] no build command detected"`);
    const label = this.kind.toUpperCase();
    ctx.onEvent({ type: "status", message: `[${label}] $ ${command}` });
    const r = await runShellCommand(command, { cwd: ctx.cwd, timeoutMs: ctx.commandTimeoutMs });
    const merged = `${r.stdout}${r.stderr ? "\n" + r.stderr : ""}`.trim();
    const status = r.timedOut
      ? `timeout after ${Math.round(ctx.commandTimeoutMs / 1000)}s`
      : r.exitCode === 0
        ? `exit 0 (${label} passed)`
        : `exit ${r.exitCode} (${label} FAILED)`;
    const content = `[${label}] ${command}\nStatus: ${status}\n${merged || "(no output)"}`;
    const failed = r.timedOut || r.exitCode !== 0;
    return result(
      this.definition.name,
      content,
      { command, exitCode: r.exitCode, passed: !failed, timedOut: r.timedOut },
      status
    );
  }
}

export class RunTestsTool extends VerifyTool {
  readonly kind = "test" as const;
  definition: ToolDefinition = {
    name: "run_tests",
    description:
      "Run the project's test suite. Uses the configured testCommand, the explicit command argument, or auto-detects from package.json/pytest/cargo/go. Returns full output plus pass/fail. Use after edits to verify.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "Optional explicit test command override." } },
    },
  };
}

export class RunBuildTool extends VerifyTool {
  readonly kind = "build" as const;
  definition: ToolDefinition = {
    name: "run_build",
    description:
      "Run the project's build/lint/typecheck command to confirm it compiles. Uses configured buildCommand, explicit command, or auto-detection.",
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "Optional explicit build command override." } },
    },
  };
}
