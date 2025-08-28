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
    
    // Clean up old worksheetsState if it exists (migration from old approach)
    if (meta.worksheetsState && Object.keys(meta.worksheetsState).length > 0) {
      console.log("[Sheets] Cleaning up old worksheetsState, migrating to timestamp-based approach");
      delete meta.worksheetsState;
    }
    
    // Initialize lastWorksheetCheckTs for existing triggers that don't have it
    if (!meta.lastWorksheetCheckTs && lastProcessedTs > 0) {
      console.log("[Sheets] Initializing lastWorksheetCheckTs for existing trigger");
      // Set it to a bit before lastProcessedTs to catch any worksheets created around that time
      meta.lastWorksheetCheckTs = lastProcessedTs - (5 * 60 * 1000); // 5 minutes before
      console.log("[Sheets] Set lastWorksheetCheckTs to:", new Date(meta.lastWorksheetCheckTs).toISOString());
    }
    
    console.log("[Sheets] Polling with event:", event, "metadata:", meta);

    if (!lastProcessedTs) {
      const initialMetadata = { 
        ...(meta || {}), 
        lastProcessedTs: Date.now(),
        lastWorksheetCheckTs: Date.now() // Initialize worksheet check timestamp too
      };
      await prismaClient.trigger.update({ 
        where: { zapId }, 
        data: { metadata: initialMetadata as any } 
      });
      console.log("[Sheets] Initialized new trigger with timestamps");
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

      console.log("[Sheets] Processing row-based event:", event);
      console.log("[Sheets] Event matching details:", {
        event,
        "event.includes('new or updated spreadsheet row')": event.includes("new or updated spreadsheet row"),
        "event.includes('new spreadsheet row')": event.includes("new spreadsheet row")
      });

      // Read the sheet data across a wide range to capture far columns
      const valuesRes = await getSheetValues(accessToken, spreadsheetId, `${worksheetName}!A:ZZZ`);
      const rows: any[] = Array.isArray(valuesRes.values) ? valuesRes.values : [];
      console.log("[Sheets] Read rows from sheet:", rows.length, "headers:", rows[0]);
      if (rows.length === 0) {
        res.status(200).json({ createdCount: 0, created: [] });
        return;
      }

      const headers: string[] = Array.isArray(rows[0]) ? (rows[0] as string[]) : [];
      const triggerColumnName = meta.triggerColumnName as string | undefined;
      const triggerEventSnapshot = meta.triggerEventSnapshot as string | undefined;
      const headerIndex = triggerColumnName ? headers.findIndex((h) => String(h).trim() === triggerColumnName) : -1;

      // Initialize sheetState snapshot on first run
      const sheetState: Record<string, string> = (meta.sheetState as Record<string, string>) || {};
      let currentRowCount = Math.max(0, rows.length - 1); // exclude header
      const lastRowCount: number = typeof meta.lastRowCount === "number" ? meta.lastRowCount : 0;

      console.log("[Sheets] Initialization check:", {
        lastProcessedTs,
        sheetStateKeys: Object.keys(sheetState).length,
        currentRowCount,
        lastRowCount,
        condition: !lastProcessedTs || (Object.keys(sheetState).length === 0 && lastRowCount === 0),
        "meta.sheetState": meta.sheetState,
        "meta.sheetState type": typeof meta.sheetState,
        "meta.sheetState keys": meta.sheetState ? Object.keys(meta.sheetState) : "undefined"
      });

      // Only treat as initialization if we have no timestamp OR if we have no sheetState AND no lastRowCount
      // This prevents treating a trigger with existing data as "new"
      if (!lastProcessedTs || (Object.keys(sheetState).length === 0 && lastRowCount === 0)) {
        console.log("[Sheets] Building initial snapshot - returning early");
        // Build initial snapshot without emitting
        for (let i = 1; i < rows.length; i++) {
          const rowKey = `${spreadsheetId}:${worksheetName}:${i + 1}`;
          if (headerIndex >= 0) {
            const valueAtColumn = (rows[i][headerIndex] ?? "").toString();
            sheetState[rowKey] = valueAtColumn;
          }
        }
        
        console.log("[Sheets] Built sheetState snapshot:", {
          sheetStateKeys: Object.keys(sheetState).length,
          sampleKeys: Object.keys(sheetState).slice(0, 3),
          sampleValues: Object.values(sheetState).slice(0, 3)
        });
        
        const updateData = { 
          metadata: { 
            ...(meta || {}), 
            lastProcessedTs: Date.now(), 
            sheetState, 
            lastRowCount: currentRowCount 
          } as any 
        };
        
        console.log("[Sheets] Updating database with:", {
          lastProcessedTs: updateData.metadata.lastProcessedTs,
          sheetStateKeys: Object.keys(updateData.metadata.sheetState).length,
          lastRowCount: updateData.metadata.lastRowCount
        });
        
        await prismaClient.trigger.update({
          where: { zapId },
          data: updateData,
        });
        
        console.log("[Sheets] Database update completed");
        res.status(200).json({ createdCount: 0, created: [] });
        return;
      }

      console.log("[Sheets] Continuing with event processing...");

      if (event.includes("new or updated spreadsheet row")) {
        console.log("[Sheets] Processing 'new or updated spreadsheet row' event");
        if (!triggerColumnName || headerIndex < 0) {
          res.status(400).json({ message: "Missing or invalid triggerColumnName in metadata" });
          return;
        }
        console.log("[Sheets] Row update check", { zapId, spreadsheetId, worksheetName, header: triggerColumnName });
        for (let i = 1; i < rows.length; i++) { // skip header row
          const row = rows[i];
          const rowKey = `${spreadsheetId}:${worksheetName}:${i + 1}`;
          const newValue = (row[headerIndex] ?? "").toString();
          const prevValue = sheetState[rowKey];
          const isNewRow = !(rowKey in sheetState);
          const isUpdated = prevValue !== undefined && prevValue !== newValue;
          if (isNewRow || isUpdated) {
            console.log(
              "[Sheets] Detected",
              isNewRow ? "new row" : "updated row",
              {
                zapId,
                spreadsheetId,
                worksheetName,
                rowKey,
                header: triggerColumnName,
                previous: prevValue,
                current: newValue,
              }
            );
            await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
              const run = await tx.zapRun.create({
                data: {
                  zapId,
                  metadata: {
                    source: "google_sheets",
                    type: "new_or_updated_row",
                    sheetRowKey: rowKey,
                    spreadsheetId,
                    worksheetName,
                    rowNumber: i + 1,
                    header: triggerColumnName,
                    value: newValue,
                    values: row,
                  },
                },
              });
              await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
              created.push(rowKey);
            });
            // Update snapshot
            sheetState[rowKey] = newValue;
          }
        }
      } else if (event.includes("new spreadsheet row")) {
        console.log("[Sheets] Processing 'new spreadsheet row' event");
        const lastRowCount: number = typeof meta.lastRowCount === "number" ? meta.lastRowCount : 0;
        console.log("[Sheets] New row check", { zapId, spreadsheetId, worksheetName, lastRowCount, currentRowCount });
        console.log("[Sheets] Row count comparison - lastRowCount:", lastRowCount, "currentRowCount:", currentRowCount, "difference:", currentRowCount - lastRowCount);
        console.log("[Sheets] Condition check - currentRowCount > lastRowCount:", currentRowCount, ">", lastRowCount, "=", currentRowCount > lastRowCount);
        
        if (currentRowCount > lastRowCount) {
          console.log("[Sheets] Processing new rows from index", lastRowCount + 1, "to", currentRowCount);
          for (let i = lastRowCount + 1; i <= currentRowCount; i++) {
            const rowIndex = i; // 1-based for data rows
            const row = rows[rowIndex];
            const rowKey = `${spreadsheetId}:${worksheetName}:${rowIndex + 1}`;
            console.log("[Sheets] Detected new row", { zapId, spreadsheetId, worksheetName, rowKey, headers, values: row });
            await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
              const run = await tx.zapRun.create({
                data: {
                  zapId,
                  metadata: {
                    source: "google_sheets",
                    type: "new_row",
                    sheetRowKey: rowKey,
                    spreadsheetId,
                    worksheetName,
                    rowNumber: rowIndex + 1,
                    headers,
                    values: row,
                  },
                },
              });
              await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
              created.push(rowKey);
              console.log("[Sheets] Added to created array:", rowKey, "created.length now:", created.length);
            });
          }
        } else {
          console.log("[Sheets] No new rows detected - current count not greater than last count");
        }
        // Update lastRowCount snapshot
        (meta as any).lastRowCount = currentRowCount;
        console.log("[Sheets] Updated lastRowCount to:", currentRowCount);
      } else {
        console.log("[Sheets] Event not matched - event:", event);
      }

      // Persist updated snapshots and watermark
      const finalMetadata = { ...(meta || {}), sheetState, lastProcessedTs: Date.now() };
      console.log("[Sheets] Final metadata being saved:", {
        lastProcessedTs: finalMetadata.lastProcessedTs,
        lastRowCount: finalMetadata.lastRowCount,
        sheetStateKeys: Object.keys(finalMetadata.sheetState || {}).length,
        lastWorksheetCheckTs: finalMetadata.lastWorksheetCheckTs ? new Date(finalMetadata.lastWorksheetCheckTs).toISOString() : 'not set'
      });
      
      await prismaClient.trigger.update({
        where: { zapId },
        data: { metadata: finalMetadata as any },
      });
      console.log("[Sheets] Updated trigger metadata with new lastRowCount:", currentRowCount);
      console.log("[Sheets] Final created array state:", { createdCount: created.length, created });
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

      const targetWorksheetName = typeof meta.worksheetName === "string" ? meta.worksheetName : undefined;
      const lastWorksheetCheckTs: number = typeof meta.lastWorksheetCheckTs === "number" ? meta.lastWorksheetCheckTs : 0;

      console.log("[Sheets] Checking for new worksheets since:", new Date(lastWorksheetCheckTs).toISOString());

      const sheet = await getSpreadsheet(accessToken, spreadsheetId);
      const sheets = Array.isArray(sheet.sheets) ? sheet.sheets : [];
      
      console.log("[Sheets] Found", sheets.length, "worksheets in spreadsheet");
      
      for (const s of sheets) {
        const title = s?.properties?.title as string | undefined;
        const sheetId = s?.properties?.sheetId as number | undefined;
        const updatedTime = s?.properties?.updatedTime as string | undefined;
        
        if (!title || sheetId === undefined || !updatedTime) {
          console.log("[Sheets] Skipping worksheet due to missing data:", { title, sheetId, updatedTime });
          continue;
        }
        if (targetWorksheetName && title !== targetWorksheetName) {
          console.log("[Sheets] Skipping worksheet due to name filter:", { title, targetWorksheetName });
          continue;
        }

        // Check if this worksheet was updated after our last check
        const worksheetUpdatedTs = new Date(updatedTime).getTime();
        console.log("[Sheets] Checking worksheet:", { 
          title, 
          updatedTime, 
          worksheetUpdatedTs, 
          lastWorksheetCheckTs,
          isNewer: worksheetUpdatedTs > lastWorksheetCheckTs,
          timeDiff: worksheetUpdatedTs - lastWorksheetCheckTs
        });
        
        if (worksheetUpdatedTs <= lastWorksheetCheckTs) {
          console.log("[Sheets] Skipping worksheet - not updated since last check:", title);
          continue;
        }

        console.log("[Sheets] Detected new/updated worksheet", { 
          zapId, 
          spreadsheetId, 
          worksheetName: title, 
          sheetId, 
          updatedTime,
          lastCheck: new Date(lastWorksheetCheckTs).toISOString(),
          worksheetUpdate: new Date(worksheetUpdatedTs).toISOString()
        });
        
        await prismaClient.$transaction(async (tx: Prisma.TransactionClient) => {
          const run = await tx.zapRun.create({
            data: {
              zapId,
              metadata: {
                source: "google_sheets",
                type: "new_worksheet",
                worksheetKey: `${spreadsheetId}:${title}`,
                spreadsheetId,
                worksheetName: title,
                sheetId,
                updatedTime,
              },
            },
          });
          await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
        });
        
        created.push(`${spreadsheetId}:${title}`);
      }

      // Store only the timestamp, not the entire state
      (meta as any).lastWorksheetCheckTs = Date.now();
      console.log("[Sheets] Updated lastWorksheetCheckTs to:", new Date(Date.now()).toISOString());
      
      // If we didn't find any new worksheets by timestamp, let's also check if there are any
      // worksheets that we haven't processed before by checking the database
      if (created.length === 0) {
        console.log("[Sheets] No worksheets found by timestamp, checking for unprocessed worksheets...");
        
        for (const s of sheets) {
          const title = s?.properties?.title as string | undefined;
          const sheetId = s?.properties?.sheetId as number | undefined;
          
          if (!title || sheetId === undefined) continue;
          if (targetWorksheetName && title !== targetWorksheetName) continue;
          
          const wsKey = `${spreadsheetId}:${title}`;
          
          // Check if we've already processed this worksheet
          const existing = await prismaClient.zapRun.findFirst({
            where: {
              zapId,
              metadata: {
                path: ["worksheetKey"],
                equals: wsKey
              } as any
            }
          });
          
          if (!existing) {
            console.log("[Sheets] Found unprocessed worksheet via database check:", { title, wsKey });
            
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
                    detectedVia: "database_check"
                  },
                },
              });
              await tx.zapRunOutbox.create({ data: { zapRunId: run.id } });
            });
            
            created.push(wsKey);
          }
        }
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


