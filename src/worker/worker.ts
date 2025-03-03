import { Kafka } from "kafkajs";

const kafka = new Kafka({
  clientId: "outbox-processor",
  brokers: ["localhost:9092"],
});
const TOPIC_NAME = "zap-events";

async function main() {
  const consumer = kafka.consumer({ groupId: "main-worker" });
  await consumer.connect();

  await consumer.subscribe({ topic: TOPIC_NAME, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const offset = message.offset ? message.offset.toString() : "undefined";
      console.log({
        topic,
        partition,
        offset,
        value: message.value?.toString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
      console.log(`Committing offset: ${offset} for partition: ${partition}`);
      await consumer.commitOffsets([
        { topic, partition, offset: message.offset },
      ]);
    },
  });
}

main();
