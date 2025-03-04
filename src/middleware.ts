import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { JWT_PASSWORD } from "./config";

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const token = req.headers.authorization;

  try {
    if (!token) {
      res.status(401).json({
        message: "No token provided",
      });
      return;
    }

    const payload = jwt.verify(token, JWT_PASSWORD);

    // Type assertion to add id to the request
    (req as any).id = (payload as any).id;

    next();
  } catch (e) {
    res.status(403).json({
      message: "You are not logged in",
    });
  }
};
