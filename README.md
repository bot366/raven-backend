# RAVEN Backend

TypeScript + Fastify + PostgreSQL file-transfer API. The database stores transfer metadata; uploaded files are stored on disk.

## Requirements
- Node.js 20+
- PostgreSQL
- Postman

## Setup
1. Extract the project and open this folder in VS Code.
2. Run `npm install`.
3. Create a PostgreSQL database named `transfers` (or choose another name and update `DATABASE_URL`).
4. Copy `.env.example` to `.env` and set your PostgreSQL password.
5. Run `npm run db:migrate`.
6. Run `npm run dev`.
7. Check `GET http://localhost:3000/health`.

Example database URL:
`postgresql://postgres:YOUR_PASSWORD@localhost:5432/transfers`

## API reference

All routes use `http://localhost:3000` as the local base URL.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Check API and database |
| POST | `/transfers` | Create a transfer session |
| GET | `/transfers/:id` | Get transfer metadata/status |
| POST | `/transfers/:id/upload` | Upload one file to a session |
| GET | `/transfers/:id/download` | Download file by transfer ID |
| GET | `/share/:token` | Download through a share token |

### 1. Health check
`GET http://localhost:3000/health`

Expected: `200`
```json
{"status":"ok","service":"RAVEN API","database":"connected"}
```

### 2. Create a transfer
`POST http://localhost:3000/transfers`

Headers: `Content-Type: application/json`

Body (raw JSON):
```json
{
  "filename": "sample.pdf",
  "filesize": 0
}
```
Use `filesize: 0` if you do not know the file size yet. The actual upload updates the filename and size. Expected: `201`. Save `transfer.id` from the response.

### 3. Upload a file
`POST http://localhost:3000/transfers/PASTE_ID_HERE/upload`

In Postman:
- Body -> form-data
- Key: `file`
- Change the key type from Text to File
- Select a local test file
- Do not manually set `Content-Type`; Postman adds the multipart boundary.
- Send.

Expected: `201`, `status` becomes `completed`, and the response contains `shareUrl`.

### 4. Get transfer details
`GET http://localhost:3000/transfers/PASTE_ID_HERE`

Expected: `200` with filename, size, status, timestamps and download URL.

### 5. Download by ID
`GET http://localhost:3000/transfers/PASTE_ID_HERE/download`

Expected: `200` and the file is returned. In Postman use the arrow beside Send -> Send and Download, or save the response.

### 6. Download using share link
Copy `shareUrl` from the upload response, for example:
`http://localhost:3000/share/SHARE_TOKEN`

Send it as a GET request. Expected: `200` and file download.

## Suggested Postman test sequence
1. Health check.
2. Create transfer; copy the returned ID.
3. Upload a file using that ID.
4. Get transfer details using that ID.
5. Download using the ID.
6. Download using the share URL.
7. Try a random ID (should return `404`).
8. Try uploading again to the completed transfer (should return `409`).

## Postman environment variables (optional)
Create an environment with:
- `baseUrl` = `http://localhost:3000`
- `transferId` = paste the ID after creating a transfer
- `shareUrl` = paste the returned share URL

Then use `{{baseUrl}}/transfers/{{transferId}}`.

## Status values
- `pending`: session created; file not uploaded yet
- `completed`: file stored successfully
- `expired`: transfer expiry time has passed

## Notes and production work still needed
- Upload progress bars belong in the client: Postman can show request progress, but the backend does not currently persist byte-by-byte progress.
- Files are stored on the local disk. For deployment across multiple server instances, use object storage such as S3-compatible storage.
- This starter does not include authentication, malware scanning, rate limiting, resumable/chunked uploads, or automated deletion of expired files. Add these before exposing it publicly.
- The migration uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` to extend an existing `transfers` table. Back up your database before running migrations on valuable data.
- Do not commit `.env` or uploaded files to Git.
