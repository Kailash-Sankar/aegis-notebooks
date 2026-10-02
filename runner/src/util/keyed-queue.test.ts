import test from "node:test";
import assert from "node:assert/strict";
import { KeyedQueue } from "./keyed-queue.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("KeyedQueue serializes work for the same key", async () => {
  const queue = new KeyedQueue();
  const order: string[] = [];

  const a = queue.run("k", async () => {
    order.push("a:start");
    await tick();
    order.push("a:end");
  });
  const b = queue.run("k", async () => {
    order.push("b:start");
    order.push("b:end");
  });

  await Promise.all([a, b]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("KeyedQueue runs different keys concurrently", async () => {
  const queue = new KeyedQueue();
  const order: string[] = [];

  const a = queue.run("a", async () => {
    order.push("a:start");
    await tick();
    order.push("a:end");
  });
  const b = queue.run("b", async () => {
    order.push("b:start");
    order.push("b:end");
  });

  await Promise.all([a, b]);
  assert.ok(
    order.indexOf("b:end") < order.indexOf("a:end"),
    "b should finish before the slower a",
  );
});

test("a rejected task does not poison the next task", async () => {
  const queue = new KeyedQueue();
  const failing = queue.run("k", async () => {
    throw new Error("boom");
  });
  await assert.rejects(failing, /boom/);

  const value = await queue.run("k", async () => "recovered");
  assert.equal(value, "recovered");
});
