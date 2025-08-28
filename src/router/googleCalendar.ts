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

// Poll for new Google Calendar events
const pollCalendarHandler: RequestHandler<{ zapId: string }> = async (req, res) => {
  const { zapId } = req.params as { zapId: string };
  console.log("running google calendar poll handler");
  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: { metadata: true, triggerEvent: true, type: { select: { name: true } } },
    });
    if (!trigger || trigger.type?.name !== "Google Calendar") {
      res.status(400).json({ message: "Trigger is not Google Calendar" });
      return;
    }

    const meta = (trigger.metadata as any) ?? {};
    const calendarId = typeof meta.calendarId === "string" ? meta.calendarId : "primary";
    let lastProcessedTs: number = typeof meta.lastProcessedTs === "number" ? meta.lastProcessedTs : 0;

    if (!lastProcessedTs) {
      await prismaClient.trigger.update({ where: { zapId }, data: { metadata: { ...(meta || {}), calendarId, lastProcessedTs: Date.now() } as any } });
      res.status(200).json({ createdCount: 0, created: [] });
      return;
    }

    const accessToken = await getAccessTokenForZap(zapId);
    if (!accessToken) {
      res.status(404).json({ message: "No Google access token" });
      return;
    }

    const timeMin = new Date(lastProcessedTs - 60 * 1000).toISOString();
    const params: any = {
      calendarId,
      singleEvents: true,
      orderBy: "startTime",
      timeMin,
      maxResults: 100,
    };

    const { data } = await axios.get(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      params,
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const created: string[] = [];
    const events = Array.isArray(data.items) ? data.items : [];
    for (const ev of events) {
      if (!ev || !ev.id) continue;
      const existing = await prismaClient.zapRun.findFirst({
        where: { zapId, metadata: { path: ["calendarEventId"], equals: ev.id } as any },
      });
        
      if (existing) continue;

      await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
        const run = await tx.zapRun.create({
          data: {
            zapId,
            metadata: {
              source: "google_calendar",
              type: "new_event",
              calendarId,
              calendarEventId: ev.id,
              summary: ev.summary,
              start: ev.start,
              end: ev.end,
            },
          },
        });
        await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
        created.push(ev.id);
      });
    }

    if (created.length > 0) {
      await prismaClient.trigger.update({ where: { zapId }, data: { metadata: { ...(meta || {}), calendarId, lastProcessedTs: Date.now() } as any } });
    }

    res.status(200).json({ createdCount: created.length, created });
  } catch (err) {
    console.error("Google Calendar poll error", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

router.get("/poll/:zapId", pollCalendarHandler);

export default router;


