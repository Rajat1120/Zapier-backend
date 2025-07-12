import { Router } from "express";
import { authMiddleware } from "../middleware";
import { prismaClient } from "../db/database";
import { ZapCreateSchema, ZapUpdateSchema } from "../types/type";

const router = Router();

router.post("/", authMiddleware, async (req, res): Promise<any> => {
  // @ts-ignore
  const id: string = req.id;
  const body = req.body;
  const parsedData = ZapCreateSchema.safeParse(body);

  if (!parsedData.success) {
    return res.status(411).json({
      message: "Incorrect inputs",
    });
  }

  const zapId = await prismaClient.$transaction(async (tx: any) => {
    const zap = await prismaClient.zap.create({
      data: {
        userId: parseInt(id),
        triggerId: "",
        actions: {
          create: parsedData.data.actions.map((x, index) => ({
            actionId: x.availableActionId,
            sortingOrder: +x.sortingOrder,
            metadata: x.actionMetadata,
            index: x.index,
          })),
        },
      },
    });

    if (parsedData.data.availableTriggerId) {
      const trigger = await tx.trigger.create({
        data: {
          triggerId: parsedData.data.availableTriggerId,
          zapId: zap.id,
        },
      });

      await tx.zap.update({
        where: {
          id: zap.id,
        },
        data: {
          triggerId: trigger.id,
        },
      });
    }

    return zap.id;
  });
  return res.json({
    zapId,
  });
});

router.get("/", authMiddleware, async (req, res): Promise<any> => {
  // @ts-ignore
  const id = req.id;
  const zaps = await prismaClient.zap.findMany({
    where: {
      userId: id,
    },
    include: {
      actions: {
        include: {
          type: true,
        },
      },
      trigger: {
        include: {
          type: true,
        },
      },
    },
  });

  return res.json({
    zaps,
  });
});

router.get("/:zapId", authMiddleware, async (req, res): Promise<any> => {
  //@ts-ignore
  const id = req.id;
  const zapId = req.params.zapId;

  const zap = await prismaClient.zap.findFirst({
    where: {
      id: zapId,
      userId: id,
    },
    include: {
      actions: {
        include: {
          type: true,
        },
      },
      trigger: {
        include: {
          type: true,
        },
      },
    },
  });

  return res.json({
    zap,
  });
});

router.post("/:zapId", authMiddleware, async (req, res): Promise<any> => {
  // @ts-ignore
  const userId: string = req.id;
  const body = req.body;
  const parsedData = ZapUpdateSchema.safeParse(body);

  if (!parsedData.success) {
    return res.status(411).json({
      message: "Incorrect update inputs",
    });
  }

  const { zapId, actions } = parsedData.data;

  // Step 1: Get all existing actions for this zap
  const existingActions = await prismaClient.action.findMany({
    where: {
      zapId: zapId,
    },
  });

  // Step 2: Get sortingOrders from the new actions array
  const newSortingOrders = actions.map((action) => action.sortingOrder);

  // Step 3: Find actions that need to be deleted (exist in DB but not in new actions)
  const actionsToDelete = existingActions.filter(
    (existing) => !newSortingOrders.includes(existing.sortingOrder)
  );

  // Step 4: Delete actions that are no longer needed
  if (actionsToDelete.length > 0) {
    await prismaClient.action.deleteMany({
      where: {
        id: {
          in: actionsToDelete.map((action) => action.id),
        },
      },
    });
  }

  // Step 5: Update or create actions from the new actions array
  for (const action of actions) {
    const existing = await prismaClient.action.findFirst({
      where: {
        zapId: zapId,
        sortingOrder: action.sortingOrder,
      },
    });

    if (existing) {
      // Update the existing action
      await prismaClient.action.update({
        where: {
          id: existing.id,
        },
        data: {
          index: action.index,
          metadata: action.metadata,
          actionId: action.actionId,
        },
      });
    } else {
      // Create a new action
      await prismaClient.action.create({
        data: {
          zapId,
          actionId: action.actionId,
          sortingOrder: action.sortingOrder,
          metadata: action.metadata,
          index: action.index,
        },
      });
    }
  }

  // Update the Trigger table if the trigger action (index === 0) exists
  const triggerAction = actions.find((action) => action.index === 0);
  if (triggerAction) {
    const existingTrigger = await prismaClient.trigger.findUnique({
      where: { zapId },
      select: { triggerId: true },
    });

    const dataToUpdate: any = {
      triggerId: triggerAction.actionId || "",
      metadata: triggerAction.metadata,
    };

    // ✅ Only add triggerEvent to update if triggerId changed
    if (
      existingTrigger &&
      existingTrigger.triggerId !== triggerAction.actionId
    ) {
      dataToUpdate.triggerEvent = null;
    }

    await prismaClient.trigger.updateMany({
      where: { zapId },
      data: dataToUpdate,
    });
  }
  return res.status(200).json({
    message: "Actions updated successfully",
  });
});

export const zapRouter = router;
