import { json } from "express";
import { Kafka } from "kafkajs";
import { prismaClient } from "../db/database";
import { parse } from "./parser";
import { sendEmail } from "./email";
import { JsonObject } from "@prisma/client/runtime/library";

const kafka = new Kafka({
  clientId: "outbox-processor",
  brokers: ["localhost:9092"],
});
const TOPIC_NAME = "zap-events";

async function main() {
  const consumer = kafka.consumer({ groupId: "main-worker" });
  await consumer.connect();
  const producer = kafka.producer();
  await producer.connect();
  console.log("run");

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

      if (!message.value?.toString()) {
        return;
      }
      const parsedValue = JSON.parse(message.value.toString());
      const zapRunId = parsedValue.zapRunId;
      const stage = parsedValue.stage;

      const zapRunDetails = await prismaClient.zapRun.findFirst({
        where: {
          id: zapRunId,
        },
        include: {
          zap: {
            include: {
              actions: {
                include: {
                  type: true,
                },
              },
            },
          },
        },
      });
      const currentAction = zapRunDetails?.zap.actions.find(
        (x) => x.sortingOrder === stage
      );

      if (!currentAction) {
        console.log("Current action not found?");
        return;
      }

      const zapRunMetadata = zapRunDetails?.metadata;

      if (currentAction.type.id === "email") {
        console.log("Sending email");

        const body = parse(
          (currentAction.metadata as JsonObject)?.body as string,
          zapRunMetadata
        );
        const to = parse(
          (currentAction.metadata as JsonObject)?.email as string,
          zapRunMetadata
        );
        console.log(`Sending out email to ${to} body is ${body}`);
        await sendEmail(to, body);
      }

      if (currentAction.type.id === "solana_send") {
        console.log("Sending SOL");
        const amount = parse(
          (currentAction.metadata as JsonObject)?.amount as string,
          zapRunMetadata
        );
        const address = parse(
          (currentAction.metadata as JsonObject)?.address as string,
          zapRunMetadata
        );
        console.log(`Sending out SOL of ${amount} to address ${address}`);
        // await sendSol(address, amount);
      }

      const lastStage = (zapRunDetails?.zap.actions?.length || 1) - 1; // 1
      console.log(lastStage);
      console.log(stage);
      if (lastStage !== stage) {
        console.log("pushing back to the queue");
        await producer.send({
          topic: TOPIC_NAME,
          messages: [
            {
              value: JSON.stringify({
                stage: stage + 1,
                zapRunId,
              }),
            },
          ],
        });
      }

      console.log("processing done");

      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second
      console.log(`Committing offset: ${offset} for partition: ${partition}`);
      await consumer.commitOffsets([
        { topic, partition, offset: message.offset },
      ]);
    },
  });
}

main();
