import "dotenv/config";
import path from "node:path";

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

export const config = {
  port: numberFromEnv("PORT", 3000),
  host: process.env.HOST ?? "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL,
  storageDir: path.resolve(process.env.STORAGE_DIR ?? "./storage"),
  maxFileSizeBytes: numberFromEnv("MAX_FILE_SIZE_MB", 100) * 1024 * 1024,
  expiryHours: numberFromEnv("TRANSFER_EXPIRY_HOURS", 24),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173"
};

if (!config.databaseUrl) throw new Error("DATABASE_URL is missing from .env");
