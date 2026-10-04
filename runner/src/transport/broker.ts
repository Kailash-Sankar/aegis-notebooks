import { Kafka, type Consumer, type Producer } from "kafkajs";
import type { Config } from "../config.js";

/**
 * Transport abstraction (design §4.5). Redpanda/Kafka in real runs; an
 * in-process broker in dev/tests so the pipeline is runnable without infra.
 *
 * Delivery is **at-least-once**: consumers commit only after the handler
 * resolves, so handlers must be idempotent (the content-addressed raw + engine
 * dedupe make that true).
 */
export interface BrokerMessage {
  topic: string;
  key: string;
  value: string;
}

export interface Broker {
  readonly enabled: boolean;
  connect(): Promise<void>;
  publish(topic: string, key: string, value: string): Promise<void>;
  subscribe(
    topic: string,
    groupId: string,
    handler: (message: BrokerMessage) => Promise<void>,
  ): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * In-process broker for dev and tests. Handlers run inline on publish, in
 * registration order. Not durable and not shared across processes.
 */
export class MemoryBroker implements Broker {
  readonly enabled = true;
  readonly published: BrokerMessage[] = [];
  private readonly handlers = new Map<
    string,
    Array<(message: BrokerMessage) => Promise<void>>
  >();

  async connect(): Promise<void> {}

  async publish(topic: string, key: string, value: string): Promise<void> {
    const message: BrokerMessage = { topic, key, value };
    this.published.push(message);
    for (const handler of this.handlers.get(topic) ?? []) {
      await handler(message);
    }
  }

  async subscribe(
    topic: string,
    _groupId: string,
    handler: (message: BrokerMessage) => Promise<void>,
  ): Promise<void> {
    const list = this.handlers.get(topic) ?? [];
    list.push(handler);
    this.handlers.set(topic, list);
  }

  async disconnect(): Promise<void> {
    this.handlers.clear();
  }
}

export class KafkaBroker implements Broker {
  readonly enabled = true;
  private readonly kafka: Kafka;
  private producer: Producer | null = null;
  private connecting: Promise<void> | null = null;
  private readonly consumers: Consumer[] = [];

  constructor(brokers: string[], clientId: string) {
    this.kafka = new Kafka({ clientId, brokers });
  }

  async connect(): Promise<void> {
    if (this.producer) return;
    // Memoize the in-flight connection so concurrent callers share one attempt.
    if (!this.connecting) {
      const producer = this.kafka.producer();
      this.connecting = producer
        .connect()
        .then(() => {
          this.producer = producer;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  async publish(topic: string, key: string, value: string): Promise<void> {
    if (!this.producer) await this.connect();
    await this.producer?.send({ topic, messages: [{ key, value }] });
  }

  async subscribe(
    topic: string,
    groupId: string,
    handler: (message: BrokerMessage) => Promise<void>,
  ): Promise<void> {
    const consumer = this.kafka.consumer({ groupId });
    this.consumers.push(consumer);
    await consumer.connect();
    // Read from the beginning: the group join can take tens of seconds, and
    // with `fromBeginning: false` any message produced before the first
    // assignment would be skipped. Loading is idempotent (content-addressed
    // raw + engine dedupe), so reprocessing on restart is safe.
    await consumer.subscribe({ topic, fromBeginning: true });
    await consumer.run({
      // Process several partitions at once so one slow/stuck partition cannot
      // block the others (default is 1).
      partitionsConsumedConcurrently: 6,
      // kafkajs auto-commits after eachMessage resolves; a throw retries and,
      // after exhaustion, surfaces so the caller can route to the DLQ.
      eachMessage: async ({ message }) => {
        await handler({
          topic,
          key: message.key?.toString() ?? "",
          value: message.value?.toString() ?? "",
        });
      },
    });
  }

  async disconnect(): Promise<void> {
    await this.producer?.disconnect();
    for (const consumer of this.consumers) await consumer.disconnect();
  }
}

/** Redpanda/Kafka when `KAFKA_BROKERS` is set, else an in-process broker. */
export function createBroker(config: Config): Broker {
  const brokers = (config.KAFKA_BROKERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return brokers.length > 0
    ? new KafkaBroker(brokers, config.KAFKA_CLIENT_ID)
    : new MemoryBroker();
}
