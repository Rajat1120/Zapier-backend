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

  for (const action of actions) {
    const existing = await prismaClient.action.findFirst({
      where: {
        zapId: zapId,
        sortingOrder: action.sortingOrder,
      },
    });

    if (existing) {
      // Update the index if the action exists
      await prismaClient.action.update({
        where: {
          id: existing.id,
        },
        data: {
          index: action.index,
          metadata: action.metadata, // Optional: in case metadata also changes
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

  return res.status(200).json({
    message: "Actions updated/inserted successfully",
  });
});

export const zapRouter = router;
