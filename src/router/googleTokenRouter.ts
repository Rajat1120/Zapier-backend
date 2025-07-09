import { Router } from "express";
import { prismaClient } from "../db/database";
import { authMiddleware } from "../middleware";

const router = Router();
interface GoogleTokenPayload {
  access_token: string;
  refresh_token: string;
  scopes: string[];
  expires_in: number;
}

router.post("/", authMiddleware, async (req, res): Promise<any> => {
  //@ts-ignore
  const userId = parseInt(req.id); // coming from auth middleware
  const token: GoogleTokenPayload = req.body;
  const { access_token, refresh_token, scopes, expires_in } = token;

  if (!access_token || !refresh_token || !scopes || !expires_in) {
    return res.status(400).json({ message: "Missing token fields" });
  }

  const existing = await prismaClient.google_tokens.findUnique({
    where: { userId },
    select: { scopes: true },
  });

  const existingScopes = existing?.scopes || [];

  // Merge and deduplicate scopes
  const mergedScopes = Array.from(new Set([...existingScopes, ...scopes]));

  try {
    const expiresAt = new Date(Date.now() + expires_in * 1000);
    const updatedAt = new Date();

    await prismaClient.google_tokens.upsert({
      where: { userId },
      update: {
        access_token,
        refresh_token,
        scopes: mergedScopes,
        expiresAt,
        updatedAt,
      },
      create: {
        userId,
        access_token,
        refresh_token,
        scopes: mergedScopes,
        expiresAt,
        updatedAt,
      },
    });

    return res.status(200).json({ message: "✅ Google tokens saved." });
  } catch (error) {
    console.error("Failed to save tokens:", error);
    return res.status(500).json({ message: "Error saving tokens" });
  }
});

export const googleTokenRouter = router;
