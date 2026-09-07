# broken-calc

A small, intentionally broken calculator used to exercise the **opencode** autonomous
agent. Two functions (`multiply`, `greet`) return wrong results, so the test suite in
`test.js` fails.

Reproduce the agent workflow from the `broken-calc` directory:

```bash
export OPENROUTER_API_KEY='sk-or-...'        # your real key
opencode --auto "The test suite is failing. Inspect the code, fix the bugs so all tests pass, and verify."
```

The agent should inspect the repo, read `calc.js`, plan the fix, edit the two functions,
run `npm test`, and (because the fixes are correct) reach a fully passing suite.

Run the tests directly to see the baseline failures:

```bash
npm test     # 2 tests fail
```
