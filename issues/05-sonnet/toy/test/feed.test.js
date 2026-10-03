import { test } from "node:test";
import assert from "node:assert/strict";
import { latest } from "../src/feed.js";

test("the feed lists the three newest issues with their dates", () => {
  assert.deepEqual(latest(), ["#12 · 23 Mar 2026", "#11 · 16 Mar 2026", "#10 · 9 Mar 2026"]);
});
