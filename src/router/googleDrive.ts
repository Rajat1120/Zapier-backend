// Google Drive integration routes: Watch for file changes and handle webhook notifications
import { Router, Request, Response } from "express";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { prismaClient } from "../db/database";
import { getTokenForUser } from "../utils/googleTokens";
import { authMiddleware } from "../middleware";
import { fetchDriveFolders } from "../lib/google/drive";

const router = Router();

// A simple in-memory cache to store processed file IDs (moved outside to persist across requests)
const recentlyProcessed = new Map<string, number>();

// Clean up old entries from cache every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, time] of recentlyProcessed.entries()) {
    if (now - time > 5 * 60 * 1000) {
      recentlyProcessed.delete(key);
    }
  }
}, 5 * 60 * 1000); // Run every 5 minutes, not every minute

// Route to initiate a Google Drive watch channel for detecting file changes
// POST /api/google-drive/watch
router.post("/watch", async (req, res): Promise<any> => {
  const { userId, zapId } = req.body;

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
    const utcDate = new Date(Number(expiration));

    // Add IST offset (UTC+5:30 => 330 minutes = 19800000 ms)
    const istDate = new Date(utcDate.getTime() + 5.5 * 60 * 60 * 1000);

    // Store the new watch details in the database
    await prismaClient.google_drive_watch.create({
      data: {
        userId,
        channelId,
        resourceId,
        expiration: istDate,
        startPageToken: startPageToken.data.startPageToken,
        zapId,
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
          fields: "changes(file(id,name,mimeType,trashed,parents)),newStartPageToken",
        },
      }
    );

    for (const change of data.changes) {
      const file = change.file;
      const fileId = file?.id;

      // Skip if deleted/trashed
      if (file?.trashed) continue;

      // Check if we've already processed this file recently to avoid duplicates
      const now = Date.now();
      const lastSeen = recentlyProcessed.get(fileId);
      if (lastSeen && now - lastSeen < 2 * 60 * 1000) {
        continue; // Skip this file, continue to next
      }

      // Mark this file as being processed immediately to prevent race conditions
      recentlyProcessed.set(fileId, now);

      // Get detailed file metadata including appProperties
      const fileMeta = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${file.id}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          params: {
            fields: "createdTime,modifiedTime,name,mimeType,parents,trashed,appProperties",
          },
        }
      );

      // Check for self-generated files to prevent infinite loops
      const appProperties = fileMeta.data.appProperties || {};
      const requiredFields = ["origin", "originZapId", "originNodeId", "originZapRunId"];
      const detectedFields = Object.keys(appProperties);
      const hasAllRequiredFields = requiredFields.every(field => appProperties.hasOwnProperty(field));

      // Filter out files created by the zap engine
      if (appProperties.origin === "zap-engine" && appProperties.originZapId === watch.zapId) {
        console.log(JSON.stringify({
          event: "drive_file_filtered",
          fileId: file.id,
          reason: "self-generated",
          zapId: watch.zapId,
          zapRunId: null, // No triggering run for filtered files
          timestamp: new Date().toISOString(),
        }));
        continue; // Skip processing this file
      }

      // Log warning for missing or incomplete appProperties
      if (!hasAllRequiredFields && detectedFields.length > 0) {
        console.log(JSON.stringify({
          event: "appProperties_incomplete",
          fileId: file.id,
          detectedFields,
          expectedFields: requiredFields,
          action: "proceed",
          timestamp: new Date().toISOString(),
        }));
      } else if (detectedFields.length === 0) {
        console.log(JSON.stringify({
          event: "appProperties_missing",
          fileId: file.id,
          detectedFields: [],
          expectedFields: requiredFields,
          action: "proceed",
          timestamp: new Date().toISOString(),
        }));
      }

      // Skip if file is trashed (double check)
      if (fileMeta.data.trashed) {
        continue;
      }

      // Load trigger for this watch
      const trigger = await prismaClient.trigger.findUnique({
        where: { zapId: watch.zapId },
        select: {
          triggerEvent: true,
          metadata: true,
          type: { select: { name: true } },
        },
      });

      if (!trigger || trigger.type?.name !== "Google drive") {
        continue;
      }

      const meta = (trigger.metadata as any) ?? {};
      const targetFolderId = typeof meta.folderId === "string" ? meta.folderId : "";

      const createdAt = new Date(fileMeta.data.createdTime);
      const timeDiffMinutes = (now - createdAt.getTime()) / (1000 * 60);
      const isNewlyCreated = timeDiffMinutes < 1;
      const modifiedAt = new Date(fileMeta.data.modifiedTime);
      const isUpdated = !isNewlyCreated && now - modifiedAt.getTime() < 60 * 1000;

      const parents: string[] = Array.isArray(fileMeta.data.parents) ? fileMeta.data.parents : [];
      const isInTargetFolder = targetFolderId ? parents.includes(targetFolderId) : false;

      // Evaluate against trigger events
      const ev = (trigger.triggerEvent || "").toLowerCase();

      const shouldCreateForNewFile = ev.includes("new file") && isNewlyCreated;
      const shouldCreateForNewFileInFolder =
        ev.includes("new file in folder") && isNewlyCreated && isInTargetFolder;
      const shouldCreateForNewFolder =
        ev.includes("new folder") && isNewlyCreated && fileMeta.data.mimeType === "application/vnd.google-apps.folder";
      const shouldCreateForUpdatedFile = ev.includes("updated file") && isUpdated && (!targetFolderId || isInTargetFolder);

      const shouldCreate =
        shouldCreateForNewFile ||
        shouldCreateForNewFileInFolder ||
        shouldCreateForNewFolder ||
        shouldCreateForUpdatedFile;

      if (!shouldCreate) {
        continue;
      }

      // Prevent duplicates by checking existing ZapRuns for this file id and event type
      const type = shouldCreateForNewFolder
        ? "new_folder"
        : shouldCreateForNewFileInFolder
        ? "new_file_in_folder"
        : shouldCreateForUpdatedFile
        ? "updated_file"
        : "new_file";

      const existingRun = await prismaClient.zapRun.findFirst({
        where: {
          zapId: watch.zapId,
          metadata: { path: ["driveFileId"], equals: file.id } as any,
        },
      });
      if (existingRun) continue;

      console.log("[Drive] Detected", type, {
        zapId: watch.zapId,
        fileId: file.id,
        name: fileMeta.data.name,
        parents,
        targetFolderId,
      });

      await prismaClient.$transaction(async (tx) => {
        // Check for recursion guard
        const currentRecursionLevel = appProperties.originZapRunId
          ? await tx.zapRun.findUnique({
              where: { id: appProperties.originZapRunId },
              select: { recursionLevel: true },
            }).then(run => run?.recursionLevel || 0)
          : 0;

        const maxAllowedRecursion = 1; // Configurable limit

        if (currentRecursionLevel >= maxAllowedRecursion) {
          console.log(JSON.stringify({
            event: "zaprun_recursion_prevented",
            zapRunId: "pending", // Will be assigned when created
            recursionLevel: currentRecursionLevel + 1,
            maxAllowed: maxAllowedRecursion,
            triggeringFile: file.id,
            timestamp: new Date().toISOString(),
          }));
          return; // Exit early without throwing error
        }

        const run = await tx.zapRun.create({
          data: {
            zapId: watch.zapId,
            recursionLevel: currentRecursionLevel + 1,
            metadata: {
              source: "google_drive",
              type,
              driveFileId: file.id,
              name: fileMeta.data.name,
              mimeType: fileMeta.data.mimeType,
              parents,
              targetFolderId: targetFolderId || undefined,
            },
          },
        });
        await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
      });
    }

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

router.get(
  "/google/folders",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    // @ts-ignore
    const userId = req.id;

    try {
      const googleToken = await prismaClient.google_tokens.findFirst({
        where: { userId },
      });

      if (!googleToken?.access_token) {
        res.status(404).json({ error: "Google access token not found" });
        return;
      }

      const folders = await fetchDriveFolders(googleToken.access_token);
      res.json({ folders });
    } catch (error: any) {
      console.error("Folder fetch error:", error);
      res.status(500).json({ error: error.message || "Server error" });
    }
  }
);

export default router;
