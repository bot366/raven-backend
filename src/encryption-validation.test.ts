import test from "node:test";
import assert from "node:assert/strict";
import { validateEncryptionEnvelopes } from "./encryption-validation.js";

function envelope(userId: string, keyVersion = 1) {
  const enc = Buffer.alloc(65);
  enc[0] = 0x04;
  return {
    userId,
    keyVersion,
    enc: enc.toString("base64"),
    ciphertext: Buffer.alloc(48, 7).toString("base64"),
  };
}

test("public encrypted links accept exactly the sender envelope", () => {
  const result = validateEncryptionEnvelopes([envelope("sender")], ["sender"]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.envelopes.length, 1);
});

test("direct encrypted transfers require both participant envelopes", () => {
  const result = validateEncryptionEnvelopes(
    [envelope("sender"), envelope("recipient")],
    ["sender", "recipient"],
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.envelopes.length, 2);
});

test("rejects missing, extra, duplicate, and non-participant envelopes", () => {
  assert.equal(validateEncryptionEnvelopes([], ["sender"]).ok, false);
  assert.equal(validateEncryptionEnvelopes([envelope("sender")], ["sender", "recipient"]).ok, false);
  assert.equal(validateEncryptionEnvelopes(
    [envelope("sender"), envelope("sender")],
    ["sender", "recipient"],
  ).ok, false);
  assert.equal(validateEncryptionEnvelopes(
    [envelope("sender"), envelope("attacker")],
    ["sender", "recipient"],
  ).ok, false);
  assert.equal(validateEncryptionEnvelopes(
    [envelope("sender"), envelope("recipient"), envelope("extra")],
    ["sender", "recipient"],
  ).ok, false);
});

test("rejects invalid key versions and malformed HPKE envelope values", () => {
  assert.equal(validateEncryptionEnvelopes([envelope("sender", 0)], ["sender"]).ok, false);
  assert.equal(validateEncryptionEnvelopes([envelope("sender", 1.5)], ["sender"]).ok, false);
  assert.equal(validateEncryptionEnvelopes(
    [{ ...envelope("sender"), enc: Buffer.alloc(65, 1).toString("base64") }],
    ["sender"],
  ).ok, false);
  assert.equal(validateEncryptionEnvelopes(
    [{ ...envelope("sender"), ciphertext: Buffer.alloc(47).toString("base64") }],
    ["sender"],
  ).ok, false);
  assert.equal(validateEncryptionEnvelopes(
    [{ ...envelope("sender"), ciphertext: "not-base64" }],
    ["sender"],
  ).ok, false);
});
