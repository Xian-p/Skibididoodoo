import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ContextManager } from "../context/context";
import { makeTempDir, writeTemp } from "./testutil";

function cfg(autoCompact = true): { contextLimitTokens: number; autoCompact: boolean } {
  return { contextLimitTokens: 2000, autoCompact };
}

test("context manager caches and dedups seen files", () => {
  const cm = new ContextManager(cfg() as never);
  cm.markSeen("/tmp/x.ts", 10, 123);
  assert.equal(cm.hasSeen("/tmp/x.ts"), true);
  assert.equal(cm.hasSeen("/tmp/y.ts"), false);
  assert.ok(cm.renderMemoryBlock().includes("FILES ALREADY READ"));
});

test("cache returns stale content after mtime change is avoided", async () => {
  const dir = makeTempDir();
  const f = path.join(dir, "c.txt");
  writeTemp(f, "version one");
  const cm = new ContextManager(cfg() as never);
  cm.cache(f, "version one");
  const { statSync } = require("node:fs");
  const st = statSync(f);
  cm.markSeen(f, st.size, st.mtimeMs);
  assert.equal(cm.getCached(f), "version one");
  // change the file -> cache is invalid (size changed)
  writeTemp(f, "version two has much longer content");
  assert.notEqual(cm.getCached(f), "version one");
});

test("notes are kept and bounded", () => {
  const cm = new ContextManager(cfg() as never);
  for (let i = 0; i < 50; i++) cm.addNote(`note ${i}`);
  assert.ok(cm.getNotes().length <= 30);
  assert.ok(cm.getNotes().some((n) => n.includes("49")));
});

test("needsAutoCompact triggers after many messages", () => {
  const cm = new ContextManager(cfg(true) as never);
  for (let i = 0; i < 30; i++) cm.countMessage();
  assert.equal(cm.needsAutoCompact(), true);
});
