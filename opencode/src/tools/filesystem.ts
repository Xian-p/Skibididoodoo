import * as fs from "node:fs";
import * as path from "node:path";
import { BaseTool, result } from "./tool";
import type { ToolArgs, ToolExecutionContext, ToolResult, ToolDefinition } from "../types";
import { abs, displayPath, requireInside, walk, fmtSize } from "./pathutil";

const MAX_CONTENT_CHARS = 25000;

/** A filesystem snapshot used for undo (copies content into a backup file). */
async function snapshotFile(backupDir: string, filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return undefined;
    const backup = path.join(backupDir, `${Date.now()}-${Math.random().toString(36).slice(2)}.bak`);
    await fs.promises.mkdir(path.dirname(backup), { recursive: true });
    await fs.promises.copyFile(filePath, backup);
    return backup;
  } catch {
    return undefined;
  }
}

async function undoBackupDir(ctx: ToolExecutionContext): Promise<string> {
  const d = path.join(ctx.opencodeDir, "undo");
  await fs.promises.mkdir(d, { recursive: true });
  return d;
}

export class ReadFileTool extends BaseTool {
  definition: ToolDefinition = {
    name: "read_file",
    description:
      "Read a text file from disk and return its contents. For large files only the requested (or first) line range is returned. Returns file metadata and line numbers.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to the file, relative to the project or absolute." },
        startLine: { type: "number", description: "1-based first line to read (default 1)." },
        endLine: { type: "number", description: "1-based last line to read (inclusive)." },
        maxChars: { type: "number", description: "Optional hard character cap." },
      },
      required: ["path"],
    },
  };

  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const p = abs(ctx.cwd, String(args.path));
    const stat = await fs.promises.stat(p).catch(() => null);
    if (!stat) return { tool: this.definition.name, content: `Error: no such file: ${p}`, summary: `no such file ${p}`, error: true, data: null };
    if (stat.isDirectory()) {
      return { tool: this.definition.name, content: `Error: ${p} is a directory; use list_directory.`, summary: "is a directory", error: true, data: null };
    }
    const cap = Math.min(Number(args.maxChars) || MAX_CONTENT_CHARS, MAX_CONTENT_CHARS);
    const text = await fs.promises.readFile(p, "utf8");
    const rawLines = text.split(/\r?\n/);
    // Drop a single trailing empty element caused by a final newline.
    if (rawLines.length && rawLines[rawLines.length - 1] === "" && text.endsWith("\n")) rawLines.pop();
    const lines = rawLines;
    const start = Math.max(1, Number(args.startLine) || 1);
    const end = args.endLine ? Math.min(lines.length, Number(args.endLine)) : lines.length;
    const slice = lines.slice(start - 1, end);
    let content = slice.join("\n");
    const totalLines = lines.length;
    let truncated = content.length > cap || start > 1 || end < totalLines;
    let shownLines = slice.length;
    if (content.length > cap) {
      content = content.slice(0, cap) + "\n… (truncated)";
      truncated = true;
      shownLines = Math.min(shownLines, cap);
    }
    const numbered = content
      .split("\n")
      .map((ln, i) => `${String(start + i).padStart(4)}| ${ln}`)
      .join("\n");
    const body = `File: ${displayPath(ctx.cwd, p)}\nLines ${start}–${end} of ${totalLines} (${shownLines} shown${truncated ? ", truncated" : ""}), ${fmtSize(stat.size)}\n${numbered}`;
    return result(
      this.definition.name,
      body,
      {
        path: p,
        totalLines,
        size: stat.size,
        startLine: start,
        endLine: end,
        truncated,
        language: path.extname(p).slice(1),
      },
      `read ${displayPath(ctx.cwd, p)} (${totalLines} lines)`
    );
  }
}

export class ReadFileRangeTool extends BaseTool {
  definition: ToolDefinition = {
    name: "read_file_range",
    description:
      "Read a specific contiguous range of lines from a large file. Returns content with line numbers and confirms the full length so the model can page through big files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
      },
      required: ["path", "startLine", "endLine"],
    },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    return new ReadFileTool().run(
      { path: args.path, startLine: args.startLine, endLine: args.endLine, maxChars: MAX_CONTENT_CHARS },
      ctx
    );
  }
}

export class WriteFileTool extends BaseTool {
  definition: ToolDefinition = {
    name: "write_file",
    description:
      "Create or fully overwrite a text file with the given content. Only allowed inside the project. Creates parent directories as needed. Prefer edit_file for small changes to existing files.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const p = requireInside(ctx.cwd, String(args.path), "write to");
    if (!(await ctx.permission.requireWrite(`write file ${displayPath(ctx.cwd, p)}`, p))) {
      return { tool: this.definition.name, content: "Permission denied by user.", summary: "write denied", error: true, data: null };
    }
    const content = String(args.content ?? "");
    const backupDir = await undoBackupDir(ctx);
    const existing = await fs.promises.access(p).then(() => true).catch(() => false);
    if (existing) {
      const b = await snapshotFile(backupDir, p);
      if (b) await ctx.undo?.record("write", p, b);
    } else {
      await fs.promises.mkdir(path.dirname(p), { recursive: true });
      await ctx.undo?.record("mkdir", path.dirname(p));
    }
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, content, "utf8");
    return result(
      this.definition.name,
      `${existing ? "Overwrote" : "Created"} file ${displayPath(ctx.cwd, p)} (${content.length} bytes)`,
      { path: p, bytes: content.length, created: !existing }
    );
  }
}

export class EditFileTool extends BaseTool {
  definition: ToolDefinition = {
    name: "edit_file",
    description:
      "Make a precise textual replacement inside a file. Provide the exact existing text (oldText) and its replacement (newText). For multiple identical occurrences set replaceAll=true or use numbered occurrences. Fails clearly if oldText is not found.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string", description: "Exact text already present in the file to replace." },
        newText: { type: "string", description: "Replacement text." },
        replaceAll: { type: "boolean", description: "Replace every occurrence (default false)." },
        occurrence: { type: "number", description: "Which occurrence to replace when duplicate text exists (1-based, default 1)." },
      },
      required: ["path", "oldText", "newText"],
    },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const p = requireInside(ctx.cwd, String(args.path), "edit");
    if (!(await ctx.permission.requireWrite(`edit file ${displayPath(ctx.cwd, p)}`, p))) {
      return { tool: this.definition.name, content: "Permission denied by user.", summary: "edit denied", error: true, data: null };
    }
    const oldText = String(args.oldText);
    const newText = String(args.newText ?? "");
    if (!oldText) {
      return { tool: this.definition.name, content: "Error: oldText must not be empty.", summary: "empty oldText", error: true, data: null };
    }
    const source = await fs.promises.readFile(p, "utf8");
    const idx = source.indexOf(oldText);
    if (idx < 0) {
      return {
        tool: this.definition.name,
        content: `Error: the specified oldText was not found in ${displayPath(ctx.cwd, p)}. File may have changed; re-read it and retry.`,
        summary: "oldText not found",
        error: true,
        data: null,
      };
    }
    const replaceAll = Boolean(args.replaceAll);
    const occurrence = Math.max(1, Number(args.occurrence) || 1);
    let updated: string;
    if (replaceAll) {
      updated = source.split(oldText).join(newText);
    } else {
      updated = replaceNth(source, oldText, newText, occurrence);
    }
    if (updated === source) {
      return { tool: this.definition.name, content: "No change made.", summary: "no change", error: false, data: { path: p } };
    }
    const backupDir = await undoBackupDir(ctx);
    const b = await snapshotFile(backupDir, p);
    if (b) await ctx.undo?.record("write", p, b);
    await fs.promises.writeFile(p, updated, "utf8");
    return result(
      this.definition.name,
      `Edited ${displayPath(ctx.cwd, p)}: applied textual replacement.`,
      { path: p, changed: true }
    );
  }
}

function replaceNth(hay: string, needle: string, repl: string, n: number): string {
  let count = 0;
  let i = 0;
  let found = -1;
  while (i <= hay.length - needle.length) {
    if (hay.slice(i, i + needle.length) === needle) {
      count++;
      if (count === n) {
        found = i;
        break;
      }
      i += needle.length;
    } else {
      i++;
    }
  }
  if (found < 0) return hay;
  return hay.slice(0, found) + repl + hay.slice(found + needle.length);
}

export class DeleteFileTool extends BaseTool {
  definition: ToolDefinition = {
    name: "delete_file",
    description: "Permanently delete a file inside the project (content is preserved in the undo journal).",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const p = requireInside(ctx.cwd, String(args.path), "delete");
    if (!(await ctx.permission.requireWrite(`delete file ${displayPath(ctx.cwd, p)}`, p))) {
      return { tool: this.definition.name, content: "Permission denied by user.", summary: "delete denied", error: true, data: null };
    }
    const backupDir = await undoBackupDir(ctx);
    const b = await snapshotFile(backupDir, p);
    if (b) await ctx.undo?.record("delete", p, b);
    await fs.promises.rm(p, { force: true });
    return result(this.definition.name, `Deleted ${displayPath(ctx.cwd, p)}`, { path: p });
  }
}

export class ListDirectoryTool extends BaseTool {
  definition: ToolDefinition = {
    name: "list_directory",
    description:
      "List the contents of a directory. By default shallow (top-level only). Set recursive=true to walk subdirectories while skipping node_modules/.git/build/caches. Returns a tree with file types and sizes.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory to list (default '.')." },
        recursive: { type: "boolean" },
        maxDepth: { type: "number", description: "Recursion depth when recursive (default 3)." },
      },
    },
  };
  async run(args: ToolArgs, ctx: ToolExecutionContext): Promise<ToolResult> {
    const p = abs(ctx.cwd, String(args.path || "."));
    const stat = await fs.promises.stat(p).catch(() => null);
    if (!stat) return { tool: this.definition.name, content: `Error: no such directory: ${p}`, summary: "not found", error: true, data: null };
    if (!stat.isDirectory()) {
      return { tool: this.definition.name, content: `Error: ${p} is a file; use read_file.`, summary: "not a dir", error: true, data: null };
    }
    const recursive = Boolean(args.recursive);
    const maxDepth = recursive ? Math.min(6, Number(args.maxDepth) || 3) : 1;
    const files = recursive ? await walk(p, { cwd: ctx.cwd, excludedDirs: ctx.excludedDirs, maxDepth, respectGitignore: true }) : await listFlat(p);
    const lines = [`Directory: ${displayPath(ctx.cwd, p)}${recursive ? " (recursive)" : ""}`];
    for (const f of files) {
      const rel = path.relative(p, f);
      const stat2 = await fs.promises.stat(f).catch(() => null);
      const type = stat2?.isDirectory() ? "dir " : stat2?.isFile() ? "file" : "link";
      lines.push(`  ${type}  ${rel}${stat2 && stat2.isFile() ? `  (${fmtSize(stat2.size)})` : ""}`);
    }
    return result(this.definition.name, lines.join("\n"), { path: p, files: files.length });
  }
}

async function listFlat(dir: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const ent of entries) out.push(path.join(dir, ent.name));
  return out.sort();
}
