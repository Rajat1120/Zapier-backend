import { Router, RequestHandler } from "express";
import axios from "axios";
import type { Prisma } from "@prisma/client";
import { prismaClient } from "../db/database";

const router = Router();

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

// Poll for new Google Slides presentations
const pollSlidesHandler: RequestHandler<{ zapId: string }> = async (req, res) => {
  const { zapId } = req.params as { zapId: string };
  console.log("running google slides poll handler");
  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: { metadata: true, triggerEvent: true, type: { select: { name: true } } },
    });
    if (!trigger || trigger.type?.name !== "Google slides") {
      res.status(400).json({ message: "Trigger is not Google Slides" });
      return;
    }

    const meta = (trigger.metadata as any) ?? {};
    let lastProcessedTs: number = typeof meta.lastProcessedTs === "number" ? meta.lastProcessedTs : 0;

    if (!lastProcessedTs) {
      await prismaClient.trigger.update({ where: { zapId }, data: { metadata: { ...(meta || {}), lastProcessedTs: Date.now() } as any } });
      res.status(200).json({ createdCount: 0, created: [] });
      return;
    }

    const accessToken = await getAccessTokenForZap(zapId);
    if (!accessToken) {
      res.status(404).json({ message: "No Google access token" });
      return;
    }

    // Use Drive files list to find newly created Slides
    const timeMinIso = new Date(lastProcessedTs - 60 * 1000).toISOString();
    const { data } = await axios.get("https://www.googleapis.com/drive/v3/files", {
      params: {
        q: `mimeType='application/vnd.google-apps.presentation' and trashed=false and createdTime > '${timeMinIso}'`,
        fields: "files(id, name, createdTime)",
        pageSize: 100,
      },
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const created: string[] = [];
    const files = Array.isArray(data.files) ? data.files : [];
    for (const f of files) {
      const existing = await prismaClient.zapRun.findFirst({
        where: { zapId, metadata: { path: ["slidesPresentationId"], equals: f.id } as any },
      });
      if (existing) continue;
      console.log("creating new zap run for", f.id);
      await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
        const run = await tx.zapRun.create({
          data: {
            zapId,
            metadata: {
              source: "google_slides",
              type: "new_presentation",
              name: f.name,
              slidesPresentationId: f.id,
              createdTime: f.createdTime,
            },
          },
        });
        await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
        created.push(f.id);
      });
    }

    if (created.length > 0) {
      await prismaClient.trigger.update({ where: { zapId }, data: { metadata: { ...(meta || {}), lastProcessedTs: Date.now() } as any } });
    }

    res.status(200).json({ createdCount: created.length, created });
  } catch (err) {
    console.error("Google Slides poll error", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

router.get("/poll/:zapId", pollSlidesHandler);

export default router;


