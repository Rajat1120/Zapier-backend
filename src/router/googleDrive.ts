// Google Drive integration routes: Watch for file changes and handle webhook notifications
import { Router } from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { prismaClient } from "../db/database";
import { getTokenForUser } from "../utils/googleTokens";

const router = Router();

// Route to initiate a Google Drive watch channel for detecting file changes
// POST /api/google-drive/watch
router.post("/watch", async (req, res): Promise<any> => {
  const { userId } = req.body;

  try {
    // Fetch the user's access token from the database
    const tokenRecord = await prismaClient.google_tokens.findUnique({
      where: { userId },
      select: { access_token: true },
    });

    if (!tokenRecord?.access_token) {
      return res.status(400).json({ message: "No access token found" });
    }

    const accessToken = tokenRecord.access_token;
    const channelId = uuidv4();

    // Get the current startPageToken for listing changes from Google Drive
    const startPageToken = await axios.get(
      "https://www.googleapis.com/drive/v3/changes/startPageToken",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Create a new watch channel on the user's Google Drive changes
    const response = await axios.post(
      "https://www.googleapis.com/drive/v3/changes/watch",
      {
        id: channelId,
        type: "web_hook",
        address: `${process.env.BACKEND_URL}/api/google-drive/webhook`,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        params: {
          pageToken: startPageToken.data.startPageToken,
        },
      }
    );
    const { expiration, resourceId } = response.data;

    // Store the new watch details in the database
    await prismaClient.google_drive_watch.create({
      data: {
        userId,
        channelId,
        resourceId,
        expiration: new Date(Number(expiration)),
        startPageToken: startPageToken.data.startPageToken,
      },
    });

    res.status(200).json({ message: "Watch started", data: response.data });
  } catch (error) {
    console.error("Error starting Drive watch:", error);
    res.status(500).json({ message: "Failed to start watch" });
  }
});

// Webhook route that Google calls when a file change is detected
router.post("/webhook", async (req, res) => {
  try {
    const { headers } = req;

    let channelId = headers["x-goog-channel-id"];

    if (Array.isArray(channelId)) {
      channelId = channelId[0];
    }

    // Find the corresponding watch entry in the database using the channel ID
    const watch = await prismaClient.google_drive_watch.findFirst({
      where: { channelId: channelId as string },
    });

    if (!watch) {
      res.status(404).json({ message: "Watch not found" });
      return;
    }

    // Fetch a valid access token for the user
    const { access_token: accessToken } = await getTokenForUser(watch.userId);

    const pageToken = watch.startPageToken;

    // Retrieve the list of file changes from Google Drive
    const { data } = await axios.get(
      "https://www.googleapis.com/drive/v3/changes",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        params: {
          pageToken: pageToken,
          fields: "changes(file(id,name,mimeType)),newStartPageToken",
        },
      }
    );

    // A simple in-memory cache to store processed file IDs for 2 minutes
    const recentlyProcessed = new Map<string, number>();

    for (const change of data.changes) {
      const file = change.file;
      const fileId = file?.id;

      if (
        file?.mimeType === "application/vnd.google-apps.document" &&
        file?.createdTime === file?.modifiedTime
      ) {
        // check deduplication
        const now = Date.now();
        const lastSeen = recentlyProcessed.get(fileId);

        if (lastSeen && now - lastSeen < 2 * 60 * 1000) {
          console.log("⏩ Duplicate webhook for file, skipping:", file.name);
          continue;
        }

        // Fetch metadata to confirm it's recent
        const fileMeta = await axios.get(
          `https://www.googleapis.com/drive/v3/files/${file.id}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            params: {
              fields: "createdTime,name,mimeType",
            },
          }
        );

        const createdAt = new Date(fileMeta.data.createdTime);
        const timeDiffMinutes =
          (Date.now() - createdAt.getTime()) / (1000 * 60);

        if (timeDiffMinutes < 1) {
          console.log("📄 NEW Google Doc created:", file.name);

          // ✅ Mark file as processed now
          recentlyProcessed.set(fileId, now);
        } else {
          console.log("✏️ Existing doc modified, ignoring:", file.name);
        }
      } else {
        console.log("⏩ Ignoring file (not a doc):", file.name, file.mimeType);
      }
    }

    setInterval(() => {
      const now = Date.now();
      for (const [key, time] of recentlyProcessed.entries()) {
        if (now - time > 5 * 60 * 1000) {
          recentlyProcessed.delete(key);
        }
      }
    }, 60 * 1000);

    // Update the stored startPageToken to continue tracking future changes
    await prismaClient.google_drive_watch.update({
      where: { channelId: channelId as string },
      data: {
        startPageToken: data.newStartPageToken,
      },
    });

    res.status(200).json({ message: "Webhook processed" });
  } catch (error) {
    console.error("Error processing webhook:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export default router;
