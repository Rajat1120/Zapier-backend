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

// Helper to get spreadsheet metadata and sheets
async function getSpreadsheet(accessToken: string, spreadsheetId: string) {
  const { data } = await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` , {
    headers: { Authorization: `Bearer ${accessToken}` },
    params: { includeGridData: false },
  });
  return data;
}

// Helper to read values from a sheet range
async function getSheetValues(accessToken: string, spreadsheetId: string, range: string) {
  const { data } = await axios.get(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}` , {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return data;
}

// Poll for Google Sheets triggers
const pollSheetsHandler: RequestHandler<{ zapId: string }> = async (req, res) => {
  const { zapId } = req.params as { zapId: string };
  console.log("running google sheets poll handler");
  try {
    const trigger = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: { metadata: true, triggerEvent: true, type: { select: { name: true } } },
    });
    if (!trigger || trigger.type?.name !== "Google sheets") {
      res.status(400).json({ message: "Trigger is not Google Sheets" });
      return;
    }

    const event = (trigger.triggerEvent || "").toLowerCase();
    const meta = (trigger.metadata as any) ?? {};
    const spreadsheetId = meta.spreadsheetId as string | undefined;
    const worksheetName = meta.worksheetName as string | undefined; // for row events
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

    const created: string[] = [];

    if (event.includes("new or updated spreadsheet row") || event.includes("new spreadsheet row")) {
      if (!spreadsheetId || !worksheetName) {
        res.status(400).json({ message: "Missing spreadsheetId or worksheetName in trigger metadata" });
        return;
      }

      // Read the whole sheet (optimize later with valueRenderOption/majorDimension)
      const valuesRes = await getSheetValues(accessToken, spreadsheetId, `${worksheetName}!A:Z`);
      const rows: any[] = Array.isArray(valuesRes.values) ? valuesRes.values : [];

      for (let i = 1; i < rows.length; i++) { // skip header row
        const row = rows[i];
        const rowKey = `${spreadsheetId}:${worksheetName}:${i + 1}`;
        const existing = await prismaClient.zapRun.findFirst({
          where: { zapId, metadata: { path: ["sheetRowKey"], equals: rowKey } as any },
        });
        if (existing) continue;

        await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
          const run = await tx.zapRun.create({
            data: {
              zapId,
              metadata: {
                source: "google_sheets",
                type: event.includes("updated") ? "new_or_updated_row" : "new_row",
                sheetRowKey: rowKey,
                spreadsheetId,
                worksheetName,
                rowNumber: i + 1,
                values: row,
              },
            },
          });
          await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
          created.push(rowKey);
        });
      }
    } else if (event.includes("new spreadsheet")) {
      // Use Drive to find newly created spreadsheets
      const timeMin = new Date(lastProcessedTs - 60 * 1000).toISOString();
      const { data } = await axios.get("https://www.googleapis.com/drive/v3/files", {
        params: {
          q: `mimeType='application/vnd.google-apps.spreadsheet' and trashed=false and createdTime > '${timeMin}'`,
          fields: "files(id, name, createdTime)",
          pageSize: 100,
        },
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const files = Array.isArray(data.files) ? data.files : [];
      for (const f of files) {
        const existing = await prismaClient.zapRun.findFirst({
          where: { zapId, metadata: { path: ["spreadsheetId"], equals: f.id } as any },
        });
        if (existing) continue;
        await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
          const run = await tx.zapRun.create({
            data: {
              zapId,
              metadata: {
                source: "google_sheets",
                type: "new_spreadsheet",
                spreadsheetId: f.id,
                name: f.name,
                createdTime: f.createdTime,
              },
            },
          });
          await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
        });
        created.push(f.id);
      }
    } else if (event.includes("new worksheet")) {
      if (!spreadsheetId) {
        res.status(400).json({ message: "Missing spreadsheetId in trigger metadata" });
        return;
      }

      const sheet = await getSpreadsheet(accessToken, spreadsheetId);
      const sheets = Array.isArray(sheet.sheets) ? sheet.sheets : [];
      for (const s of sheets) {
        const title = s?.properties?.title as string | undefined;
        const sheetId = s?.properties?.sheetId as number | undefined;
        if (!title || sheetId === undefined) continue;
        const wsKey = `${spreadsheetId}:${title}`;
        const existing = await prismaClient.zapRun.findFirst({
          where: { zapId, metadata: { path: ["worksheetKey"], equals: wsKey } as any },
        });
        console.log("existing", existing);
        if (existing) continue;
        await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
          const run = await tx.zapRun.create({
            data: {
              zapId,
              metadata: {
                source: "google_sheets",
                type: "new_worksheet",
                worksheetKey: wsKey,
                spreadsheetId,
                worksheetName: title,
                sheetId,
              },
            },
          });
          await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
        });
        created.push(wsKey);
      }
    }

    if (created.length > 0) {
      console.log("created", created);
      await prismaClient.trigger.update({ where: { zapId }, data: { metadata: { ...(meta || {}), lastProcessedTs: Date.now() } as any } });
    }

    res.status(200).json({ createdCount: created.length, created });
  } catch (err) {
    console.error("Google Sheets poll error", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

router.get("/poll/:zapId", pollSheetsHandler);

export default router;


