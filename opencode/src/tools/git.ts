import { spawnSync } from "node:child_process";
import { BaseTool, result } from "./tool";
import type { ToolArgs, ToolExecutionContext, ToolResult, ToolDefinition } from "../types";
import { findGitRoot, displayPath } from "./pathutil";

function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string; code: number | null } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), code: r.status };
}

export class GitStatusTool extends BaseTool {
  definition: ToolDefinition = {
    name: "git_status",
    description: "Report git status: current branch, staged and unstaged changes, untracked files. Run to see what changed before/after edits.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: "Optional repo path (default project)." } } },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const p = ctx.cwd;
    const root = findGitRoot(p);
    if (!root) return { tool: this.definition.name, content: "Not a git repository.", summary: "not a git repo", error: false, data: null };
    const s = git(p, ["status", "--porcelain=v1", "--branch"]);
    const parsed: { path: string; status: string; staged: boolean }[] = [];
    for (const line of s.out.split("\n")) {
      if (!line.trim() || line.startsWith("##")) continue;
      const staged = line.trim().charAt(0) !== " " && line.trim().charAt(0) !== "?";
      parsed.push({ path: line.slice(3).trim(), status: line.slice(0, 2), staged });
    }
    const content = s.ok ? `Git root: ${root}\n${s.out || "(clean working tree)"}` : `git failed: ${s.err}`;
    return result(this.definition.name, content, { branch: branchName(s.out), entries: parsed, dirty: parsed.length > 0 });
  }
}

export class GitDiffTool extends BaseTool {
  definition: ToolDefinition = {
    name: "git_diff",
    description: "Show the git diff for tracked/untracked changes. Useful to verify exactly what changed. Optionally diff a single file or a staged/unstaged scope.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Restrict to a specific file/dir path." },
        staged: { type: "boolean", description: "Show the staged (index) diff instead." },
      },
    },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const root = findGitRoot(ctx.cwd);
    if (!root) return { tool: this.definition.name, content: "Not a git repository.", summary: "not a git repo", error: false, data: null };
    const scope = args.path ? [String(args.path)] : [];
    const base = args.staged ? ["--cached"] : [];
    const d = git(ctx.cwd, ["diff", ...base, ...scope]);
    const MAX = 24000;
    let out = d.out;
    if (out.length > MAX) out = out.slice(0, MAX) + "\n… (diff truncated)";
    return result(this.definition.name, out || "(no diff)", { ok: d.ok });
  }
}

function branchName(porcelain: string): string {
  const first = porcelain.split("\n")[0] || "";
  if (first.startsWith("##")) return first.replace("## ", "").split(" ")[0];
  return "unknown";
}

export function gitDiffUntracked(cwd: string): string {
  return git(cwd, ["status", "--porcelain"]).out;
}
