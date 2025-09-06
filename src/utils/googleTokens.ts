import { prismaClient } from "../db/database";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

export async function getTokenForUser(userId: number) {
  let token = await prismaClient.google_tokens.findUnique({
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

  // Check if token is expired or expires soon (within 5 minutes)
  const now = new Date();
  const expiresThreshold = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes from now

  if (token.expiresAt <= expiresThreshold) {
    console.log(
      `🔄 Token for user ${userId} is expired or expires soon, refreshing...`
    );

    if (!token.refresh_token) {
      throw new Error(`No refresh token available for user ${userId}`);
    }

    try {
      const refreshResponse = await axios.post(
        "https://oauth2.googleapis.com/token",
        new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          refresh_token: token.refresh_token,
          grant_type: "refresh_token",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const { access_token, expires_in } = refreshResponse.data;
      const newExpiresAt = new Date(Date.now() + expires_in * 1000);

      await prismaClient.google_tokens.update({
        where: { userId },
        data: {
          access_token,
          expiresAt: newExpiresAt,
          updatedAt: new Date(),
        },
      });

      // Update local token object
      token.access_token = access_token;
      token.expiresAt = newExpiresAt;

      console.log(`✅ Token refreshed successfully for user ${userId}`);
    } catch (error: any) {
      console.error(
        `❌ Failed to refresh token for user ${userId}:`,
        error.response?.data || error.message
      );
      throw new Error(`Failed to refresh token for user ${userId}`);
    }
  }

  // Parse scopes - handle both string and array formats
  let parsedScopes: string[];

  if (Array.isArray(token.scopes)) {
    parsedScopes = token.scopes;
  } else if (typeof token.scopes === "string") {
    try {
      // Handle cases where scopes might be stored as JSON string
      parsedScopes = JSON.parse(token.scopes);

      // Validate that parsed result is an array
      if (!Array.isArray(parsedScopes)) {
        console.error("Parsed scopes is not an array:", parsedScopes);
        parsedScopes = [];
      }
    } catch (error) {
      console.error(
        "Failed to parse scopes JSON:",
        error,
        "Raw scopes:",
        token.scopes
      );
      // If it fails to parse, treat as a single scope (fallback)
      parsedScopes = [token.scopes];
    }
  } else {
    console.error("Unexpected scopes type:", typeof token.scopes, token.scopes);
    parsedScopes = [];
  }

  console.log(
    `🔑 Retrieved ${parsedScopes.length} scopes for user ${userId}:`,
    parsedScopes
  );

  return {
    ...token,
    scopes: parsedScopes,
  };
}
