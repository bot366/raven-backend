# RAVEN End-to-End Encryption (E2EE) Design

Status: design proposal for the controlled-testing phase. This document does not enable encryption or change live application behavior.

## 1. Security goal

New RAVEN transfers should be encrypted in the sender's browser before any file bytes reach the API. Only the sender and the intended recipient should have the decryption material. The API, database, hosting provider, and storage system should receive ciphertext and encrypted key envelopes only.

This is application-layer end-to-end encryption. HTTPS/TLS remains required as a separate transport-security layer.

## 2. Threat model and limits

The design is intended to protect file contents and file metadata against:
- A database-only disclosure.
- A storage-volume or backup disclosure.
- A network observer between the browser and RAVEN.
- Routine access by hosting or application operators to stored transfer bytes.

It does not protect against:
- Malware, browser extensions, keyloggers, or an attacker controlling either endpoint.
- Someone using an already-unlocked sender or recipient device.
- A malicious or compromised frontend build that changes the JavaScript delivered to users. A web application can technically deliver code that reads plaintext before encryption or after decryption; independent client verification or a separately distributed signed client would be needed to strengthen this threat boundary.
- A recipient copying, screenshotting, or forwarding a file after decrypting it.
- A malicious server replacing a recipient's public key unless key fingerprints are independently verified or a key-transparency mechanism is added.

The first release should be labelled experimental and used only with disposable, non-sensitive files until the protocol and implementation have been independently reviewed. The selected HPKE JavaScript implementation documents that it has passed relevant test vectors but has not been formally audited.

## 3. Cryptographic construction

### File contents

- Generate a fresh random 256-bit Data Encryption Key (DEK) for every transfer using the browser cryptographically secure random generator.
- Encrypt file data in independent chunks in the browser using AES-256-GCM.
- Use a fresh random 96-bit nonce for every chunk under that DEK. Never reuse a nonce with the same key.
- Authenticate transfer ID, format version, chunk index, and chunk count as additional authenticated data (AAD). This prevents undetected chunk substitution or reordering.
- Hash ciphertext on the server for corruption detection. The server-side hash is not a replacement for GCM authentication.
- Keep chunk encryption bounded in memory so large files do not need to be loaded entirely into RAM.

### Metadata

Encrypt the original filename, MIME type, and original plaintext size with AES-256-GCM under the same DEK but with a separate nonce and metadata-specific AAD. The backend should store only an opaque placeholder filename and ciphertext size. Sender, recipient, and share pages decrypt metadata in the browser.

The server will still learn some operational metadata, including account IDs, recipient, approximate encrypted size, timestamps, IP/network information, and transfer status. Hiding all traffic and relationship metadata is outside this first version.

### Delivering the DEK to accounts

Use HPKE (RFC 9180) to encrypt the DEK separately to:
1. The sender's public encryption key, so the sender can later open their sent file.
2. The intended recipient's public encryption key, for direct account-to-account transfers.

Use HPKE Auth mode for direct-transfer envelopes so the recipient can authenticate the sender's key, not Base mode alone. The recipient must verify that the sender public key is the one associated with the claimed account. A public-key directory controlled by the same server is vulnerable to key substitution; the UI should expose key fingerprints for out-of-band verification and clearly warn when a contact's key changes. Also include a unique transfer/message identifier and track processed transfer IDs so replayed envelope submissions can be rejected.

Initial cipher suite: DHKEM(P-256, HKDF-SHA256) / HKDF-SHA256 / AES-256-GCM. Use a maintained HPKE implementation rather than designing a custom key-wrapping protocol. The implementation currently evaluated is `@hpke/core`, which uses the Web Cryptography API and documents browser support. Its repository states that it has passed HPKE/Wycheproof test vectors but has not been formally audited; that limitation must remain visible in the security notes.

The API stores only the HPKE encapsulated value and ciphertext envelope. It must never receive the DEK or a plaintext private key.

### Identity keys and recovery

- Each account has one versioned public/private encryption key pair.
- The public key is registered with RAVEN and can be returned to an authenticated sender.
- The private key is generated in the browser and never uploaded in plaintext.
- Create a random, high-entropy recovery code for the user. Use it to encrypt the export of the private key locally with AES-256-GCM. Upload only the encrypted private-key backup, salt/nonce, and public key.
- Keep an imported non-extractable private CryptoKey in IndexedDB on a device after the user unlocks it.
- A new device or cleared browser profile must require the recovery code to restore the private key. RAVEN cannot recover the key if both the local copy and recovery code are lost. This is an intentional consequence of server-blind encryption.
- The recovery code must be displayed once, with a download/copy option and a confirmation step. Never log it or send it to the API.
- Public-key changes must be versioned and shown to users. A key fingerprint should be available for out-of-band verification. Do not silently trust a changed key from the server directory.

### Public share links

For a public share, the file DEK is carried in the URL fragment, for example `https://<frontend>/share/<token>#key=<secret>`. Browsers do not send URL fragments in HTTP requests, so the API receives only the share token and cannot read the key. The frontend share page fetches ciphertext, decrypts locally, and offers the file to the visitor.

Anyone with the complete share link can decrypt the file. Anyone with only the token cannot. Revoking a link prevents future downloads through RAVEN but cannot erase copies already downloaded by visitors.

## 4. Storage and API changes

The implementation will need:
- A versioned user encryption-key record containing public key, encrypted private-key backup, recovery salt/nonce, and timestamps.
- A transfer-key-envelope table scoped to transfer, recipient account, envelope purpose (sender/recipient), and algorithm version.
- Encrypted transfer metadata and an encryption format/version field on transfers.
- Authenticated endpoints to create/read the current user's key record, retrieve a recipient's public key, and create/read only the caller's own transfer envelopes.
- A ciphertext download path for authenticated direct recipients and public share visitors.
- Backend authorization checks that prevent one account from reading another account's key backup or envelopes.

The existing chunk upload integrity checks can continue to hash ciphertext. The encrypted file format must be versioned and have explicit nonce/chunk framing so downloads can be split and authenticated reliably.

## 5. Compatibility

- Existing transfers are legacy plaintext transfers and must be explicitly marked as such. Do not silently claim they are encrypted.
- New transfers should use the encrypted format only after the sender and recipient key setup is complete.
- Do not perform server-side "retroactive encryption" on old files: the server would have to read the original plaintext. A user can download an old file and re-upload it through the encrypted client flow.
- The feature must not be enabled on the live deployment until backend migrations, frontend code, and API behavior are deployed together.

## 6. Implementation sequence

1. **Identity and recovery:** public-key records, encrypted private-key backup, browser key cache, recovery-code setup/restore, key fingerprints, and authorization tests.
2. **Direct transfers:** client-side chunk encryption, encrypted metadata, sender/recipient HPKE envelopes, ciphertext upload/download, and decrypt-on-recipient behavior.
3. **Public shares:** frontend share route, fragment-only key handling, local decryption, and clear bearer-link warnings.
4. **Hardening:** tamper tests, wrong-key tests, replay/authorization tests, large-file memory tests, upload retry/resume tests, and a security review.

## 7. Required tests before enabling E2EE

- Sender can encrypt, upload, and decrypt their own transfer.
- Intended recipient can decrypt; a different account cannot.
- API/database/storage fixtures contain no plaintext file bytes, filename, or MIME type for encrypted transfers.
- A changed ciphertext byte, nonce, AAD, or chunk order causes decryption to fail.
- A missing, wrong, or corrupted envelope fails closed with a clear error.
- Recovery code restores the same identity key on a second browser profile.
- Wrong recovery code does not import a usable private key.
- Public share link works with the fragment key; token-only access yields ciphertext and cannot reveal plaintext.
- A transfer created before E2EE remains labelled legacy and continues using its existing compatibility path.
- Chunk retries and interruptions do not cause nonce reuse or mix ciphertext from different files.
- Backend logs and error responses never contain plaintext file data or recovery material.

## 8. References

- RFC 9180, Hybrid Public Key Encryption: https://www.rfc-editor.org/rfc/rfc9180.html
- OWASP Cryptographic Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- hpke-js implementation and supported environments: https://github.com/dajiaji/hpke-js
