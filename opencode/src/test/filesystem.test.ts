import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { ReadFileTool, WriteFileTool, EditFileTool, DeleteFileTool, ListDirectoryTool } from "../tools/filesystem";
import { makeTempDir, fakeCtx, writeTemp } from "./testutil";

test("read_file returns numbered content and correct totals", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "a.txt");
  writeTemp(file, "one\ntwo\nthree\n");
  const r = await new ReadFileTool().run({ path: "a.txt" }, fakeCtx(dir));
  assert.equal(r.error, false);
  assert.equal((r.data as { totalLines: number }).totalLines, 3);
  assert.ok(r.content.includes("1| one"));
  assert.ok(r.content.includes("3| three"));
});

test("read_file supports a line range", async () => {
  const dir = makeTempDir();
  const file = path.join(dir, "big.txt");
  writeTemp(file, Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join("\n"));
  const r = await new ReadFileTool().run({ path: "big.txt", startLine: 10, endLine: 12 }, fakeCtx(dir));
  assert.ok(r.content.includes("10| line10"));
  assert.ok(r.content.includes("12| line12"));
  assert.ok(!r.content.includes("line50"));
});

test("read_file reports missing file", async () => {
  const dir = makeTempDir();
  const r = await new ReadFileTool().run({ path: "nope.txt" }, fakeCtx(dir));
  assert.equal(r.error, true);
});

test("write_file creates, edit_file applies precise change", async () => {
  const dir = makeTempDir();
  const ctx = fakeCtx(dir);
  const w = await new WriteFileTool().run({ path: "calc.ts", content: "const a = 1;\nconsole.log(a + a);\n" }, ctx);
  assert.equal(w.error, false);
  const e = await new EditFileTool().run(
    { path: "calc.ts", oldText: "a + a", newText: "a * 2" },
    ctx
  );
  assert.equal(e.error, false);
  const r = await new ReadFileTool().run({ path: "calc.ts" }, ctx);
  assert.ok(r.content.includes("a * 2"));
  assert.ok(!r.content.includes("a + a"));
});

test("edit_file fails cleanly when oldText missing", async () => {
  const dir = makeTempDir();
  writeTemp(path.join(dir, "x.ts"), "hello");
  const r = await new EditFileTool().run({ path: "x.ts", oldText: "missing-text", newText: "y" }, fakeCtx(dir));
  assert.equal(r.error, true);
  assert.ok(r.content.includes("not found"));
});

test("delete_file removes file", async () => {
  const dir = makeTempDir();
  writeTemp(path.join(dir, "d.txt"), "data");
  const r = await new DeleteFileTool().run({ path: "d.txt" }, fakeCtx(dir));
  assert.equal(r.error, false);
});

test("write_file refuses paths outside the project", async () => {
  const dir = makeTempDir();
  const outside = path.join(dir, "..", "opencode_escape.txt");
  const t = new WriteFileTool();
  const r = await t.execute({ path: outside }, fakeCtx(dir)); // execute() wraps the throw
  assert.equal(r.error, true);
  assert.ok(r.content.includes("outside the project"));
});

test("list_directory returns project files", async () => {
  const dir = makeTempDir();
  writeTemp(path.join(dir, "src", "index.ts"), "x");
  writeTemp(path.join(dir, "readme.md"), "x");
  const r = await new ListDirectoryTool().run({ path: "." }, fakeCtx(dir));
  assert.ok(r.content.includes("src"));
  assert.ok(r.content.includes("readme.md"));
});
