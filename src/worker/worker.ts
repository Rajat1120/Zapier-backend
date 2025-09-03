import Redis from "ioredis";
import { prismaClient } from "../db/database";
import { parse } from "./parser";
import { sendEmail } from "./email";
import axios from "axios";
import { getTokenForUser } from "../utils/googleTokens";

if (!process.env.REDIS_URL)
  throw new Error("REDIS_URL environment variable is not defined");
const redis = new Redis(process.env.REDIS_URL);
const STREAM_NAME = "zap-events";
const GROUP_NAME = "zap-group";
const CONSUMER_NAME = "zap-worker";

async function setupStream() {
  try {
    await redis.xgroup("CREATE", STREAM_NAME, GROUP_NAME, "$", "MKSTREAM");
  } catch (err: any) {
    if (!err.message.includes("BUSYGROUP")) {
      console.error("Failed to create group:", err);
    }
  }
}

export async function Consumer() {
  console.log("👟 Consumer started");
  await setupStream();
  console.log("🔌 Connected to Redis stream and group setup done");

  while (true) {
    console.log("⏳ Waiting for messages...");
    const result = (await redis.xreadgroup(
      "GROUP",
      GROUP_NAME,
      CONSUMER_NAME,
      "COUNT",
      1,
      "BLOCK",
      10000,
      "STREAMS",
      STREAM_NAME,
      ">"
    )) as [string, [string, string[]][]][];
    console.log("📦 Received message:", result);

    if (!result) continue;

    for (const [, streamMessages] of result) {
      for (const [id, fields] of streamMessages) {
        if (!Array.isArray(fields)) {
          console.warn("⚠️ Unexpected Redis message format:", fields);
          continue;
        }

        const fieldIndex = fields.findIndex((val) => val === "data");
        if (fieldIndex === -1 || !fields[fieldIndex + 1]) {
          console.warn("⚠️ No 'data' field found in Redis message:", fields);
          continue;
        }

        const payload = JSON.parse(fields[fieldIndex + 1]);
        const { zapRunId, stage } = payload;

        const zapRunDetails = await prismaClient.zapRun.findFirst({
          where: { id: zapRunId },
          include: {
            zap: {
              include: {
                actions: {
                  include: { type: true },
                },
              },
            },
          },
        });

        console.log("👀 Received Redis Payload:", payload);
        console.log("📥 zapRunId:", zapRunId);
        console.log("📥 stage:", stage);

        console.log(
          "🧠 zapRunDetails:",
          JSON.stringify(zapRunDetails, null, 2)
        );
        console.log("🧠 Actions:", zapRunDetails?.zap.actions);

        console.log("🔍 Looking for action with index =", stage);
        const currentAction = zapRunDetails?.zap.actions.find(
          (x) => x.index === stage
        );
        if (!currentAction) continue;

        // Skip trigger (index 0) - only process actual actions (index >= 1)
        if (stage === 0) {
          console.log("⏭️ Skipping trigger at index 0");
          // Don't continue here - we still need to queue the next stage
        } else {
          const zapRunMetadata = zapRunDetails?.metadata;

          // Get action event from database
          const actionEvent = currentAction.actionEvent;
          console.log("🎬 Action Event:", actionEvent);

          // Execute action based on actionEvent
          if (actionEvent === "Archive Email") {
            console.log("📧 About to archive email");

            const metadata = currentAction.metadata as { messageId: string };
            const messageId = parse(metadata.messageId, zapRunMetadata);

            try {
              const { access_token, scopes } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              // Get real token scopes from Google
              const tokenInfo = await axios.get(
                `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${access_token}`
              );
              
              const realTokenScopes = tokenInfo.data.scope.split(' ');
              console.log("🔑 Real token scopes:", realTokenScopes);
              
              const requiredScopes = [
                "https://www.googleapis.com/auth/gmail.modify",
                "https://www.googleapis.com/auth/gmail.labels",
              ];

              const hasRequiredScopes = requiredScopes.every((scope) =>
                realTokenScopes.includes(scope)
              );
              
              if (!hasRequiredScopes) {
                const missingScopes = requiredScopes.filter(s => !realTokenScopes.includes(s));
                throw new Error(
                  `❌ Token missing Gmail scopes. Missing: ${missingScopes.join(", ")}. User needs to re-authenticate.`
                );
              }

              console.log("🔍 Required scopes:", requiredScopes);
              console.log("🔍 Has required scopes:", hasRequiredScopes);

              await axios.post(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
                { removeLabelIds: ["INBOX"] },
                {
                  headers: {
                    Authorization: `Bearer ${access_token}`,
                    "Content-Type": "application/json",
                  },
                }
              );

              console.log("✅ Email archived successfully");
            } catch (error: any) {
              console.error("❌ Failed to archive email:");
              console.error("Status:", error.response?.status);
              console.error("Error:", error.response?.data);
              console.error("Message ID:", messageId);
            }
          } else if (actionEvent === "Delete Email") {
            console.log("🗑️ About to delete email");

            const metadata = currentAction.metadata as {
              messageId: string;
            };

            const messageId = parse(metadata.messageId, zapRunMetadata);

            try {
              const { access_token, scopes } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              // Log real Google tokeninfo scopes
              try {
                const tokenInfo = await axios.get(
                  `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${access_token}`
                );
                console.log(
                  "🔑 Google tokeninfo scopes:",
                  tokenInfo.data.scope
                );
              } catch (e) {
                console.warn(
                  "⚠️ Could not fetch Google tokeninfo for access_token"
                );
              }

              // Check if token has required Gmail scopes
              const requiredScopes = [
                "https://www.googleapis.com/auth/gmail.modify",
              ];

              const normalizedScopes = scopes.map((s) => s.trim());
              const hasRequiredScopes = requiredScopes.every((scope) =>
                normalizedScopes.includes(scope)
              );

              if (!hasRequiredScopes) {
                throw new Error(
                  `Token missing required Gmail scopes. Has: ${scopes.join(
                    ", "
                  )}`
                );
              }

              await axios.post(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`,
                {},
                {
                  headers: { Authorization: `Bearer ${access_token}` },
                }
              );

              console.log("✅ Email deleted successfully");
            } catch (error) {
              console.error("❌ Failed to delete email:", error);
            }
          } else if (actionEvent === "Add label to email") {
            console.log("🏷️ About to add label to email");

            const metadata = currentAction.metadata as {
              messageId: string;
              labelName: string;
            };

            const messageId = parse(metadata.messageId, zapRunMetadata);
            const labelName = parse(metadata.labelName, zapRunMetadata);

            try {
              const { access_token, scopes } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              // Log real Google tokeninfo scopes
              try {
                const tokenInfo = await axios.get(
                  `https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${access_token}`
                );
                console.log(
                  "🔑 Google tokeninfo scopes:",
                  tokenInfo.data.scope
                );
              } catch (e) {
                console.warn(
                  "⚠️ Could not fetch Google tokeninfo for access_token"
                );
              }

              // Check if token has required Gmail scopes
              const requiredScopes = [
                "https://www.googleapis.com/auth/gmail.modify",
                "https://www.googleapis.com/auth/gmail.labels",
              ];

              const normalizedScopes = scopes.map((s) => s.trim());
              const hasRequiredScopes = requiredScopes.every((scope) =>
                normalizedScopes.includes(scope)
              );

              if (!hasRequiredScopes) {
                throw new Error(
                  `Token missing required Gmail scopes. Has: ${scopes.join(
                    ", "
                  )}`
                );
              }

              // First get or create the label
              const labelsResponse = await axios.get(
                "https://gmail.googleapis.com/gmail/v1/users/me/labels",
                {
                  headers: { Authorization: `Bearer ${access_token}` },
                }
              );

              let labelId = labelsResponse.data.labels.find(
                (label: any) => label.name === labelName
              )?.id;

              if (!labelId) {
                // Create label if it doesn't exist
                const createLabelResponse = await axios.post(
                  "https://gmail.googleapis.com/gmail/v1/users/me/labels",
                  {
                    name: labelName,
                    labelListVisibility: "labelShow",
                    messageListVisibility: "show",
                  },
                  {
                    headers: { Authorization: `Bearer ${access_token}` },
                  }
                );
                labelId = createLabelResponse.data.id;
              }

              // Add label to message
              await axios.post(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`,
                {
                  addLabelIds: [labelId],
                },
                {
                  headers: { Authorization: `Bearer ${access_token}` },
                }
              );

              console.log("✅ Label added to email successfully");
            } catch (error) {
              console.error("❌ Failed to add label to email:", error);
            }
          } else if (actionEvent === "Clear Spreadsheet Row(s)") {
            console.log("🧹 About to clear spreadsheet rows");

            const metadata = currentAction.metadata as {
              spreadsheetId: string;
              range: string;
            };

            const spreadsheetId = parse(metadata.spreadsheetId, zapRunMetadata);
            const range = parse(metadata.range, zapRunMetadata);

            try {
              const { access_token } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              await axios.post(
                `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:clear`,
                {},
                {
                  headers: { Authorization: `Bearer ${access_token}` },
                }
              );

              console.log("✅ Spreadsheet rows cleared successfully");
            } catch (error) {
              console.error("❌ Failed to clear spreadsheet rows:", error);
            }
          } else if (actionEvent === "Create Spreadsheet") {
            console.log("📊 About to create spreadsheet");

            const metadata = currentAction.metadata as {
              title: string;
              headers?: string[];
            };

            const title = parse(metadata.title, zapRunMetadata);
            const headers = metadata.headers?.map((h) =>
              parse(h, zapRunMetadata)
            );

            try {
              const { access_token } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              const spreadsheetData: any = {
                properties: {
                  title,
                },
              };

              if (headers && headers.length > 0) {
                spreadsheetData.sheets = [
                  {
                    data: [
                      {
                        rowData: [
                          {
                            values: headers.map((header) => ({
                              userEnteredValue: { stringValue: header },
                            })),
                          },
                        ],
                      },
                    ],
                  },
                ];
              }

              await axios.post(
                "https://sheets.googleapis.com/v4/spreadsheets",
                spreadsheetData,
                {
                  headers: { Authorization: `Bearer ${access_token}` },
                }
              );

              console.log("✅ Spreadsheet created successfully");
            } catch (error) {
              console.error("❌ Failed to create spreadsheet:", error);
            }
          } else if (actionEvent === "Create Document from text") {
            console.log("📝 About to create Google Doc from text");

            const metadata = currentAction.metadata as {
              title: string;
              content: string;
            };

            const title = parse(metadata.title, zapRunMetadata);
            const content = parse(metadata.content, zapRunMetadata);

            try {
              const { access_token } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              const docResponse = await axios.post(
                "https://docs.googleapis.com/v1/documents",
                { title },
                {
                  headers: { Authorization: `Bearer ${access_token}` },
                }
              );

              const documentId = docResponse.data.documentId;

              if (content) {
                await axios.post(
                  `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`,
                  {
                    requests: [
                      {
                        insertText: {
                          location: { index: 1 },
                          text: content,
                        },
                      },
                    ],
                  },
                  {
                    headers: { Authorization: `Bearer ${access_token}` },
                  }
                );
              }

              console.log("✅ Google Doc created successfully");
            } catch (error) {
              console.error("❌ Failed to create Google Doc:", error);
            }
          } else if (actionEvent === "Create File From Text") {
            console.log("📁 About to create file from text in Google Drive");

            const metadata = currentAction.metadata as {
              name: string;
              content: string;
              folderId?: string;
            };

            const name = parse(metadata.name, zapRunMetadata);
            const content = parse(metadata.content, zapRunMetadata);
            const folderId = metadata.folderId
              ? parse(metadata.folderId, zapRunMetadata)
              : undefined;

            try {
              const { access_token } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              const fileMetadata: any = {
                name,
                mimeType: "text/plain",
              };

              if (folderId) {
                fileMetadata.parents = [folderId];
              }

              const form = new FormData();
              form.append(
                "metadata",
                new Blob([JSON.stringify(fileMetadata)], {
                  type: "application/json",
                })
              );
              form.append("file", new Blob([content], { type: "text/plain" }));

              await axios.post(
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
                form,
                {
                  headers: {
                    Authorization: `Bearer ${access_token}`,
                    "Content-Type": "multipart/related",
                  },
                }
              );

              console.log("✅ File created from text successfully");
            } catch (error) {
              console.error("❌ Failed to create file from text:", error);
            }
          } else if (actionEvent === "Create Folder") {
            console.log("📁 About to create folder in Google Drive");

            const metadata = currentAction.metadata as {
              name: string;
              parentId?: string;
            };

            const name = parse(metadata.name, zapRunMetadata);
            const parentId = metadata.parentId
              ? parse(metadata.parentId, zapRunMetadata)
              : undefined;

            try {
              const { access_token } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              const folderMetadata: any = {
                name,
                mimeType: "application/vnd.google-apps.folder",
              };

              if (parentId) {
                folderMetadata.parents = [parentId];
              }

              await axios.post(
                "https://www.googleapis.com/drive/v3/files",
                folderMetadata,
                {
                  headers: { Authorization: `Bearer ${access_token}` },
                }
              );

              console.log("✅ Folder created successfully");
            } catch (error) {
              console.error("❌ Failed to create folder:", error);
            }
          } else if (actionEvent === "Copy File") {
            console.log("📋 About to copy file in Google Drive");

            const metadata = currentAction.metadata as {
              fileId: string;
              name?: string;
              parentId?: string;
            };

            const fileId = parse(metadata.fileId, zapRunMetadata);
            const name = metadata.name
              ? parse(metadata.name, zapRunMetadata)
              : undefined;
            const parentId = metadata.parentId
              ? parse(metadata.parentId, zapRunMetadata)
              : undefined;

            try {
              const { access_token } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              const copyMetadata: any = {};
              if (name) copyMetadata.name = name;
              if (parentId) copyMetadata.parents = [parentId];

              await axios.post(
                `https://www.googleapis.com/drive/v3/files/${fileId}/copy`,
                copyMetadata,
                {
                  headers: { Authorization: `Bearer ${access_token}` },
                }
              );

              console.log("✅ File copied successfully");
            } catch (error) {
              console.error("❌ Failed to copy file:", error);
            }
          } else if (actionEvent === "Delete File") {
            console.log("🗑️ About to delete file in Google Drive");

            const metadata = currentAction.metadata as {
              fileId: string;
            };

            const fileId = parse(metadata.fileId, zapRunMetadata);

            try {
              const { access_token } = await getTokenForUser(
                zapRunDetails?.zap.userId!
              );

              await axios.delete(
                `https://www.googleapis.com/drive/v3/files/${fileId}`,
                {
                  headers: { Authorization: `Bearer ${access_token}` },
                }
              );

              console.log("✅ File deleted successfully");
            } catch (error) {
              console.error("❌ Failed to delete file:", error);
            }
          }

          // Legacy email action for backward compatibility
          else if (currentAction.type?.id === "email") {
            console.log("📧 About to send email");

            const metadata = currentAction.metadata as {
              body: string;
              email: string;
            };

            console.log("📨 Email metadata:", metadata);

            const body = parse(metadata.body, zapRunMetadata);
            const to = parse(metadata.email, zapRunMetadata);

            console.log("📨 Parsed email body:", body);
            console.log("📨 Parsed email to:", to);

            try {
              await sendEmail(to, body);
              console.log("✅ Email sent successfully");
            } catch (error) {
              console.error("❌ Failed to send email:", error);
            }
          }

          if (currentAction.type?.id === "solana_send") {
            const metadata = currentAction.metadata as {
              amount: string;
              address: string;
            };
            const amount = parse(metadata.amount, zapRunMetadata);
            const address = parse(metadata.address, zapRunMetadata);
            console.log(`Send SOL: ${amount} to ${address}`);
            // await sendSol(address, amount);
          }
        } // Close the else block for stage !== 0

        const lastStage = (zapRunDetails?.zap.actions.length || 1) - 1;
        console.log(`📊 Stage ${stage} completed. Last stage: ${lastStage}`);

        if (lastStage !== stage) {
          console.log(`➡️ Adding next stage ${stage + 1} to queue`);
          await redis.xadd(
            STREAM_NAME,
            "*",
            "data",
            JSON.stringify({ zapRunId, stage: stage + 1 })
          );
        } else {
          console.log("🏁 All stages completed for this zap run");
        }

        await redis.xack(STREAM_NAME, GROUP_NAME, id);
      }
    }
  }
}
