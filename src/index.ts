import googleDriveRouter from "./router/googleDrive";
import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { userRouter } from "./router/user";
import { zapRouter } from "./router/zap";
import { triggerRouter } from "./router/trigger";
import { actionRouter } from "./router/action";
import { Producer } from "./processor/process";
import { Consumer } from "./worker/worker";
import { googleTokenRouter } from "./router/googleTokenRouter";
import { refreshGoogleTokens } from "./cron/refreshGoogleTokens";

const client = new PrismaClient();

// Add error handling for background processes
Producer().catch((error) => {
  console.error("Producer failed:", error);
  // Don't exit the process, just log the error
});

Consumer().catch((error) => {
  console.error("Consumer failed:", error);
  // Don't exit the process, just log the error
});

const app = express();

// ✅ Enable CORS for all origins (development only)
app.use(cors());

app.use(express.json());

app.post("/hooks/catch/:userId/:zapId", async (req, res) => {
  const userId = req.params.userId;
  const zapId = req.params.zapId;
  const body = req.body;

  try {
    // store into db a new trigger
    await client.$transaction(async (tx: any) => {
      const run = await client.zapRun.create({
        data: {
          zapId: zapId,
          metadata: body,
        },
      });

      await client.zapRunOutbox.create({
        data: {
          zapRunId: run.id,
        },
      });
    });

    res.json({ message: "webhook received" });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.use("/api/v1/user", userRouter);
app.use("/api/v1/zap", zapRouter);
app.use("/api/v1/trigger", triggerRouter);
app.use("/api/v1/action", actionRouter);
app.use("/api/google-token", googleTokenRouter);
app.use("/api/google-drive", googleDriveRouter);

app.get("/", (req, res) => {
  res.status(200).send("🚀 Zapier backend is live");
});

setInterval(() => {
  refreshGoogleTokens();
}, 30 * 60 * 1000);

const PORT = 8000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);
});
