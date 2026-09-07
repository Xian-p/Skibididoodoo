import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { BaseTool, result } from "./tool";
import type { ToolArgs, ToolExecutionContext, ToolResult, ToolDefinition } from "../types";
import { abs, displayPath } from "./pathutil";

function ignoreArgs(excludedDirs: string[]): string[] {
  const args: string[] = [];
  for (const d of excludedDirs) args.push("--glob", `!**/${d}/**`);
  args.push("--glob", "!.git/**");
  return args;
}

export class SearchCodeTool extends BaseTool {
  definition: ToolDefinition = {
    name: "search_code",
    description:
      "Search the project source using ripgrep (rg) with a plain grep fallback. Use regex. Skips node_modules, .git and other excluded directories automatically. Returns matching lines with file:line:content and optional context.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex (or literal) to search for." },
        path: { type: "string", description: "Optional directory/file to scope the search (default project root)." },
        glob: { type: "string", description: "Optional glob like '*.ts' to filter files." },
        context: { type: "number", description: "Number of lines of context around each match (default 0)." },
        literal: { type: "boolean", description: "Treat pattern as a literal string (default false)." },
      },
      required: ["pattern"],
    },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const pattern = String(args.pattern);
    const base = abs(ctx.cwd, String(args.path || "."));
    const glob = args.glob ? String(args.glob) : undefined;
    const context = Math.min(5, Number(args.context) || 0);
    const literal = Boolean(args.literal);
    const rgArgs = ["--line-number", "--no-heading", "--color", "never", "-a"];
    if (context > 0) rgArgs.push("-C", String(context));
    rgArgs.push(...ignoreArgs(ctx.excludedDirs));
    if (glob) rgArgs.push("--glob", glob);
    if (literal) rgArgs.push("--fixed-strings");
    rgArgs.push(pattern, base);

    const rg = spawnSync("rg", rgArgs, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    let out: string;
    let truncated = false;
    const MAX = 20000;
    if (rg.error || rg.status === null) {
      // rg missing or error → grep fallback
      const fallback = grepFallback(base, pattern, literal, glob, ctx.excludedDirs, context);
      out = fallback.out;
      truncated = fallback.truncated;
    } else if (rg.status === 0) {
      out = rg.stdout;
    } else if (rg.status === 1) {
      out = ""; // no matches
    } else {
      out = `rg failed (status ${rg.status}): ${rg.stderr}`.trim();
    }
    if (out.length > MAX) {
      truncated = true;
      out = out.slice(0, MAX) + "\n… (truncated)";
    }
    const lines = out ? out.split("\n") : [];
    if (truncated && lines.length) lines[lines.length - 1] = lines[lines.length - 1].replace("… (truncated)", "… (truncated)");
    return result(
      this.definition.name,
      lines.length
        ? `Matches for ${JSON.stringify(pattern)} (${lines.length} lines shown):\n${out}`
        : `No matches for ${JSON.stringify(pattern)} in ${displayPath(ctx.cwd, base)}`,
      { matches: lines.length, truncated }
    );
  }
}

function grepFallback(
  base: string,
  pattern: string,
  literal: boolean,
  glob: string | undefined,
  excludedDirs: string[],
  context: number
): { out: string; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;
  const re = literal ? null : (() => { try { return new RegExp(pattern); } catch { return null; } })();
  const globRe = glob ? new RegExp("^" + glob.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null;
  const walkFiles = (dir: string, depth = 0) => {
    if (depth > 8) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (excludedDirs.includes(e.name)) continue;
        walkFiles(full, depth + 1);
      } else if (e.isFile()) {
        if (globRe && !globRe.test(e.name)) continue;
        try {
          const content = fs.readFileSync(full, "utf8");
          const ls = content.split("\n");
          for (let i = 0; i < ls.length; i++) {
            const hit = literal ? ls[i].includes(pattern) : (re ? re.test(ls[i]) : false);
            if (hit) {
              out.push(`${full}:${i + 1}:${ls[i]}`);
              if (context > 0) {
                for (let k = 1; k <= context; k++) {
                  if (i - k >= 0) out.push(`${full}:${i - k + 1}:${ls[i - k]}`);
                  if (i + k < ls.length) out.push(`${full}:${i + k + 1}:${ls[i + k]}`);
                }
              }
              if (out.length > 2000) { truncated = true; return; }
            }
          }
        } catch {
          /* binary/unreadable skip */
        }
      }
    }
  };
  walkFiles(base);
  return { out: out.join("\n"), truncated };
}
