import { pool } from "./db.js";

const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS transfers (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), filename TEXT NOT NULL,
 filesize BIGINT NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS share_token UUID;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS sha256 TEXT;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS chunk_size INTEGER;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS chunk_count INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS transfers_share_token_unique ON transfers(share_token) WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS transfers_expires_at_idx ON transfers(expires_at);

CREATE TABLE IF NOT EXISTS users (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), display_name TEXT NOT NULL,
 email TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime_type TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users(LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(LOWER(username)) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS transfer_chunks (
 transfer_id UUID NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
 chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
 chunk_size BIGINT NOT NULL CHECK (chunk_size >= 0),
 sha256 TEXT NOT NULL,
 storage_path TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY (transfer_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS transfers_user_id_created_at_idx ON transfers(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_recipient_created_at_idx ON transfers(recipient_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS transfer_chunks_transfer_id_idx ON transfer_chunks(transfer_id);
`;

const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  const result = await client.query(`
    SELECT current_database() AS database,
      to_regclass('public.transfers') AS transfers_table,
      to_regclass('public.users') AS users_table,
      to_regclass('public.sessions') AS sessions_table,
      to_regclass('public.transfer_chunks') AS transfer_chunks_table,
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='transfers' AND column_name='sha256') AS transfer_sha256_column
  `);
  console.log("RAVEN database migration completed:", result.rows[0]);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
