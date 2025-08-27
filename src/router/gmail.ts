import { Router } from "express";
import type { RequestHandler } from "express";
import type { Prisma } from "@prisma/client";
import axios from "axios";
import { prismaClient } from "../db/database";

const router = Router();

// Helpers
const systemLabels = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "IMPORTANT",
  "STARRED",
  "UNREAD",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  "CATEGORY_PROMOTIONS",
]);

function buildLabelFilter(labelId: string): string {
  const isSystem = systemLabels.has(String(labelId).toUpperCase());
  return isSystem ? `in:${String(labelId).toLowerCase()}` : `label:${labelId}`;
}

async function getAccessTokenForZap(zapId: string): Promise<string | null> {
  const trigger = await prismaClient.trigger.findFirst({
    where: { zapId },
    select: { zap: { select: { userId: true } } },
  });
  if (!trigger) return null;
  const userId = trigger.zap.userId;
  const tokenRow = await prismaClient.google_tokens.findUnique({
    where: { userId },
    select: { access_token: true },
  });
  return tokenRow?.access_token ?? null;
}

// Lists Gmail messages with attachments for the trigger's label, and enqueues new ZapRuns
const newAttachmentsHandler: RequestHandler<{ zapId: string }> = async (req, res) => {
  const { zapId } = req.params as { zapId: string };

  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: { metadata: true, zap: { select: { userId: true } } },
    });

    console.log("running new attachments handler");
    

    if (!trigger) {
      res.status(404).json({ message: "Trigger not found" });
      return;
    }

    const meta = (trigger.metadata as any) ?? {};
    const labelId = meta?.labelId as string | undefined;
    if (!labelId) {
      res.status(400).json({ message: "Missing labelId in trigger metadata" });
      return;
    }

    let lastProcessedTs = typeof meta.lastProcessedTs === "number" ? meta.lastProcessedTs : 0;
    // First run: initialize watermark to now so we don't backfill old emails
    if (!lastProcessedTs) {
      await prismaClient.trigger.update({
        where: { zapId },
        data: {
          metadata: {
            ...(meta || {}),
            labelId,
            lastProcessedTs: Date.now(),
          } as any,
        },
      });
      // Nothing to process on initial setup
      console.log([]);
      res.status(200).json({ createdCount: 0, created: [] });
      return;
    }
    const safetyWindowMs = 60 * 1000; // 60 seconds safety window
    const afterUnix = lastProcessedTs > 0 ? Math.floor((lastProcessedTs - safetyWindowMs) / 1000) : 0;

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

    const created: string[] = [];
    let pageToken: string | undefined = undefined;
    // Build label filter: system labels use in:<label>, custom labels use label:<id or name>
    const labelFilter = buildLabelFilter(labelId);

    // Ensure we never query with a future 'after'
    const nowUnix = Math.floor(Date.now() / 1000);
    const safeAfterUnix = afterUnix > 0 && afterUnix < nowUnix ? afterUnix : 0;

    const baseQuery = `has:attachment ${labelFilter}` + (safeAfterUnix > 0 ? ` after:${safeAfterUnix}` : "");

    console.log(baseQuery);
    
    do {
      const listRes: {
        data: {
          messages?: { id: string; threadId: string }[];
          nextPageToken?: string;
        };
      } = await axios.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
        params: { q: baseQuery, maxResults: 100, pageToken },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const rawMessages: { id: string; threadId: string }[] = listRes.data?.messages ?? [];
      pageToken = listRes.data?.nextPageToken;
      // Filter only brand-new messages (not already processed)
      const messages: { id: string; threadId: string }[] = [];
      for (const msg of rawMessages) {
        const existing = await prismaClient.zapRun.findFirst({
          where: {
            zapId,
            metadata: {
              path: ["gmailMessageId"],
              equals: msg.id,
            } as any,
          },
        });
        if (!existing) messages.push(msg);
      }

      console.log( "messages", messages);

      // Enqueue Zaps for new-only messages
      for (const msg of messages) {
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
      } 
    } while (pageToken);

    // Fallback: if nothing found with 'after', query recent window and filter by internalDate
    if (created.length === 0 && safeAfterUnix > 0) {
      const fallbackQuery = `has:attachment ${labelFilter} newer_than:7d`;
      let fbPageToken: string | undefined = undefined;
      do {
        const fbList: { data: { messages?: { id: string; threadId: string }[]; nextPageToken?: string } } =
          await axios.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
            params: { q: fallbackQuery, maxResults: 50, pageToken: fbPageToken },
            headers: { Authorization: `Bearer ${accessToken}` },
          });

        const fbMessages = fbList.data?.messages ?? [];
        fbPageToken = fbList.data?.nextPageToken;

        // Fetch details to check internalDate
        const candidates: { id: string; threadId: string }[] = [];
        for (const m of fbMessages) {
          try {
            const detail: { data: { id: string; threadId: string; internalDate?: string } } = await axios.get(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}`,
              { params: { format: "metadata" }, headers: { Authorization: `Bearer ${accessToken}` } }
            );
            const internalMs = Number(detail.data?.internalDate ?? 0);
            if (internalMs > lastProcessedTs) {
              // Ensure not already processed
              const existing = await prismaClient.zapRun.findFirst({
                where: {
                  zapId,
                  metadata: { path: ["gmailMessageId"], equals: m.id } as any,
                },
              });
              if (!existing) candidates.push({ id: m.id, threadId: m.threadId });
            }
          } catch {}
        }

        if (candidates.length > 0) {
          console.log(candidates);
          for (const msg of candidates) {
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
          }
          break; // Stop after first batch of new items found
        }
      } while (fbPageToken);
    }

    // Update watermark for next polling run only if we processed any new messages
    if (created.length > 0) {
      await prismaClient.trigger.update({
        where: { zapId },
        data: {
          metadata: {
            ...(meta || {}),
            labelId,
            lastProcessedTs: Date.now(),
          } as any,
        },
      });
    }

    res.status(200).json({ createdCount: created.length, created });
    return;
  } catch (err) {
    console.error("Gmail new-attachments error", err);
    res.status(500).json({ message: "Internal server error" });
    return;
  }
};

router.get("/new-attachments/:zapId", newAttachmentsHandler);

// Lists Gmail messages for the trigger's label, and enqueues new ZapRuns for new emails
const newEmailsHandler: RequestHandler<{ zapId: string }> = async (req, res) => {
  const { zapId } = req.params as { zapId: string };
  console.log("running new emails handler");
  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: { metadata: true, zap: { select: { userId: true } } },
    });
    if (!trigger) {
      res.status(404).json({ message: "Trigger not found" });
      return;
    }

    const meta = (trigger.metadata as any) ?? {};
    const labelId = meta?.labelId as string | undefined;
    if (!labelId) {
      res.status(400).json({ message: "Missing labelId in trigger metadata" });
      return;
    }

    let lastProcessedTs = typeof meta.lastProcessedTs === "number" ? meta.lastProcessedTs : 0;
    if (!lastProcessedTs) {
      await prismaClient.trigger.update({
        where: { zapId },
        data: { metadata: { ...(meta || {}), labelId, lastProcessedTs: Date.now() } as any },
      });
      res.status(200).json({ createdCount: 0, created: [] });
      return;
    }

    const accessToken = await getAccessTokenForZap(zapId);
    if (!accessToken) {
      res.status(404).json({ message: "No Google access token" });
      return;
    }

    const safetyWindowMs = 60 * 1000;
    const afterUnix = lastProcessedTs > 0 ? Math.floor((lastProcessedTs - safetyWindowMs) / 1000) : 0;
    const nowUnix = Math.floor(Date.now() / 1000);
    const safeAfterUnix = afterUnix > 0 && afterUnix < nowUnix ? afterUnix : 0;

    const labelFilter = buildLabelFilter(labelId);
    const baseQuery = `${labelFilter}` + (safeAfterUnix > 0 ? ` after:${safeAfterUnix}` : "");

    const created: string[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const listRes: { data: { messages?: { id: string; threadId: string }[]; nextPageToken?: string } } =
        await axios.get("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
          params: { q: baseQuery, maxResults: 100, pageToken },
          headers: { Authorization: `Bearer ${accessToken}` },
        });

      const rawMessages = listRes.data?.messages ?? [];
      pageToken = listRes.data?.nextPageToken;

      const messages: { id: string; threadId: string }[] = [];
      for (const msg of rawMessages) {
        const existing = await prismaClient.zapRun.findFirst({
          where: { zapId, metadata: { path: ["gmailMessageId"], equals: msg.id } as any },
        });
        if (!existing) messages.push(msg);
      }

      console.log("messages", messages);

      for (const msg of messages) {
        await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
          const run = await tx.zapRun.create({
            data: {
              zapId,
              metadata: { source: "gmail", type: "new_email", gmailMessageId: msg.id, labelId },
            },
          });
          await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
          created.push(msg.id);
        });
      }
    } while (pageToken);

    if (created.length > 0) {
      await prismaClient.trigger.update({
        where: { zapId },
        data: { metadata: { ...(meta || {}), labelId, lastProcessedTs: Date.now() } as any },
      });
    }

    res.status(200).json({ createdCount: created.length, created });
  } catch (err) {
    console.error("Gmail new-emails error", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

router.get("/new-emails/:zapId", newEmailsHandler);

// Lists Gmail threads for the trigger's label, and enqueues ZapRuns for brand-new conversations
const newConversationsHandler: RequestHandler<{ zapId: string }> = async (req, res) => {
  const { zapId } = req.params as { zapId: string };
  console.log("running new conversations handler");
  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: { metadata: true, zap: { select: { userId: true } } },
    });
    if (!trigger) {
      res.status(404).json({ message: "Trigger not found" });
      return;
    }

    const meta = (trigger.metadata as any) ?? {};
    const labelId = meta?.labelId as string | undefined;
    if (!labelId) {
      res.status(400).json({ message: "Missing labelId in trigger metadata" });
      return;
    }

    let lastProcessedTs = typeof meta.lastProcessedTs === "number" ? meta.lastProcessedTs : 0;
    if (!lastProcessedTs) {
      await prismaClient.trigger.update({
        where: { zapId },
        data: { metadata: { ...(meta || {}), labelId, lastProcessedTs: Date.now() } as any },
      });
      res.status(200).json({ createdCount: 0, created: [] });
      return;
    }

    const accessToken = await getAccessTokenForZap(zapId);
    if (!accessToken) {
      res.status(404).json({ message: "No Google access token" });
      return;
    }

    const safetyWindowMs = 60 * 1000;
    const afterUnix = lastProcessedTs > 0 ? Math.floor((lastProcessedTs - safetyWindowMs) / 1000) : 0;
    const nowUnix = Math.floor(Date.now() / 1000);
    const safeAfterUnix = afterUnix > 0 && afterUnix < nowUnix ? afterUnix : 0;

    const labelFilter = buildLabelFilter(labelId);
    const baseQuery = `${labelFilter}` + (safeAfterUnix > 0 ? ` after:${safeAfterUnix}` : "");

    const created: string[] = [];
    let pageToken: string | undefined = undefined;
    do {
      const listRes: { data: { threads?: { id: string }[]; nextPageToken?: string } } = await axios.get(
        "https://gmail.googleapis.com/gmail/v1/users/me/threads",
        { params: { q: baseQuery, maxResults: 100, pageToken }, headers: { Authorization: `Bearer ${accessToken}` } }
      );

      const rawThreads = listRes.data?.threads ?? [];
      pageToken = listRes.data?.nextPageToken;

      for (const th of rawThreads) {
        // Ensure not already processed
        const existing = await prismaClient.zapRun.findFirst({
          where: { zapId, metadata: { path: ["gmailThreadId"], equals: th.id } as any },
        });
        if (existing) continue;

        try {
          const detail: { data: { id: string; messages?: { id: string; internalDate?: string }[] } } = await axios.get(
            `https://gmail.googleapis.com/gmail/v1/users/me/threads/${th.id}`,
            { params: { format: "metadata" }, headers: { Authorization: `Bearer ${accessToken}` } }
          );
          const messages = detail.data?.messages ?? [];
          if (messages.length === 0) continue;
          const first = messages[0];
          const internalMs = Number(first.internalDate ?? 0);
          console.log("messages", messages);
          
          
          // Consider as a new conversation if it's the first message in the thread
          // and it's newer than our watermark (with safety window handled in query)
          if (messages.length === 1 && internalMs > lastProcessedTs) {
            console.log("new conversation", internalMs, lastProcessedTs);
            
            await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
              const run = await tx.zapRun.create({
                data: {
                  zapId,
                  metadata: {
                    source: "gmail",
                    type: "new_conversation",
                    gmailThreadId: detail.data.id,
                    gmailMessageId: first.id,
                    labelId,
                  },
                },
              });
              await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
              created.push(detail.data.id);
            });
          }
        } catch {}
      }
    } while (pageToken);

    if (created.length > 0) {
      await prismaClient.trigger.update({
        where: { zapId },
        data: { metadata: { ...(meta || {}), labelId, lastProcessedTs: Date.now() } as any },
      });
    }

    res.status(200).json({ createdCount: created.length, created });
  } catch (err) {
    console.error("Gmail new-conversations error", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

router.get("/new-conversations/:zapId", newConversationsHandler);

// Unified polling endpoint that routes based on triggerEvent for Gmail
const gmailPollHandler: RequestHandler<{ zapId: string }> = async (req, res) => {
  const { zapId } = req.params as { zapId: string };
  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: {
        triggerEvent: true,
        type: { select: { name: true } },
      },
    });

    if (!trigger) {
      res.status(404).json({ message: "Trigger not found" });
      return;
    }
    if (trigger.type?.name !== "Gmail") {
      res.status(400).json({ message: "Trigger is not Gmail" });
      return;
    }

    const event = (trigger.triggerEvent || "").toLowerCase();
    const noopNext = (() => {}) as any;
    // Delegate by event
    if (event.includes("attachment")) {
      return newAttachmentsHandler(req, res, noopNext);
    }
    if (event.includes("conversation")) {
      return newConversationsHandler(req, res, noopNext);
    }
    if (event.includes("email")) {
      return newEmailsHandler(req, res, noopNext);
    }

    res.status(400).json({ message: "Unsupported Gmail triggerEvent" });
  } catch (err) {
    console.error("Gmail poll error", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

router.get("/poll/:zapId", gmailPollHandler);

export default router;


