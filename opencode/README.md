# opencode

A **real, working autonomous coding agent CLI** for Node.js / Android Termux, inspired by
Claude Code. It uses **free models through OpenRouter** (a free API key), streams model
output to the terminal, and drives an **autonomous inspect → plan → read → edit → run →
verify → fix → re-verify** loop with real filesystem, terminal, search, Git and test tools.

It is a working product, not a mockup: every "tool" the model thinks it is calling is
actually executed on your machine and its real output is returned to the model. Nothing is
fabricated.

> Note about identity/cost: you need a free OpenRouter account + API key. The *default*
> model is a free model, but you can point it at any OpenRouter model. There is **no paid
> AI requirement**.

---

## 1. Architecture

Layered, modular TypeScript (compiled with `tsc` to plain CommonJS — **zero runtime
dependencies**, which is ideal for Termux). Only dev dependency is `typescript`.

```
CLI (src/cli/)                interactive REPL, events, confirmations, slash commands
        │
        ▼
AGENT (src/agent/agent.ts)    the autonomous loop (iteration cap, tool dispatch, memory)
        │
        ▼
MODEL PROVIDER (src/provider/) OpenRouter streaming provider + model/fallback manager
        │
        ▼
TOOLS (src/tools/)            filesystem · terminal · search(rg) · git · tests · meta
        │
 AGENT holds
   ├─ Context Manager (src/context/)   dedup, caches, line-ranges, auto-compaction
   ├─ Permissions     (src/permissions/) risk classification + allow/deny/ask
   ├─ Undo + Sessions (src/session/)   journal-based safe /undo and persistence
   └─ Config          (src/config/)     ~/.config + project .opencode layering
```

### Source file map
| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point, argument parsing, wiring |
| `src/cli/repl.ts`, `src/cli/colors.ts` | interactive terminal UI |
| `src/agent/agent.ts` | the autonomous loop and turn orchestration |
| `src/provider/openrouter.ts` | streaming SSE + native tool-call provider |
| `src/provider/manager.ts` | primary/fallback model manager + textual fallback |
| `src/tools/*.ts` | all real tools (see list below) |
| `src/tools/registry.ts` | tool assembly + dispatch |
| `src/permissions/permissions.ts` | permission/risk system |
| `src/context/context.ts` | context manager (dedup, cache, compaction) |
| `src/session/session.ts`, `src/session/undo.ts` | sessions + safe undo |
| `src/config/config.ts` | layered configuration |
| `src/util/logger.ts`, `src/types.ts` | helpers + shared types |
| `src/test/*.test.ts` | tests (`npm test`) |

---

## 2. Install prerequisites on Android Termux

Open Termux and run:

```bash
# Update package lists (Android package management is 'pkg')
pkg update && pkg upgrade -y

# 1) Node.js (>= 18 recommended)
pkg install nodejs-lts        # Node 20+, includes npm

# 2) Git
pkg install git

# 3) ripgrep (used by search_code; the tool falls back to grep automatically if absent)
pkg install ripgrep

# (optional but useful) a decent shell/editor
pkg install bash

# Verify
node --version
npm --version
rg --version
```

---

## 3. Install and build opencode

```bash
# Create/clone the project (this source tree)
git clone <your-repo-or-this-folder> ~/opencode   # or copy the folder
cd ~/opencode

# Install the (dev) TypeScript compiler
npm install

# Compile TypeScript -> dist/
npm run build

# Optional: put `opencode` on PATH (creates ~/.local/bin symlink via npm)
npm link

# Sanity check
node dist/index.js --help
```

If you don't `npm link`, run it with `node ~/opencode/dist/index.js ...` or `npm start`.

---

## 4. OpenRouter setup

### 4.1 Create a free API key
1. Go to **https://openrouter.ai** and sign up (free).
2. Visit **https://openrouter.ai/keys** and click **Create Key**.
3. Copy the key (starts with `sk-or-v1-...`). Free models require the key but cost nothing.
   Some free models are rate-limited and occasionally busy — that is exactly why opencode
   has automatic fallback models.

### 4.2 Set the key in Termux
Add to your shell profile so it persists:

```bash
echo "export OPENROUTER_API_KEY='sk-or-v1-...your-key...'" >> ~/.bashrc
source ~/.bashrc
```

Or set it just for the current shell:
```bash
export OPENROUTER_API_KEY='sk-or-v1-...'
```

You can also store it in a file (opencode reads it if the env var is unset):
```bash
mkdir -p ~/.config/opencode
echo -n 'sk-or-v1-...' > ~/.config/opencode/api_key
```

### 4.3 Configure default + fallback models
Models are configured in JSON (section 5) or on the command line. Recommended free models:

```bash
export OPENCODE_MODEL='deepseek/deepseek-chat-v3:free'
# fallbacks are comma separated:
export OPENCODE_FALLBACK_MODELS='meta-llama/llama-3.3-70b-instruct:free,qwen/qwen-2.5-72b-instruct:free'
```

Change models at runtime with the **`/model`** command inside the REPL.

> **Which model should I pick?** You want a model with strong function-calling support.
> Free tier varies: `deepseek/deepseek-chat-v3:free`, `qwen/qwen-2.5-coder-32b-instruct:free`
> and `meta-llama/llama-3.3-70b-instruct:free` generally handle tool calls. If your chosen
> model is chat-only, set `"toolProtocol": "textual"` in config (see section 6) and opencode
> will use a robust `<tool_call>…</tool_call>` text protocol instead of native function calls.

### 4.4 Run the agent
```bash
cd /path/to/your/project
opencode                 # interactive
# or headless single task (auto-allows file writes):
opencode "add a function to calc.js and test it"
```

---

## 5. Configuration

Configuration is merged from **defaults → global → project → CLI/env**, later wins.

### Global — `~/.config/opencode/config.json`
First run creates it automatically. See `examples/global-config.example.json`.

### Project — `.opencode/config.json` (per repository)
See `examples/project-config.example.json`.

Key options:

| Key | Default | Meaning |
|-----|---------|---------|
| `model` | free model | primary model id |
| `fallbackModels` | `[]` | ordered fallback models used on provider failure |
| `baseUrl` | OpenRouter | provider base URL (modular for future providers) |
| `toolProtocol` | `"native"` | `"native"` (function calls) or `"textual"` (`<tool_call>` tags) |
| `maxIterations` | `25` | cap on the autonomous loop |
| `commandTimeoutSec` | `120` | timeout for executed commands |
| `requestTimeoutSec` | `120` | HTTP timeout to the model API |
| `permissionMode` | `"ask"` | `"allow"` / `"ask"` / `"deny"` for file writes/edits/deletes |
| `dangerousMode` | `"ask"` | behaviour for risky commands |
| `contextLimitTokens` | `60000` | threshold that triggers auto-compaction |
| `autoCompact` | `true` | summarise old context automatically |
| `testCommand` / `buildCommand` | auto | explicit test/build commands |
| `toolResultLimitChars` | `6000` | trim tool results sent to the model |
| `allowCommands` | list | command globs that skip the confirmation prompt |
| `denyCommands` | list | command globs that are always refused |
| `excludedDirs` | list | dirs skipped by recursive scans / search |

Environment overrides: `OPENROUTER_API_KEY`, `OPENCODE_MODEL`, `OPENCODE_FALLBACK_MODELS`, `OPENCODE_LOG`.

---

## 6. How it works (workflow)

**Core loop:** `Request → Inspect → Plan → Read → Edit → Run → Error → Fix → Test → Verify`

Each iteration the agent sends its conversation (plus any requested tool results) to the
model. The model either emits **tool calls** (native or textual) or a **final answer**.
Tool calls are executed by the real tool registry and their real output is returned; the
loop repeats up to `maxIterations`. The agent watches for duplicate-tool-call loops and
stops them, and it refuses to *claim* success: if it finished after editing code without
running any verification command, opencode prints a warning instead of trusting the claim.

### The tools (all real)
| Tool | What it really does |
|------|---------------------|
| `read_file` | reads a file, returns numbered lines + metadata, honours line ranges |
| `read_file_range` | reads a specific line range of a (large) file |
| `write_file` | creates/overwrites a file **inside the project** (journaled for undo) |
| `edit_file` | precise text replacement, fails cleanly if text not found |
| `delete_file` | deletes a file inside the project (content snapshotted) |
| `list_directory` | lists a dir, optional bounded recursive walk skipping excluded dirs |
| `search_code` | ripgrep with automatic `grep` fallback, skips excluded dirs |
| `execute_command` | runs a real shell command with timeout + output capture |
| `git_status` / `git_diff` | real `git` status and diff |
| `run_tests` / `run_build` | auto-detects/uses configured test & build commands |
| `inspect_errors` | heuristically parses a failed command/test output for error lines + file refs |
| `log`, `plan`, `status` | lightweight working-memory/meta tools |

### Permissions & safety
- Reading/listing/searching is automatic.
- Writes/edits/deletes are gated by `permissionMode`.
- Terminal commands go through a **risk classifier** (not just string matching):
  `rm -rf`, `sudo`/`su`, `chmod`/`chown`, disk/device ops (`mkfs`,`fdisk`,`dd`,`mount`),
  formatting, `git reset --hard`, `git clean -f`, `--force` pushes, package/system installs,
  and references outside the project all raise flags. Depending on severity and
  `dangerousMode` the user is asked to confirm or the command is refused.
- `denyCommands` always refuse; `allowCommands` skip the prompt.
- Git state preservation: opencode **never** runs `git reset --hard`, and `/undo` only
  restores snapshots of files this agent itself changed.

### Context management
- Tracks which files the model has already seen and caches their content keyed by
  mtime/size, so unchanged files aren't re-sent in full.
- Uses line ranges for large files.
- Keeps a compact **working memory** (discovered architecture, decisions, changed files,
  test results, unresolved issues) surfaced to the model.
- **Auto-compacts** by summarising old turns when the token estimate grows; trigger
  manually with `/compact`.

---

## 7. Slash commands

| Command | Action |
|---------|--------|
| `/help` | show commands |
| `/model <id>` | switch primary model (keeps fallbacks, persists to `.opencode/config.json`) |
| `/status` | show model, fallbacks, session, iteration, changed files |
| `/clear` | clear the screen |
| `/compact` | manually compact/summarise context |
| `/plan <task>` | ask the model for a plan only (no edits) |
| `/diff` | git diff of files this agent changed |
| `/undo` | safely roll back this agent's own file edits |
| `/exit` | quit |

CLI flags: `--model`, `--fallback`, `--auto` (auto-allow writes), `--danger`,
`--once "<task>"`, `--plan "<task>"`, `--sessions`, `--resume <id>`, `--help`.

---

## 8. Demo: fix an intentionally broken project

The repo ships a broken project at `test-workspace/broken-calc`. Two functions return
wrong results so its test suite fails.

```bash
cd test-workspace/broken-calc
npm test                 # baseline: 2 tests fail (multiply, greet)
```

Then run the **real** agent on it:

```bash
export OPENROUTER_API_KEY='sk-or-v1-...'
opencode --auto "The test suite is failing. Inspect the code, fix all bugs so every test passes, and verify your work."
```

The `--auto` flag auto-allows file writes (dangerous commands still require confirmation)
so the run proceeds without pausing for each edit.

### What the agent does (real flow — reproducible by running the command above)
The exact wording/tool ordering the LLM chooses varies per model, but this is the flow the
agent follows (and what the end-to-end test in `src/test/agent.loop.test.ts` verifies with a
scripted model brain against the **real** tool registry):

1. **Start + inspect** → `list_directory .`, `read_file calc.js`, `read_file test.js`, `git_status`.
2. **Understand** → it sees `multiply` returns `a + b` (should be `a * b`) and `greet`
   returns `"Goodbye, "` (should be `"Hello, "`).
3. **Plan** → `plan` tool listing the two edits then `run_tests`.
4. **Edit** → `edit_file calc.js` replaces the `multiply` body, then replaces the `greet` body
   (precise edits; unrelated code untouched).
5. **Run** → `run_tests` → `node --test`.
6. **Verify** → `git_diff` / `git_status` show exactly the two hunks changed.
7. **Finish** → a short final answer: which bugs were fixed and the passing test result.

Check the result yourself afterwards:

```bash
npm test                 # now passes (6/6)
git diff                 # exactly the two intentional fixes
git status               # only calc.js changed
```

> The test example in `src/test/agent.loop.test.ts` runs this whole flow offline and asserts:
> tests fail before → the agent autonomously inspects → edits precisely → `node test.js` runs
> → tests pass after. Run it with `npm test`.

---

## 9. Running the offline test suite

The project includes unit + integration tests using Node's built-in runner (no extra deps):

```bash
npm run build
npm test
```

Covered: filesystem tools (read/write/edit/delete/list, line ranges, out-of-project guard),
permissions/risk classifier, context manager dedup+cache+compaction, session persistence,
safe undo (restores deleted/edited files), shell runner (exit codes, stderr, timeouts), and
the full **agent loop end-to-end** on the broken example.

---

## 10. Troubleshooting & notes

- **`OPENROUTER_API_KEY is not set`** → do section 4.2.
- **"Provider switched …"** → your primary model was busy/limited; the fallback took over. That is normal.
- **"model does not support tools" / it just chats** → pick a tool-calling model or set `"toolProtocol": "textual"`.
- **Permission prompts** feel annoying for a demo → use `--auto` or set `"permissionMode": "allow"`.
- **Dangerous** commands are never run silently: when confirmation is required the agent stops and asks.
- **Iteration limit reached** without a verified finish → the CLI says so clearly; it never pretends success.
- **Undo** is scoped to the agent's own operations and refuses to run `git reset --hard`.

### Safety guarantees (engineered, not aspirational)
- Never fabricates tool output, files, tests, commands, or Git state.
- Never claims success without verification.
- Never hides command failures.
- Never silently discards user changes.
- Never uses `git reset --hard`.
- Skips `node_modules`, `.git`, build/cache dirs during scans and search.

---

## License
MIT
