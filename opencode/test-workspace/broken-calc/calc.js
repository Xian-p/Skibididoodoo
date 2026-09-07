// calc.js — a deliberately broken calculator. There are bugs to find.

function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

// BUG 1: multiply returns the sum instead of the product.
function multiply(a, b) {
  return a + b;
}

function divide(a, b) {
  if (b === 0) {
    throw new Error("cannot divide by zero");
  }
  return a / b;
}

// BUG 2: greet says "Goodbye" instead of "Hello".
function greet(name) {
  return "Goodbye, " + name;
}

module.exports = { add, subtract, multiply, divide, greet };
