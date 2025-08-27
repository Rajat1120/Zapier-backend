import { Router } from "express";
import axios from "axios";
import { prismaClient } from "../db/database";

const router = Router();

// Lists Gmail messages with attachments for the trigger's label, and enqueues new ZapRuns
router.get("/new-attachments/:zapId", async (req, res) => {
  const { zapId } = req.params as { zapId: string };

  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: { metadata: true, zap: { select: { userId: true } } },
    });

    if (!trigger) {
      return res.status(404).json({ message: "Trigger not found" });
    }

    const labelId = (trigger.metadata as any)?.labelId as string | undefined;
    if (!labelId) {
      return res.status(400).json({ message: "Missing labelId in trigger metadata" });
    }

    const userId = trigger.zap.userId;
    const tokenRow = await prismaClient.google_tokens.findUnique({
      where: { userId },
      select: { access_token: true },
    });

    if (!tokenRow?.access_token) {
      return res.status(404).json({ message: "No Google access token" });
    }

    const accessToken = tokenRow.access_token;

    const listRes = await axios.get(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      {
        params: { q: `has:attachment label:${labelId}`, maxResults: 10 },
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    const messages: { id: string; threadId: string }[] = listRes.data?.messages ?? [];

    const created: string[] = [];

    for (const msg of messages) {
      // Dedup by checking existing ZapRun with this gmailMessageId in metadata
      const existing = await prismaClient.zapRun.findFirst({
        where: {
          zapId,
          // Prisma JSON path filter (Postgres): metadata->>'gmailMessageId' = msg.id
          metadata: {
            path: ["gmailMessageId"],
            equals: msg.id,
          } as any,
        },
      });

      if (existing) continue;

      await prismaClient.$transaction(async (tx) => {
        const run = await tx.zapRun.create({
          data: {
            zapId,
            metadata: {
              source: "gmail",
              type: "new_attachment",
              gmailMessageId: msg.id,
              labelId,
            },
          },
        });

        await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
        created.push(msg.id);
      });
    }

    return res.status(200).json({ createdCount: created.length, created });
  } catch (err) {
    console.error("Gmail new-attachments error", err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export default router;


