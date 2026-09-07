import { spawn } from "node:child_process";
import { cwd } from "node:process";

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Whether output was truncated due to size cap. */
  truncatedOut: boolean;
}

const MAX_OUT = 12000; // characters per stream retained

/**
 * Run a shell command, capturing stdout/stderr, honouring a timeout.
 * The command runs via `bash -lc` so pipes and environment work normally,
 * mirroring an interactive Termux shell.
 */
export function runShellCommand(
  command: string,
  opts: { cwd?: string; timeoutMs: number; stdin?: string; env?: Record<string, string> }
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: opts.cwd || cwd(),
      env: { ...process.env as Record<string, string>, ...(opts.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let outTrunc = false;
    let errTrunc = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve({ exitCode: null, stdout: out, stderr: err, timedOut: true, truncatedOut: outTrunc || errTrunc });
      }
    }, opts.timeoutMs);

    const push = (buf: string, which: "out" | "err") => {
      if (which === "out") {
        out = (out + buf).slice(0, MAX_OUT);
        if (out.length >= MAX_OUT && (out + buf).length > MAX_OUT) outTrunc = true;
      } else {
        err = (err + buf).slice(0, MAX_OUT);
        if (err.length >= MAX_OUT && (err + buf).length > MAX_OUT) errTrunc = true;
      }
    };
    child.stdout?.on("data", (d: Buffer) => push(d.toString(), "out"));
    child.stderr?.on("data", (d: Buffer) => push(d.toString(), "err"));
    if (opts.stdin) child.stdin?.write(opts.stdin);
    child.stdin?.end();
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: null, stdout: out, stderr: `spawn error: ${e.message}`, timedOut: false, truncatedOut: outTrunc });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, stdout: out, stderr: err, timedOut: false, truncatedOut: outTrunc || errTrunc });
      }
    });
  });
}
