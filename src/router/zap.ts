import { Router } from "express";
import { authMiddleware } from "../middleware";

const router = Router();

router.post("/", authMiddleware, (req, res) => {});

router.post("/", authMiddleware, (req, res) => {});
router.get("/user", (req, res) => {});
router.get("/:zapId", (req, res) => {});

export const zapRouter = router;
