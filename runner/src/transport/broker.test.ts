import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryBroker, type BrokerMessage } from "./broker.js";

test("MemoryBroker delivers published messages to subscribers", async () => {
  const broker = new MemoryBroker();
  const got: BrokerMessage[] = [];
  await broker.subscribe("t", "g", async (message) => {
    got.push(message);
  });
  await broker.publish("t", "k1", "v1");
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { topic: "t", key: "k1", value: "v1" });
});

test("MemoryBroker isolates topics", async () => {
  const broker = new MemoryBroker();
  const got: string[] = [];
  await broker.subscribe("a", "g", async () => {
    got.push("a");
  });
  await broker.subscribe("b", "g", async () => {
    got.push("b");
  });
  await broker.publish("b", "k", "v");
  assert.deepEqual(got, ["b"]);
});

test("MemoryBroker records published messages for inspection", async () => {
  const broker = new MemoryBroker();
  await broker.publish("t", "k", "v");
  assert.equal(broker.published.length, 1);
  assert.equal(broker.published[0]?.key, "k");
});
