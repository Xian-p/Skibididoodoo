import * as readline from "node:readline";
import type { AgentEvent } from "../types";
import type { Agent, TurnResult } from "../agent/agent";
import type { ModelManager } from "../provider/manager";
import type { ResolvedConfig } from "../types";
import type { Session } from "../session/session";
import { fx } from "./colors";

export interface ReplOptions {
  config: ResolvedConfig;
  agent: Agent;
  manager: ModelManager;
  noninteractive: boolean;
  autoWrite: boolean;
  allowDangerous: boolean;
  singleShot?: string;
}

const VERSION = "1.0.0";

export class Repl {
  private agent: Agent;
  private manager: ModelManager;
  private config: ResolvedConfig;
  private noninteractive: boolean;
  private autoWrite: boolean;
  private allowDangerous: boolean;
  private singleShot?: string;
  private rl: readline.Interface;
  private streaming = false;
  private session: Session;

  constructor(opts: ReplOptions) {
    this.agent = opts.agent;
    this.manager = opts.manager;
    this.config = opts.config;
    this.noninteractive = opts.noninteractive;
    this.autoWrite = opts.autoWrite;
    this.allowDangerous = opts.allowDangerous;
    this.singleShot = opts.singleShot;
    this.session = opts.agent.getSession();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: !this.noninteractive,
    });
  }

  async start(): Promise<void> {
    this.printBanner();
    if (this.singleShot) {
      await this.runTurn(this.singleShot);
      this.rl.close();
      return;
    }
    await this.loop();
  }

  private printBanner(): void {
    const model = this.agent.currentModelLabel();
    console.log("");
    console.log(fx.bold(fx.cyan(" opencode")) + fx.gray(` v${VERSION} — autonomous coding agent (OpenRouter)`));
    console.log(fx.gray(` project : ${this.config.cwd}`));
    console.log(fx.gray(` session : ${this.session.state.id}`));
    console.log(fx.gray(` model   : ${model}`));
    console.log(fx.gray(` iteration limit : ${this.config.maxIterations}   permission mode: ${this.config.permissionMode}   type /help`));
    console.log("");
  }

  private promptFor(): string {
    return fx.green("❯ ") + fx.gray("(task) ") + fx.reset("");
  }

  private async loop(): Promise<void> {
    for (;;) {
      const input = await this.question(this.promptFor());
      const line = input.trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const ok = await this.handleSlash(line);
        if (ok === "exit") return;
        continue;
      }
      await this.runTurn(line);
    }
  }

  private question(prompt: string): Promise<string> {
    return new Promise((resolve) => {
      this.rl.question(prompt, resolve);
    });
  }

  private async runTurn(request: string): Promise<TurnResult> {
    const result = await this.agent.run(request);
    this.printTurnResult(result);
    return result;
  }

  private printTurnResult(r: TurnResult): void {
    this.ensureNewline();
    console.log("");
    console.log(fx.dim(fx.gray("── session summary ─────────────────────────")));
    console.log(
      fx.gray(`iterations used : ${r.iterations}   files changed : ${r.filesChanged.length}   model : ${this.agent.currentModelLabel()}`)
    );
    if (r.reachedLimit) console.log(fx.yellow("⚠ reached the configured iteration limit without a verified finish."));
    if (r.stoppedForLoop) console.log(fx.yellow("⚠ stopped because the agent repeated an identical tool call (possible loop)."));
    for (const w of r.warnings) console.log(fx.yellow(`⚠ ${w}`));
    if (r.filesChanged.length) console.log(fx.gray(`changed: ${r.filesChanged.join(", ")}`));
  }

  /** Handle events emitted by the agent. */
  onEvent = (e: AgentEvent): void => {
    switch (e.type) {
      case "text":
        this.writeStream(e.text || "");
        break;
      case "status":
        this.ensureNewline();
        process.stdout.write(fx.dim(fx.gray(`▸ ${e.message}`)) + "\n");
        break;
      case "tool_start": {
        this.ensureNewline();
        const name = e.tool || "";
        const icon = /^(read_file|read_file_range|list_directory|search_code|git_status)$/.test(name) ? "·" : "⚙";
        process.stdout.write(`${fx.cyan(icon)} ${fx.bold(name)}\n`);
        break;
      }
      case "tool_end": {
        this.ensureNewline();
        const s = e.summary || "";
        const errLike = /\b(error|fail|denied|not found|timeout|no such)\b/i.test(s);
        process.stdout.write(
          `  ${errLike ? fx.yellow("→") : fx.green("✓")} ${errLike ? fx.yellow(s) : fx.dim(fx.gray(s))}\n`
        );
        break;
      }
      case "tool_error": {
        this.ensureNewline();
        process.stdout.write(fx.red(`  ✖ ${e.tool}: ${e.error}`) + "\n");
        break;
      }
      case "thinking": {
        this.ensureNewline();
        process.stdout.write(fx.magenta(`🤔 task received`) + "\n");
        break;
      }
      case "plan": {
        this.ensureNewline();
        process.stdout.write(fx.cyan("📋 plan\n"));
        if (e.plan) for (const p of e.plan) process.stdout.write(`   ${p}\n`);
        break;
      }
      case "error":
        this.ensureNewline();
        process.stdout.write(fx.red(`✖ ${e.error}`) + "\n");
        break;
    }
  };

  /** Ask the user a yes/no question (used by permissions). */
  ask = async (prompt: string, opts?: { danger?: boolean }): Promise<boolean> => {
    const danger = opts?.danger === true;
    if (this.noninteractive) {
      // Headless: allow writes and moderate commands; dangerous only if explicit.
      if (danger) {
        process.stderr.write(`[auto] DENIED (dangerous, headless): ${prompt.split("\n")[0]}\n`);
        return false;
      }
      process.stderr.write(`[auto] allowed: ${prompt.split("\n")[0]}\n`);
      return true;
    }
    if (danger && !this.allowDangerous) {
      // still ask
    }
    const label = danger ? fx.red("DANGER") : fx.yellow("confirm");
    const defaultNo = danger ? true : false;
    const q = `${fx.bold(label)} — ${prompt}\n${defaultNo ? "y/N" : "Y/n"}? `;
    const ans = await this.question(q);
    const a = ans.trim().toLowerCase();
    if (danger) return a === "y" || a === "yes";
    return a === "" || a === "y" || a === "yes";
  };

  private writeStream(t: string): void {
    if (t.length === 0) return;
    if (!this.streaming) {
      process.stdout.write("\n");
      this.streaming = true;
    }
    process.stdout.write(t);
  }

  private ensureNewline(): void {
    if (this.streaming) {
      process.stdout.write("\n");
      this.streaming = false;
    }
  }

  private async handleSlash(line: string): Promise<"continue" | "exit"> {
    const [cmd, ...rest] = line.split(" ");
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "/help":
        console.log(fx.bold("\nCommands"));
        console.log(`  ${fx.green("/help")}         this help`);
        console.log(`  ${fx.green("/model <id>")}    switch model (e.g. ${fx.cyan("deepseek/deepseek-chat:free")})`);
        console.log(`  ${fx.green("/status")}        show model, iteration, changed files, session`);
        console.log(`  ${fx.green("/clear")}         clear the screen`);
        console.log(`  ${fx.green("/compact")}       manually compact/compress context`);
        console.log(`  ${fx.green("/plan <task>")}   ask the model to outline steps without editing`);
        console.log(`  ${fx.green("/diff")}          show git diff of files this agent changed`);
        console.log(`  ${fx.green("/undo")}          safely roll back this agent's file edits (never git reset)`);
        console.log(`  ${fx.green("/exit")}          quit\n`);
        break;
      case "/model": {
        if (!arg) {
          console.log(fx.gray(`current model: ${this.agent.currentModelLabel()}`));
          console.log(fx.gray(`fallbacks: ${this.manager.getProviderList().slice(1).join(", ") || "none"}`));
          break;
        }
        try {
          this.manager.setModels(arg, this.config.fallbackModels);
          console.log(fx.green(`model → ${arg}`));
          // persist to project config
          const { saveModelChoice } = require("../config/config");
          saveModelChoice(this.config, arg);
        } catch (e) {
          console.log(fx.red(`failed to set model: ${(e as Error).message}`));
        }
        break;
      }
      case "/status": {
        const s = this.session.state;
        console.log(fx.bold("\nStatus"));
        console.log(`  model        : ${this.agent.currentModelLabel()}`);
        console.log(`  fallback     : ${this.manager.getProviderList().slice(1).join(", ") || "none"}`);
        console.log(`  session id   : ${s.id}`);
        console.log(`  task         : ${s.task || "(none)"}`);
        console.log(`  messages kept: ${s.messages.length}`);
        console.log(`  files changed: ${this.agent.getChangedFiles().length ? this.agent.getChangedFiles().join(", ") : "none"}`);
        console.log(`  iteration    : ${s.iteration}`);
        break;
      }
      case "/clear":
        process.stdout.write("\u001b[2J\u001b[H");
        break;
      case "/compact": {
        const msg = await this.agent.compactManual();
        console.log(fx.green(msg));
        break;
      }
      case "/plan": {
        if (!arg) {
          console.log(fx.yellow("usage: /plan <natural-language task>"));
          break;
        }
        console.log(fx.cyan("\nPlanning…"));
        const plan = await this.agent.plan(arg);
        console.log(plan);
        break;
      }
      case "/diff": {
        const d = await this.agent.diff();
        console.log(d || "(no changes)");
        break;
      }
      case "/undo": {
        const msg = await this.agent.undoAll();
        console.log(msg);
        break;
      }
      case "/exit":
      case "/quit":
        console.log(fx.gray("bye."));
        this.rl.close();
        return "exit";
      default:
        console.log(fx.yellow(`unknown command: ${cmd} — try /help`));
    }
    return "continue";
  }
}
