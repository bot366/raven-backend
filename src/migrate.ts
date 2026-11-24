import { pool } from "./db.js";

const sql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  filename TEXT NOT NULL,
  filesize BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE transfers ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMPTZ;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS share_token UUID;
CREATE UNIQUE INDEX IF NOT EXISTS transfers_share_token_unique
  ON transfers(share_token) WHERE share_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS transfers_expires_at_idx ON transfers(expires_at);
`;

try {
await pool.query(sql);

const result = await pool.query(`
  SELECT
    current_database() AS database,
    current_user AS username,
    current_schema() AS schema,
    to_regclass('public.transfers') AS transfers_table
`);

console.log("Database connection details:", result.rows[0]);
console.log("RAVEN database migration completed.");
} catch (error) {
  console.error("Migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
