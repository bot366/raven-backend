import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;
export const pool = new Pool({ connectionString: config.databaseUrl });

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
) {
  return pool.query<T>(text, values);
}
