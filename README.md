# RAVEN

RAVEN is a React + TypeScript file-sharing application backed by Fastify, Neon PostgreSQL, and server-side file storage.

## Architecture
- Frontend: Vite static site on Render
- API: Fastify web service on Render
- Database: Neon PostgreSQL
- Authentication: Argon2id password hashes, opaque server-side sessions in Secure, HttpOnly cookies, and email ownership verification before transfers
- Transfers: each transfer is owned by its creating account; public share-token downloads remain available to anyone holding the link until expiry.
- Profiles: unique usernames, username/email recipient lookup, generated initials avatars, and optional profile photos.
- Dashboard: responsive overview, sent/received files, shared links, profile settings, and a small animated 2D raven during uploads.

## Deploy the backend
- Root directory: repository root
- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment variables:
  - `DATABASE_URL`: Neon connection string for database `raven_db`
  - `CORS_ORIGIN`: exact deployed frontend origin, without trailing slash
  - `PUBLIC_BASE_URL`: backend public origin
  - `MAX_FILE_SIZE_MB`: upload limit (default 100)
  - `TRANSFER_EXPIRY_HOURS`: transfer lifetime (default 24)
  - `STORAGE_DIR`: local storage directory (temporary only on ephemeral hosting)
  - `RESEND_API_KEY`: Resend sending API key (keep this secret on the backend only)
  - `EMAIL_FROM`: sender address on a verified Resend domain, e.g. `RAVEN <verify@example.com>`
  - `FRONTEND_BASE_URL`: deployed frontend origin used to build verification links
- Run `npm run db:migrate` once after deploying the new API code and before enabling the new frontend. If the Render service has no Shell, run the SQL shown in the `Database update` section using the Neon SQL Editor.

## Database update

The migration adds nullable usernames for existing accounts, avatar metadata, an `email_verified` flag, and hashed one-time email verification tokens. Existing accounts become unverified by default and must verify their current email or change it to a correct address. New accounts must verify before using file transfers.

Run this in the Neon SQL Editor for `raven_db` before testing the new frontend:

```sql
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_path TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_mime_type TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
  ON public.users (LOWER(username))
  WHERE username IS NOT NULL;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_verification_tokens_user_created_idx
  ON public.email_verification_tokens(user_id, created_at DESC);

ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS sha256 TEXT;
ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS chunk_size INTEGER;
ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS chunk_count INTEGER;

CREATE TABLE IF NOT EXISTS public.transfer_chunks (
  transfer_id UUID NOT NULL REFERENCES public.transfers(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_size BIGINT NOT NULL CHECK (chunk_size >= 0),
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (transfer_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS transfer_chunks_transfer_id_idx
  ON public.transfer_chunks(transfer_id);
```

The backend migration script contains the same changes and is safe to rerun.

## Deploy the frontend
- Root directory: `frontend/raven-frontend`
- Build command: `npm install && npm run build`
- Publish directory: `dist`
- Environment variables:
  - `VITE_API_URL`: backend public origin
  - `VITE_MAX_FILE_SIZE_MB=100`

## API routes
- `GET /health`
- `POST /auth/register`, `POST /auth/login` (email or username), `POST /auth/logout`, `GET /auth/me`
- `POST /auth/verify-email`, `POST /auth/resend-verification`, `POST /auth/change-email`
- `PUT /profile/username`, `PUT /profile/avatar`, `GET /profile/avatar`
- `GET /users/lookup?identifier=...`: authenticated username/email recipient lookup
- `GET /transfers`: authenticated user's latest 100 sent transfers
- `GET /transfers/received`: authenticated user's latest 100 files sent directly to their RAVEN account
- `POST /transfers`, `POST /transfers/:id/upload`: authenticated legacy single-request upload; include optional `recipientIdentifier` (username or email) when creating a direct account-to-account transfer
- `POST /transfers/:id/chunks/start`, `GET /transfers/:id/chunks`, `PUT /transfers/:id/chunks/:index`, `POST /transfers/:id/chunks/complete`, `DELETE /transfers/:id/chunks`: authenticated chunked upload session, status, chunk receipt, assembly, and cancellation
- `GET /transfers/:id`, `GET /transfers/:id/download`: authenticated sender or designated recipient
- `GET /share/:token`: public token-based download

## Chunked uploads

The frontend sends 8 MiB chunks with up to three concurrent requests. Each chunk includes a SHA-256 digest in the `X-Chunk-Sha256` header; the backend verifies the digest and exact expected byte length before accepting it. Repeated identical chunk submissions are idempotent. Completion rechecks each stored chunk, assembles chunks in order, calculates a final SHA-256 digest, and only then marks the transfer complete. A failed upload can be retried in the same browser session and already-received chunks are skipped. The chunk manifest is stored in Neon, but chunk bytes are stored in the backend's local filesystem, so resuming after a Render restart is not guaranteed.

## Email verification

New accounts receive a one-time verification link that expires after 30 minutes. Existing accounts are also marked unverified by the migration. Unverified users may sign in, resend the verification message, or change their email after confirming their current password, but transfer creation, recipient lookup, chunk uploads, transfer downloads, and public share-link downloads are blocked until verification succeeds. Verification email is sent by the backend through Resend. Set `RESEND_API_KEY`, `EMAIL_FROM`, and `FRONTEND_BASE_URL` in the Render backend environment before deploying this change. Add and verify a sending domain in Resend first; the sender address must belong to that verified domain. Never expose the Resend key through a `VITE_` frontend variable.

## Security and storage notes
The API requires exact CORS origins and uses credentialed requests with Secure, HttpOnly, SameSite=None session cookies. The browser includes credentials with frontend API calls. State-changing browser requests are checked against the allowed Origin list. Do not use wildcard CORS.

The current file store writes to the service's local filesystem. Render filesystems are ephemeral unless a persistent disk is configured. Uploaded files and profile photos can be lost during restarts or deploys. This is only suitable for temporary testing; configure a persistent disk or S3-compatible object storage before storing important files.

Never commit `.env`, database credentials, API keys, session cookies, or uploaded files.
