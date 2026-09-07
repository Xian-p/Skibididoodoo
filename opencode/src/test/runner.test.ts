import { test } from "node:test";
import assert from "node:assert/strict";
import { runShellCommand } from "../tools/runner";

test("runner captures output and exit code", async () => {
  const r = await runShellCommand("echo hello && echo world", { timeoutMs: 5000 });
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdout.includes("hello"));
  assert.ok(r.stdout.includes("world"));
});

test("runner reports a failing exit code", async () => {
  const r = await runShellCommand("exit 3", { timeoutMs: 5000 });
  assert.equal(r.exitCode, 3);
});

test("runner reports stderr separately", async () => {
  const r = await runShellCommand("echo oops >&2", { timeoutMs: 5000 });
  assert.ok(r.stderr.includes("oops"));
});

test("runner honours a timeout and kills the process", async () => {
  const r = await runShellCommand("sleep 5", { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
});
