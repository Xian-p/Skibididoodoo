import { test } from "node:test";
import assert from "node:assert/strict";
import { PermissionSystem } from "../permissions/permissions";
import type { Config } from "../types";

function mk(over: Partial<Config> = {}): Config {
  return {
    model: "m",
    fallbackModels: [],
    baseUrl: "https://example.com",
    toolProtocol: "native",
    maxIterations: 10,
    commandTimeoutSec: 30,
    permissionMode: "allow",
    dangerousMode: "ask",
    contextLimitTokens: 1000,
    autoCompact: false,
    excludedDirs: ["node_modules"],
    disabledTools: [],
    denyCommands: [],
    allowCommands: [],
    requestTimeoutSec: 30,
    verbose: false,
    toolResultLimitChars: 1000,
    sessionDir: "/tmp/x",
    ...over,
  };
}

function sys(cfg: Config): PermissionSystem {
  return new PermissionSystem(cfg, "/tmp/proj", async () => true);
}

test("safe read/list commands are classified safe and auto-allowed", async () => {
  const p = sys(mk({ dangerousMode: "ask" }));
  assert.equal(p.classifyRisk("cat foo.ts").level, "safe");
  assert.equal(await p.requireCommand("ls -la"), true);
  assert.equal(await p.requireCommand("git status"), true);
});

test("rm -rf is dangerous", async () => {
  const p = sys(mk({ dangerousMode: "ask" }));
  assert.equal(p.classifyRisk("rm -rf node_modules").level, "dangerous");
});

test("git reset --hard is dangerous", async () => {
  const p = sys(mk({ dangerousMode: "ask" }));
  assert.equal(p.classifyRisk("git reset --hard HEAD~1").level, "dangerous");
});

test("sudo flagged as non-safe (gated by dangerousMode)", async () => {
  const p = sys(mk({ dangerousMode: "ask" }));
  assert.notEqual(p.classifyRisk("sudo apt install python3").level, "safe");
});

test("dangerous commands deny when dangerousMode=deny", async () => {
  const p = sys(mk({ dangerousMode: "deny" }));
  assert.equal(await p.requireCommand("rm -rf /tmp/foo"), false);
});

test("explicit denyCommands always deny", async () => {
  const p = sys(mk({ denyCommands: ["*killall*"], dangerousMode: "allow" }));
  assert.equal(await p.requireCommand("killall node"), false);
});

test("explicit allowCommands can permit a risky command", async () => {
  const p = sys(mk({ allowCommands: ["npm test"], dangerousMode: "ask" }));
  assert.equal(await p.requireCommand("npm test"), true);
});

test("ask is consulted when appropriate (user says no)", async () => {
  const asked: string[] = [];
  const cfg = mk({ permissionMode: "ask" });
  const ps = new PermissionSystem(cfg, "/tmp/proj", async (p) => {
    asked.push(p);
    return false;
  });
  // A file write in ask mode routes to requireWrite which asks.
  assert.equal(await ps.requireWrite("write /tmp/proj/x.ts"), false);
  assert.equal(asked.length, 1);
});
