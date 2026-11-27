# RAVEN End-to-End Encryption (E2EE) Design

Status: experimental direct account-to-account encryption and encrypted public share links are implemented on branch `raven-e2ee-design` in draft PR #7. They are not merged or deployed. Key transparency, safe key rotation, and independent audit are not implemented.

## 1. Security goal

New direct account-to-account transfers are encrypted in the sender's browser before file bytes reach the API. Only the sender and intended recipient should possess decryption material. The API, database, hosting provider, and storage system receive ciphertext and encrypted key envelopes only.

HTTPS/TLS remains mandatory as a separate transport-security layer.

## 2. Threat model and limits

Designed to protect file contents and encrypted metadata against database-only disclosure, storage/backup disclosure, network observers, and routine access by hosting/application operators.

It does not protect against:
- Malware, hostile browser extensions, keyloggers, or an attacker controlling either endpoint.
- A compromised frontend build. Malicious JavaScript delivered by the application can read plaintext before encryption, after decryption, and can request cryptographic operations from the browser even when private keys are non-exportable.
- Someone using an already-unlocked endpoint.
- A recipient copying or forwarding a file after decryption.
- A first-contact public-key substitution if the user does not compare the fingerprint through a genuinely separate trusted channel.
- Loss of both the local private key and recovery code.

Server-visible metadata includes account IDs, sender/recipient relationship, approximate encrypted size, timestamps, IP/network details and transfer status.

## 3. Cryptographic construction

### File contents and metadata

- A fresh random 256-bit data-encryption key (DEK) per transfer.
- AES-256-GCM encryption in the browser, in bounded chunks.
- Each file chunk uses a unique 96-bit nonce constructed from a fresh random 64-bit transfer prefix and a 32-bit chunk index.
- The reserved index `0xffffffff` is used only for encrypted metadata; file chunks cannot use this nonce.
- Transfer ID, format version, chunk index and chunk count are authenticated as AAD.
- Filename, MIME type, plaintext size, chunk layout and nonce prefix are encrypted with the DEK and metadata-specific AAD.
- The server hashes ciphertext for corruption detection; the GCM tag provides cryptographic authenticity.

The implementation validates metadata shape, expected chunk count, file sizes and the reserved metadata nonce before decrypting chunks.

### Key envelopes

HPKE Auth mode is used with DHKEM(P-256, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM. The sender and recipient each receive a separate envelope containing the transfer DEK. HPKE context info binds the envelope to:
- the transfer ID,
- sender account ID,
- recipient account ID,
- and whether the envelope is for the sender or recipient.

This prevents an otherwise valid envelope from being replayed or swapped across accounts, transfers, or envelope purposes. The recipient also verifies the sender's account key fingerprint before attempting to decrypt.

### Account identity and recovery

- Each account has a versioned P-256 public/private encryption key pair.
- The private-key backup is encrypted locally with AES-256-GCM using a randomly generated 256-bit recovery code and HKDF-SHA-256.
- The recovery code is never sent to the server.
- After creation or recovery, the private key is imported as a non-exportable WebCrypto key, then checked against its public key using an HPKE self-test before caching.
- The unlocked private key stays in current-tab memory and is cleared on logout. After reload, users must unlock it again with the recovery code.
- Losing the recovery code and every unlocked/local copy makes old encrypted transfers unrecoverable.

### Public-key fingerprint verification and pinning

- Fingerprints are SHA-256 over the raw uncompressed P-256 public key.
- On first contact, the sender must compare the recipient's fingerprint with a value the recipient shared out-of-band through a separate trusted channel, such as an in-person comparison or voice call.
- On receipt, the recipient performs the same verification for the sender.
- Public encrypted share links use a random DEK in the URL fragment (`#key=...`). URL fragments are not sent in HTTP requests, so the server receives the token but not the decryption key. Anyone who receives the complete link can decrypt the file. The browser uses the fragment key to decrypt locally; the server stores only ciphertext and the sender envelope. The sender's copy of the complete link is retained in tab-scoped session storage so it can be copied after a page refresh; it is not written to persistent local storage and is cleared on logout or when the tab session ends.
- The browser stores verified fingerprints per local-account/peer-account pair. A changed fingerprint is rejected, not silently accepted.
- Clearing browser site data removes local pins; contacts must be verified again.

This is out-of-band verification with local pinning, not a key-transparency service. If users compare only values displayed by the same potentially compromised RAVEN service, the comparison provides no independent trust.

## 4. Backend controls

- Versioned user public-key and encrypted-private-key-backup records.
- Authenticated public-key lookup.
- Transfer key envelopes restricted to sender and recipient.
- Server validates canonical base64 encoding, key sizes, transfer participants and current key versions.
- Envelope storage occurs only while the transfer is pending and is transactionally tied to a successful pending-transfer update.
- Encrypted transfers reject the legacy single-request plaintext upload endpoint.
- Transfer completion requires encrypted metadata and both participant key envelopes.
- Legacy transfers remain encryption version 0 and are not retroactively relabelled encrypted.

## 5. Compatibility and exclusions

- Direct RAVEN account-to-account transfers and public encrypted share links are supported in this branch.
- Public links are bearer secrets: anyone with the complete link can decrypt the file. RAVEN does not store the fragment key. The sender's full link is retained in tab-scoped session storage for the current tab and cleared on logout/session end; it is not persisted in local storage.
- Existing transfers remain legacy/plaintext.
- The server cannot retroactively encrypt old files without reading plaintext.
- Key rotation and safe replacement/revocation are not implemented.

## 6. Tests

The CI suite currently covers:
- Identity setup and recovery.
- Rejection of wrong recovery codes.
- Rejection when a public key no longer matches the recovered private key.
- Non-exportability of unlocked private keys.
- HPKE sender/recipient key-envelope round trip.
- Rejection of wrong recipient, wrong envelope purpose and wrong transfer ID.
- Fingerprint normalization, first-contact pinning, and rejecting a changed peer key.
- AES-GCM metadata/chunk round trip.
- Public-share sender-only envelope and fragment-key decryption round trip.
- Rejection of altered ciphertext and metadata nonce.

These tests are important regression checks, not a full security audit or complete browser/backend integration suite.

## 7. Remaining security work before production

1. Independent cryptographic and application security review.
2. Safer key rotation/recovery and explicit key-change UX.
3. Key transparency or a stronger authenticated contact directory.
4. Browser integration tests across supported browsers and devices, including shared links opened in a separate browser.
5. Replay/authorization testing and large-file memory/performance testing.
6. Safe key rotation/replacement and better recovery after loss of the recovery code.
7. Key transparency or a stronger authenticated contact directory.
8. Review frontend delivery integrity and XSS/content security controls.

The implementation remains experimental. Test only with disposable, non-sensitive files until all remaining work and an independent review are complete.

## 8. References

- RFC 9180, Hybrid Public Key Encryption: https://www.rfc-editor.org/rfc/rfc9180.html
- OWASP Cryptographic Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- hpke-js implementation: https://github.com/dajiaji/hpke-js
