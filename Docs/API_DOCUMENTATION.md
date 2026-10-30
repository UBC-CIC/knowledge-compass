# Knowledge Compass REST API Documentation

This document provides comprehensive documentation for the Knowledge Compass REST API, including endpoint descriptions, authentication requirements, request/response formats, and example usage.

## Table of Contents

- [Authentication](#authentication)
- [Base URL](#base-url)
- [Common Headers](#common-headers)
- [Error Responses](#error-responses)
- [Public Endpoints](#public-endpoints)
- [User Endpoints](#user-endpoints)
- [Chat Session Endpoints](#chat-session-endpoints)
- [System Message Endpoints](#system-message-endpoints)
- [Public Settings Endpoints](#public-settings-endpoints)
- [Feedback Endpoints](#feedback-endpoints)
- [Admin Endpoints](#admin-endpoints)
- [WebSocket API](#websocket-api)

## Authentication

Every endpoint except `GET /user/publicToken` requires a token in the `Authorization` header. There are two kinds:

- **Public users (no account).** `POST /user` creates an anonymous user and returns a 30-day `credential`. Send it as `Authorization: Bearer <credential>` to `GET /user/publicToken` to get a 15-minute access token bound to that user. Without a credential, `GET /user/publicToken` returns an anonymous token that can only create a user and read public settings.
- **Administrators.** Sign in with Amazon Cognito (TOTP MFA required) and send the Cognito ID token.

---

### Obtaining a Token

Public access token:

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/publicToken" \
  -H "Authorization: Bearer {credential}"
```

Admin ID token:

```javascript
// JavaScript example using AWS Amplify
import { fetchAuthSession } from "aws-amplify/auth";

const session = await fetchAuthSession();
const token = session.tokens?.idToken?.toString();
```

---

### Authorization Levels

The API uses two custom Lambda authorizers:

- **adminAuthorizer**: Verifies the Cognito ID token and requires membership of the `admin` group. Required for all `/admin/*` endpoints.
- **userAuthorizer**: Verifies a public access token. User and chat session routes require a token bound to the user named in the request; an anonymous token only reaches `POST /user` and the public settings routes.

`GET /user/publicToken` has no authorizer.

## Base URL

```
https://{api-id}.execute-api.{region}.amazonaws.com/prod
```

Replace `{api-id}` and `{region}` with your API Gateway deployment values (found in the AWS Console or CDK outputs).

## Common Headers

```
Authorization: {access-token or cognito-id-token}
Content-Type: application/json
```

## Error Responses

### Standard Error Format

```json
{ "error": "Error message description" }
```

### HTTP Status Codes

- `200` - Success
- `201` - Created
- `204` - No Content
- `400` - Bad Request
- `401` - Unauthorized (missing or invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `409` - Conflict (e.g. duplicate resource)
- `500` - Internal Server Error

---

# Public Endpoints

These endpoints require no authentication.

## Get Public Token

Returns a 15-minute access token. With `Authorization: Bearer <credential>` (from `POST /user`) the token is bound to that user; without it the token is anonymous.

**Endpoint:** `GET /user/publicToken`

**Response:**

```json
{ "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
```

When the server rotates the credential (about daily), the response also includes `credential`; the client must replace its stored one. A credential that is invalid, expired, revoked or whose user no longer exists returns `401`; create a new user.

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/publicToken" \
  -H "Authorization: Bearer {credential}"
```

---

# User Endpoints

These endpoints require a public access token (`userAuthorizer`).

## Create User

Create a new guest user record. Guests never hold an email address.

**Endpoint:** `POST /user`

**Request Body:**

```json
{
  "display_name": "Jane Doe"
}
```

**Parameters:**

- `display_name` (string, optional): Display name, trimmed and cut to 64 characters

Any other field (`role`, `email`, `metadata`) is ignored. New users are always `student` guests.

**Response:**

```json
{
  "userId": "uuid",
  "credential": "eyJhbGciOi...",
  "role": "student",
  "email": null,
  "display_name": "Jane Doe",
  "created_at": "2024-01-15T10:30:00.000Z",
  "last_seen_at": "2024-01-15T10:30:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"display_name": "Jane Doe"}'
```

---

## Get User

Retrieve a user by ID.

**Endpoint:** `GET /user/{user_id}`

**Path Parameters:**

- `user_id` (uuid, required): The user's UUID

**Response:** `200 OK` with user object

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Get Chat History

Get paginated message history for a chat session owned by a user.

**Endpoint:** `GET /user/{user_id}/chat_sessions/{chat_session_id}/chat_history`

**Path Parameters:**

- `user_id` (uuid, required): Owner's UUID
- `chat_session_id` (uuid, required): Chat session UUID

**Query Parameters:**

- `limit` (integer, optional): Messages to return, max 1000 (default: 200)
- `offset` (integer, optional): Messages to skip (default: 0)

**Response:**

```json
{
  "chat_session_id": "uuid",
  "user_id": "uuid",
  "messages": [
    {
      "id": "uuid",
      "chat_session_id": "uuid",
      "sender": "user",
      "content": "What programs are available?",
      "sources": null,
      "warning": null,
      "created_at": "2024-01-20T14:22:00.000Z"
    }
  ],
  "pagination": {
    "limit": 200,
    "offset": 0,
    "total": 42,
    "hasMore": false
  }
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid/chat_sessions/uuid/chat_history?limit=50&offset=0" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

# Chat Session Endpoints

These endpoints require a public access token (`userAuthorizer`).

## Create Chat Session

Create a new chat session for a user.

**Endpoint:** `POST /chat_sessions`

**Request Body:**

```json
{
  "user_id": "uuid",
  "title": "My first chat",
  "metadata": {}
}
```

**Parameters:**

- `user_id` (uuid, required): Owner's UUID
- `title` (string, optional): Chat session title
- `metadata` (object, optional): Arbitrary metadata

**Response:**

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "title": "My first chat",
  "created_at": "2024-01-15T10:30:00.000Z",
  "last_active_at": "2024-01-15T10:30:00.000Z",
  "metadata": null
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"user_id": "uuid", "title": "My first chat"}'
```

---

## Get Chat Sessions for User

Get all chat sessions belonging to a user.

**Endpoint:** `GET /chat_sessions/user/{user_id}`

**Path Parameters:**

- `user_id` (uuid, required): User UUID

**Response:** `200 OK` with list of chat session objects

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/user/uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Rename Chat Session

Rename a chat session. Only the owning user may update.

**Endpoint:** `PUT /chat_sessions/{chat_session_id}`

**Path Parameters:**

- `chat_session_id` (uuid, required): Chat session UUID

**Query Parameters:**

- `user_id` (uuid, required): Owner's UUID (used to verify ownership)

**Request Body:**

```json
{ "title": "Renamed session" }
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/uuid?user_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"title": "Renamed session"}'
```

---

## Delete Chat Session

Delete a chat session. Only the owning user may delete.

**Endpoint:** `DELETE /chat_sessions/{chat_session_id}`

**Path Parameters:**

- `chat_session_id` (uuid, required): Chat session UUID

**Query Parameters:**

- `user_id` (uuid, required): Owner's UUID (used to verify ownership)

**Response:** `204 No Content`

**Example (cURL):**

```bash
curl -X DELETE "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/uuid?user_id=uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Generate Text Response

Generate an AI response for a message in a chat session.

**Endpoint:** `POST /chat_sessions/{chat_session_id}/text_generation`

**Path Parameters:**

- `chat_session_id` (uuid, required): Chat session UUID

**Request Body:**

```json
{
  "query": "My son's school wants him in a separate classroom. What can I do?",
  "user_id": "uuid"
}
```

**Parameters:**

- `query` (string, required): The user's message
- `user_id` (uuid, optional): User UUID

**Response:**

```json
{
  "response": "That sounds stressful. Can you tell me a bit more about...",
  "sources": []
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/uuid/text_generation" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"query": "How do I ask for an IEP meeting?", "user_id": "uuid"}'
```

---

# System Message Endpoints

These endpoints require a public access token (`userAuthorizer`).

## Get Active System Message

Get the currently active version of a system message by type.

**Endpoint:** `GET /system_message/{message_type}`

**Path Parameters:**

- `message_type` (string, required): One of:
  - `disclaimer`, `guardrails`, `system_role`, `system_checklist`, `system_instructions`
  - `initial_prompt`, `detective_phase_prompt`, `suggestion_phase_prompt`
  - `welcome_message`, `partial_hallucination_warning`, `full_hallucination_warning`

**Response:**

```json
{
  "id": "uuid",
  "type": "disclaimer",
  "message": "AI can make mistakes. Check important info.",
  "version": 2,
  "created_at": "2024-01-15T10:30:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/system_message/disclaimer" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

# Public Settings Endpoints

These endpoints accept any public access token, including an anonymous one.

## Get Max Characters Per User Message

**Endpoint:** `GET /system-settings/max-characters-per-user-message`

**Response:**

```json
{ "max_characters_per_user_message": 2000 }
```

---

## Get Service Status

Maintenance banner and read-only flag for the chat UI. Cacheable for 30 seconds.

**Endpoint:** `GET /system-settings/service-status`

**Response:**

```json
{ "service_status": "banner", "service_message": "Planned maintenance tonight from 8 to 9 pm." }
```

`service_status` is `normal`, `banner` or `read_only`; `service_message` is `null` when the status is `normal`.

---

# Feedback Endpoints

End-of-conversation thumbs up/down with an optional comment. One feedback row per chat session; only the owning user may read or change it (`userAuthorizer`).

## Get Session Feedback

**Endpoint:** `GET /chat_sessions/{chat_session_id}/feedback?user_id={uuid}`

**Response:**

```json
{ "feedback": { "rating": "up", "comment": null, "updated_at": "2026-10-15T10:30:00.000Z" } }
```

`feedback` is `null` if none has been given.

---

## Save Session Feedback

Create or replace the feedback for a session.

**Endpoint:** `PUT /chat_sessions/{chat_session_id}/feedback?user_id={uuid}`

**Request Body:**

```json
{ "rating": "down", "comment": "The steps did not fit our province." }
```

- `rating` (string, required): `up` or `down`
- `comment` (string, optional)

**Response:**

```json
{ "rating": "down", "has_comment": true, "updated_at": "2026-10-15T10:30:00.000Z" }
```

---

# Admin Endpoints

All admin endpoints require a valid Cognito token with admin privileges (`adminAuthorizer`).

## User Management

### List Users

Get a paginated list of all users.

**Endpoint:** `GET /admin/users`

**Query Parameters:**

- `limit` (integer, optional): Number of users to return (default: 50)
- `offset` (integer, optional): Number of users to skip (default: 0)

**Response:** `200 OK` with list of user objects

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/users?limit=50&offset=0" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create Admin User

Create an administrator. Creates the Cognito user (Cognito emails a temporary password), adds it to the `admin` group and writes its `users` row. An email that already has a Cognito account is added to the `admin` group instead. Served by `adminProvisioningHandler.js`, the only handler allowed to call Cognito admin APIs. The email domain must be allowed by `/KC/AllowedEmailDomains`.

**Endpoint:** `POST /admin/users`

**Request Body:**

```json
{
  "display_name": "Jane Smith",
  "email": "jane.smith@example.com"
}
```

**Parameters:**

- `display_name` (string, required): Display name (max 255 chars)
- `email` (string, required): Email address (max 255 chars)

**Response:** `201 Created` for a new Cognito user, `200 OK` for an existing one

```json
{
  "id": "uuid",
  "display_name": "Jane Smith",
  "email": "jane.smith@example.com",
  "role": "admin",
  "cognito": "created"
}
```

`cognito` is `created` or `existing`.

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/users" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"display_name": "Jane Smith", "email": "jane.smith@example.com"}'
```

---

### Ensure Own Admin Row

Find, link or create the signed-in administrator's own `users` row (keyed on the Cognito sub from the authorizer) and set its role to `admin`. Acts only on the caller; the request body is ignored (`user_id`, `email` and `role` are accepted for compatibility but unused). The dashboard calls it after sign-in.

**Endpoint:** `POST /admin/promote_user`

**Response:** `200 OK` with the updated user

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/promote_user" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get User Chat Sessions

Get all chat sessions for a specific user.

**Endpoint:** `GET /admin/users/{userId}/chat_sessions`

**Path Parameters:**

- `userId` (uuid, required): The user's UUID

**Query Parameters:**

- `limit` (integer, optional): Default 50
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with list of chat session objects

---

### Get Chat Session Messages

Get all messages for a specific chat session.

**Endpoint:** `GET /admin/chat_sessions/{sessionId}/messages`

**Path Parameters:**

- `sessionId` (uuid, required): Chat session UUID

**Query Parameters:**

- `limit` (integer, optional): Default 200
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with list of message objects

---

## Knowledge Base / Data Sources

### List Data Sources

List all data sources with their latest ingestion run status.

**Endpoint:** `GET /admin/data_sources`

**Response:**

```json
{
  "items": [
    {
      "data_source": {
        "id": "uuid",
        "name": "https://example.com",
        "type": "website",
        "created_at": "2024-01-15T10:30:00.000Z",
        "metadata": {},
        "include_patterns": null,
        "exclude_patterns": null
      },
      "latest_ingestion_run": {
        "id": "uuid",
        "data_source_id": "uuid",
        "status": "completed",
        "error_message": null,
        "created_at": "2024-01-15T10:30:00.000Z",
        "completed_at": "2024-01-15T10:35:00.000Z"
      }
    }
  ]
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/data_sources" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Stage Data Sources

Stage a new data source (website or CSV) for future syncing.

**Endpoint:** `POST /admin/data_sources`

**Request Body (website):**

```json
{
  "type": "website",
  "created_by": "admin@example.com",
  "name": "https://example.com",
  "include_patterns": ["/docs/*"],
  "exclude_patterns": ["/blog/*"]
}
```

**Request Body (CSV):**

```json
{
  "type": "csv",
  "created_by": "admin@example.com",
  "csv_file_name": "data.csv",
  "csv_s3_bucket": "my-kb-bucket",
  "csv_s3_key": "uploads/csv/1712345678_data.csv",
  "metadata_s3_key": "uploads/json/1712345678_data.csv.metadata.json"
}
```

**Parameters:**

- `type` (string, required): `website` or `csv`
- `created_by` (string, required): Admin email
- `name` (string, optional): URL for website sources
- `include_patterns` / `exclude_patterns` (array, optional): URL path filters for web crawling
- `csv_file_name`, `csv_s3_bucket`, `csv_s3_key` (string): Required for CSV sources
- `metadata_file_name`, `metadata_s3_bucket`, `metadata_s3_key` (string, optional): Metadata file for CSV sources

**Response:**

```json
{
  "message": "Data source staged",
  "action": "staged",
  "type": "website",
  "created_by": "admin@example.com",
  "staged_data_source_ids": ["uuid"]
}
```

---

### Sync Data Sources

Queue all pending data sources and begin ingestion.

**Endpoint:** `POST /admin/data_sources/sync`

**Request Body (optional):**

```json
{ "created_by": "admin@example.com" }
```

**Response:**

```json
{
  "message": "Sync started",
  "action": "sync_started",
  "sync_session_id": "uuid",
  "queued_count": 3,
  "s3_queued_count": 1,
  "website_queued_count": 2
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/data_sources/sync" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"created_by": "admin@example.com"}'
```

---

### Generate Presigned Upload URL

Generate an S3 presigned URL for uploading a single knowledge base file.

**Endpoint:** `GET /admin/generate-presigned-url`

**Query Parameters:**

- `file_name` (string, required): Name of the file to upload (max 255 chars)
- `content_type` (string, optional): MIME type (default: `application/octet-stream`)

**Response:**

```json
{
  "presignedUrl": "https://s3.amazonaws.com/bucket/path?...",
  "key": "uploads/csv/1712345678_3f9c2a1b7e4d8c06_data.csv",
  "bucket": "my-kb-bucket"
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/generate-presigned-url?file_name=data.csv&content_type=text/csv" \
  -H "Authorization: eyJraWQiOiJ..."
```

**Notes:**
- The returned `bucket`/`key` are recorded against the calling admin. `POST /admin/data_sources` (and `/batch`) only accept a location issued to the same admin, within 24 hours, and each location can be staged once; anything else is rejected with 400. Upload the file again to get a new location.

---

### Generate Presigned Upload URLs (Batch)

Generate presigned S3 upload URLs for multiple files in a single request. Use this for zip uploads to avoid hitting WAF rate limits from calling the single-file endpoint in a loop.

**Endpoint:** `POST /admin/generate-presigned-urls/batch`

**Request Body:**

```json
{
  "files": [
    { "file_name": "alumni.csv", "content_type": "text/csv" },
    { "file_name": "alumni.csv.metadata.json", "content_type": "application/json" },
    { "file_name": "courses.md", "content_type": "text/markdown" },
    { "file_name": "courses.md.metadata.json", "content_type": "application/json" }
  ]
}
```

**Parameters:**

- `files` (array, required): Up to 200 file descriptors
  - `file_name` (string, required): File name (max 255 chars)
  - `content_type` (string, optional): MIME type (default: `application/octet-stream`)

**Response:**

```json
{
  "presigned_urls": [
    {
      "file_name": "alumni.csv",
      "presigned_url": "https://s3.amazonaws.com/bucket/path?...",
      "key": "uploads/csv/1712345678_a41e9d03c27b5f18_alumni.csv",
      "bucket": "my-kb-bucket"
    }
  ]
}
```

**Notes:**
- Presigned URLs expire after 10 minutes
- Each returned `bucket`/`key` is bound to the calling admin and can be staged once, within 24 hours (see the single-file endpoint)
- S3 uploads go directly to S3 and do not pass through WAF
- Supported content types: `text/csv`, `text/markdown`, `application/json`, `text/json`, `application/octet-stream`

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/generate-presigned-urls/batch" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"files": [{"file_name": "alumni.csv", "content_type": "text/csv"}]}'
```

---

### Stage Data Sources (Batch)

Stage multiple CSV/Markdown + metadata JSON file pairs in a single request. Designed for zip uploads. Duplicates are silently skipped.

**Endpoint:** `POST /admin/data_sources/batch`

**Request Body:**

```json
{
  "created_by": "admin@example.com",
  "items": [
    {
      "type": "csv",
      "primary_file_name": "alumni.csv",
      "primary_s3_bucket": "my-kb-bucket",
      "primary_s3_key": "uploads/csv/1712345678_alumni.csv",
      "metadata_file_name": "alumni.csv.metadata.json",
      "metadata_s3_bucket": "my-kb-bucket",
      "metadata_s3_key": "uploads/json/1712345678_alumni.csv.metadata.json"
    }
  ]
}
```

**Parameters:**

- `created_by` (string, required): Admin email
- `items` (array, required): Up to 100 file pairs
  - `type` (string, required): `csv` or `markdown`
  - `primary_file_name` (string, required): CSV or Markdown file name
  - `primary_s3_bucket` / `primary_s3_key` (string, required): S3 location of the primary file
  - `metadata_file_name` (string, required): Must match `{primary_file_name}.metadata.json`
  - `metadata_s3_bucket` / `metadata_s3_key` (string, required): S3 location of the metadata file

**Response:**

```json
{
  "message": "Batch staging complete. 2 staged, 1 skipped, 0 failed.",
  "staged_count": 2,
  "skipped_count": 1,
  "error_count": 0,
  "staged": [{ "index": 0, "file": "alumni.csv", "data_source_ids": ["uuid", "uuid"] }],
  "skipped": [{ "index": 1, "file": "courses.csv", "reason": "already_staged" }],
  "errors": []
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/data_sources/batch" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"created_by": "admin@example.com", "items": [...]}'
```

---

### Other Knowledge Base Routes

These routes are served by the knowledge base Lambda. The ingestion lifecycle behind them is described in [`KNOWLEDGE_BASE_DOCUMENTATION.md`](./KNOWLEDGE_BASE_DOCUMENTATION.md#admin-routes).

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/admin/data_sources/{id}/retry` | Add a `pending` run for a source whose latest run failed (`409` otherwise) |
| `GET` | `/admin/data_sources/{id}/links` | Per-row link status for a CSV with a URL column (`status`, `limit`, `offset` query parameters) |
| `DELETE` | `/admin/data_sources/{id}` | Delete a source, its chunks and vectors, and its S3 objects |
| `GET` | `/admin/embedding-models` | Embedding models that can back a new space |
| `GET`, `POST` | `/admin/embedding-spaces` | List or create embedding spaces |
| `POST` | `/admin/embedding-spaces/{id}/jobs` | Start a dry run, rebuild or delta job |
| `POST` | `/admin/embedding-spaces/{id}/validate` | Validate a space |
| `POST` | `/admin/embedding-spaces/{id}/activate` | Cut retrieval over to a space |
| `POST` | `/admin/embedding-spaces/{id}/rollback` | Cut back to a retired space |
| `POST` | `/admin/embedding-spaces/{id}/purge` | Delete a retired space's vectors |
| `GET` | `/admin/embedding-jobs/{id}` | Poll an embedding job |
| `GET` | `/admin/guideline` | Guideline documents, detected sections and prompt mode |
| `POST` | `/admin/guideline/upload-url` | Presigned upload URL for a guideline document |
| `POST` | `/admin/guideline/documents` | Register an uploaded guideline document |
| `DELETE` | `/admin/guideline/documents/{id}` | Remove a guideline document |
| `PATCH` | `/admin/guideline/sections/{id}` | Override a detected section's label |
| `PUT` | `/admin/guideline/mode` | Switch the prompt mode |

Routes that can start ingestion return `409` with `CUTOVER_LOCKED` while an embedding-space cutover runs.

---

## Journeys and Situations

Journeys and their situation clusters drive the router and the guidance prompts. Each journey has versioned `detective_questions` and `guidance` prompt fields; each cluster has a versioned `response_pattern`.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/admin/journeys` | Journeys with their clusters and prompt versions (archived included) |
| `POST` | `/admin/journeys` | Create a journey. Body: `key`, `name` (required); `description`, `detection_signals`, `sort_order`, `detective_questions`, `guidance`. `BOTH`, `UNCLEAR`, `UNKNOWN` and `NONE` are reserved keys |
| `PUT` | `/admin/journeys/{journey_id}` | Update `name`, `description`, `detection_signals`, `sort_order`, or archive/restore with `is_archived` (the last active journey cannot be archived) |
| `POST` | `/admin/journeys/{journey_id}/clusters` | Add a cluster. Body: `key`, `name`, `matches_when` (required); `sort_order`, `response_pattern` |
| `PUT` | `/admin/clusters/{cluster_id}` | Update `name`, `matches_when`, `sort_order`, or `is_archived` |
| `POST` | `/admin/journey-prompts` | Save a new active version. Body: `field` (`detective_questions`, `guidance` or `response_pattern`), `owner_id` (journey id, or cluster id for `response_pattern`), `content` |
| `POST` | `/admin/journey-prompts/{version_id}/activate` | Activate a version (deactivates the previous one) |
| `DELETE` | `/admin/journey-prompts/{version_id}` | Delete a version that is not active (`409` for the active one) |
| `GET` | `/admin/journeys/feedback` | Thumbs up/down counts per journey and cluster. `timeRange`: `7d`, `30d` (default), `3m`, `1y` or `all` |

---

## Feedback Triage

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/admin/feedback/{chat_session_id}/message` | The assistant reply the feedback was left on |
| `PUT` | `/admin/feedback/{chat_session_id}` | Star or dismiss feedback (shared by all admins). Body: `starred`, `dismissed` (booleans) |

---

## System Settings

### Get System Settings

Retrieve the current system settings.

**Endpoint:** `GET /admin/system-settings`

**Response:**

```json
{
  "id": "uuid",
  "max_messages_per_day": 45,
  "min_messages_before_suggest": 4,
  "routing_mode": "fixed",
  "min_exchanges_before_answer": 0,
  "max_characters_per_user_message": 2000,
  "max_characters_per_day": 10000,
  "max_messages_per_day_global": 5000,
  "max_characters_per_ai_message": 5000,
  "temperature": 0.15,
  "top_p": 0.5,
  "support_score_threshold": 0.25,
  "scope_alignment_score_threshold": 0.25,
  "grounded_threshold": 0.75,
  "partially_grounded_threshold": 0.5,
  "service_status": "normal",
  "service_message": null,
  "updated_by_email": "admin@example.com",
  "updated_at": "2026-10-15T10:30:00.000Z"
}
```

The values shown are the defaults returned when no settings row exists.

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-settings" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update System Settings

Update one or more system settings (partial update).

**Endpoint:** `PUT /admin/system-settings`

**Request Body:**

```json
{
  "max_characters_per_day": 12000,
  "service_status": "banner",
  "service_message": "Planned maintenance tonight from 8 to 9 pm."
}
```

**Parameters (all optional):**

- `max_messages_per_day` (integer, 1–1000): Max messages per user per day
- `min_messages_before_suggest` (integer, 0–500): Fixed mode: exchanges before guidance. Dynamic mode: the latest exchange by which guidance is given
- `routing_mode` (string): `fixed` (exchange count decides) or `dynamic` (the per-turn router decides)
- `min_exchanges_before_answer` (integer, 0–500): Dynamic mode floor before guidance
- `max_characters_per_user_message` (integer, 1–200000): Max length of one user message
- `max_characters_per_day` (integer): Characters one user may send per UTC day
- `max_messages_per_day_global` (integer): Messages all public users together may send per UTC day
- `max_characters_per_ai_message` (integer): Max AI response length
- `temperature`, `top_p` (number, 0–1): Stored but **not sent** to the model (Claude Haiku 5.5 rejects non-default sampling values)
- `support_score_threshold`, `scope_alignment_score_threshold`, `grounded_threshold`, `partially_grounded_threshold` (number, 0–1): Grounding check thresholds
- `service_status` (string): `normal`, `banner` (show `service_message` above the chat) or `read_only` (show it and refuse new chat turns)
- `service_message` (string, up to 500 characters): Text shown to families; `null` when unused

**Response:** `200 OK` with the updated settings object

**Example (cURL):**

```bash
curl -X PUT "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-settings" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"max_characters_per_day": 12000}'
```

---

## Analytics

### Get Analytics

Get usage analytics time series and totals.

**Endpoint:** `GET /admin/analytics`

**Query Parameters:**

- `timeRange` (string, optional): Time range — `7d`, `30d`, `90d`, `6m`, `1y` (default: `90d`)
- `endDaysAgo` (integer, optional): End of the window in days ago, inclusive — e.g. `timeRange=10d&endDaysAgo=4` covers 10 to 4 days ago (default: `0`, i.e. up to now)

**Response:**

```json
{
  "totals": {
    "users": 120,
    "chat_sessions": 450,
    "messages": 3200,
    "questions": 1800
  },
  "timeSeries": [
    {
      "date": "2024-01-20",
      "users": 12,
      "questions": 45,
      "chat_sessions": 18
    }
  ]
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/analytics?timeRange=30d" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## System Messages

### Get All System Messages

Get all system message types with their full version history. Active version is listed first.

**Endpoint:** `GET /admin/system-messages`

**Response:**

```json
{
  "disclaimer": [
    {
      "id": "uuid",
      "type": "disclaimer",
      "content": "AI can make mistakes. Check important info.",
      "character_limit": 400,
      "version": 2,
      "is_active": true,
      "affects_text_generation": false,
      "created_by": "uuid",
      "created_by_email": "admin@example.com",
      "created_at": "2024-01-15T10:30:00.000Z"
    }
  ],
  "welcome_message": [...]
}
```

**System message types:**

| Type | Description |
|---|---|
| `disclaimer` | Disclaimer shown to users |
| `guardrails` | Content guardrail instructions |
| `system_role` | AI system role definition |
| `system_checklist` | AI checklist instructions |
| `system_instructions` | General AI instructions |
| `initial_prompt` | Initial conversation prompt |
| `detective_phase_prompt` | Detective phase AI prompt |
| `suggestion_phase_prompt` | Suggestion phase AI prompt |
| `welcome_message` | Welcome message shown on chat |
| `partial_hallucination_warning` | Warning for partial hallucinations |
| `full_hallucination_warning` | Warning for full hallucinations |

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create System Message Version

Create a new version of a system message and set it as active.

**Endpoint:** `POST /admin/system-messages/{system_message_type}`

**Path Parameters:**

- `system_message_type` (string, required): One of the types listed above

**Request Body:**

```json
{
  "content": "AI can make mistakes. Always verify important information.",
  "adminEmail": "admin@example.com"
}
```

**Parameters:**

- `content` (string, required): The full message content
- `adminEmail` (string, required): Email of the admin creating this version

**Response:** `200 OK` with the newly created version object (is_active: true)

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages/disclaimer" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"content": "AI can make mistakes.", "adminEmail": "admin@example.com"}'
```

---

### Activate System Message Version

Set a specific version as the active version for its type.

**Endpoint:** `POST /admin/system-messages/{system_message_type}/{version_id}/activate`

**Path Parameters:**

- `system_message_type` (string, required): Message type
- `version_id` (uuid, required): UUID of the version to activate

**Request Body:**

```json
{ "adminEmail": "admin@example.com" }
```

**Response:**

```json
{
  "success": true,
  "status": "activated",
  "activated": { "id": "uuid", "type": "disclaimer", "version": 2, "is_active": true, "..." : "..." },
  "previous_active": { "id": "uuid", "version": 1 }
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages/disclaimer/uuid/activate" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"adminEmail": "admin@example.com"}'
```

---

### Delete System Message Version

Delete a non-active system message version. Active versions cannot be deleted.

**Endpoint:** `DELETE /admin/system-messages/{system_message_type}/{version_id}`

**Path Parameters:**

- `system_message_type` (string, required): Message type
- `version_id` (uuid, required): UUID of the version to delete

**Request Body:**

```json
{ "adminEmail": "admin@example.com" }
```

**Response:**

```json
{
  "success": true,
  "deleted": { "id": "uuid", "type": "disclaimer", "version": 1 }
}
```

**Example (cURL):**

```bash
curl -X DELETE "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages/disclaimer/uuid" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"adminEmail": "admin@example.com"}'
```

---

## Security Considerations

### Token Management

- Cognito ID tokens expire after 1 hour — use refresh tokens to obtain new ones
- Never expose tokens in logs or client-side code
- Use AWS Amplify for automatic secure token storage and refresh

### CORS

All endpoints support CORS with the following headers:

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: *`
- `Access-Control-Allow-Headers: Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token`

### Input Validation

- Request bodies are validated against schemas defined in the OpenAPI spec
- Query parameters are type-checked
- The raw OpenAPI/Swagger definition is located at `cdk/OpenAPI_Swagger_Definition.yaml`

## WebSocket API

For real-time streaming AI responses, use the WebSocket API instead of the REST text generation endpoint.

**WebSocket URL:**

```
wss://{websocket-api-id}.execute-api.{region}.amazonaws.com/prod
```

The WebSocket URL is available as a CDK output after deployment.

**Authentication:**

```javascript
const ws = new WebSocket(url, ["kc.v1", accessToken]);
```

`accessToken` is the user-bound access token from `GET /user/publicToken` (sent with the stored credential). It travels in the `Sec-WebSocket-Protocol` header, never in the URL; tokens in the query string are ignored. Non-browser clients may send `Authorization: Bearer <accessToken>` instead. The server echoes `kc.v1` and binds the connection to the token's user. Each `generate_text` frame also carries the current `token`, which must belong to that same user; a frame for another user gets an `error` event with `error: "CONNECTION_USER_MISMATCH"`. Frames on a connection with no binding get `error: "CONNECTION_NOT_AUTHORIZED"` and the server closes the socket; the client reconnects (or falls back to the REST text generation endpoint).

## Troubleshooting

### 401 Unauthorized

- Verify the `Authorization` header is present and contains a valid Cognito ID token
- Check the token hasn't expired (1 hour lifetime)

```javascript
import { fetchAuthSession } from "aws-amplify/auth";
const session = await fetchAuthSession({ forceRefresh: true });
const token = session.tokens?.idToken?.toString();
```

### 403 Forbidden

- Verify the user has the required role (`admin` for `/admin/*` endpoints)
- Admin and user authorizers are separate — having an admin account does not automatically grant user-level access if the user record doesn't exist

### 404 Not Found

- Verify the resource ID is correct
- Check the user owns the resource (for user-scoped endpoints)

### 409 Conflict

- A resource with the same identifier already exists (e.g. duplicate email on user creation)

### 500 Internal Server Error

- Check CloudWatch logs for the relevant Lambda function for detailed error information
- Verify the request body matches the expected schema

---

**API Version:** 1.0.0  
**OpenAPI Spec:** `cdk/OpenAPI_Swagger_Definition.yaml`
