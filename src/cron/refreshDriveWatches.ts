// cron/refreshDriveWatches.ts
import axios from "axios";
import { prismaClient } from "../db/database";
import { getTokenForUser } from "../utils/googleTokens";

export async function refreshDriveWatches() {
  console.log("⏳ Running Drive Watch Refresher...");

  // Step 1: Calculate time 20 min from now
  // 20 minutes in milliseconds
  const istOffset = 5.5 * 60 * 60 * 1000;
  const bufferInMs = 20 * 60 * 1000; // 20 mins
  const bufferExpiry = new Date(Date.now() + bufferInMs + istOffset);
  const expiringWatches = await prismaClient.google_drive_watch.findMany({
    where: {
      expiration: { lt: bufferExpiry },
      zap: { published: true },
    },
    include: {
      zap: {
        include: {
          trigger: {
            include: {
              type: true,
            },
          },
        },
      },
    },
  });

  console.log(`📦 Watches expiring soon: ${expiringWatches.length}`);

  for (const watch of expiringWatches) {
    try {
      const { userId, zapId } = watch;
      const accessToken = (await getTokenForUser(userId)).access_token;

      // Step 3: Get fresh startPageToken
      const startPageTokenRes = await axios.get(
        "https://www.googleapis.com/drive/v3/changes/startPageToken",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      const newChannelId = crypto.randomUUID();
      const triggerName = watch.zap.trigger?.type.name;
      let webhookUrl = "";

      if (triggerName === "Google docs") {
        webhookUrl = `${process.env.BACKEND_URL}/api/google-docs/webhook`;
      } else if (triggerName === "Google Drive") {
        webhookUrl = `${process.env.BACKEND_URL}/api/google-drive/webhook`;
      } else {
        console.error(
          `Unsupported trigger type for watch refresh: ${triggerName}`
        );
        continue;
      }
      // Step 4: Start new watch
      const watchRes = await axios.post(
        "https://www.googleapis.com/drive/v3/changes/watch",
        {
          id: newChannelId,
          type: "web_hook",
          address: webhookUrl,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          params: {
            pageToken: startPageTokenRes.data.startPageToken,
          },
        }
      );

      const { expiration, resourceId } = watchRes.data;

      // Step 5: Delete existing watch rows for this zap to avoid duplicates
      await prismaClient.google_drive_watch.deleteMany({
        where: { zapId },
      });

      // If expiration is in milliseconds (e.g., 1722092316000)
      const utcDate = new Date(Number(expiration));

      // Convert to IST (UTC + 5:30)
      const istOffset = 5.5 * 60 * 60 * 1000; // 5.5 hours in milliseconds
      const istDate = new Date(utcDate.getTime() + istOffset);
      // Step 6: Insert fresh watch entry
      await prismaClient.google_drive_watch.create({
        data: {
          userId,
          zapId,
          channelId: newChannelId,
          resourceId,
          expiration: istDate,
          startPageToken: startPageTokenRes.data.startPageToken,
        },
      });

      console.log(`🔁 Refreshed watch for user ${userId}`);
    } catch (err) {
      console.error(`❌ Failed to refresh watch for user ${watch.userId}`, err);
    }
  }

  console.log("✅ Done refreshing Google Drive watches.");
}
