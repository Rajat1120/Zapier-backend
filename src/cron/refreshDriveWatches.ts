// cron/refreshDriveWatches.ts
import axios from "axios";
import { prismaClient } from "../db/database";
import { getTokenForUser } from "../utils/googleTokens";

export async function refreshDriveWatches() {
  console.log("⏳ Running Drive Watch Refresher...");

  // Step 1: Calculate time 20 min from now
  const bufferExpiry = new Date(Date.now() + 20 * 60 * 1000);

  // Step 2: Find watches expiring in next 20 min AND zap is published
  const expiringWatches = await prismaClient.google_drive_watch.findMany({
    where: {
      expiration: { lt: bufferExpiry },
      zap: { published: true }, // assumes zap relation
    },
    include: { zap: true },
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

      // Step 4: Start new watch
      const watchRes = await axios.post(
        "https://www.googleapis.com/drive/v3/changes/watch",
        {
          id: newChannelId,
          type: "web_hook",
          address: `${process.env.BACKEND_URL}/api/google-drive/webhook`,
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

      // Step 5: Update DB with new watch info
      await prismaClient.google_drive_watch.update({
        where: { id: watch.id },
        data: {
          channelId: newChannelId,
          resourceId,
          expiration: new Date(Number(expiration)),
          startPageToken: startPageTokenRes.data.startPageToken,
          zapId,
        },
      });

      console.log(`🔁 Refreshed watch for user ${userId}`);
    } catch (err) {
      console.error(`❌ Failed to refresh watch for user ${watch.userId}`, err);
    }
  }

  console.log("✅ Done refreshing Google Drive watches.");
}
