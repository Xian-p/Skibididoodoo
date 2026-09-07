import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { c, log } from "../util/logger";
import type { Config, ResolvedConfig } from "../types";

export const GLOBAL_CONFIG_DIR = path.join(os.homedir(), ".config", "opencode");
export const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");

export const DEFAULT_MODEL = "meta-llama/llama-3.1-8b-instruct:free";
export const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/** Merge helper that only overrides defined keys (shallow, top-level only). */
function applyOverrides(base: Config, over: Record<string, unknown> | undefined): Config {
  const out: Config = { ...base };
  if (!over) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = v;
  }
  return out;
}

function defaultConfig(): Config {
  return {
    model: process.env.OPENCODE_MODEL || DEFAULT_MODEL,
    fallbackModels: (process.env.OPENCODE_FALLBACK_MODELS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    baseUrl: DEFAULT_BASE_URL,
    toolProtocol: "native",
    maxIterations: 25,
    commandTimeoutSec: 120,
    permissionMode: "ask",
    dangerousMode: "ask",
    contextLimitTokens: 60000,
    autoCompact: true,
    excludedDirs: [
      "node_modules",
      ".git",
      "dist",
      "build",
      ".next",
      ".cache",
      ".opencode",
      "coverage",
      "target",
      "out",
      ".venv",
      "venv",
      "__pycache__",
      ".tox",
      ".mypy_cache",
      ".pytest_cache",
      ".ruff_cache",
      ".svelte-kit",
      ".turbo",
      ".vite",
    ],
    disabledTools: [],
    denyCommands: [],
    allowCommands: [],
    requestTimeoutSec: 120,
    verbose: false,
    toolResultLimitChars: 6000,
    sessionDir: "",
  };
}

function readJsonFile(file: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
    log("warn", `${file}: expected a JSON object, ignoring.`);
    return undefined;
  } catch (e) {
    return undefined;
  }
}

/**
 * Loads configuration layered as:
 *   built-in defaults < global ~/.config/opencode/config.json < project .opencode/config.json < env.
 * Returns the merged resolved config, creating default global config on first run.
 */
export function loadConfig(cwd: string): ResolvedConfig {
  // Ensure a default global config exists so the directory is discoverable.
  try {
    if (!fs.existsSync(GLOBAL_CONFIG_DIR)) {
      fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
      const sample = {
        model: DEFAULT_MODEL,
        fallbackModels: [],
        toolProtocol: "native",
        maxIterations: 25,
        commandTimeoutSec: 120,
        permissionMode: "ask",
        dangerousMode: "ask",
        contextLimitTokens: 60000,
        autoCompact: true,
        excludedDirs: defaultConfig().excludedDirs,
        allowCommands: ["git status", "git diff", "git log", "ls", "cat"],
        denyCommands: [],
      };
      fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(sample, null, 2) + "\n");
    }
  } catch {
    /* non fatal */
  }

  let merged = defaultConfig();

  const global = readJsonFile(GLOBAL_CONFIG_FILE);
  const projDir = path.join(cwd, ".opencode");
  const proj = readJsonFile(path.join(projDir, "config.json"));

  // Order matters: project config overrides global overrides defaults.
  merged = applyOverrides(merged, global);
  merged = applyOverrides(merged, proj);

  // Re-apply environment overrides on top of merged file config.
  if (process.env.OPENCODE_MODEL) merged.model = process.env.OPENCODE_MODEL;

  const opencodeDir = path.resolve(path.join(cwd, ".opencode"));
  const apiKey = resolveApiKey();
  if (!apiKey) {
    log("error", `OPENROUTER_API_KEY is not set. See README “OpenRouter setup”.`);
  }

  const resolved: ResolvedConfig = {
    ...merged,
    apiKey,
    cwd,
    opencodeDir,
    sessionDir: merged.sessionDir || path.join(opencodeDir, "sessions"),
    commandTimeoutSec: Math.max(1, merged.commandTimeoutSec),
    maxIterations: Math.max(1, merged.maxIterations),
    requestTimeoutSec: Math.max(5, merged.requestTimeoutSec),
    toolProtocol: merged.toolProtocol === "textual" ? "textual" : "native",
  };
  return resolved;
}

/** API key: env var, then ~/.config/opencode/api_key, then project .opencode/api_key. */
export function resolveApiKey(): string {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY.trim();
  for (const f of [GLOBAL_CONFIG_FILE.replace(/config\.json$/, "api_key"), path.join(process.cwd(), ".opencode", "api_key")]) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v) return v;
    } catch {
      /* ignore */
    }
  }
  return "";
}

export function ensureProjectDir(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    log("warn", `could not create ${dir}: ${(e as Error).message}`);
  }
  return dir;
}

export function saveModelChoice(config: ResolvedConfig, model: string): void {
  const proj = path.join(config.opencodeDir, "config.json");
  try {
    let obj: Record<string, unknown> = {};
    if (fs.existsSync(proj)) obj = JSON.parse(fs.readFileSync(proj, "utf8"));
    obj.model = model;
    fs.mkdirSync(config.opencodeDir, { recursive: true });
    fs.writeFileSync(proj, JSON.stringify(obj, null, 2) + "\n");
    config.model = model;
    log("info", `Model set to ${c.cyan(model)} (saved in ${proj})`);
  } catch (e) {
    log("error", `failed to save model: ${(e as Error).message}`);
  }
}
