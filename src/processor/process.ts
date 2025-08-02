import Redis from "ioredis";
import { PrismaClient } from "@prisma/client";
const client = new PrismaClient();

if (!process.env.REDIS_URL)
  throw new Error("REDIS_URL environment variable is not defined");
const redis = new Redis(process.env.REDIS_URL); // put your Upstash URL here
const STREAM_NAME = "zap-events";

export async function Producer() {
  while (true) {
    const pendingRows = await client.zapRunOutbox.findMany({ take: 10 });
    if (pendingRows.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10000)); // 10s if nothing to do
    }

    console.log({ processor: pendingRows });

    for (const row of pendingRows) {
      await redis.xadd(
        STREAM_NAME,
        "*", // auto-ID
        "data",
        JSON.stringify({ zapRunId: row.zapRunId, stage: 0 })
      );
    }

    await client.zapRunOutbox.deleteMany({
      where: { id: { in: pendingRows.map((row) => row.id) } },
    });
  }
}
