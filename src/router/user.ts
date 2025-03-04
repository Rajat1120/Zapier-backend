import { JWT_PASSWORD } from "./../config";
import { Router } from "express";
import { SigninSchema, SignupSchema } from "../types/type";
import { prismaClient } from "../db/database";
import jwt from "jsonwebtoken";
import { authMiddleware } from "../middleware";

const router = Router();

router.post("/signup", async (req, res): Promise<any> => {
  const body = req.body;
  const parsedData = SignupSchema.safeParse(body);

  if (!parsedData.success) {
    return res.status(411).json({ message: "Incorrect inputs" });
  }

  const userExist = await prismaClient.user.findFirst({
    where: { email: parsedData.data.username },
  });

  if (userExist) {
    return res.status(403).json({ message: "User already exists" });
  }

  await prismaClient.user.create({
    data: {
      email: parsedData.data.username,
      // TODO: hash password
      password: parsedData.data.password,
      name: parsedData.data.name,
    },
  });

  // await send email verification

  return res.json({
    message: "please verify your account by checking your email",
  });
});

router.post("/signin", async (req, res): Promise<any> => {
  const body = req.body;
  const parsedData = SigninSchema.safeParse(body);

  if (!parsedData.success) {
    return res.status(411).json({ message: "Incorrect inputs" });
  }

  const user = await prismaClient.user.findFirst({
    where: {
      email: parsedData.data.username,
      password: parsedData.data.password,
    },
  });

  if (!user) {
    return res.status(403).json({ message: "User not found" });
  }

  // sign the JWT
  const token = jwt.sign(
    {
      id: user.id,
    },
    JWT_PASSWORD
  );

  res.json({
    token: token,
  });
});

router.get("/", authMiddleware, async (req, res): Promise<any> => {
  // TODO: Fix the type
  // @ts-ignore
  const id = req.id;
  const user = await prismaClient.user.findFirst({
    where: {
      id,
    },
    select: {
      name: true,
      email: true,
    },
  });

  return res.json({
    user,
  });
});

export const userRouter = router;
