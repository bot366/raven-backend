export type EncryptionEnvelopeInput = {
  userId?: unknown;
  keyVersion?: unknown;
  enc?: unknown;
  ciphertext?: unknown;
};

export type ValidatedEncryptionEnvelope = {
  userId: string;
  keyVersion: number;
  enc: string;
  ciphertext: string;
};

export type EnvelopeValidation =
  | { ok: true; envelopes: ValidatedEncryptionEnvelope[] }
  | { ok: false; error: string };

export function isCanonicalBase64(value: unknown, minBytes: number, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) + 8) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value &&
    decoded.length >= minBytes && decoded.length <= maxBytes;
}

/**
 * Envelopes must match the transfer's participant set exactly:
 * one for a public encrypted link, two for a direct transfer.
 */
export function validateEncryptionEnvelopes(
  value: unknown,
  participantIds: string[],
): EnvelopeValidation {
  const participants = new Set(participantIds);
  if (participants.size < 1 || participants.size > 2 || participants.size !== participantIds.length) {
    return { ok: false, error: "Invalid encrypted-transfer participants." };
  }
  if (!Array.isArray(value) || value.length !== participants.size) {
    return {
      ok: false,
      error: "The transfer must contain exactly one key envelope for each participant.",
    };
  }

  const seen = new Set<string>();
  const envelopes: ValidatedEncryptionEnvelope[] = [];
  for (const candidate of value as EncryptionEnvelopeInput[]) {
    if (!candidate || typeof candidate !== "object" ||
        typeof candidate.userId !== "string" || !participants.has(candidate.userId) ||
        seen.has(candidate.userId) ||
        !Number.isSafeInteger(candidate.keyVersion) || Number(candidate.keyVersion) < 1 ||
        !isCanonicalBase64(candidate.enc, 65, 65) ||
        Buffer.from(candidate.enc, "base64")[0] !== 0x04 ||
        !isCanonicalBase64(candidate.ciphertext, 48, 48)) {
      return { ok: false, error: "Invalid participant key envelope." };
    }
    seen.add(candidate.userId);
    envelopes.push({
      userId: candidate.userId,
      keyVersion: Number(candidate.keyVersion),
      enc: candidate.enc,
      ciphertext: candidate.ciphertext,
    });
  }

  if (seen.size !== participants.size) {
    return {
      ok: false,
      error: "A key envelope is required for every transfer participant.",
    };
  }
  return { ok: true, envelopes };
}
