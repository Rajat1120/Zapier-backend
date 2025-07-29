import { Router } from "express";
import { prismaClient } from "../db/database";

const router = Router();

router.get("/available", async (req, res) => {
  const availableTriggers = await prismaClient.availableTriggers.findMany({});
  res.json({
    availableTriggers,
  });
});

router.post("/:zapId", async (req: any, res: any) => {
  const { zapId } = req.params;
  const { triggerEvent, metadata } = req.body;

  if (!triggerEvent || typeof triggerEvent !== "string") {
    return res.status(400).json({ message: "Invalid triggerEvent" });
  }

  try {
    const updated = await prismaClient.trigger.update({
      where: { zapId },
      data: { triggerEvent, metadata },
    });

    await prismaClient.action.updateMany({
      where: { zapId, index: 0 },
      data: { metadata },
    });

    return res.status(200).json({
      message: "✅ Trigger updated",
      trigger: updated,
    });
  } catch (error) {
    console.error("Failed to update trigger:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.post("/metadata/:zapId", async (req: any, res: any) => {
  const { zapId } = req.params;
  const { metadata } = req.body;

  if (!metadata || typeof metadata !== "object") {
    return res.status(400).json({ message: "Invalid metadata" });
  }

  try {
    // Update trigger metadata
    const updatedTrigger = await prismaClient.trigger.update({
      where: { zapId },
      data: { metadata },
    });

    // Update metadata in the action with index 0
    await prismaClient.action.updateMany({
      where: {
        zapId,
        index: 0,
      },
      data: {
        metadata,
      },
    });

    return res.status(200).json({
      message: "✅ Trigger and action metadata updated",
      trigger: updatedTrigger,
    });
  } catch (error) {
    console.error("Failed to update trigger and action metadata:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

router.get("/:zapId", async (req: any, res: any) => {
  const { zapId } = req.params;

  try {
    const event = await prismaClient.trigger.findFirst({
      where: { zapId },
      select: { triggerEvent: true, zapId: true, triggerId: true },
    });

    if (!event) {
      return res.status(404).json({ message: "Trigger not found" });
    }

    res.status(200).json({
      triggerEvent: event.triggerEvent,
      zapId: event.zapId,
      triggerApp: event.triggerId,
    });
  } catch (error) {
    console.error("Failed to fetch trigger:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

export const triggerRouter = router;
