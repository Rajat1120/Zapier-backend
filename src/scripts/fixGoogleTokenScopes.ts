import { prismaClient } from "../db/database";

async function fixGoogleTokenScopes() {
  console.log("🔄 Starting to fix Google token scopes...");
  
  try {
    // Get all tokens
    const tokens = await prismaClient.google_tokens.findMany({
      select: {
        id: true,
        userId: true,
        scopes: true,
      },
    });

    console.log(`Found ${tokens.length} token records`);

    for (const token of tokens) {
      console.log(`\n👤 Processing token for user ${token.userId}`);
      console.log(`📄 Current scopes type:`, typeof token.scopes);
      console.log(`📄 Current scopes:`, token.scopes);

      let fixedScopes: string[];

      if (Array.isArray(token.scopes)) {
        console.log("✅ Scopes already in correct array format");
        continue;
      }

      if (typeof token.scopes === 'string') {
        try {
          fixedScopes = JSON.parse(token.scopes);
          
          if (!Array.isArray(fixedScopes)) {
            console.error(`❌ Parsed scopes is not an array for user ${token.userId}:`, fixedScopes);
            continue;
          }

          console.log(`🔧 Fixed scopes:`, fixedScopes);

          // Update the database with the fixed scopes
          await prismaClient.google_tokens.update({
            where: { id: token.id },
            data: { scopes: fixedScopes },
          });

          console.log(`✅ Updated scopes for user ${token.userId}`);
        } catch (error) {
          console.error(`❌ Failed to parse scopes for user ${token.userId}:`, error);
          console.error(`📄 Raw scopes:`, token.scopes);
        }
      } else {
        console.error(`❌ Unexpected scopes type for user ${token.userId}:`, typeof token.scopes);
      }
    }

    console.log("\n🎉 Finished fixing Google token scopes");
  } catch (error) {
    console.error("❌ Error fixing Google token scopes:", error);
  } finally {
    await prismaClient.$disconnect();
  }
}

// Run the script if called directly
if (require.main === module) {
  fixGoogleTokenScopes();
}

export { fixGoogleTokenScopes };
