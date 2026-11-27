import {
  Aes256Gcm,
  CipherSuite,
  DhkemP256HkdfSha256,
  HkdfSha256,
} from "@hpke/core";

const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const textEncoder = new TextEncoder();
const RECOVERY_INFO = textEncoder.encode("RAVEN private-key recovery v1");
const CHUNK_PLAINTEXT_SIZE = 8 * 1024 * 1024 - 16;
const keyCache = new Map<string, CryptoKeyPair>();

export type StoredEncryptionKey = {
  user_id: string;
  key_version: number;
  public_key: string;
  encrypted_private_key: string;
  recovery_salt: string;
  recovery_nonce: string;
  algorithm: string;
};

export type EncryptionIdentity = {
  pair: CryptoKeyPair;
  publicKey: string;
  keyVersion: number;
};

export type KeyEnvelope = {
  userId: string;
  keyVersion: number;
  enc: string;
  ciphertext: string;
};

export type TransferEncryptionSession = {
  fileKey: CryptoKey;
  noncePrefix: Uint8Array;
  metadataNonce: Uint8Array;
  encryptedMetadata: string;
  envelopes: KeyEnvelope[];
  shareKey: string;
  chunkCount: number;
  cipherSize: number;
  plaintextChunkSize: number;
};

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}
export function encodeBase64(input: ArrayBuffer | ArrayBufferView): string {
  const bytes = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function importShareFileKey(value: string): Promise<CryptoKey> {
  const raw = fromBase64(value);
  if (raw.length !== 32 || encodeBase64(raw) !== value) {
    raw.fill(0);
    throw new Error("This encrypted share link has an invalid decryption key.");
  }
  try {
    return await crypto.subtle.importKey("raw", toArrayBuffer(raw), "AES-GCM", false, ["decrypt"]);
  } finally {
    raw.fill(0);
  }
}
function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer;
}
function recoveryCodeFromBytes(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function recoveryCodeBytes(code: string): Uint8Array {
  const normalized = code.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]{40,48}={0,2}$/.test(normalized)) throw new Error("The recovery code format is invalid.");
  const decoded = fromBase64(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  if (decoded.length !== 32) throw new Error("The recovery code must contain 32 bytes.");
  return decoded;
}
function aad(value: string): ArrayBuffer {
  return textEncoder.encode(value).buffer as ArrayBuffer;
}
function makeChunkNonce(prefix: Uint8Array, index: number): Uint8Array {
  if (prefix.length !== 8 || !Number.isSafeInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error("Invalid encrypted chunk nonce parameters.");
  }
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(8, index, false);
  return nonce;
}
function chunkAad(transferId: string, index: number, count: number): ArrayBuffer {
  return aad("RAVEN:E2EE:1:" + transferId + ":" + index + ":" + count);
}

async function recoveryAesKey(codeBytes: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", toArrayBuffer(codeBytes), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: toArrayBuffer(salt), info: toArrayBuffer(RECOVERY_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}


async function assertKeyPairMatches(pair: CryptoKeyPair): Promise<void> {
  if (pair.privateKey.extractable) {
    throw new Error("The account private key must be non-exportable while unlocked.");
  }
  const challenge = randomBytes(32);
  const info = aad("RAVEN:IDENTITY-PAIR-CHECK:v1");
  const senderContext = await suite.createSenderContext({
    recipientPublicKey: pair.publicKey,
    senderKey: pair,
    info,
  });
  const ciphertext = await senderContext.seal(toArrayBuffer(challenge));
  const recipientContext = await suite.createRecipientContext({
    recipientKey: pair,
    enc: senderContext.enc,
    senderPublicKey: pair.publicKey,
    info,
  });
  let opened: ArrayBuffer;
  try {
    opened = await recipientContext.open(ciphertext);
  } catch {
    throw new Error("The private encryption key does not match this account's public key.");
  }
  const actual = new Uint8Array(opened);
  let difference = actual.length ^ challenge.length;
  for (let index = 0; index < Math.min(actual.length, challenge.length); index++) {
    difference |= actual[index] ^ challenge[index];
  }
  challenge.fill(0);
  actual.fill(0);
  if (difference !== 0) throw new Error("The encryption identity failed its key-pair self-check.");
}

export async function createEncryptionIdentity(): Promise<{
  payload: { publicKey: string; encryptedPrivateKey: string; recoverySalt: string; recoveryNonce: string };
  recoveryCode: string;
  identity: EncryptionIdentity;
}> {
  const generatedPair = await suite.kem.generateKeyPair();
  const publicRaw = new Uint8Array(await suite.kem.serializePublicKey(generatedPair.publicKey));
  const privatePkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", generatedPair.privateKey));
  const codeBytes = randomBytes(32);
  const recoverySalt = randomBytes(16);
  const recoveryNonce = randomBytes(12);
  const recoveryKey = await recoveryAesKey(codeBytes, recoverySalt);
  const encryptedPrivate = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(recoveryNonce), additionalData: aad("RAVEN:PRIVATE-KEY:1") },
    recoveryKey,
    toArrayBuffer(privatePkcs8),
  );
  const recoveryCode = recoveryCodeFromBytes(codeBytes);
  const nonExportablePrivateKey = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(privatePkcs8),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  privatePkcs8.fill(0);
  codeBytes.fill(0);
  const pair: CryptoKeyPair = { publicKey: generatedPair.publicKey, privateKey: nonExportablePrivateKey };
  await assertKeyPairMatches(pair);
  const identity = { pair, publicKey: encodeBase64(publicRaw), keyVersion: 1 };
  return {
    payload: {
      publicKey: identity.publicKey,
      encryptedPrivateKey: encodeBase64(encryptedPrivate),
      recoverySalt: encodeBase64(recoverySalt),
      recoveryNonce: encodeBase64(recoveryNonce),
    },
    recoveryCode,
    identity,
  };
}

export async function unlockEncryptionIdentity(
  userId: string,
  key: StoredEncryptionKey,
  recoveryCode: string,
): Promise<EncryptionIdentity> {
  const codeBytes = recoveryCodeBytes(recoveryCode);
  const recoveryKey = await recoveryAesKey(codeBytes, fromBase64(key.recovery_salt));
  let privateRaw: ArrayBuffer;
  try {
    privateRaw = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(fromBase64(key.recovery_nonce)),
        additionalData: aad("RAVEN:PRIVATE-KEY:1"),
      },
      recoveryKey,
      toArrayBuffer(fromBase64(key.encrypted_private_key)),
    );
  } catch {
    throw new Error("That recovery code is incorrect or the encrypted key backup is damaged.");
  }
  const publicKey = await suite.kem.deserializePublicKey(toArrayBuffer(fromBase64(key.public_key)));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    privateRaw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  new Uint8Array(privateRaw).fill(0);
  const pair: CryptoKeyPair = { publicKey, privateKey };
  await assertKeyPairMatches(pair);
  const identity = {
    pair,
    publicKey: key.public_key,
    keyVersion: Number(key.key_version),
  };
  keyCache.set(userId, identity.pair);
  return identity;
}

export function cacheEncryptionIdentity(userId: string, pair: CryptoKeyPair): void {
  keyCache.set(userId, pair);
}
export function getCachedEncryptionIdentity(userId: string): CryptoKeyPair | null {
  return keyCache.get(userId) ?? null;
}
export function clearCachedEncryptionIdentity(userId: string): void {
  keyCache.delete(userId);
}

async function wrapFileKey(
  fileKeyRaw: Uint8Array,
  recipientPublicKey: CryptoKey,
  senderPair: CryptoKeyPair,
  senderId: string,
  recipientId: string,
  keyVersion: number,
  transferId: string,
  purpose: "sender" | "recipient",
): Promise<KeyEnvelope> {
  const context = await suite.createSenderContext({
    recipientPublicKey,
    senderKey: senderPair,
    info: aad("RAVEN:FILE-KEY:1:" + transferId + ":" + senderId + ":" + recipientId + ":" + purpose),
  });
  const ciphertext = await context.seal(toArrayBuffer(fileKeyRaw));
  return {
    userId: recipientId,
    keyVersion,
    enc: encodeBase64(context.enc),
    ciphertext: encodeBase64(ciphertext),
  };
}

export async function createTransferEncryptionSession(
  file: File,
  transferId: string,
  senderId: string,
  senderPair: CryptoKeyPair,
  senderKeyVersion: number,
  recipientId: string | null,
  recipientPublicKeyRaw: string | null,
  recipientKeyVersion: number | null,
): Promise<TransferEncryptionSession> {
  if ((recipientId === null) !== (recipientPublicKeyRaw === null) ||
      (recipientId === null) !== (recipientKeyVersion === null)) {
    throw new Error("Recipient encryption details are incomplete.");
  }
  const fileKeyRaw = randomBytes(32);
  const fileKey = await crypto.subtle.importKey("raw", toArrayBuffer(fileKeyRaw), "AES-GCM", false, ["encrypt", "decrypt"]);
  const envelopes: KeyEnvelope[] = [
    await wrapFileKey(fileKeyRaw, senderPair.publicKey, senderPair, senderId, senderId, senderKeyVersion, transferId, "sender"),
  ];
  if (recipientId !== null && recipientPublicKeyRaw !== null && recipientKeyVersion !== null) {
    if (!Number.isSafeInteger(recipientKeyVersion) || recipientKeyVersion < 1) {
      fileKeyRaw.fill(0);
      throw new Error("The recipient encryption key version is invalid.");
    }
    const recipientPublicKey = await suite.kem.deserializePublicKey(toArrayBuffer(fromBase64(recipientPublicKeyRaw)));
    envelopes.push(await wrapFileKey(
      fileKeyRaw, recipientPublicKey, senderPair, senderId, recipientId, recipientKeyVersion, transferId, "recipient"
    ));
  }
  // The raw DEK is also used as the secret in a public share-link URL fragment.
  // URL fragments are not included in HTTP requests; the server receives only ciphertext.
  const shareKey = encodeBase64(fileKeyRaw);
  fileKeyRaw.fill(0);
  const plaintextChunkSize = CHUNK_PLAINTEXT_SIZE;
  const chunkCount = Math.max(1, Math.ceil(file.size / plaintextChunkSize));
  const noncePrefix = randomBytes(8);
  // Reserve the final uint32 nonce counter exclusively for metadata.
  const metadataNonce = makeChunkNonce(noncePrefix, 0xffffffff);
  const metadata = {
    version: 1,
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    originalSize: file.size,
    plaintextChunkSize,
    chunkCount,
    noncePrefix: encodeBase64(noncePrefix),
  };
  const encryptedMetadata = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(metadataNonce),
      additionalData: aad("RAVEN:E2EE:1:" + transferId + ":metadata"),
    },
    fileKey,
    toArrayBuffer(textEncoder.encode(JSON.stringify(metadata))),
  );
  return {
    fileKey,
    noncePrefix,
    metadataNonce,
    encryptedMetadata: encodeBase64(encryptedMetadata),
    envelopes,
    shareKey,
    chunkCount,
    cipherSize: file.size + chunkCount * 16,
    plaintextChunkSize,
  };
}

export async function encryptTransferChunk(
  session: TransferEncryptionSession,
  transferId: string,
  index: number,
  plaintext: Blob,
): Promise<Uint8Array> {
  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(makeChunkNonce(session.noncePrefix, index)),
      additionalData: chunkAad(transferId, index, session.chunkCount),
    },
    session.fileKey,
    await plaintext.arrayBuffer(),
  );
  return new Uint8Array(encrypted);
}

export async function decryptTransferMetadata(
  fileKey: CryptoKey,
  transferId: string,
  encryptedMetadata: string,
  metadataNonce: string,
): Promise<{
  version: number;
  filename: string;
  mimeType: string;
  originalSize: number;
  plaintextChunkSize: number;
  chunkCount: number;
  noncePrefix: string;
}> {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(fromBase64(metadataNonce)),
      additionalData: aad("RAVEN:E2EE:1:" + transferId + ":metadata"),
    },
    fileKey,
    toArrayBuffer(fromBase64(encryptedMetadata)),
  );
  const value = JSON.parse(new TextDecoder().decode(decrypted)) as {
    version: number; filename: string; mimeType: string; originalSize: number;
    plaintextChunkSize: number; chunkCount: number; noncePrefix: string;
  };
  const expectedChunkCount = Math.max(1, Math.ceil(value.originalSize / CHUNK_PLAINTEXT_SIZE));
  if (value.version !== 1 || !Number.isSafeInteger(value.originalSize) || value.originalSize < 0 ||
      !Number.isSafeInteger(value.chunkCount) || value.chunkCount !== expectedChunkCount ||
      value.chunkCount > 0xffffffff ||
      value.plaintextChunkSize !== CHUNK_PLAINTEXT_SIZE ||
      typeof value.filename !== "string" || value.filename.length < 1 || value.filename.length > 255 ||
      typeof value.mimeType !== "string" || value.mimeType.length > 150) {
    throw new Error("The encrypted file metadata is invalid.");
  }
  const noncePrefix = fromBase64(value.noncePrefix);
  const metadataNonceBytes = fromBase64(metadataNonce);
  if (noncePrefix.length !== 8 || metadataNonceBytes.length !== 12 ||
      !makeChunkNonce(noncePrefix, 0xffffffff).every((byte, index) => byte === metadataNonceBytes[index])) {
    throw new Error("The encrypted file nonce metadata is invalid.");
  }
  return value;
}

export async function unwrapTransferKey(
  pair: CryptoKeyPair,
  transferId: string,
  senderUserId: string,
  recipientUserId: string,
  purpose: "sender" | "recipient",
  enc: string,
  ciphertext: string,
  senderPublicKeyRaw: string,
): Promise<CryptoKey> {
  const senderPublicKey = await suite.kem.deserializePublicKey(toArrayBuffer(fromBase64(senderPublicKeyRaw)));
  const context = await suite.createRecipientContext({
    recipientKey: pair,
    enc: toArrayBuffer(fromBase64(enc)),
    senderPublicKey,
    info: aad("RAVEN:FILE-KEY:1:" + transferId + ":" + senderUserId + ":" + recipientUserId + ":" + purpose),
  });
  const fileKeyRaw = await context.open(toArrayBuffer(fromBase64(ciphertext)));
  if (fileKeyRaw.byteLength !== 32) {
    new Uint8Array(fileKeyRaw).fill(0);
    throw new Error("The transfer encryption key is invalid.");
  }
  const fileKey = await crypto.subtle.importKey("raw", fileKeyRaw, "AES-GCM", false, ["decrypt"]);
  new Uint8Array(fileKeyRaw).fill(0);
  return fileKey;
}

export type TransferDecryptionMetadata = {
  version: number;
  filename: string;
  mimeType: string;
  originalSize: number;
  plaintextChunkSize: number;
  chunkCount: number;
  noncePrefix: string;
};

/**
 * Decrypt an HTTP response incrementally. Ciphertext is held only for the
 * current authenticated chunk; only plaintext Blob parts are retained for
 * the browser's normal download flow.
 */
export async function decryptTransferStreamToBlob(
  fileKey: CryptoKey,
  transferId: string,
  metadata: TransferDecryptionMetadata,
  stream: ReadableStream<Uint8Array> | null,
): Promise<Blob> {
  if (!stream) throw new Error("This browser could not open the encrypted download stream.");
  const reader = stream.getReader();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let ended = false;
  const pieces: BlobPart[] = [];
  let recoveredBytes = 0;

  const pull = async (): Promise<void> => {
    if (ended) throw new Error("The encrypted download ended before all chunks arrived.");
    const { value, done } = await reader.read();
    if (done) {
      ended = true;
      return;
    }
    if (value && value.byteLength > 0) {
      buffered.push(value);
      bufferedBytes += value.byteLength;
    }
  };

  const readExactly = async (size: number): Promise<Uint8Array> => {
    while (bufferedBytes < size) await pull();
    const output = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      const first = buffered[0];
      if (!first) throw new Error("The encrypted download stream is incomplete.");
      const take = Math.min(first.byteLength, size - written);
      output.set(first.subarray(0, take), written);
      written += take;
      bufferedBytes -= take;
      if (take === first.byteLength) buffered.shift();
      else buffered[0] = first.subarray(take);
    }
    return output;
  };

  try {
    if (metadata.version !== 1 || !Number.isSafeInteger(metadata.originalSize) ||
        metadata.originalSize < 0 || !Number.isSafeInteger(metadata.chunkCount) ||
        metadata.chunkCount !== Math.max(1, Math.ceil(metadata.originalSize / metadata.plaintextChunkSize)) ||
        metadata.plaintextChunkSize !== CHUNK_PLAINTEXT_SIZE) {
      throw new Error("The encrypted file metadata is invalid.");
    }

    for (let index = 0; index < metadata.chunkCount; index++) {
      const plainSize = Math.min(
        metadata.plaintextChunkSize,
        metadata.originalSize - index * metadata.plaintextChunkSize,
      );
      const encryptedChunk = await readExactly(plainSize + 16);
      const plaintext = await decryptTransferChunk(
        fileKey,
        transferId,
        index,
        metadata.chunkCount,
        metadata.noncePrefix,
        toArrayBuffer(encryptedChunk),
      );
      if (plaintext.byteLength !== plainSize) {
        throw new Error("A decrypted chunk has an unexpected size.");
      }
      pieces.push(toArrayBuffer(plaintext));
      recoveredBytes += plaintext.byteLength;
    }

    if (recoveredBytes !== metadata.originalSize) {
      throw new Error("The decrypted file did not pass its size checks.");
    }
    if (bufferedBytes !== 0) {
      throw new Error("The encrypted download contains unexpected trailing data.");
    }
    while (!ended) {
      const { value, done } = await reader.read();
      if (done) ended = true;
      else if (value && value.byteLength > 0) {
        throw new Error("The encrypted download contains unexpected trailing data.");
      }
    }
    return new Blob(pieces, { type: metadata.mimeType || "application/octet-stream" });
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function decryptTransferChunk(
  fileKey: CryptoKey,
  transferId: string,
  index: number,
  count: number,
  noncePrefix: string,
  ciphertext: ArrayBuffer,
): Promise<Uint8Array> {
  const nonce = makeChunkNonce(fromBase64(noncePrefix), index);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: chunkAad(transferId, index, count),
    },
    fileKey,
    ciphertext,
  );
  return new Uint8Array(plaintext);
}


export async function getKeyFingerprint(publicKeyRaw: string): Promise<string> {
  const publicBytes = fromBase64(publicKeyRaw);
  if (publicBytes.length !== 65 || publicBytes[0] !== 4) {
    throw new Error("The account public key has an invalid P-256 encoding.");
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(publicBytes)));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return hex.match(/.{1,4}/g)?.join(" ") ?? hex;
}

function normalizeFingerprint(value: string): string {
  return value.replace(/[^a-f0-9]/gi, "").toUpperCase();
}

export function fingerprintsMatch(expected: string, actual: string): boolean {
  const normalizedExpected = normalizeFingerprint(expected);
  const normalizedActual = normalizeFingerprint(actual);
  return normalizedExpected.length === 64 && normalizedActual.length === 64 &&
    normalizedExpected === normalizedActual;
}

export async function verifyAndPinPeerKey(
  localUserId: string,
  peerUserId: string,
  publicKeyRaw: string,
  peerLabel: string,
): Promise<string> {
  if (localUserId === peerUserId) return getKeyFingerprint(publicKeyRaw);
  const fingerprint = await getKeyFingerprint(publicKeyRaw);
  const storageKey = "raven:e2ee:peer-key:" + localUserId + ":" + peerUserId;
  const pinned = window.localStorage.getItem(storageKey);
  if (pinned) {
    if (!fingerprintsMatch(pinned, fingerprint)) {
      throw new Error(
        "SECURITY WARNING: " + peerLabel + "'s encryption key has changed since you verified it. Do not send or decrypt files until you confirm the new fingerprint with them through a separate trusted channel."
      );
    }
    return fingerprint;
  }

  const expected = window.prompt(
    "Verify " + peerLabel + "'s encryption fingerprint through a separate trusted channel (for example, a voice call or in person).\n\n" +
    "Fingerprint shown by RAVEN:\n" + fingerprint + "\n\n" +
    "Paste the fingerprint they gave you. Do not accept this key based only on what RAVEN displays."
  );
  if (!expected || !fingerprintsMatch(expected, fingerprint)) {
    throw new Error("Fingerprint verification failed. No key was trusted and the transfer was stopped.");
  }
  window.localStorage.setItem(storageKey, fingerprint);
  return fingerprint;
}
