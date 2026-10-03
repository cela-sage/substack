import { test } from "node:test";
import assert from "node:assert/strict";
import { pageOf } from "../src/page.js";

test("page 1 is the five newest issues", () => {
  assert.deepEqual(pageOf(1), [12, 11, 10, 9, 8]);
});

test("page 3 holds the two oldest", () => {
  assert.deepEqual(pageOf(3), [2, 1]);
});

test("a page past the end is empty", () => {
  assert.deepEqual(pageOf(4), []);
});
