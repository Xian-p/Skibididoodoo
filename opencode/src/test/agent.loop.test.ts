import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  Config,
  ModelProvider,
  ProviderChatMessage,
  ProviderStreamEvent,
  ResolvedConfig,
  ToolCall,
  ToolDefinition,
} from "../types";
import { Agent } from "../agent/agent";
import { ModelManager } from "../provider/manager";
import { runShellCommand } from "../tools/runner";

const FIXTURE = path.join(__dirname, "..", "..", "test-workspace", "broken-calc");

/**
 * A deterministic stand-in for the model brain. It returns a fixed sequence of
 * native tool calls (mirroring a sensible agent strategy) and then a final
 * answer. Every tool is executed by the REAL tool registry, so this proves the
 * agent loop, message protocol, permission system, precise edit_file and
 * test-runner all work end to end — offline.
 */
class ScriptedBrain {
  private call = 0;
  rounds: Array<{ calls: ToolCall[] }> = [
    { calls: [{ id: "r1", name: "read_file", argumentsJson: JSON.stringify({ path: "calc.js" }) }] },
    {
      calls: [
        {
          id: "r2",
          name: "edit_file",
          argumentsJson: JSON.stringify({
            path: "calc.js",
            oldText: "function multiply(a, b) {\n  return a + b;\n}",
            newText: "function multiply(a, b) {\n  return a * b;\n}",
          }),
        },
      ],
    },
    {
      calls: [
        {
          id: "r3",
          name: "edit_file",
          argumentsJson: JSON.stringify({
            path: "calc.js",
            oldText: 'return "Goodbye, " + name;',
            newText: 'return "Hello, " + name;',
          }),
        },
      ],
    },
    { calls: [{ id: "r4", name: "run_tests", argumentsJson: "{}" }] },
  ];

  provider(): ModelProvider {
    return {
      name: "fake",
      model: "scripted/fake",
      supportsNativeTools: () => true,
      complete: async () => "summary",
      streamChat: async function* (): AsyncGenerator<ProviderStreamEvent> {
        throw new Error("not used");
      },
    } as unknown as ModelProvider;
  }

  async *streamChat(): AsyncGenerator<ProviderStreamEvent> {
    const i = this.call++;
    if (i < this.rounds.length) {
      const { calls } = this.rounds[i];
      yield { type: "done", result: { text: "", toolCalls: calls, model: "scripted/fake" } };
    } else {
      yield { type: "text", text: "I found and fixed the two bugs. Running the tests." };
      yield { type: "done", result: { text: "done", toolCalls: [], model: "scripted/fake" } };
    }
  }

  /** minimal ModelManager-compatible object */
  asManager(): ModelManager {
    const self = this;
    return {
      current: () => self.provider(),
      currentModel: () => "scripted/fake",
      getProviderList: () => ["scripted/fake"],
      supportsNativeTools: () => true,
      streamWithFallback: async function* (): AsyncGenerator<{ event: ProviderStreamEvent; provider: string }> {
        for await (const ev of self.streamChat()) {
          yield { event: ev, provider: "scripted/fake" };
        }
      },
      complete: async () => "summary",
    } as unknown as ModelManager;
  }
}

function tempConfig(dir: string): ResolvedConfig {
  const base: Config = {
    model: "scripted/fake",
    fallbackModels: [],
    baseUrl: "x",
    toolProtocol: "native",
    maxIterations: 10,
    commandTimeoutSec: 30,
    permissionMode: "allow",
    dangerousMode: "deny",
    contextLimitTokens: 50000,
    autoCompact: false,
    excludedDirs: ["node_modules", ".git", "dist"],
    disabledTools: [],
    denyCommands: [],
    allowCommands: [],
    requestTimeoutSec: 20,
    verbose: false,
    toolResultLimitChars: 4000,
    sessionDir: path.join(dir, ".opencode", "sessions"),
  };
  return {
    ...base,
    apiKey: "test-key",
    cwd: dir,
    opencodeDir: path.join(dir, ".opencode"),
    // Run the specific file (not the recursive `node --test` glob) so that when
    // this integration test is itself executed under `node --test`, the child
    // node process does not hit Node's "recursive node:test run" guard.
    testCommand: "node test.js",
  } as ResolvedConfig;
}

test("agent autonomously inspects, edits, runs tests and finishes — end to end", async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-loop-"));
  const projDir = path.join(work, "proj");
  // Copy the broken project into projDir.
  fs.cpSync(FIXTURE, projDir, { recursive: true });

  const brain = new ScriptedBrain();
  const config = tempConfig(projDir);
  const agent = new Agent(config, brain.asManager(), {
    onEvent: () => {},
    ask: async () => true,
    isInteractive: () => false,
  });

  // Confirm the bug exists first.
  const before = await runShellCommand("node test.js", { cwd: projDir, timeoutMs: 30000 });
  assert.equal(before.exitCode, 1);

  const result = await agent.run("Make all the tests in this repo pass.");
  assert.equal(result.reachedLimit, false);
  assert.ok(result.filesChanged.length >= 1, "expected calc.js to be changed");

  // Independent real verification that the tests now pass.
  const after = await runShellCommand("node test.js", { cwd: projDir, timeoutMs: 30000 });
  assert.equal(after.exitCode, 0, `expected tests to pass:\n${after.stdout}`);

  // The edit must be precise and correct.
  const fixed = fs.readFileSync(path.join(projDir, "calc.js"), "utf8");
  assert.ok(fixed.includes("function multiply(a, b) {\n  return a * b;\n}"), "multiply should use product");
  assert.ok(!fixed.includes('return "Goodbye, '), "greet should say Hello, not Goodbye");
  assert.ok(fixed.includes('return "Hello, '));
});
