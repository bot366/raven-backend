# RAVEN

RAVEN is a React + TypeScript file-sharing application backed by Fastify, Neon PostgreSQL, and server-side file storage.

## Architecture
- Frontend: Vite static site on Render
- API: Fastify web service on Render
- Database: Neon PostgreSQL
- Authentication: Argon2id password hashes and opaque server-side sessions in Secure, HttpOnly cookies
- Transfers: authenticated account-to-account transfers, legacy public share links, and experimental end-to-end encrypted direct transfers and public share links.
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
- For the existing production release, run the migration only when deploying its matching API/frontend versions. The additional E2EE schema on `raven-e2ee-design` is experimental: do not apply it to production Neon or deploy this branch until the security review and browser integration work are complete.

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

CREATE TABLE IF NOT EXISTS public.transfer_events (
  id BIGSERIAL PRIMARY KEY,
  transfer_id UUID NOT NULL REFERENCES public.transfers(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('view','download')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transfer_events_transfer_type_created_idx
  ON public.transfer_events(transfer_id,event_type,created_at DESC);

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
- `POST /auth/register`, `POST /auth/login` (email or username), `POST /auth/logout`, `GET /auth/me`, `PUT /auth/password`, `GET /auth/sessions`, `DELETE /auth/sessions/others`
- `PUT /profile/display-name`, `PUT /profile/username`, `PUT /profile/avatar`, `GET /profile/avatar`
- `GET /users/lookup?identifier=...`: authenticated username/email recipient lookup
- `GET /encryption/keys/me`, `PUT /encryption/keys/me`: read or create the caller's encryption identity and encrypted recovery backup
- `GET /encryption/keys/:userId/public`: retrieve a recipient's public encryption key
- `POST /transfers/:id/envelopes`, `GET /transfers/:id/envelope`: store and retrieve participant-only encrypted file-key envelopes
- `GET /transfers`: authenticated user's latest 100 sent transfers
- `GET /transfers/received`: authenticated user's latest 100 files sent directly to their RAVEN account
- `POST /transfers/:id/expiry`, `POST /transfers/:id/revoke-link`: manage active public share links
- `POST /transfers`, `POST /transfers/:id/upload`: authenticated legacy single-request upload; include optional `recipientIdentifier` (username or email) when creating a direct account-to-account transfer
- `POST /transfers/:id/chunks/start`, `GET /transfers/:id/chunks`, `PUT /transfers/:id/chunks/:index`, `POST /transfers/:id/chunks/complete`, `DELETE /transfers/:id/chunks`: authenticated chunked upload session, status, chunk receipt, assembly, and cancellation
- `GET /transfers/:id`, `GET /transfers/:id/download`: authenticated sender or designated recipient
- `GET /share/:token`, `GET /share/:token/download`: public token-based download; encrypted public shares record opens/downloads

## Chunked uploads

The frontend sends 8 MiB chunks with up to three concurrent requests. Each chunk includes a SHA-256 digest in the `X-Chunk-Sha256` header; the backend verifies the digest and exact expected byte length before accepting it. Repeated identical chunk submissions are idempotent. Completion rechecks each stored chunk, assembles chunks in order, calculates a final SHA-256 digest, and only then marks the transfer complete. A failed upload can be retried in the same browser session and already-received chunks are skipped. The chunk manifest is stored in Neon, but chunk bytes are stored in the backend's local filesystem, so resuming after a Render restart is not guaranteed.

## Email verification

RAVEN can require email ownership verification before account holders can send or receive files.

### Backend environment variables

Set these on the **Render backend service only**:

- `RESEND_API_KEY`: a Resend API key with sending permission. Do not add this to the frontend or a `VITE_` variable.
- `EMAIL_FROM`: a sender address on a domain verified for sending in Resend, for example `RAVEN <verify@yourdomain.com>`.
- `FRONTEND_BASE_URL`: the deployed RAVEN frontend origin, used to construct the verification link.

Keep `CORS_ORIGIN` set to the exact frontend origin as before. `FRONTEND_BASE_URL` should be that same deployed frontend URL unless the verification page is hosted elsewhere.

### Resend setup

1. Create a Resend account and add a domain you control under **Domains**.
2. Copy the DNS records Resend displays into the DNS provider that manages that domain. Add the DKIM and SPF records exactly as provided; do not guess the record names or values.
3. Wait for Resend to show the domain as verified for sending. DMARC is recommended for deliverability.
4. Create a sending-only API key and add it to Render as `RESEND_API_KEY`.
5. Set `EMAIL_FROM` to an address at that verified domain, and set `FRONTEND_BASE_URL` to the deployed frontend origin.
6. Redeploy the backend after saving the environment variables.

### Database

The migration adds `users.email_verified` (existing rows default to `FALSE`) and a one-time verification-token table. Run the updated `npm run db:migrate` against the matching Neon database, or execute this SQL in the Neon SQL Editor:

```sql
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
```

### Behaviour

- New accounts are created unverified and receive a link valid for 30 minutes.
- The link contains a random token in the URL fragment; the frontend sends it to the API only after the user clicks **Verify email address**.
- The database stores only a SHA-256 hash of the token. A token can be used once.
- Users may sign in while unverified, but transfer APIs and public share downloads are blocked until verification.
- A signed-in unverified user can request another email (one-minute cooldown) or correct the address after confirming their password.
- Existing accounts become unverified when this migration is first applied. They must verify the email currently on their account before using transfers.

**Important:** apply the migration to the intended Neon database before deploying the corresponding backend. No migration should be run against production until this feature branch is approved.

## Security and storage notes
The API requires exact CORS origins and uses credentialed requests with Secure, HttpOnly, SameSite=None session cookies. The browser includes credentials with frontend API calls. State-changing browser requests are checked against the allowed Origin list. Do not use wildcard CORS.

The current file store writes to the service's local filesystem. Render filesystems are ephemeral unless a persistent disk is configured. Uploaded files and profile photos can be lost during restarts or deploys. This is only suitable for temporary testing; configure a persistent disk or S3-compatible object storage before storing important files.

Never commit `.env`, database credentials, API keys, session cookies, or uploaded files.


## End-to-end encryption (experimental implementation)

The E2EE path in this branch supports new direct account-to-account transfers and encrypted public share links. The browser encrypts each file chunk with AES-256-GCM before upload. Chunk nonces are unique within the transfer and the transfer ID, chunk index, and chunk count are authenticated as additional data. The filename, MIME type, plaintext size, chunk layout, and nonce prefix are encrypted as transfer metadata. Each file receives a random data-encryption key.

That data key is wrapped separately for the sender and recipient using HPKE Auth mode with DHKEM(P-256), HKDF-SHA256, and AES-256-GCM. HPKE context info binds each envelope to the transfer ID, sender account ID, recipient account ID, and envelope purpose. For direct transfers, the server stores ciphertext, encrypted metadata, and separate sender/recipient key envelopes. For public encrypted links, it stores only the sender envelope; the share key is placed in the URL fragment and is not sent in HTTP requests. It does not receive the file key or plaintext private key. Server-side SHA-256 checks validate ciphertext integrity; AES-GCM authentication detects unauthorized changes during decryption.

Each account creates an encryption identity in Settings. The private key is encrypted locally with a random 256-bit recovery code before its encrypted PKCS#8 backup is uploaded. Once created or recovered, the private key is imported as a non-exportable WebCrypto key and checked against the public key before it is cached in memory. The recovery code is shown once and must be saved by the user. RAVEN cannot restore a lost private key without that code. The private key remains in browser memory for the current tab and is cleared on logout; after a page reload, the user must unlock it again with the recovery code.

Before sending to a new contact, the sender must compare the recipient's public-key fingerprint with a value the recipient shares through a separate trusted channel. The recipient performs the same check on the sender when decrypting the transfer. Verified peer fingerprints are pinned in that browser profile. A changed key is rejected rather than silently trusted. The fingerprint is SHA-256 over the raw P-256 public key, displayed in grouped hexadecimal. Clearing browser site data removes pins, so users must verify contacts again.

Important limitations for this experimental implementation:
- This branch is not merged or deployed. Do not run its database SQL on the live database until this PR has been reviewed and approved.
- Public encrypted links are bearer secrets. Anyone with the complete link, including the key after `#`, can decrypt the file. Legacy public links remain unencrypted.
- Existing transfers are not retroactively encrypted and remain marked as legacy (encryption version 0).
- The server still sees sender, recipient, timing, IP/network details, encrypted byte size, and transfer status.
- This is out-of-band fingerprint verification with local pinning, not a cryptographic key-transparency service. First-contact security depends on users comparing fingerprints through a genuinely separate trusted channel. Browser storage can be cleared; after that, re-verification is required. Key rotation and safe key replacement are not implemented.
- A compromised frontend build, browser extension, malware, or compromised endpoint can expose plaintext while the user opens or sends a file. Non-exportable keys reduce direct key export but do not stop malicious JavaScript from asking the browser to perform cryptographic operations while the page is compromised.
- This is an experimental controlled-testing implementation, not an audited secure file-sharing product. Test only with disposable, non-sensitive files and obtain an independent security review before handling private data.

The backend validates exactly one sender envelope for public links or one envelope per participant for direct transfers. Encrypted downloads decrypt the response incrementally, one authenticated chunk at a time. The browser assembles verified plaintext chunks into a download Blob; very large files can still use substantial memory. The recipient and sender can decrypt a completed encrypted transfer from their respective transfer lists using their unlocked account encryption identity. The browser decrypts the ciphertext locally, checks AES-GCM authentication for every chunk, and triggers the download only after the full stream passes its length and integrity checks.
