import Redis from "ioredis";
import { prismaClient } from "../db/database";
import { parse } from "./parser";
import { sendEmail } from "./email";

if (!process.env.REDIS_URL)
  throw new Error("REDIS_URL environment variable is not defined");
const redis = new Redis(process.env.REDIS_URL);
const STREAM_NAME = "zap-events";
const GROUP_NAME = "zap-group";
const CONSUMER_NAME = "zap-worker";

async function setupStream() {
  try {
    await redis.xgroup("CREATE", STREAM_NAME, GROUP_NAME, "$", "MKSTREAM");
  } catch (err: any) {
    if (!err.message.includes("BUSYGROUP")) {
      console.error("Failed to create group:", err);
    }
  }
}

export async function Consumer() {
  console.log("👟 Consumer started");
  await setupStream();
  console.log("🔌 Connected to Redis stream and group setup done");

  while (true) {
    console.log("⏳ Waiting for messages...");
    const result = (await redis.xreadgroup(
      "GROUP",
      GROUP_NAME,
      CONSUMER_NAME,
      "COUNT",
      1,
      "BLOCK",
      10000,
      "STREAMS",
      STREAM_NAME,
      ">"
    )) as [string, [string, string[]][]][];
    console.log("📦 Received message:", result);

    if (!result) continue;

    for (const [, streamMessages] of result) {
      for (const [id, fields] of streamMessages) {
        if (!Array.isArray(fields)) {
          console.warn("⚠️ Unexpected Redis message format:", fields);
          continue;
        }

        const fieldIndex = fields.findIndex((val) => val === "data");
        if (fieldIndex === -1 || !fields[fieldIndex + 1]) {
          console.warn("⚠️ No 'data' field found in Redis message:", fields);
          continue;
        }

        const payload = JSON.parse(fields[fieldIndex + 1]);
        const { zapRunId, stage } = payload;

        const zapRunDetails = await prismaClient.zapRun.findFirst({
          where: { id: zapRunId },
          include: {
            zap: {
              include: {
                actions: {
                  include: { type: true },
                },
              },
            },
          },
        });

        console.log("👀 Received Redis Payload:", payload);
        console.log("📥 zapRunId:", zapRunId);
        console.log("📥 stage:", stage);

        console.log(
          "🧠 zapRunDetails:",
          JSON.stringify(zapRunDetails, null, 2)
        );
        console.log("🧠 Actions:", zapRunDetails?.zap.actions);

        console.log("🔍 Looking for action with index =", stage);
        const currentAction = zapRunDetails?.zap.actions.find(
          (x) => x.index === stage
        );
        if (!currentAction) continue;

        const zapRunMetadata = zapRunDetails?.metadata;

        if (currentAction.type?.id === "email") {
          console.log("📧 About to send email");

          const metadata = currentAction.metadata as {
            body: string;
            email: string;
          };

          console.log("📨 Email metadata:", metadata);

          const body = parse(metadata.body, zapRunMetadata);
          const to = parse(metadata.email, zapRunMetadata);

          console.log("📨 Parsed email body:", body);
          console.log("📨 Parsed email to:", to);

          try {
            await sendEmail(to, body);
            console.log("✅ Email sent successfully");
          } catch (error) {
            console.error("❌ Failed to send email:", error);
          }
        }

        if (currentAction.type?.id === "solana_send") {
          const metadata = currentAction.metadata as {
            amount: string;
            address: string;
          };
          const amount = parse(metadata.amount, zapRunMetadata);
          const address = parse(metadata.address, zapRunMetadata);
          console.log(`Send SOL: ${amount} to ${address}`);
          // await sendSol(address, amount);
        }

        const lastStage = (zapRunDetails?.zap.actions.length || 1) - 1;
        if (lastStage !== stage) {
          await redis.xadd(
            STREAM_NAME,
            "*",
            "data",
            JSON.stringify({ zapRunId, stage: stage + 1 })
          );
        }

        await redis.xack(STREAM_NAME, GROUP_NAME, id);
      }
    }
  }
}
