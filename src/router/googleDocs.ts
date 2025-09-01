import { Router, Request, Response, RequestHandler } from "express";
import axios from "axios";
import { prismaClient } from "../db/database";
import { getTokenForUser } from "../utils/googleTokens";
import { v4 as uuidv4 } from "uuid";
import { authMiddleware } from "../middleware";
import { fetchDriveFolders } from "../lib/google/drive";

const router = Router();

// In-memory dedupe to avoid duplicate processing for the same file in a short window
const recentlyProcessed = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [key, time] of recentlyProcessed.entries()) {
    if (now - time > 5 * 60 * 1000) {
      recentlyProcessed.delete(key);
    }
  }
}, 5 * 60 * 1000);

async function getAccessTokenForZap(zapId: string): Promise<string | null> {
  const trigger = await prismaClient.trigger.findFirst({
    where: { zapId },
    select: { zap: { select: { userId: true } } },
  });
  if (!trigger) return null;
  const tokenRow = await prismaClient.google_tokens.findUnique({
    where: { userId: trigger.zap.userId },
    select: { access_token: true },
  });
  return tokenRow?.access_token ?? null;
}

// Start a Drive changes watch for Docs (webhook based)
// POST /api/google-docs/watch
router.post("/watch", async (req: Request, res: Response): Promise<any> => {
  const { userId, zapId } = req.body as { userId: number; zapId: string };
  console.log("[Docs] Request to start watch", { userId, zapId });
  
  // Validate BACKEND_URL is set
  if (!process.env.BACKEND_URL) {
    console.error("[Docs] BACKEND_URL environment variable not set");
    return res.status(500).json({ message: "BACKEND_URL not configured" });
  }
  
  try {
    const tokenRecord = await prismaClient.google_tokens.findUnique({
      where: { userId },
      select: { access_token: true },
    });

    if (!tokenRecord?.access_token) {
      console.error("[Docs] No access token found for user", { userId });
      return res.status(400).json({ message: "No access token found" });
    }

    const accessToken = tokenRecord.access_token;
    const channelId = uuidv4();

    // Get the current startPageToken to track changes
    const sptRes = await axios.get(
      "https://www.googleapis.com/drive/v3/changes/startPageToken",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    const webhookUrl = `${process.env.BACKEND_URL}/api/google-docs/webhook`;
    console.log("[Docs] Setting up webhook with URL:", webhookUrl);
    
    const response = await axios.post(
      "https://www.googleapis.com/drive/v3/changes/watch",
      {
        id: channelId,
        type: "web_hook",
        address: webhookUrl,
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        params: {
          pageToken: sptRes.data.startPageToken,
        },
      }
    );

    const { expiration, resourceId } = response.data || {};
    const utcDate = expiration ? new Date(Number(expiration)) : new Date();
    const istDate = new Date(utcDate.getTime() + 5.5 * 60 * 60 * 1000);

    await prismaClient.google_drive_watch.create({
      data: {
        userId,
        channelId,
        resourceId,
        expiration: istDate,
        startPageToken: sptRes.data.startPageToken,
        zapId,
      },
    });

    console.log("[Docs] Watch started", {
      zapId,
      userId,
      channelId,
      resourceId,
    });
    res.status(200).json({ message: "Watch started", data: response.data });
  } catch (error) {
    console.error("[Docs] Error starting Docs watch:", error);
    res.status(500).json({ message: "Failed to start watch" });
  }
});

// Webhook endpoint for Docs (backed by Drive changes)
router.all("/webhook", async (req: Request, res: Response): Promise<any> => {

  // Respond to HEAD requests immediately (Google may verify endpoint)
  if (req.method === "HEAD") {
    res.status(200).end();
    return;
  }

  try {
    const { headers } = req;
    let channelId = headers["x-goog-channel-id"];
    if (Array.isArray(channelId)) channelId = channelId[0];

    const watch = await prismaClient.google_drive_watch.findFirst({
      where: { channelId: channelId as string },
    });

    if (!watch) {
      res.status(404).json({ message: "Watch not found" });
      return;
    }

    const { access_token: accessToken } = await getTokenForUser(watch.userId);
    const pageToken = watch.startPageToken;

    const { data } = await axios.get(
      "https://www.googleapis.com/drive/v3/changes",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          pageToken: pageToken,
          fields:
            "changes(file(id,name,mimeType,trashed,parents,createdTime,modifiedTime)),newStartPageToken",
        },
      }
    );

    for (const change of data.changes || []) {
      const file = change.file;
      const fileId: string | undefined = file?.id;
      if (!fileId) continue;
      
      // Skip trashed/deleted files immediately
      if (file?.trashed) continue;

      // Only process Google Docs
      if (file?.mimeType !== "application/vnd.google-apps.document") continue;

      const now = Date.now();
      const lastSeen = recentlyProcessed.get(fileId);
      if (lastSeen && now - lastSeen < 2 * 60 * 1000) {
        continue;
      }
      recentlyProcessed.set(fileId, now);

      // Fetch detailed metadata to ensure we have parents and timestamps
      const fileMeta = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${file.id}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          params: {
            fields: "createdTime,modifiedTime,name,mimeType,parents,trashed",
          },
        }
      );

      if (fileMeta.data.trashed) continue;

      const trigger = await prismaClient.trigger.findUnique({
        where: { zapId: watch.zapId },
        select: {
          triggerEvent: true,
          metadata: true,
          type: { select: { name: true } },
        },
      });

      if (!trigger || trigger.type?.name !== "Google docs") {
        // This watch might belong to another integration; skip
        continue;
      }

      const meta = (trigger.metadata as any) ?? {};
      const targetFolderId =
        typeof meta.folderId === "string" ? meta.folderId : "";

      const createdAt = new Date(fileMeta.data.createdTime);
      const modifiedAt = new Date(fileMeta.data.modifiedTime);
      const isNewlyCreated = now - createdAt.getTime() < 60 * 1000;
      const isUpdated =
        !isNewlyCreated && now - modifiedAt.getTime() < 60 * 1000;

      const parents: string[] = Array.isArray(fileMeta.data.parents)
        ? fileMeta.data.parents
        : [];
      const isInTargetFolder = targetFolderId
        ? parents.includes(targetFolderId)
        : false;

      const ev = (trigger.triggerEvent || "").toLowerCase();
      
      // Check trigger type first, then apply appropriate logic
      if (ev.includes("new document in folder") || ev.includes("new documents in folder")) {
        // Folder-specific trigger: only trigger if new doc is in specified folder
        if (!isNewlyCreated || !isInTargetFolder) continue;
        var type = "new_document_in_folder";
      } else if (ev.includes("new document")) {
        // General new document trigger: trigger for any new doc
        if (!isNewlyCreated) continue;
        var type = "new_document";
      } else {
        // Not a supported trigger event for new documents
        continue;
      }

      const existingRun = await prismaClient.zapRun.findFirst({
        where: {
          zapId: watch.zapId,
          metadata: { path: ["docsDocumentId"], equals: file.id } as any,
        },
      });
      if (existingRun) continue;

      console.log("[Docs] New document created", {
        name: fileMeta.data.name,
        fileId: file.id,
        folderId: targetFolderId,
        inTargetFolder: isInTargetFolder,
      });

      await prismaClient.$transaction(async (tx) => {
        const run = await tx.zapRun.create({
          data: {
            zapId: watch.zapId,
            metadata: {
              source: "google_docs",
              type,
              docsDocumentId: file.id,
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

    // Update startPageToken for next round
    await prismaClient.google_drive_watch.update({
      where: { channelId: channelId as string },
      data: { startPageToken: (data as any).newStartPageToken },
    });

    res.status(200).json({ message: "Webhook processed" });
  } catch (error) {
    console.error("[Docs] Error processing webhook:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Polling-based detection similar to Slides/Sheets
const pollDocsHandler: RequestHandler<{ zapId: string }> = async (req, res) => {
  const { zapId } = req.params as { zapId: string };
  console.log("[Docs] Running poll handler", { zapId });
  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: {
        metadata: true,
        triggerEvent: true,
        type: { select: { name: true } },
      },
    });
    if (!trigger || trigger.type?.name !== "Google docs") {
      res.status(400).json({ message: "Trigger is not Google Docs" });
      return;
    }

    const meta = (trigger.metadata as any) ?? {};
    const folderId = typeof meta.folderId === "string" ? meta.folderId : "";
    let lastProcessedTs: number =
      typeof meta.lastProcessedTs === "number" ? meta.lastProcessedTs : 0;

    if (!lastProcessedTs) {
      await prismaClient.trigger.update({
        where: { zapId },
        data: {
          metadata: { ...(meta || {}), lastProcessedTs: Date.now() } as any,
        },
      });
      console.log(
        "[Docs] Initialized lastProcessedTs; no backfill on first run"
      );
      res.status(200).json({ createdCount: 0, created: [] });
      return;
    }

    const accessToken = await getAccessTokenForZap(zapId);
    if (!accessToken) {
      res.status(404).json({ message: "No Google access token" });
      return;
    }

    const created: string[] = [];
    const timeMinIso = new Date(lastProcessedTs - 60 * 1000).toISOString();
    const ev = (trigger.triggerEvent || "").toLowerCase();
    const isNewDocInFolderEvent =
      ev.includes("new document in folder") ||
      ev.includes("new documents in folder");
    const isNewDocEvent = ev.includes("new document");
    const isUpdatedDocEvent = ev.includes("updated document");

    const queries: string[] = [];
    if (isNewDocInFolderEvent && folderId) {
      queries.push(
        `mimeType='application/vnd.google-apps.document' and '${folderId}' in parents and trashed=false and createdTime > '${timeMinIso}'`
      );
    } else if (isNewDocEvent) {
      queries.push(
        `mimeType='application/vnd.google-apps.document' and trashed=false and createdTime > '${timeMinIso}'`
      );
    }

    if (isUpdatedDocEvent) {
      queries.push(
        `mimeType='application/vnd.google-apps.document' and trashed=false and modifiedTime > '${timeMinIso}' and createdTime <= '${timeMinIso}'`
      );
    }

    for (const q of queries) {
      const { data } = await axios.get(
        "https://www.googleapis.com/drive/v3/files",
        {
          params: {
            q,
            fields: "files(id,name,mimeType,parents,createdTime,modifiedTime)",
            pageSize: 100,
          },
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      const files = Array.isArray(data.files) ? data.files : [];
      for (const f of files) {
        const existing = await prismaClient.zapRun.findFirst({
          where: {
            zapId,
            metadata: { path: ["docsDocumentId"], equals: f.id } as any,
          },
        });
        if (existing) continue;

        const parents: string[] = Array.isArray(f.parents) ? f.parents : [];
        const isInTargetFolder = folderId ? parents.includes(folderId) : true;

        let type: string = "new_document";
        if (isNewDocInFolderEvent) type = "new_document_in_folder";
        if (isUpdatedDocEvent) type = "updated_document";

        if (isNewDocInFolderEvent && folderId && !isInTargetFolder) continue;

        console.log("[Docs] Detected via poll", type, {
          zapId,
          fileId: f.id,
          name: f.name,
          parents,
          folderId,
        });

        await prismaClient.$transaction(async (tx) => {
          const run = await tx.zapRun.create({
            data: {
              zapId,
              metadata: {
                source: "google_docs",
                type,
                docsDocumentId: f.id,
                name: f.name,
                mimeType: f.mimeType,
                parents,
                targetFolderId: folderId || undefined,
              },
            },
          });
          await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
        });
        created.push(f.id);
      }
    }

    if (created.length > 0) {
      await prismaClient.trigger.update({
        where: { zapId },
        data: {
          metadata: { ...(meta || {}), lastProcessedTs: Date.now() } as any,
        },
      });
    }

    res.status(200).json({ createdCount: created.length, created });
  } catch (err) {
    console.error("[Docs] Poll error", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

router.get("/poll/:zapId", pollDocsHandler);

// Reuse folder listing helper for Docs UI
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
      console.error("[Docs] Folder fetch error:", error);
      res.status(500).json({ error: error.message || "Server error" });
    }
  }
);

export default router;
