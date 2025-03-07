import { PrismaClient } from "@prisma/client";
import { Kafka } from "kafkajs";

const kafka = new Kafka({
  clientId: "outbox-processor",
  brokers: ["localhost:9092"],
});
const TOPIC_NAME = "zap-events";
const client = new PrismaClient();

async function main() {
  const producer = kafka.producer();
  await producer.connect();
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
    const pendingRows = await client.zapRunOutbox.findMany({
      where: {},
      take: 10,
    });

    console.log(pendingRows);
    // if (pendingRows.length === 0) break;

    await producer.send({
      topic: TOPIC_NAME,
      messages: pendingRows.map((r) => {
        return {
          value: JSON.stringify({ zapRunId: r.zapRunId, stage: 0 }),
        };
      }),
    });

    await client.zapRunOutbox.deleteMany({
      where: {
        id: {
          in: pendingRows.map((row) => row.id),
        },
      },
    });
  }
}

main();
