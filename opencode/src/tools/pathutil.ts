import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "../util/logger";

/** Normalise a user-supplied path relative to cwd to an absolute path. */
export function abs(cwd: string, p: string): string {
  if (!p) return cwd;
  if (path.isAbsolute(p)) return path.normalize(p);
  return path.resolve(cwd, p);
}

/** True if `child` is the same as, or inside, `parent`. */
export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Pretty relative path for display (falling back to absolute if outside cwd). */
export function displayPath(cwd: string, p: string): string {
  if (isWithin(cwd, p)) return path.relative(cwd, p) || ".";
  return p;
}

export interface ScanOptions {
  cwd: string;
  /** Directories (by basename) to skip. */
  excludedDirs: string[];
  /** Max directory depth to recurse. */
  maxDepth: number;
  /** Whether to skip .gitignored paths (best-effort git check). */
  respectGitignore: boolean;
}

/** Cheap recursive walk that skips excluded dirs and gitignored paths. */
export async function walk(
  dir: string,
  opts: ScanOptions,
  depth = 0
): Promise<string[]> {
  const out: string[] = [];
  if (depth > opts.maxDepth) return out;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (ent.name.startsWith(".") && ent.name !== "." && ent.name !== ".." && opts.respectGitignore) {
      if (opts.excludedDirs.includes(ent.name)) continue;
    }
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (opts.excludedDirs.includes(ent.name)) continue;
      if (opts.respectGitignore && isGitIgnored(opts.cwd, full)) continue;
      const sub = await walk(full, opts, depth + 1);
      out.push(...sub);
    } else if (ent.isFile() || ent.isSymbolicLink()) {
      if (opts.respectGitignore && isGitIgnored(opts.cwd, full)) continue;
      out.push(full);
    }
  }
  return out;
}

/** Best-effort gitignore check by shelling to git only when inside a repo. */
const gitignoreCache = new Map<string, boolean>();
let repoRootCache: string | undefined;

function isGitIgnored(cwd: string, file: string): boolean {
  const root = findGitRoot(cwd);
  if (!root) return false;
  const key = file;
  if (gitignoreCache.has(key)) return gitignoreCache.get(key)!;
  let result = false;
  try {
    const rel = path.relative(root, file);
    const r = require("node:child_process").spawnSync(
      "git",
      ["check-ignore", "-q", rel],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] }
    );
    result = r.status === 0;
  } catch {
    result = false;
  }
  gitignoreCache.set(key, result);
  return result;
}

export function findGitRoot(start: string): string | undefined {
  if (repoRootCache) return repoRootCache;
  let cur = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(cur, ".git"))) {
      repoRootCache = cur;
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

/** Human byte size. */
export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Ensure a path is inside the project (for writes). Returns abs path or throws. */
export function requireInside(cwd: string, p: string, what = "write"): string {
  const ap = abs(cwd, p);
  if (!isWithin(cwd, ap)) {
    throw new Error(`Refusing to ${what} outside the project directory: ${ap}`);
  }
  return ap;
}

export function logStats(): void {
  log("debug", `gitignore cache size=${gitignoreCache.size}`);
}
