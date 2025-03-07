import { Router } from "express";
import { prismaClient } from "../db/database";

const router = Router();

router.get("/available", async (req, res) => {
  const availableActions = await prismaClient.availableActions.findMany({});
  res.json({
    availableActions,
  });
});

export const actionRouter = router;
