
import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { pool } from "../db.js";
import { config } from "../config.js";

export async function uploadRoutes(app: FastifyInstance) {
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: config.maxFileSizeBytes
    }
  });

  app.post("/upload", async (request, reply) => {
    const file = await request.file();

    if (!file) {
      return reply.code(400).send({
        error: "No file was uploaded."
      });
    }

    const id = randomUUID();
    const extension = path.extname(file.filename).slice(0, 20);
    const storageName = `${id}${extension}`;

    await mkdir(config.storageDir, { recursive: true });

    const storagePath = path.join(config.storageDir, storageName);

    try {
      await pipeline(
        file.file,
        createWriteStream(storagePath, { flags: "wx" })
      );

      if (file.file.truncated) {
        throw new Error("File exceeds the upload size limit.");
      }

      const result = await pool.query(
        `INSERT INTO transfers
          (filename, filesize, status, storage_path, mime_type, uploaded_at, share_token)
         VALUES ($1, $2, $3, $4, $5, NOW(), gen_random_uuid())
         RETURNING id, filename, filesize, status, share_token, created_at`,
        [
          file.filename,
          file.file.bytesRead,
          "uploaded",
          storagePath,
          file.mimetype
        ]
      );

      return reply.code(201).send({
        message: "File uploaded successfully.",
        transfer: result.rows[0]
      });
    } catch (error) {
      const { unlink } = await import("node:fs/promises");
      await unlink(storagePath).catch(() => {});
      request.log.error(error);

      return reply.code(500).send({
        error: "File upload failed."
      });
    }
  });
}
