/**
 * Lightweight terminal output helpers with ANSI colours.
 * Colours are stripped automatically when stdout is not a TTY (e.g. piped),
 * which also keeps them from polluting the transcript.
 */

const USE_COLOR = ((): boolean => {
  try {
    return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
  } catch {
    return false;
  }
})();

const wrap = (code: string, open: number, close: number) => (s: unknown): string => {
  const str = String(s);
  if (!USE_COLOR) return str;
  return `\u001b[${open}m${str}\u001b[${close}m`;
};

export const c = {
  reset: wrap("reset", 0, 0),
  bold: wrap("bold", 1, 22),
  dim: wrap("dim", 2, 22),
  red: wrap("red", 31, 39),
  green: wrap("green", 32, 39),
  yellow: wrap("yellow", 33, 39),
  blue: wrap("blue", 34, 39),
  magenta: wrap("magenta", 35, 39),
  cyan: wrap("cyan", 36, 39),
  gray: wrap("gray", 90, 39),
};

export type Level = "debug" | "info" | "warn" | "error" | "silent";

let currentLevel: Level = (process.env.OPENCODE_LOG as Level) || "info";

export function setLogLevel(l: Level): void {
  currentLevel = l;
}

export function log(level: Level, msg: string): void {
  const order: Level[] = ["debug", "info", "warn", "error", "silent"];
  if (order.indexOf(level) < order.indexOf(currentLevel)) return;
  const prefix =
    level === "debug"
      ? c.gray("debug")
      : level === "info"
        ? c.blue("info")
        : level === "warn"
          ? c.yellow("warn")
          : c.red("error");
  process.stderr.write(`${prefix} ${msg}\n`);
}

/** Turn a relative/dashed flag list into a nice short string. */
export function ellipsize(s: string, max = 300): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + c.gray(`… (+${s.length - max} chars)`);
}
