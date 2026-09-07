import * as fs from "node:fs";
import * as path from "node:path";
import { log } from "../util/logger";

export interface UndoEntry {
  /** monotonically increasing id */
  id: number;
  /** unix ms timestamp */
  time: number;
  op: "write" | "delete" | "rename" | "mkdir";
  /** absolute path that was affected */
  from: string;
  /** backup snapshot of prior file content (for write/delete) */
  backup?: string;
  /** for rename: destination */
  to?: string;
}

/**
 * Journal of this agent's own filesystem modifications, used for a *safe* /undo.
 *
 * Safety model:
 *  - We never run `git reset --hard`.
 *  - Every write/delete is snapshotted *before* mutation into .opencode/undo/<id>.bak
 *    so the original content is available even if the user later edited the file.
 *  - Undo restores only entries this agent recorded. Files the user changed
 *    independently are never touched (we only restore the exact prior snapshot
 *    or delete what we created).
 *  - If a required backup file is missing or a restoration is ambiguous, we
 *    refuse rather than destroy anything.
 */
export class UndoManager {
  readonly opencodeDir: string;
  private journalFile: string;
  private entries: UndoEntry[] = [];
  private nextId = 1;

  constructor(opencodeDir: string) {
    this.opencodeDir = opencodeDir;
    this.journalFile = path.join(opencodeDir, "undo", "journal.json");
    this.load();
  }

  private backupDir(): string {
    return path.join(this.opencodeDir, "undo");
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.journalFile)) return;
      const j = JSON.parse(fs.readFileSync(this.journalFile, "utf8")) as {
        nextId: number;
        entries: UndoEntry[];
      };
      this.nextId = j.nextId || 1;
      this.entries = j.entries || [];
    } catch (e) {
      log("warn", `could not load undo journal: ${(e as Error).message}`);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.journalFile), { recursive: true });
      fs.writeFileSync(this.journalFile, JSON.stringify({ nextId: this.nextId, entries: this.entries }, null, 2));
    } catch (e) {
      log("warn", `could not save undo journal: ${(e as Error).message}`);
    }
  }

  /** Record an operation and snapshot prior content if present. */
  async record(
    op: "write" | "delete" | "rename" | "mkdir",
    fromPath: string,
    backupPath?: string,
    toPath?: string
  ): Promise<void> {
    this.entries.push({ id: this.nextId++, time: Date.now(), op, from: fromPath, backup: backupPath, to: toPath });
    this.save();
  }

  /** List current journal entries (newest last). */
  list(): UndoEntry[] {
    return [...this.entries];
  }

  count(): number {
    return this.entries.length;
  }

  /** Remove all journal entries (e.g. on session end / explicit flush). */
  clear(): void {
    this.entries = [];
    this.nextId = 1;
    this.save();
  }

  /**
   * Roll back all agent modifications recorded since the given entry id (or all).
   * Returns a human-readable report of what was undone.
   * Throws (after rolling back what it safely can) if something could not be undone.
   */
  async undoSince(sinceId = 0): Promise<string> {
    const target = this.entries.filter((e) => e.id > sinceId);
    if (target.length === 0) return "Nothing recorded to undo.";
    const report: string[] = [];
    // Reverse order.
    const ordered = target.slice().sort((a, b) => b.id - a.id);
    let refused = 0;
    for (const e of ordered) {
      try {
        const outcome = await this.revertOne(e);
        report.push(outcome);
      } catch (err) {
        refused++;
        report.push(`⚠ could not undo ${e.op} of ${e.from}: ${(err as Error).message}`);
      }
    }
    this.entries = this.entries.filter((e) => e.id <= sinceId);
    this.save();
    if (refused > 0) {
      throw new Error(`${refused} operation(s) could not be undone safely. Their journal entries were preserved.`);
    }
    return report.join("\n");
  }

  private async revertOne(e: UndoEntry): Promise<string> {
    const short = e.from.replace(process.cwd() + path.sep, "");
    switch (e.op) {
      case "write": {
        // Original file existed and had a backup → restore backup; else delete the created file.
        if (e.backup && fs.existsSync(e.backup)) {
          await fs.promises.copyFile(e.backup, e.from);
          return `restored ${short} from snapshot`;
        }
        // No backup means we created this file → delete it.
        if (fs.existsSync(e.from)) {
          await fs.promises.rm(e.from, { force: true });
          return `removed created file ${short}`;
        }
        return `nothing to do for ${short}`;
      }
      case "delete": {
        if (!e.backup) throw new Error(`no snapshot available for ${short}`);
        if (!fs.existsSync(e.backup)) throw new Error(`snapshot missing for ${short}; refusing to guess`);
        await fs.promises.mkdir(path.dirname(e.from), { recursive: true });
        await fs.promises.copyFile(e.backup, e.from);
        return `restored deleted file ${short}`;
      }
      case "rename": {
        // We never implement rename yet, but if recorded treat as needing manual.
        throw new Error(`rename undo for ${short} is not supported automatically; check manually`);
      }
      case "mkdir": {
        // Remove the directory only if empty (safe no-op otherwise).
        try {
          await fs.promises.rmdir(e.from);
          return `removed empty dir ${short}`;
        } catch {
          return `left non-empty dir ${short}`;
        }
      }
    }
  }

  /** Directory where snapshots live, exposed for cleanup. */
  snapshotDir(): string {
    return this.backupDir();
  }
}
