// cron/refreshDriveWatches.ts
import axios from "axios";
import { randomUUID } from "crypto";
import { prismaClient } from "../db/database";
import { getTokenForUser } from "../utils/googleTokens";

export async function refreshDriveWatches() {
  console.log("⏳ Running Drive Watch Refresher...");
  console.log(`📅 Current server time: ${new Date().toISOString()}`);

  // Calculate time with buffer (increased to 6 hours for better coverage)
  const bufferInMs = 6 * 60 * 60 * 1000; // 6 hours
  const currentTime = new Date();
  const bufferExpiry = new Date(currentTime.getTime() + bufferInMs);
  
  console.log(`🔍 Looking for watches expiring before: ${bufferExpiry.toISOString()}`);

  // Enhanced debug information
  console.log("\n🔍 Debug Information:");
  console.log(`Current server time (UTC): ${currentTime.toISOString()}`);
  console.log(`Buffer expiry time (UTC): ${bufferExpiry.toISOString()}`);
  console.log(`Buffer duration: ${bufferInMs / (60 * 1000)} minutes`);

  // Check your specific watch for debugging
  const debugWatch = await prismaClient.google_drive_watch.findFirst({
    where: {
      id: '5b5aa377-056d-4cb3-8532-bfb0603ff3b5'
    },
    include: {
      zap: {
        select: {
          published: true,
          id: true
        }
      }
    }
  });

  if (debugWatch) {
    console.log("\n📍 Debug: Your specific watch:");
    console.log(`   ID: ${debugWatch.id}`);
    console.log(`   Zap ID: ${debugWatch.zapId}`);
    console.log(`   Zap published: ${debugWatch.zap?.published}`);
    console.log(`   Expiration (raw): ${debugWatch.expiration}`);
    console.log(`   Expiration (ISO): ${debugWatch.expiration.toISOString()}`);
    console.log(`   Time until expiration: ${(debugWatch.expiration.getTime() - currentTime.getTime()) / (60 * 1000)} minutes`);
    console.log(`   Is expired: ${debugWatch.expiration < currentTime}`);
    console.log(`   Will expire within buffer: ${debugWatch.expiration < bufferExpiry}`);
  } else {
    console.log("\n❌ Debug: Could not find the specific watch");
  }

  // Check all watches with their zap status
  const allWatchesWithZaps = await prismaClient.google_drive_watch.findMany({
    include: {
      zap: {
        select: {
          published: true,
          id: true
        }
      }
    },
    take: 10
  });

  console.log("\n📊 All watches (sample):");
  allWatchesWithZaps.forEach(w => {
    const timeUntilExpiry = (w.expiration.getTime() - currentTime.getTime()) / (60 * 1000);
    console.log(`   Zap ${w.zapId}: Published=${w.zap?.published}, Expires in ${timeUntilExpiry.toFixed(1)} min`);
  });

  // First, let's check ALL watches to understand the state
  const allWatches = await prismaClient.google_drive_watch.findMany({
    where: {
      zap: { published: true },
    },
    select: {
      id: true,
      zapId: true,
      expiration: true,
      channelId: true,
    },
    take: 5, // Sample for debugging
  });

  console.log("\n📊 Sample of current published watches:");
  allWatches.forEach(w => {
    const isExpired = w.expiration < currentTime;
    const willExpireSoon = w.expiration < bufferExpiry;
    const minutesUntilExpiry = (w.expiration.getTime() - currentTime.getTime()) / (60 * 1000);
    console.log(`  - Zap ${w.zapId}: Expires ${w.expiration.toISOString()} | Expired: ${isExpired} | Expiring soon: ${willExpireSoon} | Minutes left: ${minutesUntilExpiry.toFixed(1)}`);
  });

  const expiringWatches = await prismaClient.google_drive_watch.findMany({
    where: {
      expiration: { lt: bufferExpiry },
      zap: { published: true },
    },
    include: {
      zap: {
        include: {
          trigger: {
            include: {
              type: true,
            },
          },
        },
      },
    },
  });

  console.log(`\n📦 Watches expiring soon: ${expiringWatches.length}`);
  
  if (expiringWatches.length === 0) {
    console.log("⚠️ No watches found that need refreshing. Check if:");
    console.log("   - Expiration dates in DB are correct");
    console.log("   - Timezone handling is consistent");
    console.log("   - Published zaps exist with watches");
    console.log("   - Buffer time is appropriate (current: 6 hours)");
    
    // Show the next watch that would expire
    const nextWatch = await prismaClient.google_drive_watch.findFirst({
      where: {
        // zap: { published: true }, // Temporarily commented out for testing
        expiration: { gt: currentTime }
      },
      orderBy: {
        expiration: 'asc'
      },
      select: {
        zapId: true,
        expiration: true
      }
    });
    
    if (nextWatch) {
      const minutesUntilNext = (nextWatch.expiration.getTime() - currentTime.getTime()) / (60 * 1000);
      console.log(`   Next watch expires in ${minutesUntilNext.toFixed(1)} minutes (Zap ${nextWatch.zapId})`);
    }
    
    return;
  }

  let successCount = 0;
  let failureCount = 0;

  for (const watch of expiringWatches) {
    console.log(`\n🔄 Processing watch for zap ${watch.zapId}`);
    console.log(`   Current expiration: ${watch.expiration.toISOString()}`);
    console.log(`   Channel ID: ${watch.channelId}`);
    
    try {
      const { userId, zapId } = watch;
      
      // Get access token
      console.log(`   Getting token for user ${userId}...`);
      const tokenData = await getTokenForUser(userId);
      const accessToken = tokenData.access_token;

      // Get fresh startPageToken
      console.log(`   Fetching start page token...`);
      const startPageTokenRes = await axios.get(
        "https://www.googleapis.com/drive/v3/changes/startPageToken",
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`   Start page token: ${startPageTokenRes.data.startPageToken}`);

      const newChannelId = randomUUID();
      const triggerName = watch.zap.trigger?.type.name;
      let webhookUrl = "";

      // Use case-insensitive comparison to handle variations like "Google drive" vs "Google Drive"
      if (triggerName?.toLowerCase() === "google docs") {
        webhookUrl = `${process.env.BACKEND_URL}/api/google-docs/webhook`;
      } else if (triggerName?.toLowerCase() === "google drive") {
        webhookUrl = `${process.env.BACKEND_URL}/api/google-drive/webhook`;
      } else {
        console.error(`   ❌ Unsupported trigger type: ${triggerName}`);
        failureCount++;
        continue;
      }

      console.log(`   Webhook URL: ${webhookUrl}`);
      console.log(`   New channel ID: ${newChannelId}`);

      // Start new watch
      console.log(`   Creating new watch...`);
      const watchRes = await axios.post(
        "https://www.googleapis.com/drive/v3/changes/watch",
        {
          id: newChannelId,
          type: "web_hook",
          address: webhookUrl,
          // Optional: Request specific expiration (Google may override)
          expiration: (Date.now() + 7 * 24 * 60 * 60 * 1000).toString(), // Request 7 days
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          params: {
            pageToken: startPageTokenRes.data.startPageToken,
          },
        }
      );

      // Log response details for debugging
      console.log(`   Response status: ${watchRes.status}`);
      console.log(`   Response data:`, watchRes.data);
      console.log(`   Response headers:`, Object.keys(watchRes.headers));
      console.log(`   Full response headers:`, watchRes.headers);
      
      // CRITICAL: Get expiration from header
      const expirationHeader = watchRes.headers["x-goog-channel-expiration"];
      console.log(`   Raw expiration header: ${expirationHeader}`);
      
      if (!expirationHeader) {
        // Try alternative header names or response body
        const altExpirationHeader = watchRes.headers["X-Goog-Channel-Expiration"] || 
                                   watchRes.headers["x-goog-expiration"] ||
                                   watchRes.data.expiration;
        
        if (altExpirationHeader) {
          console.log(`   Found alternative expiration: ${altExpirationHeader}`);
        } else {
          console.error(`   ❌ No expiration found in headers or response body`);
          console.error(`   Available headers:`, JSON.stringify(watchRes.headers, null, 2));
          throw new Error(`Missing 'x-goog-channel-expiration' header for zap ${zapId}`);
        }
      }

      // Parse the header value (milliseconds since epoch)
      const expirationValue = expirationHeader || watchRes.headers["X-Goog-Channel-Expiration"] || 
                             watchRes.headers["x-goog-expiration"] || watchRes.data.expiration;
      
      const expirationMs = parseInt(expirationValue as string, 10);
      if (isNaN(expirationMs)) {
        throw new Error(`Invalid expiration value: ${expirationValue} for zap ${zapId}`);
      }
      if (isNaN(expirationMs)) {
        throw new Error(`Invalid expiration value: ${expirationHeader} for zap ${zapId}`);
      }

      const expirationDate = new Date(expirationMs);
      console.log(`   Parsed expiration: ${expirationDate.toISOString()} (${expirationMs}ms)`);

      const resourceId = watchRes.data.resourceId;
      console.log(`   Resource ID: ${resourceId}`);

      if (!resourceId) {
        throw new Error(`Missing resourceId in response for zap ${zapId}`);
      }

      // Delete existing watch rows for this zap
      console.log(`   Deleting old watch entries...`);
      const deleteResult = await prismaClient.google_drive_watch.deleteMany({
        where: { zapId },
      });
      console.log(`   Deleted ${deleteResult.count} old entries`);

      // Create the new watch entry
      console.log(`   Creating new watch entry...`);
      const newWatch = await prismaClient.google_drive_watch.create({
        data: {
          userId,
          zapId,
          channelId: newChannelId,
          resourceId,
          expiration: expirationDate,
          startPageToken: startPageTokenRes.data.startPageToken,
        },
      });

      console.log(`   ✅ Successfully created new watch with ID: ${newWatch.id}`);
      console.log(`   New expiration: ${newWatch.expiration.toISOString()}`);
      
      // Verify the update
      const verifyWatch = await prismaClient.google_drive_watch.findFirst({
        where: { zapId },
        select: { expiration: true, channelId: true },
      });
      
      if (verifyWatch) {
        console.log(`   ✓ Verified in DB - Expiration: ${verifyWatch.expiration.toISOString()}`);
        if (verifyWatch.expiration <= currentTime) {
          console.error(`   ⚠️ WARNING: New expiration is already in the past!`);
        }
      } else {
        console.error(`   ⚠️ WARNING: Could not verify watch in database!`);
      }
      
      successCount++;
    } catch (err) {
      failureCount++;
      console.error(`   ❌ Failed to refresh watch for zap ${watch.zapId}`);
      console.error(`   Error details:`, err);
      
      if (axios.isAxiosError(err)) {
        console.error(`   Response status: ${err.response?.status}`);
        console.error(`   Response data:`, err.response?.data);
      }
    }
  }

  console.log("\n📊 Summary:");
  console.log(`   ✅ Successfully refreshed: ${successCount}`);
  console.log(`   ❌ Failed to refresh: ${failureCount}`);
  console.log("✅ Done refreshing Google Drive watches.");
}