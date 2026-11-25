# RAVEN

RAVEN is a React + TypeScript file-sharing application backed by Fastify, Neon PostgreSQL, and server-side file storage.

## Architecture
- Frontend: Vite static site on Render
- API: Fastify web service on Render
- Database: Neon PostgreSQL
- Authentication: Argon2id password hashes and opaque server-side sessions in Secure, HttpOnly cookies
- Transfers: each transfer is owned by its creating account; public share-token downloads remain available to anyone holding the link until expiry.

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
- Run `npm run db:migrate` once after deploying the new API code and before enabling the new frontend.

## Deploy the frontend
- Root directory: `frontend/raven-frontend`
- Build command: `npm install && npm run build`
- Publish directory: `dist`
- Environment variables:
  - `VITE_API_URL`: backend public origin
  - `VITE_MAX_FILE_SIZE_MB=100`

## API routes
- `GET /health`
- `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`
- `GET /transfers`: authenticated user's latest 100 sent transfers
- `GET /transfers/received`: authenticated user's latest 100 files sent directly to their RAVEN account
- `POST /transfers`, `POST /transfers/:id/upload`: authenticated; include optional `recipientEmail` when creating a direct account-to-account transfer
- `GET /transfers/:id`, `GET /transfers/:id/download`: authenticated sender or designated recipient
- `GET /share/:token`: public token-based download

## Security and storage notes
The API requires exact CORS origins and uses credentialed requests with Secure, HttpOnly, SameSite=None session cookies. The browser includes credentials with frontend API calls. State-changing browser requests are checked against the allowed Origin list. Do not use wildcard CORS.

The current file store writes to the service's local filesystem. Render filesystems are ephemeral unless a persistent disk is configured. Files can be lost during restarts or deploys. This is only suitable for temporary testing; configure a persistent disk or S3-compatible object storage before storing important files.

Never commit `.env`, database credentials, API keys, session cookies, or uploaded files.
