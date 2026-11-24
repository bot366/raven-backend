import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { query } from "../db.js";
import { config } from "../config.js";
import type { TransferRow } from "../types.js";

function publicTransfer(row: TransferRow) {
  return {
    id: row.id,
    filename: row.filename,
    filesize: Number(row.filesize),
    status: row.status,
    createdAt: row.created_at,
    uploadedAt: row.uploaded_at,
    expiresAt: row.expires_at,
    downloadUrl: row.status === "completed"
      ? `${config.publicBaseUrl}/transfers/${row.id}/download`
      : null
  };
}

async function getTransfer(id: string) {
  const result = await query<TransferRow>("SELECT * FROM transfers WHERE id = $1", [id]);
  return result.rows[0];
}

export async function transferRoutes(app: FastifyInstance) {
  // Create a transfer session (keeps the original POST /transfers capability).
  app.post<{ Body: { filename?: string; filesize?: number } }>("/transfers", async (request, reply) => {
    const filename = request.body?.filename?.trim();
    const filesize = request.body?.filesize ?? 0;

    if (!filename || filename.length > 255) {
      return reply.code(400).send({ error: "A filename between 1 and 255 characters is required." });
    }
    if (!Number.isSafeInteger(filesize) || filesize < 0 || filesize > config.maxFileSizeBytes) {
      return reply.code(400).send({ error: `filesize must be between 0 and ${config.maxFileSizeBytes} bytes.` });
    }

    const expiresAt = new Date(Date.now() + config.expiryHours * 60 * 60 * 1000);
    const result = await query<TransferRow>(
      `INSERT INTO transfers (filename, filesize, status, expires_at)
       VALUES ($1, $2, 'pending', $3) RETURNING *`,
      [filename, filesize, expiresAt]
    );
    return reply.code(201).send({ message: "Transfer session created.", transfer: publicTransfer(result.rows[0]) });
  });

  // Upload one file to an existing pending transfer.
  app.post<{ Params: { id: string } }>("/transfers/:id/upload", async (request, reply) => {
    const transfer = await getTransfer(request.params.id);
    if (!transfer) return reply.code(404).send({ error: "Transfer not found." });
    if (transfer.status !== "pending") {
      return reply.code(409).send({ error: `Cannot upload to a transfer with status '${transfer.status}'.` });
    }
    if (transfer.expires_at && new Date(transfer.expires_at) < new Date()) {
      await query("UPDATE transfers SET status = 'expired' WHERE id = $1", [transfer.id]);
      return reply.code(410).send({ error: "This transfer has expired." });
    }

    const part = await request.file({ limits: { fileSize: config.maxFileSizeBytes, files: 1 } });
    if (!part) return reply.code(400).send({ error: "Attach a file using the multipart field name 'file'." });

    const safeOriginalName = path.basename(part.filename).replace(/[\r\n"]/g, "_").slice(0, 255);
    const diskName = `${randomUUID()}${path.extname(safeOriginalName).slice(0, 20)}`;
    await mkdir(config.storageDir, { recursive: true });
    const destination = path.join(config.storageDir, diskName);

    try {
      await pipeline(part.file, fs.createWriteStream(destination, { flags: "wx" }));
      if (part.file.truncated) {
        await unlink(destination).catch(() => undefined);
        return reply.code(413).send({ error: "File exceeds the configured upload limit." });
      }

      const stat = await fs.promises.stat(destination);
      const shareToken = randomUUID();
      const updated = await query<TransferRow>(
        `UPDATE transfers
         SET filename = $2, filesize = $3, storage_path = $4, mime_type = $5,
             uploaded_at = NOW(), status = 'completed', share_token = $6
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [transfer.id, safeOriginalName, stat.size, destination, part.mimetype, shareToken]
      );

      if (!updated.rows[0]) {
        await unlink(destination).catch(() => undefined);
        return reply.code(409).send({ error: "Transfer was changed before upload completed." });
      }

      return reply.code(201).send({
        message: "File uploaded successfully.",
        transfer: publicTransfer(updated.rows[0]),
        shareUrl: `${config.publicBaseUrl}/share/${shareToken}`
      });
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      if (part.file.truncated) return reply.code(413).send({ error: "File exceeds the configured upload limit." });
      throw error;
    }
  });

  // Get transfer metadata (keeps original GET /transfers/:id).
  app.get<{ Params: { id: string } }>("/transfers/:id", async (request, reply) => {
    const transfer = await getTransfer(request.params.id);
    if (!transfer) return reply.code(404).send({ error: "Transfer not found." });

    if (transfer.expires_at && new Date(transfer.expires_at) < new Date() && transfer.status !== "expired") {
      const updated = await query<TransferRow>(
        "UPDATE transfers SET status = 'expired' WHERE id = $1 RETURNING *", [transfer.id]
      );
      return { transfer: publicTransfer(updated.rows[0]) };
    }
    return { transfer: publicTransfer(transfer) };
  });

  // Download by transfer ID.
  app.get<{ Params: { id: string } }>("/transfers/:id/download", async (request, reply) => {
    const transfer = await getTransfer(request.params.id);
    if (!transfer) return reply.code(404).send({ error: "Transfer not found." });
    if (transfer.status !== "completed" || !transfer.storage_path) {
      return reply.code(409).send({ error: "This transfer does not have an available file." });
    }
    if (transfer.expires_at && new Date(transfer.expires_at) < new Date()) {
      await query("UPDATE transfers SET status = 'expired' WHERE id = $1", [transfer.id]);
      return reply.code(410).send({ error: "This transfer has expired." });
    }
    if (!fs.existsSync(transfer.storage_path)) {
      return reply.code(404).send({ error: "The stored file is missing from the server." });
    }

    reply.header("Content-Type", transfer.mime_type ?? "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${transfer.filename.replace(/["\\]/g, "_")}"`);
    reply.header("Content-Length", String(transfer.filesize));
    return reply.send(fs.createReadStream(transfer.storage_path));
  });

  // Shareable link: same download, addressed by unguessable token.
  app.get<{ Params: { token: string } }>("/share/:token", async (request, reply) => {
    const result = await query<TransferRow>(
      "SELECT * FROM transfers WHERE share_token = $1", [request.params.token]
    );
    const transfer = result.rows[0];
    if (!transfer) return reply.code(404).send({ error: "Share link not found." });
    if (transfer.status !== "completed" || !transfer.storage_path) {
      return reply.code(410).send({ error: "This share is no longer available." });
    }
    if (transfer.expires_at && new Date(transfer.expires_at) < new Date()) {
      await query("UPDATE transfers SET status = 'expired' WHERE id = $1", [transfer.id]);
      return reply.code(410).send({ error: "This share link has expired." });
    }
    if (!fs.existsSync(transfer.storage_path)) {
      return reply.code(404).send({ error: "The stored file is missing from the server." });
    }
    reply.header("Content-Type", transfer.mime_type ?? "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${transfer.filename.replace(/["\\]/g, "_")}"`);
    reply.header("Content-Length", String(transfer.filesize));
    return reply.send(fs.createReadStream(transfer.storage_path));
  });
}
