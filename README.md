# Zapier Clone — Backend (Hooks Service)

A production-grade automation backend built with Node.js, Express, TypeScript, Prisma, Redis Streams, and Kafka. This service powers the full Zapier-style workflow engine: it receives webhook triggers, queues Zap runs, executes actions across Google integrations, sends emails, and transfers Solana tokens.

---

## Table of Contents

- [Overview](#overview)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Environment Variables](#environment-variables)
  - [Installation & Running](#installation--running)
- [Database Schema](#database-schema)
  - [Models](#models)
  - [Migration History](#migration-history)
- [Architecture](#architecture)
  - [Request Flow](#request-flow)
  - [Producer (Outbox Pattern)](#producer-outbox-pattern)
  - [Consumer (Worker)](#consumer-worker)
  - [Template Parser](#template-parser)
- [API Reference](#api-reference)
  - [Authentication](#authentication)
  - [User Routes](#user-routes)
  - [Zap Routes](#zap-routes)
  - [Trigger Routes](#trigger-routes)
  - [Action Routes](#action-routes)
  - [Google Token Routes](#google-token-routes)
  - [Webhook Ingestion](#webhook-ingestion)
- [Google Integrations](#google-integrations)
  - [Google Drive](#google-drive)
  - [Google Docs](#google-docs)
  - [Google Sheets](#google-sheets)
  - [Google Slides](#google-slides)
  - [Google Calendar](#google-calendar)
  - [Gmail](#gmail)
- [Supported Actions (Worker)](#supported-actions-worker)
- [Cron Jobs](#cron-jobs)
- [Utility Scripts](#utility-scripts)
- [Known Limitations & TODOs](#known-limitations--todos)

---

## Overview

This is the backend service for the Zapier Clone project. Its responsibilities are:

- **User management** — signup, signin, JWT-based authentication
- **Zap management** — CRUD for Zaps (automated workflows), their triggers, and actions
- **Webhook ingestion** — a public endpoint that receives arbitrary HTTP payloads and queues them as Zap runs
- **Event processing pipeline** — a Producer reads from the database outbox and publishes to Redis Streams; a Consumer reads from those streams and executes the appropriate action for each step
- **Google integrations** — webhook-based (Drive changes API) and polling-based triggers for Google Drive, Docs, Sheets, Slides, Calendar, and Gmail
- **Action execution** — Gmail operations, Google Drive/Docs/Sheets file management, email sending via Nodemailer, and Solana token transfers
- **Cron jobs** — automatic refresh of Google OAuth tokens and Drive watch channel renewals

---

## Tech Stack

| Technology | Purpose |
|---|---|
| **Node.js + Express** | HTTP server and REST API |
| **TypeScript** | Static typing |
| **Prisma 6** | ORM and database migrations (PostgreSQL) |
| **PostgreSQL** | Primary database |
| **Redis (ioredis)** | Streams-based job queue for the event pipeline |
| **KafkaJS** | Installed as a dependency (available for future use) |
| **node-cron** | Scheduled background jobs |
| **jsonwebtoken** | JWT signing and verification |
| **Zod** | Runtime schema validation for request bodies |
| **Axios** | HTTP client for Google API calls |
| **Nodemailer** | SMTP email sending |
| **@solana/web3.js** | Solana blockchain token transfers |
| **dotenv** | Environment variable loading |

---

## Project Structure

```
.
├── prisma/
│   ├── schema.prisma           # Full Prisma data model
│   └── migrations/             # Timestamped SQL migration files
│       ├── 20250302185019_init/
│       ├── 20250302191656_init/
│       ├── 20250302193432_init/
│       ├── 20250303092221_add_sorting_order/
│       ├── 20250303092454_/
│       ├── 20250304193344_/
│       ├── 20250304195854_/
│       └── 20250306133655_/
│
└── src/
    ├── index.ts                # App entry point: Express setup, route mounting, cron scheduling
    ├── config.ts               # Exports JWT_PASSWORD from env
    ├── middleware.ts           # JWT auth middleware (adds req.id)
    │
    ├── db/
    │   └── database.ts         # Prisma client singleton
    │
    ├── router/
    │   ├── user.ts             # POST /signup, POST /signin, GET /
    │   ├── zap.ts              # CRUD for Zaps (create, list, get, update)
    │   ├── trigger.ts          # CRUD for Trigger events and metadata
    │   ├── action.ts           # GET /available — list available action types
    │   ├── googleTokenRouter.ts # Store and retrieve Google OAuth tokens
    │   ├── googleDrive.ts      # Drive watch setup + webhook handler + polling
    │   ├── googleDocs.ts       # Docs watch setup + webhook handler + polling
    │   ├── googleSheets.ts     # Sheets polling (rows, worksheets, spreadsheets)
    │   ├── googleSlides.ts     # Slides polling (new presentations)
    │   ├── googleCalendar.ts   # Calendar polling (new events)
    │   └── gmail.ts            # Gmail polling (new emails, attachments, conversations)
    │
    ├── processor/
    │   └── process.ts          # Producer: reads outbox → publishes to Redis Stream
    │
    ├── worker/
    │   ├── worker.ts           # Consumer: reads Redis Stream → executes actions
    │   ├── email.ts            # Nodemailer email sender
    │   ├── parser.ts           # Template engine: resolves {key.path} placeholders
    │   └── solana.ts           # Solana SOL transfer helper
    │
    ├── cron/
    │   ├── refreshGoogleTokens.ts   # Refreshes expiring Google OAuth access tokens
    │   └── refreshDriveWatches.ts   # Renews expiring Google Drive watch channels
    │
    ├── lib/
    │   └── google/
    │       └── drive.ts        # Helper: list Drive folders for a user
    │
    ├── utils/
    │   └── googleTokens.ts     # getTokenForUser(): fetch + auto-refresh token
    │
    ├── scripts/
    │   ├── fixGoogleTokenScopes.ts  # One-time migration: fix stored scope format
    │   └── testGmailToken.ts        # Debug script: verify Gmail token scopes
    │
    └── types/
        └── type.ts             # Zod schemas: SignupSchema, SigninSchema, ZapCreateSchema, ZapUpdateSchema
```

---

## Getting Started

### Prerequisites

- **Node.js** >= 18.18.0
- **npm**
- **PostgreSQL** database
- **Redis** instance (Upstash or self-hosted)
- Google Cloud project with OAuth 2.0 credentials and the following APIs enabled:
  - Gmail API
  - Google Drive API
  - Google Docs API
  - Google Sheets API
  - Google Slides API
  - Google Calendar API

### Environment Variables

Create a `.env` file in the project root:

```env
# Database
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Redis (Upstash or self-hosted)
REDIS_URL=rediss://...

# JWT
JWT_PASSWORD=your_jwt_secret

# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Public URL of this backend (used for Google webhook callbacks)
BACKEND_URL=https://your-backend-domain.com

# Email (SMTP via Gmail)
SMTP_USERNAME=your@gmail.com
SMTP_PASSWORD=your_app_password

# Solana (optional)
SOL_PRIVATE_KEY=your_base58_private_key
```

> **BACKEND_URL** must be publicly reachable — Google Drive/Docs push notifications (webhooks) call back to this URL.

### Installation & Running

```bash
# Install dependencies
npm install

# Run database migrations and generate Prisma client, then start
npm start

# Run scope-fix migration script (one-time, if needed)
npm run fix-scopes

# Test Gmail token validity
npm run test-gmail-token
```

The `start` script runs: `npx prisma generate && tsc -b && node dist/index.js`

The server starts on **port 8000** and binds to `0.0.0.0`.

---

## Database Schema

### Models

**`User`** — registered users.

| Field | Type | Notes |
|---|---|---|
| id | Int (PK, autoincrement) | |
| name | String? | optional |
| email | String (unique) | |
| password | String | stored in plaintext — **TODO: hash** |
| jwtToken | String? | last issued JWT |
| createdAt | DateTime | |
| googleToken | google_tokens? | one-to-one |
| google_drive_watches | google_drive_watch[] | |
| zaps | Zap[] | |

**`Zap`** — a saved automation workflow.

| Field | Type | Notes |
|---|---|---|
| id | String (PK, UUID) | |
| triggerId | String | references the Trigger record |
| userId | Int | owner |
| published | Boolean | default false |
| actions | Action[] | |
| trigger | Trigger? | |
| zapRuns | ZapRun[] | |
| googleDriveWatch | google_drive_watch? | |

**`Trigger`** — the event that starts a Zap.

| Field | Type | Notes |
|---|---|---|
| id | String (PK, UUID) | |
| zapId | String (unique) | one Trigger per Zap |
| triggerId | String | references AvailableTriggers |
| triggerEvent | String? | e.g. "New Email", "New File" |
| metadata | Json | stores labelId, folderId, lastProcessedTs, etc. |

**`Action`** — a step in the Zap workflow.

| Field | Type | Notes |
|---|---|---|
| id | String (PK, UUID) | |
| zapId | String | |
| actionId | String? | references AvailableActions |
| actionEvent | String? | e.g. "Archive Email", "Create Folder" |
| index | Int | 0 = trigger slot; 1+ = action steps |
| sortingOrder | Int | display order |
| metadata | Json | action-specific parameters |

**`AvailableActions`** — master list of supported action types.

| Field | Type |
|---|---|
| id | String (PK) |
| name | String |
| image | String |

**`AvailableTriggers`** — master list of supported trigger types.

| Field | Type |
|---|---|
| id | String (PK) |
| name | String |
| image | String |

**`ZapRun`** — a single execution instance of a Zap.

| Field | Type | Notes |
|---|---|---|
| id | String (PK, UUID) | |
| zapId | String | |
| metadata | Json | trigger payload / context |
| recursionLevel | Int | default 0, guards against infinite loops |
| createdAt | DateTime | |
| zapRunOutbox | ZapRunOutbox? | |

**`ZapRunOutbox`** — transactional outbox for reliable event delivery.

| Field | Type |
|---|---|
| id | String (PK, UUID) |
| zapRunId | String (unique) |

**`google_tokens`** — stored Google OAuth tokens per user.

| Field | Type |
|---|---|
| id | String (PK, UUID) |
| userId | Int (unique) |
| access_token | String |
| refresh_token | String |
| scopes | String[] |
| expiresAt | DateTime |
| updatedAt | DateTime |
| email | String |

**`google_drive_watch`** — active Google Drive push notification channels.

| Field | Type | Notes |
|---|---|---|
| id | String (PK, UUID) | |
| userId | Int | |
| channelId | String (unique) | Google's channel ID |
| resourceId | String | Google's resource ID |
| startPageToken | String | for fetching incremental changes |
| expiration | DateTime | Google channels expire ~1 week |
| zapId | String (unique) | one watch per Zap |

### Migration History

| Migration | Change |
|---|---|
| `20250302185019_init` | Initial schema: User, Zap, Trigger, Action, AvailableActions, AvailableTriggers, ZapRun |
| `20250302191656_init` | Add ZapRunOutbox table |
| `20250302193432_init` | Add `metadata` (JSONB) to ZapRun |
| `20250303092221_add_sorting_order` | Add `sortingOrder` to Trigger (later removed) |
| `20250303092454_` | Move `sortingOrder` to Action; remove from Trigger |
| `20250304193344_` | Add `userId` to Zap (with FK to User) |
| `20250304195854_` | Add `metadata` (JSONB) to Action |
| `20250306133655_` | Add `image` field to AvailableActions and AvailableTriggers |
| `20250306160854_` | Add `metadata` (JSONB) to Trigger |

---

## Architecture

### Request Flow

```
External event (webhook / Google push / poll)
    ↓
Express route handler
    ↓
prismaClient.$transaction:
    ├── ZapRun.create({ metadata: eventPayload })
    └── ZapRunOutbox.create({ zapRunId })
    ↓
Producer (process.ts) — polling loop
    ↓
redis.xadd(STREAM_NAME, "data", { zapRunId, stage: 0 })
    + ZapRunOutbox.deleteMany (cleanup)
    ↓
Consumer (worker.ts) — blocking read from Redis Stream
    ↓
Executes action at current stage
    ↓
redis.xadd(..., { zapRunId, stage: stage + 1 })   ← if more stages remain
    ↓
redis.xack(...)   ← acknowledges message
```

### Producer (Outbox Pattern)

`src/processor/process.ts` runs as an infinite loop inside the main process:

1. Queries `ZapRunOutbox` for up to 10 pending rows
2. Publishes each to the Redis Stream `zap-events` with `{ zapRunId, stage: 0 }`
3. Deletes the processed outbox rows
4. Sleeps 10 seconds if nothing was found

The transactional outbox pattern ensures that a Zap run is never lost even if the server crashes between creating the record and publishing to Redis.

### Consumer (Worker)

`src/worker/worker.ts` runs as a separate infinite loop inside the same process:

1. Creates a Redis Consumer Group (`zap-group`) on first startup
2. Reads messages via `XREADGROUP` with a 10-second block timeout
3. For each message: looks up the `ZapRun` and the `Action` at the current `stage`
4. Stage 0 (the trigger slot) is always skipped — only stages ≥ 1 execute actions
5. Dispatches to the appropriate action handler based on `actionEvent`
6. Appends `{ zapRunId, stage: stage + 1 }` to the stream if more stages remain
7. Acknowledges the message with `XACK`

If the Producer or Consumer crashes, the error is logged and the process continues running rather than exiting — both are wrapped in `.catch()` at startup.

### Template Parser

`src/worker/parser.ts` provides a simple `{key.path}` template engine:

```typescript
parse("Send {metadata.amount} SOL to {metadata.address}", zapRunMetadata)
// → "Send 0.5 SOL to 7xKp..."
```

- Delimiter: `{` and `}`
- Supports dot-notation for nested object paths
- Returns empty string for missing keys
- Input `values` can be a JSON string or a plain object

---

## API Reference

### Authentication

All protected routes require the header:
```
Authorization: <jwt_token>
```

The JWT is signed with `JWT_PASSWORD` (from env) and contains `{ id: userId }`. The `authMiddleware` verifies the token and attaches `req.id` for downstream handlers.

### User Routes

**Base path:** `/api/v1/user`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/signup` | No | Register a new user. Body: `{ username, password, name }` |
| POST | `/signin` | No | Sign in, returns JWT token. Body: `{ username, password }` |
| GET | `/` | Yes | Get the current user's name and email |

**Signup request:**
```json
{ "username": "user@email.com", "password": "secret", "name": "Alice" }
```

**Signin response:**
```json
{ "token": "eyJ...", "email": "user@email.com", "name": "Alice" }
```

### Zap Routes

**Base path:** `/api/v1/zap`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/` | Yes | Create a new Zap with trigger and actions |
| GET | `/` | Yes | List all Zaps for the current user |
| GET | `/:zapId` | Yes | Get a single Zap with full action/trigger detail |
| POST | `/:zapId` | Yes | Update actions for an existing Zap |

**Create Zap body:**
```json
{
  "availableTriggerId": "uuid-of-trigger-type",
  "triggerMetadata": {},
  "actions": [
    {
      "availableActionId": "uuid-of-action-type",
      "actionMetadata": {},
      "index": 0,
      "sortingOrder": "1"
    }
  ]
}
```

**Update Zap body:**
```json
{
  "zapId": "zap-uuid",
  "actions": [
    {
      "actionId": "uuid",
      "metadata": {},
      "index": 1,
      "sortingOrder": 2,
      "actionEvent": "Archive Email"
    }
  ]
}
```

The update route performs a smart diff: it deletes actions whose `sortingOrder` no longer appears in the new array, upserts the rest, and updates the Trigger record if the action at `index: 0` changed.

### Trigger Routes

**Base path:** `/api/v1/trigger`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/available` | No | List all available trigger types |
| POST | `/:zapId` | No | Set the `triggerEvent` and `metadata` on a trigger |
| POST | `/metadata/:zapId` | No | Update only the metadata on a trigger (and its index-matching action) |
| GET | `/:zapId` | No | Get the current triggerEvent for a Zap |

### Action Routes

**Base path:** `/api/v1/action`

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/available` | No | List all available action types from `AvailableActions` |

### Google Token Routes

**Base path:** `/api/google-token`

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/` | Yes | Store or update a Google OAuth token for the current user |
| GET | `/` | Yes | Get current token scopes, email, and expiry |
| GET | `/accessToken` | Yes | Get just the raw access token |

**Store token body:**
```json
{
  "access_token": "ya29...",
  "refresh_token": "1//...",
  "scopes": ["https://www.googleapis.com/auth/gmail.modify"],
  "expires_in": 3600,
  "email": "user@gmail.com"
}
```

Scopes are merged with any existing scopes stored for that user so that multiple OAuth flows can accumulate permissions without overwriting each other.

### Webhook Ingestion

**`POST /hooks/catch/:userId/:zapId`**

A public endpoint (no auth required) that accepts any JSON body and immediately creates a `ZapRun` + `ZapRunOutbox` entry in a single database transaction. This is the entry point for external services to fire a Zap.

```bash
curl -X POST https://your-backend/hooks/catch/1/some-zap-uuid \
  -H "Content-Type: application/json" \
  -d '{ "event": "payment", "amount": 100 }'
```

---

## Google Integrations

All Google integrations share a common token retrieval pattern: `getTokenForUser(userId)` in `src/utils/googleTokens.ts` fetches the token from the database and automatically refreshes it using the stored `refresh_token` if it is expired or will expire within 5 minutes.

### Google Drive

**Routes:** `/api/google-drive`

| Method | Path | Description |
|---|---|---|
| POST | `/watch` | Start a Drive changes watch channel for a Zap |
| POST | `/webhook` | Receives push notifications from Google |
| GET | `/google/folders` | List Drive folders (requires auth) |

**Watch setup** creates a Google Drive `changes.watch` subscription pointing to `/webhook`. The channel ID, resource ID, expiration, and `startPageToken` are stored in `google_drive_watch`.

**Webhook handler** processes the list of changed files and creates `ZapRun` records for events matching the trigger configuration:

| Trigger Event (case-insensitive) | Condition |
|---|---|
| `new file` | File created within the last minute |
| `new file in folder` | New file inside the configured `folderId` |
| `new folder` | Folder created within the last minute |
| `updated file` | File modified recently (not newly created) |

**Recursion guard:** Files created by the Zap engine are stamped with `appProperties` (`origin: "zap-engine"`, `originZapId`, `originNodeId`, `originZapRunId`). The webhook handler skips these files to prevent infinite loops. A `recursionLevel` field on `ZapRun` provides an additional configurable cap (currently set to 1).

### Google Docs

**Routes:** `/api/google-docs`

| Method | Path | Description |
|---|---|---|
| POST | `/watch` | Start a Drive changes watch for Docs detection |
| ALL | `/webhook` | Push notification handler (responds to HEAD for verification) |
| GET | `/poll/:zapId` | Polling-based Docs detection |
| GET | `/google/folders` | List Drive folders |

Docs detection uses the Drive changes API (same mechanism as Drive) but filters for `mimeType = application/vnd.google-apps.document`. Supports trigger events for new documents optionally scoped to a specific folder.

### Google Sheets

**Routes:** `/api/google-sheets`

| Method | Path | Description |
|---|---|---|
| GET | `/poll/:zapId` | Poll for Sheets events |

Polling-based only (no webhook). Supported trigger events:

| Trigger Event | Mechanism |
|---|---|
| `new spreadsheet row` | Compares `lastRowCount` to current row count; emits for each new row |
| `new or updated spreadsheet row` | Tracks per-cell snapshots; emits on any value change |
| `new worksheet` | Checks worksheet `updatedTime` against `lastWorksheetCheckTs`; falls back to DB dedup check |
| `new spreadsheet` | Uses Drive API to find newly created spreadsheet files |

State (watermarks, row counts, cell value snapshots) is persisted back to `Trigger.metadata` after each poll.

### Google Slides

**Routes:** `/api/google-slides`

| Method | Path | Description |
|---|---|---|
| GET | `/poll/:zapId` | Poll for new presentations |

Uses the Drive files API to detect newly created `application/vnd.google-apps.presentation` files since `lastProcessedTs`.

### Google Calendar

**Routes:** `/api/google-calendar`

| Method | Path | Description |
|---|---|---|
| GET | `/poll/:zapId` | Poll for new calendar events |

Queries the Calendar Events API using `timeMin = lastProcessedTs - 60s`. Deduplicates by checking for existing `ZapRun` records with matching `calendarEventId`.

### Gmail

**Routes:** `/api/gmail`

| Method | Path | Description |
|---|---|---|
| GET | `/new-attachments/:zapId` | Poll for emails with attachments in a label |
| GET | `/new-emails/:zapId` | Poll for new emails in a label |
| GET | `/new-conversations/:zapId` | Poll for brand-new email threads |
| GET | `/poll/:zapId` | Unified dispatcher — routes to the above based on `triggerEvent` |

All Gmail polling routes follow the same pattern: on first run (no `lastProcessedTs`), initialize the watermark to now and return empty to avoid backfilling old emails. Subsequent runs query Gmail with `after:<unix_timestamp>` and deduplicate against existing `ZapRun` records by `gmailMessageId` or `gmailThreadId`.

System labels (`INBOX`, `SENT`, `SPAM`, etc.) use `in:<label>` syntax in Gmail queries; custom labels use `label:<labelId>`.

---

## Supported Actions (Worker)

The consumer in `src/worker/worker.ts` dispatches based on `currentAction.actionEvent`. Index 0 (the trigger slot) is always skipped. Currently implemented action events:

| `actionEvent` | Description |
|---|---|
| `Archive Email` | Removes the `INBOX` label from a Gmail message |
| `Delete Email` | Moves a Gmail message to trash |
| `Add label to email` | Creates the Gmail label if missing, then applies it |
| `Clear Spreadsheet Row(s)` | Clears specified rows in a Google Sheet |
| `Create Spreadsheet` | Creates a new spreadsheet (optionally copying an existing one) |
| `Create Document from text` | Creates a Google Doc and inserts text content |
| `Create File From Text` | Creates a plain text file in Google Drive |
| `Create Folder` | Creates a folder in Google Drive |
| `Copy File` | Copies a file in Google Drive (stamped with appProperties) |
| `Delete File` | Permanently deletes a file from Google Drive |
| `email` (legacy type ID) | Sends an email via Nodemailer/SMTP |
| `solana_send` (type ID) | SOL transfer helper available but commented out in execution |

All action metadata values support `{key.path}` template substitution resolved against the triggering `ZapRun.metadata`. Files created by actions are stamped with `appProperties` to prevent triggering infinite loops in Drive/Docs watches.

---

## Cron Jobs

Both cron jobs run inside the main process in `src/index.ts`.

### Google Token Refresh

`src/cron/refreshGoogleTokens.ts` — triggered every **30 minutes** via `setInterval`.

Queries all `google_tokens` records expiring within the next 5 minutes and refreshes each using the stored `refresh_token` via Google's OAuth token endpoint. Updates `access_token` and `expiresAt` in the database.

### Google Drive Watch Refresh

`src/cron/refreshDriveWatches.ts` — triggered every **30 minutes** via `node-cron` (`*/30 * * * *`).

Google Drive watch channels expire approximately every 7 days. This job:

1. Finds all watches expiring within the next **6 hours** (buffer) for published Zaps
2. For each expiring watch: fetches a new `startPageToken`, creates a new watch channel via the Drive API, stores the new channel record, and deletes the old one
3. Logs detailed debug information including expiration times and watch states
4. Reports a final success/failure count summary

---

## Utility Scripts

### `npm run fix-scopes`

`src/scripts/fixGoogleTokenScopes.ts` — a one-time migration script that converts `scopes` values stored as a JSON string into a proper PostgreSQL string array. Run this if you encounter scope-parsing errors after a schema change.

### `npm run test-gmail-token`

`src/scripts/testGmailToken.ts` — a diagnostic script (hardcoded to `userId: 2`) that fetches the stored access token, verifies it against Google's `tokeninfo` endpoint, checks whether the required Gmail scopes (`gmail.modify`, `gmail.labels`) are present, and makes a test call to the Gmail profile API.

---

## Known Limitations & TODOs

- **Passwords stored in plaintext** — the signup route has a `// TODO: hash password` comment. Production deployments must use bcrypt or similar before launch.
- **SOL transfer commented out** — `sendSol()` is called in the worker but the actual execution line is commented out. Enable only after confirming the private key and network settings.
- **IST offset hardcoded** — several files apply a hardcoded `5.5 * 60 * 60 * 1000` ms offset for IST. This should be replaced with proper UTC-based time handling throughout.
- **No rate limiting** — the public `/hooks/catch` endpoint has no rate limiting or authentication, making it vulnerable to abuse.
- **`@ts-ignore` usage** — several router and worker files suppress TypeScript errors with `// @ts-ignore`; these should be addressed with proper type guards.
- **KafkaJS installed but unused** — `kafkajs` is listed in `dependencies` but the current pipeline uses only Redis Streams. It appears to be reserved for a future architectural change.
- **Single-process architecture** — the Producer loop, Consumer loop, and HTTP server all share one Node.js process. For production scale, these should run as separate processes or containers.
- **No email verification** — the signup flow has a placeholder comment `// await send email verification` but the verification step is not implemented.
- **Polling not self-scheduled** — Gmail, Sheets, Slides, Calendar, and Docs polling endpoints are on-demand REST calls with no internal scheduler. An external system (another cron job, a separate scheduler service) must call these periodically for each active Zap.
- **Drive watch IST offset** — expiration dates stored in `google_drive_watch` have an IST offset applied, which is inconsistent with UTC-stored values elsewhere and can cause subtle timing bugs in the watch refresh logic.

---

## License

This project is private and does not include a public license.