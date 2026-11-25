import { createHash } from "node:crypto";
import { query } from "./db.js";

export const SESSION_COOKIE_NAME = "raven_session";
export interface AuthUser {
  id: string;
  displayName: string;
  username: string | null;
  email: string;
  hasAvatar: boolean;
}
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
export async function getAuthenticatedUser(token?: string): Promise<AuthUser | null> {
  if (!token || token.length > 200) return null;
  const result = await query<{
    id: string;
    display_name: string;
    username: string | null;
    email: string;
    avatar_path: string | null;
  }>(
    `SELECT u.id,u.display_name,u.username,u.email,u.avatar_path
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.expires_at>NOW() LIMIT 1`,
    [hashSessionToken(token)]
  );
  const user = result.rows[0];
  if (!user) return null;
  return {
    id: user.id,
    displayName: user.display_name,
    username: user.username,
    email: user.email,
    hasAvatar: Boolean(user.avatar_path)
  };
}