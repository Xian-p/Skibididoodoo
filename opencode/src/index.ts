#!/usr/bin/env node
import * as path from "node:path";
import type { AgentEvent, ResolvedConfig } from "./types";
import { loadConfig, resolveApiKey } from "./config/config";
import { ModelManager } from "./provider/manager";
import { Agent, type AgentDeps, type TurnResult } from "./agent/agent";
import { Repl } from "./cli/repl";
import { Session } from "./session/session";
import { fx } from "./cli/colors";

const HELP = `opencode — autonomous coding agent for Termux/Node using OpenRouter free models.

Usage:
  opencode                          start interactive session
  opencode "fix the bug in calc.js" run a single headless task in the current dir
  opencode --model <id> "task"      run with a specific model
  opencode --sessions               list saved sessions
  opencode --resume <sessionId>     resume a session's conversation history
  opencode --plan "task"            ask the model to outline steps only (no edits)
  opencode --help                   this help

Flags:
  --model <id>          primary model id (also stored in .opencode/config.json)
  --fallback <id,...>   comma-separated fallback model ids
  --auto                allow file writes without prompting (still asks for dangerous commands)
  --danger              allow dangerous commands after confirmation in interactive mode
  --plan "task"         plan-only mode
  --once "task"         headless single task (same as positional arg when not a TTY)
  --sessions            list sessions
  --resume <id>         resume session history
  --help, -h            help

Environment:
  OPENROUTER_API_KEY    (required) your OpenRouter key
  OPENCODE_MODEL        primary model override
  OPENCODE_LOG          debug|info|warn|error|silent
`;

interface Flags {
  model?: string;
  fallback?: string[];
  auto: boolean;
  danger: boolean;
  plan: boolean;
  sessions: boolean;
  resume?: string;
  once?: string;
  help: boolean;
  positional: string[];
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = { auto: false, danger: false, plan: false, sessions: false, help: false, positional: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--model":
        f.model = argv[++i];
        break;
      case "--fallback":
        f.fallback = (argv[++i] || "").split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--auto":
        f.auto = true;
        break;
      case "--danger":
        f.danger = true;
        break;
      case "--plan":
        f.plan = true;
        f.once = argv[++i] || f.once;
        break;
      case "--once":
        f.once = argv[++i];
        break;
      case "--sessions":
        f.sessions = true;
        break;
      case "--resume":
        f.resume = argv[++i];
        break;
      case "--help":
      case "-h":
        f.help = true;
        break;
      default:
        if (a.startsWith("--")) {
          // ignore unknown
        } else {
          positional.push(a);
        }
    }
  }
  f.positional = positional;
  return f;
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(HELP);
    return;
  }

  const cwd = process.cwd();
  let config: ResolvedConfig = loadConfig(cwd);

  // CLI-level overrides (mutating the resolved object).
  if (flags.model) config.model = flags.model;
  if (flags.fallback?.length) config.fallbackModels = flags.fallback;
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const headlessTask = flags.once || (flags.positional.length ? flags.positional.join(" ") : undefined);
  const allowWrites = flags.auto || !!headlessTask;
  if (allowWrites) config.permissionMode = "allow";

  if (flags.sessions) {
    const sessions = Session.list(config);
    if (!sessions.length) {
      console.log(fx.gray("no sessions yet."));
      return;
    }
    console.log(fx.bold("\nSaved sessions"));
    for (const s of sessions) {
      console.log(
        `  ${fx.cyan(s.id)}  ${new Date(s.updatedAt).toLocaleString()}  msgs=${s.messages} files=${s.filesChanged} model=${s.model}`
      );
      if (s.task) console.log(`      task: ${s.task.slice(0, 120)}`);
    }
    return;
  }

  const noninteractive = !isTTY;

  // If the API key is missing, explain setup before launching.
  if (!config.apiKey) {
    console.error(fx.yellow("\nOPENROUTER_API_KEY is not set."));
    console.error(fx.gray("  1) Get a free key at https://openrouter.ai/keys"));
    console.error(fx.gray("  2) export OPENROUTER_API_KEY='sk-or-...'   (add to ~/.bashrc for Termux)"));
    console.error(fx.gray("     or echo -n 'sk-or-...' > ~/.config/opencode/api_key"));
    if (!noninteractive) {
      console.error(fx.gray("\nIf you just want the interface anyway, set OPENROUTER_API_KEY first.\n"));
    }
    if (headlessTask) {
      process.exitCode = 2;
      return;
    }
    if (!noninteractive) {
      console.error(fx.gray("Refusing to start an interactive shell without a key — configure one and retry.\n"));
      process.exitCode = 2;
      return;
    }
  }

  // Build model manager.
  const apiKey = resolveApiKey();
  const manager = new ModelManager(config, apiKey);
  if (flags.model) manager.rebuild(flags.model, config.fallbackModels);
  else if (flags.fallback?.length) manager.rebuild(config.model, flags.fallback);
  else manager.rebuild(config.model, config.fallbackModels);

  // Late-bound hooks so Agent and Repl can reference each other.
  const hooks: {
    onEvent: (e: AgentEvent) => void;
    ask: (p: string, o?: { danger?: boolean }) => Promise<boolean>;
    isInteractive: () => boolean;
  } = {
    onEvent: () => {},
    ask: async () => true,
    isInteractive: () => !noninteractive,
  };

  const deps: AgentDeps = hooks as AgentDeps;
  const agent = new Agent(config, manager, deps);

  if (flags.resume) {
    const loaded = Session.load(config, flags.resume);
    if (loaded) {
      agent.loadHistory(loaded.state.messages);
      console.log(fx.gray(`resumed session ${flags.resume} (${loaded.state.messages.length} message blocks).`));
    } else {
      console.log(fx.yellow(`could not load session ${flags.resume}. starting fresh.`));
    }
  }

  const autoWrite = flags.auto;
  const allowDangerous = flags.danger;

  const repl = new Repl({
    config,
    agent,
    manager,
    noninteractive: noninteractive && !flags.auto,
    autoWrite,
    allowDangerous,
    singleShot: headlessTask ? headlessTask : undefined,
  });
  hooks.onEvent = (e) => repl.onEvent(e);
  hooks.ask = (p, o) => repl.ask(p, o);
  hooks.isInteractive = () => !noninteractive;

  if (flags.plan && headlessTask) {
    const plan = await agent.plan(headlessTask);
    console.log(plan || "(no plan)");
    return;
  }

  // Graceful Ctrl+C.
  let interrupted = false;
  process.on("SIGINT", () => {
    if (!interrupted) {
      interrupted = true;
      process.stdout.write("\n");
      console.log(fx.gray("(interrupting — press Ctrl+C again to quit)"));
      setTimeout(() => (interrupted = false), 1500);
    } else {
      process.exit(130);
    }
  });

  await repl.start();
}

main().catch((e) => {
  console.error(fx.red(`fatal: ${(e as Error).stack || e}`));
  process.exitCode = 1;
});
