import axios from "axios";
import { prismaClient } from "../db/database";
import dotenv from "dotenv";
import qs from "querystring";

dotenv.config();

export async function refreshGoogleTokens() {
  const users = await prismaClient.google_tokens.findMany({
    where: {
      expiresAt: {
        lt: new Date(Date.now() + 59 * 60 * 1000), // expires in next 5 mins
      },
    },
  });

  console.log("🔍 Tokens expiring soon:", users.length);

  for (const user of users) {
    if (!user.refresh_token) continue;

    try {
      const res = await axios.post(
        "https://oauth2.googleapis.com/token",
        qs.stringify({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: user.refresh_token,
          grant_type: "refresh_token",
        }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
        }
      );

      const { access_token, expires_in } = res.data;
      const istOffset = 5.5 * 60 * 60 * 1000;
      const expiresAt = new Date(Date.now() + expires_in * 1000 + istOffset);

      await prismaClient.google_tokens.update({
        where: { userId: user.userId },
        data: {
          access_token,
          expiresAt,
          updatedAt: new Date(Date.now() + istOffset),
        },
      });

      console.log(`✅ Refreshed token for user ${user.userId}`);
    } catch (err) {
      console.error(`❌ Failed to refresh token for user ${user.userId}`, err);
    }
  }
}
