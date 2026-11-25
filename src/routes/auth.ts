import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import argon2 from "argon2";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { query } from "../db.js";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME, hashSessionToken, getAuthenticatedUser } from "../auth.js";

const SESSION_SECONDS = 7 * 24 * 60 * 60;
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
type AuthBody = { displayName?: unknown; username?: unknown; email?: unknown; identifier?: unknown; password?: unknown };
type UserRow = {
  id: string;
  display_name: string;
  username: string | null;
  email: string;
  password_hash: string;
  avatar_path?: string | null;
  avatar_mime_type?: string | null;
};

function uniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
function validUsername(value: string): boolean {
  return /^[a-z0-9_]{3,20}$/.test(value);
}
function publicUser(user: { id: string; display_name: string; username: string | null; email: string; avatar_path?: string | null }) {
  return {
    id: user.id,
    displayName: user.display_name,
    username: user.username,
    email: user.email,
    hasAvatar: Boolean(user.avatar_path)
  };
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

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: AuthBody }>("/auth/register", async (request, reply) => {
    const name = typeof request.body?.displayName === "string" ? request.body.displayName.trim() : "";
    const username = typeof request.body?.username === "string" ? request.body.username.trim().toLowerCase().replace(/^@/, "") : "";
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";

    if (name.length < 2 || name.length > 60) return reply.code(400).send({ error: "Name must be between 2 and 60 characters." });
    if (!validUsername(username)) return reply.code(400).send({ error: "Username must be 3–20 characters and use only letters, numbers, or underscores." });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error: "Enter a valid email address." });
    if (password.length < 8 || password.length > 128) return reply.code(400).send({ error: "Password must be between 8 and 128 characters." });

    const hash = await argon2.hash(password, { type: argon2.argon2id });
    let result;
    try {
      result = await query<{ id: string; display_name: string; username: string; email: string; avatar_path: string | null }>(
        "INSERT INTO users(display_name,username,email,password_hash) VALUES($1,$2,$3,$4) RETURNING id,display_name,username,email,avatar_path",
        [name, username, email, hash]
      );
    } catch (error) {
      if (uniqueViolation(error)) return reply.code(409).send({ error: "That email address or username is already in use." });
      throw error;
    }
    const user = result.rows[0];
    await createSession(user.id, reply);
    return reply.code(201).send({ message: "Account created successfully.", user: publicUser(user) });
  });

  app.post<{ Body: AuthBody }>("/auth/login", async (request, reply) => {
    const identifier = typeof request.body?.identifier === "string"
      ? request.body.identifier.trim().toLowerCase()
      : typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!identifier || !password || password.length > 128) return reply.code(400).send({ error: "Username or email and password are required." });

    const result = await query<UserRow>(
      "SELECT id,display_name,username,email,password_hash,avatar_path FROM users WHERE LOWER(email)=$1 OR LOWER(username)=$1 LIMIT 1",
      [identifier.replace(/^@/, "")]
    );
    const user = result.rows[0];
    const valid = user ? await argon2.verify(user.password_hash, password).catch(() => false) : false;
    if (!user || !valid) return reply.code(401).send({ error: "Username/email or password is incorrect." });
    await createSession(user.id, reply);
    return { message: "Login successful.", user: publicUser(user) };
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

  app.put<{ Body: { username?: unknown } }>("/profile/username", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const username = typeof request.body?.username === "string" ? request.body.username.trim().toLowerCase().replace(/^@/, "") : "";
    if (!validUsername(username)) return reply.code(400).send({ error: "Username must be 3–20 characters and use only letters, numbers, or underscores." });
    try {
      const result = await query<{ id: string; display_name: string; username: string; email: string; avatar_path: string | null }>(
        "UPDATE users SET username=$2 WHERE id=$1 RETURNING id,display_name,username,email,avatar_path",
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
      const updated = await query<{ id: string; display_name: string; username: string | null; email: string; avatar_path: string | null }>(
        "UPDATE users SET avatar_path=$2,avatar_mime_type=$3 WHERE id=$1 RETURNING id,display_name,username,email,avatar_path",
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