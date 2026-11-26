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

export async function createEncryptionIdentity(): Promise<{
  payload: { publicKey: string; encryptedPrivateKey: string; recoverySalt: string; recoveryNonce: string };
  recoveryCode: string;
  identity: EncryptionIdentity;
}> {
  const pair = await suite.kem.generateKeyPair();
  const publicRaw = new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey));
  const privateRaw = new Uint8Array(await suite.kem.serializePrivateKey(pair.privateKey));
  const codeBytes = randomBytes(32);
  const recoverySalt = randomBytes(16);
  const recoveryNonce = randomBytes(12);
  const recoveryKey = await recoveryAesKey(codeBytes, recoverySalt);
  const encryptedPrivate = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(recoveryNonce), additionalData: aad("RAVEN:PRIVATE-KEY:1") },
    recoveryKey,
    toArrayBuffer(privateRaw),
  );
  const recoveryCode = recoveryCodeFromBytes(codeBytes);
  privateRaw.fill(0);
  codeBytes.fill(0);
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
  const privateKey = await suite.kem.deserializePrivateKey(privateRaw);
  const identity = {
    pair: { publicKey, privateKey },
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
  userId: string,
  keyVersion: number,
  transferId: string,
  purpose: "sender" | "recipient",
): Promise<KeyEnvelope> {
  const context = await suite.createSenderContext({
    recipientPublicKey,
    senderKey: senderPair,
    info: aad("RAVEN:FILE-KEY:1:" + transferId + ":" + userId + ":" + purpose),
  });
  const ciphertext = await context.seal(toArrayBuffer(fileKeyRaw));
  return {
    userId,
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
  recipientId: string,
  recipientPublicKeyRaw: string,
  recipientKeyVersion: number,
): Promise<TransferEncryptionSession> {
  const fileKeyRaw = randomBytes(32);
  const fileKey = await crypto.subtle.importKey("raw", toArrayBuffer(fileKeyRaw), "AES-GCM", false, ["encrypt", "decrypt"]);
  const recipientPublicKey = await suite.kem.deserializePublicKey(toArrayBuffer(fromBase64(recipientPublicKeyRaw)));
  const senderEnvelope = await wrapFileKey(fileKeyRaw, senderPair.publicKey, senderPair, senderId, senderKeyVersion, transferId, "sender");
  const recipientEnvelope = await wrapFileKey(fileKeyRaw, recipientPublicKey, senderPair, recipientId, recipientKeyVersion, transferId, "recipient");
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
    envelopes: [senderEnvelope, recipientEnvelope],
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
  if (value.version !== 1 || !Number.isSafeInteger(value.originalSize) || value.originalSize < 0 ||
      !Number.isSafeInteger(value.chunkCount) || value.chunkCount < 1 ||
      value.plaintextChunkSize !== CHUNK_PLAINTEXT_SIZE ||
      typeof value.filename !== "string" || value.filename.length < 1 || value.filename.length > 255) {
    throw new Error("The encrypted file metadata is invalid.");
  }
  if (fromBase64(value.noncePrefix).length !== 8) throw new Error("The encrypted file nonce prefix is invalid.");
  return value;
}

export async function unwrapTransferKey(
  pair: CryptoKeyPair,
  transferId: string,
  recipientUserId: string,
  purpose: "sender" | "recipient",
  enc: string,
  ciphertext: string,
  senderPublicKeyRaw: string,
): Promise<CryptoKey> {
  const senderPublicKey = await suite.kem.deserializePublicKey(toArrayBuffer(fromBase64(senderPublicKeyRaw)));
  const context = await suite.createRecipientContext({
    recipientKey: pair.privateKey,
    enc: toArrayBuffer(fromBase64(enc)),
    senderPublicKey,
    info: aad("RAVEN:FILE-KEY:1:" + transferId + ":" + recipientUserId + ":" + purpose),
  });
  const fileKeyRaw = await context.open(toArrayBuffer(fromBase64(ciphertext)));
  if (fileKeyRaw.byteLength !== 32) throw new Error("The transfer encryption key is invalid.");
  return crypto.subtle.importKey("raw", fileKeyRaw, "AES-GCM", false, ["decrypt"]);
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
    if (normalizeFingerprint(pinned) !== normalizeFingerprint(fingerprint)) {
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
  if (!expected || normalizeFingerprint(expected) !== normalizeFingerprint(fingerprint)) {
    throw new Error("Fingerprint verification failed. No key was trusted and the transfer was stopped.");
  }
  window.localStorage.setItem(storageKey, fingerprint);
  return fingerprint;
}
