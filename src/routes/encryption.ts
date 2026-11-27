import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { pool, query } from "../db.js";
import { SESSION_COOKIE_NAME, getAuthenticatedUser } from "../auth.js";

type KeyBody = {
  publicKey?: unknown;
  encryptedPrivateKey?: unknown;
  recoverySalt?: unknown;
  recoveryNonce?: unknown;
};
type EnvelopeBody = {
  encryptedMetadata?: unknown;
  metadataNonce?: unknown;
  envelopes?: Array<{
    userId?: unknown;
    keyVersion?: unknown;
    enc?: unknown;
    ciphertext?: unknown;
  }>;
};

function isBase64(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) + 8) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value &&
    decoded.length >= minBytes && decoded.length <= maxBytes;
}

async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const user = await getAuthenticatedUser(request.cookies?.[SESSION_COOKIE_NAME]);
  if (!user) {
    reply.code(401).send({ error: "Please log in to manage encryption keys." });
    return null;
  }
  return user;
}

export async function encryptionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/encryption/keys/me", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const result = await query(
      `SELECT user_id, key_version, public_key, encrypted_private_key,
              recovery_salt, recovery_nonce, algorithm, created_at, updated_at
       FROM user_encryption_keys WHERE user_id=$1`,
      [user.id]
    );
    return { key: result.rows[0] ?? null };
  });

  app.put<{ Body: KeyBody }>("/encryption/keys/me", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const { publicKey, encryptedPrivateKey, recoverySalt, recoveryNonce } = request.body ?? {};
    if (!isBase64(publicKey, 65, 65) ||
        Buffer.from(publicKey as string, "base64")[0] !== 0x04 ||
        !isBase64(encryptedPrivateKey, 48, 512) ||
        !isBase64(recoverySalt, 16, 16) ||
        !isBase64(recoveryNonce, 12, 12)) {
      return reply.code(400).send({ error: "Invalid encryption-key record." });
    }
    const inserted = await query(
      `INSERT INTO user_encryption_keys
         (user_id, key_version, public_key, encrypted_private_key, recovery_salt, recovery_nonce, algorithm)
       VALUES ($1, 1, $2, $3, $4, $5, 'HPKE-P256-HKDFSHA256-AES256GCM')
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id, key_version, public_key, algorithm, created_at`,
      [user.id, publicKey, encryptedPrivateKey, recoverySalt, recoveryNonce]
    );
    if (!inserted.rows[0]) {
      return reply.code(409).send({ error: "An encryption key already exists for this account. Key replacement requires a separate recovery and rotation process." });
    }
    return reply.code(201).send({ key: inserted.rows[0] });
  });

  app.get<{ Params: { userId: string } }>("/encryption/keys/:userId/public", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const result = await query(
      "SELECT user_id, key_version, public_key, algorithm FROM user_encryption_keys WHERE user_id=$1",
      [request.params.userId]
    );
    if (!result.rows[0]) return reply.code(404).send({ error: "This account has not set up encryption yet." });
    return { key: result.rows[0] };
  });

  app.post<{ Params: { id: string }; Body: EnvelopeBody }>("/transfers/:id/envelopes", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const transferResult = await query<{ id: string; user_id: string; recipient_user_id: string | null; status: string; encryption_version: number }>(
      "SELECT id, user_id, recipient_user_id, status, encryption_version FROM transfers WHERE id=$1 AND user_id=$2",
      [request.params.id, user.id]
    );
    const transfer = transferResult.rows[0];
    if (!transfer) return reply.code(404).send({ error: "Transfer not found." });
    if (transfer.status !== "pending" || transfer.encryption_version !== 1) {
      return reply.code(409).send({ error: "This is not a pending encrypted transfer." });
    }

    const metadata = request.body?.encryptedMetadata;
    const metadataNonce = request.body?.metadataNonce;
    const envelopes = request.body?.envelopes;
    if (!isBase64(metadata, 1, 8192) || !isBase64(metadataNonce, 12, 12) ||
        !Array.isArray(envelopes) || envelopes.length !== 2) {
      return reply.code(400).send({ error: "Invalid encrypted transfer metadata or key envelopes." });
    }

    const participants = new Set([user.id, ...(transfer.recipient_user_id ? [transfer.recipient_user_id] : [])]);
    const requiredEnvelopeCount = participants.size;
    if (envelopes.length !== requiredEnvelopeCount) {
      return reply.code(400).send({ error: "The transfer must contain exactly one key envelope for each participant." });
    }
    const seen = new Set<string>();
    for (const envelope of envelopes) {
      if (typeof envelope.userId !== "string" || !participants.has(envelope.userId) ||
          seen.has(envelope.userId) ||
          !Number.isSafeInteger(envelope.keyVersion) || Number(envelope.keyVersion) < 1 ||
          !isBase64(envelope.enc, 65, 65) || !isBase64(envelope.ciphertext, 48, 256)) {
        return reply.code(400).send({ error: "Invalid recipient key envelope." });
      }
      seen.add(envelope.userId);
    }
    if (seen.size !== requiredEnvelopeCount) return reply.code(400).send({ error: "A key envelope is required for every transfer participant." });

    for (const envelope of envelopes) {
      const currentKey = await query<{ key_version: number }>(
        "SELECT key_version FROM user_encryption_keys WHERE user_id=$1",
        [envelope.userId]
      );
      if (!currentKey.rows[0] || currentKey.rows[0].key_version !== envelope.keyVersion) {
        return reply.code(409).send({ error: "A participant's encryption key changed. Restart the transfer after refreshing keys." });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const transferUpdate = await client.query(
        "UPDATE transfers SET encrypted_metadata=$2, metadata_nonce=$3 WHERE id=$1 AND user_id=$4 AND status='pending' RETURNING id",
        [transfer.id, metadata, metadataNonce, user.id]
      );
      if (transferUpdate.rowCount !== 1) {
        await client.query("ROLLBACK");
        return reply.code(409).send({ error: "The transfer is no longer pending. Start a new encrypted transfer." });
      }
      for (const envelope of envelopes) {
        await client.query(
          `INSERT INTO transfer_key_envelopes (transfer_id, user_id, key_version, enc, ciphertext)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (transfer_id, user_id) DO UPDATE
             SET key_version=EXCLUDED.key_version, enc=EXCLUDED.enc,
                 ciphertext=EXCLUDED.ciphertext`,
          [transfer.id, envelope.userId, envelope.keyVersion, envelope.enc, envelope.ciphertext]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return { saved: true };
  });

  app.get<{ Params: { token: string } }>("/share/:token/envelope", async (request, reply) => {
    const result = await query(
      `SELECT t.id, t.encryption_version, t.encrypted_metadata, t.metadata_nonce
       FROM transfers t
       WHERE t.share_token=$1 AND t.encryption_version=1
         AND t.status='completed' AND (t.expires_at IS NULL OR t.expires_at>NOW())
         AND EXISTS (
           SELECT 1 FROM transfer_key_envelopes e
           WHERE e.transfer_id=t.id AND e.user_id=t.user_id
         )`,
      [request.params.token]
    );
    if (!result.rows[0]) return reply.code(404).send({ error: "Encrypted share not found or expired." });
    reply.header("Cache-Control", "no-store, private");
    return { envelope: result.rows[0] };
  });

  app.get<{ Params: { id: string } }>("/transfers/:id/envelope", async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const result = await query(
      `SELECT t.id, t.user_id AS sender_user_id, t.encryption_version, t.encrypted_metadata, t.metadata_nonce,
              e.key_version, e.enc, e.ciphertext, sender.public_key AS sender_public_key
       FROM transfers t
       JOIN transfer_key_envelopes e ON e.transfer_id=t.id AND e.user_id=$2
       JOIN user_encryption_keys sender ON sender.user_id=t.user_id
       WHERE t.id=$1 AND (t.user_id=$2 OR t.recipient_user_id=$2)`,
      [request.params.id, user.id]
    );
    if (!result.rows[0]) return reply.code(404).send({ error: "Encrypted transfer key was not found for this account." });
    return { envelope: result.rows[0] };
  });
}
