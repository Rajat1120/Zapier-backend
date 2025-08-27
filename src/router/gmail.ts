import { Router } from "express";
import type { RequestHandler } from "express";
import type { Prisma } from "@prisma/client";
import axios from "axios";
import { prismaClient } from "../db/database";

const router = Router();

// Lists Gmail messages with attachments for the trigger's label, and enqueues new ZapRuns
const newAttachmentsHandler: RequestHandler<{ zapId: string }> = async (req, res) => {
  const { zapId } = req.params as { zapId: string };

  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: { metadata: true, zap: { select: { userId: true } } },
    });

    if (!trigger) {
      res.status(404).json({ message: "Trigger not found" });
      return;
    }

    const labelId = (trigger.metadata as any)?.labelId as string | undefined;
    if (!labelId) {
      res.status(400).json({ message: "Missing labelId in trigger metadata" });
      return;
    }

    const userId = trigger.zap.userId;
    const tokenRow = await prismaClient.google_tokens.findUnique({
      where: { userId },
      select: { access_token: true },
    });

    if (!tokenRow?.access_token) {
      res.status(404).json({ message: "No Google access token" });
      return;
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

    console.log(messages);

   /*  for (const msg of messages) {
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

      await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
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
    } */

    res.status(200).json({ createdCount: created.length, created });
    return;
  } catch (err) {
    console.error("Gmail new-attachments error", err);
    res.status(500).json({ message: "Internal server error" });
    return;
  }
};

router.get("/new-attachments/:zapId", newAttachmentsHandler);

export default router;


