import test from "node:test";
import assert from "node:assert/strict";
import { File } from "node:buffer";
import {
  createEncryptionIdentity,
  unlockEncryptionIdentity,
  createTransferEncryptionSession,
  encryptTransferChunk,
  decryptTransferMetadata,
  decryptTransferChunk,
  unwrapTransferKey,
  encodeBase64,
  getKeyFingerprint,
  fingerprintsMatch,
  verifyAndPinPeerKey,
  type StoredEncryptionKey,
} from "../src/e2ee.ts";

test("RAVEN E2EE identity recovery, HPKE key envelopes and AES-GCM file chunks round-trip", async () => {
  const senderCreated = await createEncryptionIdentity();
  const recipientCreated = await createEncryptionIdentity();

  const storedSenderKey: StoredEncryptionKey = {
    user_id: "sender-test-id",
    key_version: 1,
    public_key: senderCreated.payload.publicKey,
    encrypted_private_key: senderCreated.payload.encryptedPrivateKey,
    recovery_salt: senderCreated.payload.recoverySalt,
    recovery_nonce: senderCreated.payload.recoveryNonce,
    algorithm: "HPKE-P256-HKDFSHA256-AES256GCM",
  };
  const storedRecipientKey: StoredEncryptionKey = {
    user_id: "recipient-test-id",
    key_version: 1,
    public_key: recipientCreated.payload.publicKey,
    encrypted_private_key: recipientCreated.payload.encryptedPrivateKey,
    recovery_salt: recipientCreated.payload.recoverySalt,
    recovery_nonce: recipientCreated.payload.recoveryNonce,
    algorithm: "HPKE-P256-HKDFSHA256-AES256GCM",
  };

  const sender = await unlockEncryptionIdentity("sender-test-id", storedSenderKey, senderCreated.recoveryCode);
  const recipient = await unlockEncryptionIdentity("recipient-test-id", storedRecipientKey, recipientCreated.recoveryCode);
  await assert.rejects(
    () => unlockEncryptionIdentity("sender-test-id", storedSenderKey, "A".repeat(43)),
    /recovery code is incorrect/i,
  );

  const originalText = "RAVEN end-to-end encrypted transfer test.";
  const originalBytes = new TextEncoder().encode(originalText);
  const file = new File([originalBytes.buffer as ArrayBuffer], "private-note.txt", { type: "text/plain" });
  const transferId = "e2ee-test-transfer";
  const session = await createTransferEncryptionSession(
    file,
    transferId,
    "sender-test-id",
    sender.pair,
    sender.keyVersion,
    "recipient-test-id",
    recipientCreated.payload.publicKey,
    recipient.keyVersion,
  );

  const senderEnvelope = session.envelopes.find((item) => item.userId === "sender-test-id");
  const recipientEnvelope = session.envelopes.find((item) => item.userId === "recipient-test-id");
  assert.ok(senderEnvelope);
  assert.ok(recipientEnvelope);
  assert.equal(sender.pair.privateKey.extractable, false);
  assert.equal(recipient.pair.privateKey.extractable, false);

  const senderFileKey = await unwrapTransferKey(
    sender.pair, transferId, "sender-test-id", "sender-test-id", "sender", senderEnvelope.enc, senderEnvelope.ciphertext, senderCreated.payload.publicKey,
  );
  const recipientFileKey = await unwrapTransferKey(
    recipient.pair, transferId, "sender-test-id", "recipient-test-id", "recipient", recipientEnvelope.enc, recipientEnvelope.ciphertext, senderCreated.payload.publicKey,
  );
  await assert.rejects(
    () => unwrapTransferKey(sender.pair, transferId, "sender-test-id", "sender-test-id", "sender", recipientEnvelope.enc, recipientEnvelope.ciphertext, senderCreated.payload.publicKey),
  );

  const senderFingerprint = await getKeyFingerprint(senderCreated.payload.publicKey);
  const recipientFingerprint = await getKeyFingerprint(recipientCreated.payload.publicKey);
  assert.equal(senderFingerprint.length, 79);
  assert.ok(fingerprintsMatch(senderFingerprint, senderFingerprint.toLowerCase().replace(/ /g, "-")));
  assert.ok(!fingerprintsMatch(senderFingerprint, recipientFingerprint));

  const originalWindow = globalThis.window;
  const pinStore = new Map<string, string>();
  let promptFingerprint = recipientFingerprint;
  const mockWindow = {
    localStorage: {
      getItem: (key: string) => pinStore.get(key) ?? null,
      setItem: (key: string, value: string) => { pinStore.set(key, value); },
    },
    prompt: () => promptFingerprint,
  } as unknown as Window & typeof globalThis;
  Object.defineProperty(globalThis, "window", { value: mockWindow, configurable: true });
  try {
    const verified = await verifyAndPinPeerKey(
      "sender-test-id", "recipient-test-id", recipientCreated.payload.publicKey, "recipient",
    );
    assert.ok(fingerprintsMatch(verified, recipientFingerprint));
    // A pinned key is accepted without asking again.
    promptFingerprint = "wrong fingerprint";
    await verifyAndPinPeerKey(
      "sender-test-id", "recipient-test-id", recipientCreated.payload.publicKey, "recipient",
    );
    // A replacement key is rejected against the originally pinned fingerprint.
    await assert.rejects(
      () => verifyAndPinPeerKey("sender-test-id", "recipient-test-id", senderCreated.payload.publicKey, "recipient"),
      /SECURITY WARNING/,
    );
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
    else Reflect.deleteProperty(globalThis, "window");
  }

  await assert.rejects(
    () => unwrapTransferKey(
      recipient.pair, transferId + "-changed", "sender-test-id", "recipient-test-id", "recipient",
      recipientEnvelope.enc, recipientEnvelope.ciphertext, senderCreated.payload.publicKey,
    ),
  );

  const metadata = await decryptTransferMetadata(
    recipientFileKey,
    transferId,
    session.encryptedMetadata,
    encodeBase64(session.metadataNonce),
  );
  assert.equal(metadata.filename, "private-note.txt");
  assert.equal(metadata.mimeType, "text/plain");
  assert.equal(metadata.originalSize, originalBytes.length);
  assert.equal(metadata.chunkCount, 1);

  const ciphertext = await encryptTransferChunk(session, transferId, 0, file.slice(0, file.size));
  const ciphertextBuffer = ciphertext.buffer.slice(
    ciphertext.byteOffset,
    ciphertext.byteOffset + ciphertext.byteLength,
  ) as ArrayBuffer;
  const senderPlaintext = await decryptTransferChunk(
    senderFileKey, transferId, 0, 1, metadata.noncePrefix, ciphertextBuffer,
  );
  const recipientPlaintext = await decryptTransferChunk(
    recipientFileKey, transferId, 0, 1, metadata.noncePrefix, ciphertextBuffer,
  );
  assert.equal(new TextDecoder().decode(senderPlaintext), originalText);
  assert.equal(new TextDecoder().decode(recipientPlaintext), originalText);

  const tampered = new Uint8Array(ciphertextBuffer.slice(0));
  tampered[0] ^= 1;
  await assert.rejects(
    () => decryptTransferChunk(
      recipientFileKey, transferId, 0, 1, metadata.noncePrefix, tampered.buffer as ArrayBuffer,
    ),
  );
});
