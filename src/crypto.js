/**
 * AES-256-GCM at-rest decryption for OAuth-credentials, gespiegelt von
 * specifyr's server/shared/utils/secrets-store.ts. Master-Key kommt aus
 * SPECIFYR_SECRET_KEY (64 hex chars = 32 bytes) — MUSS identisch zu
 * specifyr sein, sonst schlägt die Entschlüsselung fehl.
 *
 * Wir replizieren die Funktion bewusst (statt sie aus einem shared
 * package zu ziehen): der proxy ist sehr klein, eine geteilte Lib hier
 * würde ein Monorepo-Setup oder ein eigenes Paket erfordern, beides
 * deutlich mehr Setup als drei Codezeilen Crypto.
 */
import crypto from "node:crypto";

function masterKey() {
  const hex = process.env.SPECIFYR_SECRET_KEY ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "SPECIFYR_SECRET_KEY must be 64 hex chars (32 bytes) — set it identically to specifyr's value",
    );
  }
  return Buffer.from(hex, "hex");
}

/** Encrypt plaintext → { iv, tag, data } (all hex). */
export function encrypt(plaintext) {
  const key = masterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    data: data.toString("hex"),
  };
}

/** Decrypt { iv, tag, data } → plaintext. Throws on auth-tag mismatch. */
export function decrypt(entry) {
  const key = masterKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(entry.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(entry.data, "hex")),
    decipher.final(),
  ]).toString("utf8");
}
