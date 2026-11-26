# RAVEN

RAVEN is a React + TypeScript file-sharing application backed by Fastify, Neon PostgreSQL, and server-side file storage.

## Architecture
- Frontend: Vite static site on Render
- API: Fastify web service on Render
- Database: Neon PostgreSQL
- Authentication: Argon2id password hashes and opaque server-side sessions in Secure, HttpOnly cookies
- Transfers: authenticated account-to-account transfers, legacy public share links, and a first end-to-end encrypted direct-transfer path.
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
- Run `npm run db:migrate` once after deploying the new API code and before enabling the new frontend. If the Render service has no Shell, run the SQL shown in the `Database update` section using the Neon SQL Editor.

## Database update

The migration adds nullable usernames for existing accounts and avatar metadata. New signups must choose a username. Existing users are prompted to choose one after logging in.

Run this in the Neon SQL Editor for `raven_db` before testing the new frontend:

```sql
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_path TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS avatar_mime_type TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
  ON public.users (LOWER(username))
  WHERE username IS NOT NULL;

ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS sha256 TEXT;
ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS chunk_size INTEGER;
ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS chunk_count INTEGER;
ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS encryption_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS encrypted_metadata TEXT;
ALTER TABLE public.transfers ADD COLUMN IF NOT EXISTS metadata_nonce TEXT;

CREATE TABLE IF NOT EXISTS public.user_encryption_keys (
  user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version >= 1),
  public_key TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  recovery_salt TEXT NOT NULL,
  recovery_nonce TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.transfer_key_envelopes (
  transfer_id UUID NOT NULL REFERENCES public.transfers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  enc TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (transfer_id, user_id)
);
CREATE INDEX IF NOT EXISTS transfer_key_envelopes_user_created_idx
  ON public.transfer_key_envelopes(user_id, created_at DESC);

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
- `PUT /profile/username`, `PUT /profile/avatar`, `GET /profile/avatar`
- `GET /users/lookup?identifier=...`: authenticated username/email recipient lookup
- `GET /encryption/keys/me`, `PUT /encryption/keys/me`: read or create the caller's encryption identity and encrypted recovery backup
- `GET /encryption/keys/:userId/public`: retrieve a recipient's public encryption key
- `POST /transfers/:id/envelopes`, `GET /transfers/:id/envelope`: store and retrieve participant-only encrypted file-key envelopes
- `GET /transfers`: authenticated user's latest 100 sent transfers
- `GET /transfers/received`: authenticated user's latest 100 files sent directly to their RAVEN account
- `POST /transfers`, `POST /transfers/:id/upload`: authenticated legacy single-request upload; include optional `recipientIdentifier` (username or email) when creating a direct account-to-account transfer
- `POST /transfers/:id/chunks/start`, `GET /transfers/:id/chunks`, `PUT /transfers/:id/chunks/:index`, `POST /transfers/:id/chunks/complete`, `DELETE /transfers/:id/chunks`: authenticated chunked upload session, status, chunk receipt, assembly, and cancellation
- `GET /transfers/:id`, `GET /transfers/:id/download`: authenticated sender or designated recipient
- `GET /share/:token`: public token-based download

## Chunked uploads

The frontend sends 8 MiB chunks with up to three concurrent requests. Each chunk includes a SHA-256 digest in the `X-Chunk-Sha256` header; the backend verifies the digest and exact expected byte length before accepting it. Repeated identical chunk submissions are idempotent. Completion rechecks each stored chunk, assembles chunks in order, calculates a final SHA-256 digest, and only then marks the transfer complete. A failed upload can be retried in the same browser session and already-received chunks are skipped. The chunk manifest is stored in Neon, but chunk bytes are stored in the backend's local filesystem, so resuming after a Render restart is not guaranteed.

## Security and storage notes
The API requires exact CORS origins and uses credentialed requests with Secure, HttpOnly, SameSite=None session cookies. The browser includes credentials with frontend API calls. State-changing browser requests are checked against the allowed Origin list. Do not use wildcard CORS.

The current file store writes to the service's local filesystem. Render filesystems are ephemeral unless a persistent disk is configured. Uploaded files and profile photos can be lost during restarts or deploys. This is only suitable for temporary testing; configure a persistent disk or S3-compatible object storage before storing important files.

Never commit `.env`, database credentials, API keys, session cookies, or uploaded files.


## End-to-end encryption (controlled-testing implementation)

The E2EE path in this branch applies to new direct account-to-account transfers only. The browser encrypts each file chunk with AES-256-GCM before upload. Chunk nonces are unique within the transfer and the transfer ID, chunk index, and chunk count are authenticated as additional data. The filename, MIME type, plaintext size, chunk layout, and nonce prefix are encrypted as transfer metadata. Each file receives a random data-encryption key.

That data key is wrapped separately for the sender and recipient using HPKE Auth mode with DHKEM(P-256), HKDF-SHA256, and AES-256-GCM. The server stores ciphertext, the encrypted metadata, and the two key envelopes. It does not receive the file key or plaintext private key. Server-side SHA-256 checks validate ciphertext integrity; AES-GCM authentication is what detects unauthorized changes during decryption.

Each account creates an encryption identity in Settings. The private key is encrypted locally with a randomly generated 256-bit recovery code before the encrypted backup is uploaded. The recovery code is shown once and must be saved by the user. RAVEN cannot restore a lost private key without that code. The private key is held in browser memory for the current tab; after a page reload, the user must unlock it again with the recovery code.

Important limitations for this first implementation:
- This branch is not merged or deployed. Do not run its database SQL on the live database until this PR has been reviewed and approved.
- Public share links are not E2EE in this iteration. The new encrypted-send interface therefore requires a RAVEN recipient. Existing public links remain legacy, non-E2EE links.
- Existing transfers are not retroactively encrypted and remain marked as legacy (encryption version 0).
- The server still sees sender, recipient, timing, IP/network details, encrypted byte size, and transfer status.
- The backend's public-key directory is not yet protected by out-of-band key fingerprint verification or key transparency. A malicious server could substitute a recipient public key. Do not describe this initial iteration as resistant to a malicious hosting provider until that identity-verification gap is addressed.
- A compromised frontend build, browser extension, malware, or compromised endpoint can expose plaintext while the user opens or sends a file.
- This is an experimental controlled-testing implementation, not an audited secure messaging product. Test only with disposable, non-sensitive files and review the protocol and code before real private data is sent.

The recipient and sender can decrypt a completed encrypted transfer from their respective transfer lists using their unlocked account encryption identity. The browser decrypts the ciphertext locally and checks AES-GCM authentication before triggering the download.
