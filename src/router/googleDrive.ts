import { Router } from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { prismaClient } from "../db/database";

const router = Router();

// POST /api/google-drive/watch
router.post("/watch", async (req, res): Promise<any> => {
  const { userId } = req.body;

  try {
    // 1. Get access token from DB
    const tokenRecord = await prismaClient.google_tokens.findUnique({
      where: { userId },
      select: { access_token: true },
    });

    if (!tokenRecord?.access_token) {
      return res.status(400).json({ message: "No access token found" });
    }

    const accessToken = tokenRecord.access_token;
    const channelId = uuidv4();

    // 2. Call Google Drive API to start watching
    const response = await axios.post(
      "https://www.googleapis.com/drive/v3/files/root/watch",
      {
        id: channelId,
        type: "web_hook",
        address: `${process.env.BACKEND_URL}/api/webhook/google-drive`,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const { expiration, resourceId } = response.data;

    // 3. Store channel data in DB
    await prismaClient.google_drive_watch.create({
      data: {
        userId,
        channelId,
        resourceId,
        expiration: new Date(Number(expiration)),
      },
    });

    res.status(200).json({ message: "Watch started", data: response.data });
  } catch (error) {
    console.error("Error starting Drive watch:", error);
    res.status(500).json({ message: "Failed to start watch" });
  }
});

router.post("/webhook/google-drive", async (req, res) => {
  const headers = req.headers;
  console.log("📩 Raw headers:", req.headers);
  const channelId = headers["x-goog-channel-id"];
  const state = headers["x-goog-resource-state"];
  const resourceId = headers["x-goog-resource-id"];

  console.log("📩 Drive webhook:", { channelId, state, resourceId });

  // Look up user/channel in DB, then fetch latest file and run Zap

  res.status(200).send("ok");
});

export default router;
