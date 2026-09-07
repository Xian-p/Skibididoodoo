// tiny shared colour helpers for the terminal UI (duplicated import-free to keep cli self-contained)
export const useColor = (() => {
  try {
    return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  } catch {
    return false;
  }
})();
const w = (open: number, close: number) => (s: string) => (useColor ? `\u001b[${open}m${s}\u001b[${close}m` : s);
export const fx = {
  reset: w(0, 0),
  bold: w(1, 22),
  dim: w(2, 22),
  red: w(31, 39),
  green: w(32, 39),
  yellow: w(33, 39),
  blue: w(34, 39),
  magenta: w(35, 39),
  cyan: w(36, 39),
  gray: w(90, 39),
};
