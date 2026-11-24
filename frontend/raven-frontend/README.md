# RAVEN Frontend

A React + TypeScript + Vite frontend for the existing RAVEN Fastify API.

## Features

- Checks `GET /health` and displays API status.
- Selects or drag-and-drops a file.
- Creates a transfer with `POST /transfers`.
- Uploads the file with `POST /transfers/:id/upload` using multipart field name `file`.
- Displays direct download and share links returned by the API.
- Shows recent uploads in the current browser session (the API does not currently expose a list-transfers endpoint).

## Run locally

1. Open a terminal in this `frontend` folder.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and check the API URL:

   ```env
   VITE_API_URL=https://raven-backend-qg3w.onrender.com
   VITE_MAX_FILE_SIZE_MB=100
   ```

4. Start the development server:

   ```bash
   npm run dev
   ```

5. Open the local URL printed by Vite (normally `http://localhost:5173`).

## Build

```bash
npm run build
```

The production files are written to `dist/`.

## Important deployment notes

- The Render backend must allow the frontend origin through `CORS_ORIGIN`. During initial testing, `*` is permissive; before public launch, set it to the exact deployed frontend origin (for example `https://your-raven-frontend.onrender.com`).
- `VITE_MAX_FILE_SIZE_MB` is a UI-side limit and should match the backend's `MAX_FILE_SIZE_MB` setting.
- The backend currently stores uploads on Render's local filesystem. On Render's free service that filesystem is ephemeral, so files can be lost when the service restarts, redeploys, or spins down. Use persistent object storage before relying on this for important files.
- Share links are currently direct API download URLs (`/share/:token`), not a separate frontend landing page.
