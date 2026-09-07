import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../session/session";
import { UndoManager } from "../session/undo";
import * as path from "node:path";
import { makeTempDir, fakeCtx, writeTemp } from "./testutil";
import type { ResolvedConfig } from "../types";
import { ReadFileTool, WriteFileTool } from "../tools/filesystem";

function cfgFor(dir: string): ResolvedConfig {
  return {
    model: "m",
    fallbackModels: [],
    baseUrl: "x",
    toolProtocol: "native",
    maxIterations: 5,
    commandTimeoutSec: 10,
    permissionMode: "allow",
    dangerousMode: "ask",
    contextLimitTokens: 1000,
    autoCompact: false,
    excludedDirs: [],
    disabledTools: [],
    denyCommands: [],
    allowCommands: [],
    requestTimeoutSec: 10,
    verbose: false,
    toolResultLimitChars: 500,
    sessionDir: path.join(dir, ".opencode", "sessions"),
    apiKey: "k",
    cwd: dir,
    opencodeDir: path.join(dir, ".opencode"),
  };
}

test("session persists and reloads messages", () => {
  const dir = makeTempDir();
  const cfg = cfgFor(dir);
  const s = new Session(cfg);
  s.state.messages = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", name: "read_file", content: "result" },
  ];
  s.save();
  const loaded = Session.load(cfg, s.state.id);
  assert.ok(loaded);
  assert.equal(loaded.state.messages.length, 4);
  assert.equal(loaded.state.messages[1].content, "hi");
  assert.equal(loaded.state.messages[2].tool_calls?.[0].function.name, "read_file");
  // appears in listing
  const list = Session.list(cfg);
  assert.equal(list.length, 1);
  assert.equal(list[0].messages, 4);
});

test("undo restores a deleted file and reverts an edit", async () => {
  const dir = makeTempDir();
  const cfg = cfgFor(dir);
  const um = new UndoManager(cfg.opencodeDir);
  const file = path.join(dir, "keep.txt");
  writeTemp(file, "ORIGINAL");
  // Simulate agent: edit via tool, then delete, then undo.
  const ctx = fakeCtx(dir);
  // undo journaling is active via the real UndoManager (patch context undo to um)
  ctx.undo = um;
  const e = await new WriteFileTool().run({ path: "keep.txt", content: "EDITED" }, ctx);
  assert.equal(e.error, false);
  const afterEdit = await new ReadFileTool().run({ path: "keep.txt" }, ctx);
  assert.ok(afterEdit.content.includes("EDITED"));

  // Delete it, then undo all → original restored.
  const { DeleteFileTool } = require("../tools/filesystem");
  await new DeleteFileTool().run({ path: "keep.txt" }, ctx);
  assert.equal(um.count() > 0, true);
  const report = await um.undoSince(0);
  const restored = require("node:fs").readFileSync(file, "utf8");
  assert.equal(restored, "ORIGINAL");
});
