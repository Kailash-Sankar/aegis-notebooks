import test from "node:test";
import assert from "node:assert/strict";
import { newId } from "./ids.js";

test("newId returns 15 lowercase alphanumeric chars (PocketBase-compatible)", () => {
  for (let i = 0; i < 100; i++) {
    const id = newId();
    assert.equal(id.length, 15);
    assert.match(id, /^[a-z0-9]+$/);
  }
});

test("newId is not trivially repeating", () => {
  const ids = new Set(Array.from({ length: 200 }, () => newId()));
  assert.equal(ids.size, 200);
});
