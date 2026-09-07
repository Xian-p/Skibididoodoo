import type { Config, PermissionMode } from "../types";

export interface Risk {
  level: "safe" | "moderate" | "dangerous";
  reason: string;
}

export interface AskFn {
  (prompt: string, opts?: { danger: boolean }): Promise<boolean>;
}

/**
 * A layered permission classifier.
 *
 * Decision flow for terminal commands:
 *   1. If it matches an explicit deny glob   → deny.
 *   2. If it matches an explicit allow glob  → allow.
 *   3. Classify risk heuristically (+ pattern list).
 *   4. Apply mode:
 *        safe            → allow
 *        moderate        → mode dangerousMode (ask/allow/deny)
 *        dangerous       → mode dangerousMode (default ask)
 *   5. "ask" consults the user via the provided AskFn.
 *
 * File writes/edit/deletes go through requireWrite() which applies permissionMode.
 * The classifier is deliberately not purely string-matching: it also weighs
 * structural signals such as whether a path lives inside the project, and the
 * presence of multiple risk flags.
 */
export class PermissionSystem {
  private config: Config;
  private ask: AskFn;
  private cwd: string;

  constructor(config: Config, cwd: string, ask: AskFn) {
    this.config = config;
    this.cwd = cwd;
    this.ask = ask;
  }

  /** Test an allow/deny glob (supports * across any chars incl. spaces) against a command. */
  private globMatch(pattern: string, text: string): boolean {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = "^" + pattern.split("*").map(esc).join(".*") + "$";
    return new RegExp(re).test(text.trim());
  }

  private matchesAny(patterns: string[], text: string): boolean {
    return patterns.some((p) => this.globMatch(p, text));
  }

  classifyRisk(command: string): Risk {
    const c = command.trim();
    const lower = c.toLowerCase();
    const tokens = lower.split(/\s+/);

    const flags: string[] = [];

    const isRm = tokens[0] === "rm" || /(^|[;&|]\s*)rm\b/.test(lower);
    if (isRm && /-r|-rf|--recursive|-f/.test(c)) flags.push("rm -r/-f");
    if (tokens[0] === "sudo" || tokens[0] === "su") flags.push("sudo/su");
    if ((tokens[0] === "chmod" || tokens[0] === "chown" || tokens[0] === "chattr") && /\/|\/\//.test(c)) flags.push("chmod/chown on path");
    if (tokens[0] === "chmod" || tokens[0] === "chown") flags.push("chmod/chown");
    if (/^(mkfs|fdisk|parted|dd|format|mount|umount)\b/.test(lower)) flags.push("disk/device op");
    if (/^git\s+(reset|clean|checkout|reflog delete|branch -D|filter-branch|push --force)/.test(lower)) flags.push("destructive git");
    if (/git\s+reset\s+--hard/.test(lower)) flags.push("git reset --hard");
    if (/(^|[;&|]\s*)\S*rm\s+-rf\s+\/$|\s--no-preserve-root/.test(lower)) flags.push("rm -rf /");
    if (/(^|[;&|]\s*)rm\s+-rf\s+~|\.git$|node_modules|\.opencode/.test(lower)) flags.push("rm -rf on sensitive path");

    // package/system installs
    if (/^(npm i|npm install|yarn add|pnpm add|apt-get? install|apt install|pkg install|pip install|gem install|composer install|cargo install)/.test(lower)) {
      flags.push("package install");
    }
    if (/^(dropdb|drop table|mysql -e.*drop|postgres.*drop)/i.test(c)) flags.push("db drop");

    // command touching outside-project paths
    const outside = /\.\.\/|\/(home|root|usr|etc|bin|sbin|var|boot|opt|proc|sys|tmp|dev)\b/.test(c);
    if (outside && !/\$HOME/.test(c)) flags.push("references outside-project/system path");

    const joined = flags.join("; ");
    if (/rm -rf \/|git reset --hard/.test(joined)) {
      return { level: "dangerous", reason: joined };
    }
    if (/rm -r\/-f|disk\/device|db drop/.test(joined)) {
      return { level: "dangerous", reason: joined };
    }
    if (/^rm\b/.test(lower) && /-f/.test(c)) {
      return { level: "moderate", reason: "force delete" };
    }
    if (flags.length > 0) {
      // sudo, installs, chmod/chown, --force, mount are high-signal.
      if (/sudo|install|chmod|chown|mount|--force|package install/.test(joined) && flags.length >= 2) {
        return { level: "dangerous", reason: joined };
      }
      return { level: flags.length >= 2 ? "dangerous" : "moderate", reason: joined };
    }
    return { level: "safe", reason: "no elevated risk detected" };
  }

  /** Decide whether a terminal command may run. */
  async requireCommand(command: string): Promise<boolean> {
    const trimmed = command.trim();
    if (!trimmed) return false;
    if (this.matchesAny(this.config.denyCommands, trimmed)) {
      return false; // explicit deny
    }
    if (this.matchesAny(this.config.allowCommands, trimmed)) {
      return true; // explicit allow (overrides ask)
    }
    const risk = this.classifyRisk(trimmed);
    if (risk.level === "safe") return true;

    // moderate and dangerous both gate on dangerousMode (they are unusual).
    const mode: PermissionMode = this.config.dangerousMode || "ask";
    if (mode === "allow") return true;
    if (mode === "deny") return false;
    // ask
    const danger = risk.level === "dangerous";
    return this.ask(`Run command?\n\n  $ ${trimmed}\n\nRisk: ${risk.level} — ${risk.reason}`, { danger });
  }

  /** Decide whether a file write/edit/delete may proceed. */
  async requireWrite(purpose: string, targetPath?: string): Promise<boolean> {
    const mode: PermissionMode = this.config.permissionMode || "ask";
    if (mode === "allow") return true;
    if (mode === "deny") return false;
    const loc = targetPath ? `\n  Target: ${targetPath}` : "";
    return this.ask(`${purpose}${loc}\nAllow?`, { danger: false });
  }
}
