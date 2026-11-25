import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { pool, query } from "../db.js";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME, hashSessionToken, getAuthenticatedUser } from "../auth.js";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const VERIFICATION_SECONDS = 30 * 60;
type AuthBody = { displayName?: unknown; username?: unknown; email?: unknown; identifier?: unknown; password?: unknown };
type UserRow = {
  id: string;
  display_name: string;
  username: string | null;
  email: string;
  password_hash: string;
  email_verified: boolean;
  avatar_path?: string | null;
  avatar_mime_type?: string | null;
};
type PublicUserRow = {
  id: string;
  display_name: string;
  username: string | null;
  email: string;
  email_verified: boolean;
  avatar_path?: string | null;
};

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
function validUsername(value: string): boolean {
  return /^[a-z0-9_]{3,20}$/.test(value);
}
function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function publicUser(user: PublicUserRow) {
  return {
    id: user.id,
    displayName: user.display_name,
    username: user.username,
    email: user.email,
    emailVerified: user.email_verified === true,
    hasAvatar: Boolean(user.avatar_path)
  };
}
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char] || char);
}
function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    path: "/",
    maxAge: SESSION_SECONDS
  });
}
async function createSession(userId: string, reply: FastifyReply): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await query("DELETE FROM sessions WHERE expires_at<=NOW()");
  await query("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,$3)", [
    userId,
    hashSessionToken(token),
    new Date(Date.now() + SESSION_SECONDS * 1000)
  ]);
  setSessionCookie(reply, token);
}
async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await getAuthenticatedUser(request.cookies?.[SESSION_COOKIE_NAME]);
  if (!user) {
    reply.code(401).send({ error: "Please log in to update your profile." });
    return null;
  }
  return user;
}

async function sendVerificationEmail(email: string, displayName: string, token: string): Promise<void> {
  if (!config.resendApiKey || !config.emailFrom) {
    throw new Error("Email verification is not configured on the server yet.");
  }
  const verificationUrl = config.frontendBaseUrl + "/?verify=" + encodeURIComponent(token);
  const safeName = escapeHtml(displayName);
  const safeUrl = escapeHtml(verificationUrl);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.resendApiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: config.emailFrom,
      to: [email],
      subject: "Verify your RAVEN email address",
      text: "Hi " + displayName + ",\n\nVerify your RAVEN email address using this link:\n" + verificationUrl + "\n\nThis link expires in 30 minutes. If you did not create this account, you can ignore this email.",
      html: "<div style=\"font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#20243a\"><h1 style=\"color:#5a4a93\">Welcome to RAVEN</h1><p>Hi " + safeName + ",</p><p>Confirm that you own this email address to enable file transfers on your RAVEN account.</p><p><a href=\"" + safeUrl + "\" style=\"display:inline-block;padding:12px 20px;background:#8f78d8;color:#fff;text-decoration:none;border-radius:8px\">Verify email address</a></p><p>This link expires in 30 minutes. If you did not create this account, you can ignore this email.</p></div>"
    })
  });
  const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || "The email provider rejected the verification message.");
  }
}

async function createAndSendVerification(userId: string, email: string, displayName: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await query("DELETE FROM email_verification_tokens WHERE user_id=$1", [userId]);
  await query(
    "INSERT INTO email_verification_tokens(user_id,token_hash,expires_at) VALUES($1,$2,$3)",
    [userId, hashSessionToken(token), new Date(Date.now() + VERIFICATION_SECONDS * 1000)]
  );
  await sendVerificationEmail(email, displayName, token);
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AuthBody }>("/auth/register", async (request, reply) => {
    const name = typeof request.body?.displayName === "string" ? request.body.displayName.trim() : "";
    const username = typeof request.body?.username === "string" ? request.body.username.trim().toLowerCase().replace(/^@/, "") : "";
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";

    if (name.length < 2 || name.length > 60) return reply.code(400).send({ error: "Name must be between 2 and 60 characters." });
    if (!validUsername(username)) return reply.code(400).send({ error: "Username must be 3–20 characters and use only letters, numbers, or underscores." });
    if (!validEmail(email)) return reply.code(400).send({ error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 128) return reply.code(400).send({ error: "Password must be between 8 and 128 characters." });

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    let result;
    try {
      result = await query<PublicUserRow>(
        "INSERT INTO users(display_name,username,email,password_hash,email_verified) VALUES($1,$2,$3,$4,FALSE) RETURNING id,display_name,username,email,email_verified,avatar_path",
        [name, username, email, hash]
      );
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: "That email address or username is already in use." });
      throw error;
    }
    const user = result.rows[0];
    await createSession(user.id, reply);
    let verificationEmailSent = false;
    try {
      await createAndSendVerification(user.id, user.email, user.display_name);
      verificationEmailSent = true;
    } catch (error) {
      request.log.error({ err: error }, "Could not send RAVEN verification email");
    }
    return reply.code(201).send({
      message: verificationEmailSent ? "Account created. Check your inbox to verify your email." : "Account created, but the verification email could not be sent yet.",
      verificationEmailSent,
      user: publicUser(user)
    });
  });

  app.post<{ Body: AuthBody }>("/auth/login", async (request, reply) => {
    const identifier = typeof request.body?.identifier === "string"
      ? request.body.identifier.trim().toLowerCase()
      : typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!identifier || !password || password.length > 128) return reply.code(400).send({ error: "Username or email and password are required." });

    const result = await query<UserRow>(
      "SELECT id,display_name,username,email,password_hash,email_verified,avatar_path FROM users WHERE LOWER(email)=$1 OR LOWER(username)=$1 LIMIT 1",
      [identifier.replace(/^@/, "")]
    );
    const user = result.rows[0];
    const valid = user ? await argon2.verify(user.password_hash, password).catch(() => false) : false;
    if (!user || !valid) return reply.code(401).send({ error: "Username/email or password is incorrect." });
    await createSession(user.id, reply);
    return {
      message: user.email_verified ? "Login successful." : "Login successful. Verify your email to use file transfers.",
      user: publicUser(user)
    };
  });

  app.post("/auth/logout", async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (token) await query("DELETE FROM sessions WHERE token_hash=$1", [hashSessionToken(token)]);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/", secure: true, sameSite: "none" });
    return { message: "Logged out successfully." };
  });

  app.get("/auth/me", async (request, reply) => {
    const user = await getAuthenticatedUser(request.cookies?.[SESSION_COOKIE_NAME]);
    if (!user) return reply.code(401).send({ error: "You are not logged in." });
    return { user };
  });

  app.post<{ Body: { token?: unknown } }>("/auth/verify-email", async (request, reply) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    if (token.length < 20 || token.length > 200) return reply.code(400).send({ error: "Verification link is invalid or incomplete." });
    const client = await pool.connect();
    let user: PublicUserRow | undefined;
    try {
      await client.query("BEGIN");
      const match = await client.query<{ user_id: string }>(
        "SELECT user_id FROM email_verification_tokens WHERE token_hash=$1 AND used_at IS NULL AND expires_at>NOW() FOR UPDATE",
        [hashSessionToken(token)]
      );
      if (!match.rows[0]) {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "This verification link is invalid, expired or already used. Request a new one." });
      }
      const updated = await client.query<PublicUserRow>(
        "UPDATE users SET email_verified=TRUE WHERE id=$1 RETURNING id,display_name,username,email,email_verified,avatar_path",
        [match.rows[0].user_id]
      );
      user = updated.rows[0];
      await client.query("UPDATE email_verification_tokens SET used_at=NOW() WHERE token_hash=$1", [hashSessionToken(token)]);
      await client.query("DELETE FROM email_verification_tokens WHERE user_id=$1 AND token_hash<>$2", [match.rows[0].user_id, hashSessionToken(token)]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (!user) return reply.code(400).send({ error: "Could not verify this account." });
    await createSession(user.id, reply);
    return { message: "Email verified successfully.", user: publicUser(user) };
  });

  app.post("/auth/resend-verification", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (user.emailVerified) return { message: "Your email address is already verified." };
    const recent = await query<{ recent: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM email_verification_tokens WHERE user_id=$1 AND created_at>NOW()-INTERVAL '60 seconds') AS recent",
      [user.id]
    );
    if (recent.rows[0]?.recent) return reply.code(429).send({ error: "Please wait one minute before requesting another verification email." });
    try {
      await createAndSendVerification(user.id, user.email, user.displayName);
      return { message: "A new verification email has been sent." };
    } catch (error) {
      request.log.error({ err: error }, "Could not resend RAVEN verification email");
      return reply.code(503).send({ error: "RAVEN could not send the verification email. Email delivery may not be configured yet." });
    }
  });

  app.post<{ Body: { email?: unknown; password?: unknown } }>("/auth/change-email", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!validEmail(email)) return reply.code(400).send({ error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 128) return reply.code(400).send({ error: "Enter your current password to change your email." });

    const account = await query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id=$1", [user.id]);
    const valid = account.rows[0] ? await argon2.verify(account.rows[0].password_hash, password).catch(() => false) : false;
    if (!valid) return reply.code(401).send({ error: "Your current password is incorrect." });

    let updated;
    try {
      updated = await query<PublicUserRow>(
        "UPDATE users SET email=$2,email_verified=FALSE WHERE id=$1 RETURNING id,display_name,username,email,email_verified,avatar_path",
        [user.id, email]
      );
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: "That email address is already linked to another RAVEN account." });
      throw error;
    }
    await query("DELETE FROM email_verification_tokens WHERE user_id=$1", [user.id]);
    let verificationEmailSent = false;
    try {
      await createAndSendVerification(user.id, email, user.displayName);
      verificationEmailSent = true;
    } catch (error) {
      request.log.error({ err: error }, "Could not send verification email after email change");
    }
    return {
      message: verificationEmailSent ? "Email address updated. Check the new inbox to verify it." : "Email address updated, but the verification email could not be sent yet.",
      verificationEmailSent,
      user: publicUser(updated.rows[0])
    };
  });

  app.put<{ Body: { username?: unknown } }>("/profile/username", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const username = typeof request.body?.username === "string" ? request.body.username.trim().toLowerCase().replace(/^@/, "") : "";
    if (!validUsername(username)) return reply.code(400).send({ error: "Username must be 3–20 characters and use only letters, numbers, or underscores." });
    try {
      const result = await query<PublicUserRow>(
        "UPDATE users SET username=$2 WHERE id=$1 RETURNING id,display_name,username,email,email_verified,avatar_path",
        [user.id, username]
      );
      return { user: publicUser(result.rows[0]) };
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: "That username is already taken. Try another one." });
      throw error;
    }
  });

  app.put("/profile/avatar", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const part = await request.file({ limits: { fileSize: AVATAR_MAX_BYTES, files: 1 } });
    if (!part) return reply.code(400).send({ error: "Choose a profile image first." });
    const extensions: Record<string, string> = {
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif"
    };
    const extension = extensions[part.mimetype];
    if (!extension) return reply.code(415).send({ error: "Use a JPG, PNG, WebP, or GIF image." });

    await mkdir(config.storageDir, { recursive: true });
    const destination = path.join(config.storageDir, "avatar-" + randomUUID() + extension);
    try {
      await pipeline(part.file, fs.createWriteStream(destination, { flags: "wx" }));
      if (part.file.truncated) {
        await unlink(destination).catch(() => undefined);
        return reply.code(413).send({ error: "Profile images must be 2 MB or smaller." });
      }
      const previous = await query<{ avatar_path: string | null }>("SELECT avatar_path FROM users WHERE id=$1", [user.id]);
      const updated = await query<PublicUserRow>(
        "UPDATE users SET avatar_path=$2,avatar_mime_type=$3 WHERE id=$1 RETURNING id,display_name,username,email,email_verified,avatar_path",
        [user.id, destination, part.mimetype]
      );
      const oldPath = previous.rows[0]?.avatar_path;
      if (oldPath && oldPath !== destination) await unlink(oldPath).catch(() => undefined);
      return { user: publicUser(updated.rows[0]) };
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      if (part.file.truncated) return reply.code(413).send({ error: "Profile images must be 2 MB or smaller." });
      throw error;
    }
  });

  app.get("/profile/avatar", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const result = await query<{ avatar_path: string | null; avatar_mime_type: string | null }>(
      "SELECT avatar_path,avatar_mime_type FROM users WHERE id=$1",
      [user.id]
    );
    const avatar = result.rows[0];
    if (!avatar?.avatar_path || !fs.existsSync(avatar.avatar_path)) return reply.code(404).send({ error: "No profile image has been set." });
    reply.header("Content-Type", avatar.avatar_mime_type || "application/octet-stream");
    reply.header("Cache-Control", "private, no-store");
    return reply.send(fs.createReadStream(avatar.avatar_path));
  });
}