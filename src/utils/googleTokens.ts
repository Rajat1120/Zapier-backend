import { prismaClient } from "../db/database";

export async function getTokenForUser(userId: number) {
  const token = await prismaClient.google_tokens.findUnique({
    where: { userId },
    select: {
      access_token: true,
      refresh_token: true,
      expiresAt: true,
      scopes: true,
    },
  });

  if (!token) {
    throw new Error(`No Google token found for user ${userId}`);
  }

  return token;
}
