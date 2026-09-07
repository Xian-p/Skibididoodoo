import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolExecutionContext } from "../types";

/** Create a throwaway project dir under the OS temp dir. */
export function makeTempDir(prefix = "opencode-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Build a permissive ToolExecutionContext rooted at `cwd`. */
export function fakeCtx(cwd: string, opts?: { askWrite?: boolean }): ToolExecutionContext {
  const askWrite = opts?.askWrite ?? true;
  return {
    cwd,
    opencodeDir: path.join(cwd, ".opencode"),
    commandTimeoutMs: 8000,
    excludedDirs: ["node_modules", ".git", "dist"],
    permission: {
      requireWrite: async () => askWrite,
      requireCommand: async () => true,
      classifyRisk: () => ({ level: "safe" as const, reason: "test" }),
    },
    undo: {
      record: async () => {},
    },
    onEvent: () => {},
  };
}

export function writeTemp(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

export { path };
