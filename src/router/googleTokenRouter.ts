import { Router } from "express";
import { prismaClient } from "../db/database";
import { authMiddleware } from "../middleware";

const router = Router();
interface GoogleTokenPayload {
  access_token: string;
  refresh_token: string;
  scopes: string[];
  expires_in: number;
  email: string;
}

router.post("/", authMiddleware, async (req, res): Promise<any> => {
  //@ts-ignore
  const userId = parseInt(req.id); // coming from auth middleware
  const token: GoogleTokenPayload = req.body;
  const { access_token, refresh_token, scopes, expires_in, email } = token;

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
  const istOffset = 5.5 * 60 * 60 * 1000; // 5 hours 30 mins in ms
  const expiresAtUTC = new Date(Date.now() + expires_in * 1000);
  const expiresAtIST = new Date(expiresAtUTC.getTime() + istOffset);
  const updatedAtIST = new Date(Date.now() + istOffset);
  try {
    await prismaClient.google_tokens.upsert({
      where: { userId },
      update: {
        access_token,
        refresh_token,
        scopes: mergedScopes,
        expiresAt: expiresAtIST,
        updatedAt: updatedAtIST,
        email,
      },
      create: {
        userId,
        access_token,
        refresh_token,
        scopes: mergedScopes,
        expiresAt: expiresAtIST,
        updatedAt: updatedAtIST,
        email,
      },
    });

    return res.status(200).json({ message: "✅ Google tokens saved." });
  } catch (error) {
    console.error("Failed to save tokens:", error);
    return res.status(500).json({ message: "Error saving tokens" });
  }
});

router.get("/", authMiddleware, async (req, res): Promise<any> => {
  try {
    // @ts-ignore – assuming req.id is added by authMiddleware
    const userId = parseInt(req.id);

    const existing = await prismaClient.google_tokens.findUnique({
      where: { userId },
      select: { scopes: true, email: true },
    });

    if (!existing) {
      return res
        .status(404)
        .json({ message: "No token found for user", scopes: [] });
    }

    return res
      .status(200)
      .json({ scopes: existing.scopes, email: existing.email });
  } catch (error) {
    console.error("Error fetching scopes:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

export const googleTokenRouter = router;
