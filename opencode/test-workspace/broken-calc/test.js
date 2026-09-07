// test.js — tests for calc.js. Several of these fail until the bugs are fixed.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { add, subtract, multiply, divide, greet } = require("./calc");

test("add returns the sum", () => {
  assert.equal(add(2, 3), 5);
});

test("subtract returns the difference", () => {
  assert.equal(subtract(10, 4), 6);
});

test("multiply returns the product", () => {
  assert.equal(multiply(2, 3), 6); // currently returns 5
  assert.equal(multiply(-4, 5), -20);
});

test("divide returns the quotient", () => {
  assert.equal(divide(10, 2), 5);
});

test("divide rejects division by zero", () => {
  assert.throws(() => divide(1, 0), /zero/);
});

test("greet says hello", () => {
  assert.equal(greet("Ada"), "Hello, Ada"); // currently "Goodbye, Ada"
});
