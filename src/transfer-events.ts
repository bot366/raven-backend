import { query } from "./db.js";

/**
 * Activity metrics are approximate request counts, not unique visitors.
 * Tracking failures must never prevent an otherwise valid share from opening
 * or downloading.
 */
export async function recordTransferEvent(
  transferId: string,
  eventType: "view" | "download",
): Promise<void> {
  try {
    await query(
      "INSERT INTO transfer_events(transfer_id,event_type) VALUES($1,$2)",
      [transferId, eventType],
    );
  } catch {
    // Activity tracking is non-critical and must not interrupt file delivery.
  }
}
