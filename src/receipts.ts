// Signed receipts (spec §54). A receipt body is canonicalized with RFC 8785
// (JSON Canonicalization Scheme), hashed with SHA-256, and the digest is
// signed with Ed25519. Anyone holding the published public key can verify
// that Chorus issued the receipt and that it has not changed since.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * RFC 8785 canonical JSON. Object keys are sorted by UTF-16 code units (what
 * Array.prototype.sort does), and ECMAScript's number and string serialization
 * is exactly the one JCS specifies.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("JCS: non-finite numbers are not allowed");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}

export interface SignedReceipt {
  body: Record<string, unknown>;
  /** hex SHA-256 of the canonical body */
  sha256: string;
  /** base64url Ed25519 signature over the raw digest bytes */
  signature: string;
  key_id: string;
}

export class ReceiptSigner {
  readonly keyId: string;
  private readonly privateKey: KeyObject;
  readonly publicKeyPem: string;

  constructor(privateKey: KeyObject, keyId?: string) {
    this.privateKey = privateKey;
    const pub = createPublicKey(privateKey);
    this.publicKeyPem = pub.export({ type: "spki", format: "pem" }).toString();
    const fingerprint = createHash("sha256").update(pub.export({ type: "spki", format: "der" })).digest("hex");
    this.keyId = keyId ?? `chorus-${fingerprint.slice(0, 12)}`;
  }

  /**
   * Load the key from RECEIPT_SIGNING_KEY (PKCS#8 PEM) if given, else from
   * `path`, generating and saving a new key there on first use so the key
   * (and key ID) stay stable across restarts.
   */
  static load(opts: { pem?: string; path?: string; keyId?: string }): ReceiptSigner {
    if (opts.pem) return new ReceiptSigner(createPrivateKey(opts.pem), opts.keyId);
    if (opts.path && existsSync(opts.path)) {
      return new ReceiptSigner(createPrivateKey(readFileSync(opts.path, "utf8")), opts.keyId);
    }
    const { privateKey } = generateKeyPairSync("ed25519");
    if (opts.path) {
      mkdirSync(dirname(opts.path), { recursive: true });
      writeFileSync(opts.path, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    }
    return new ReceiptSigner(privateKey, opts.keyId);
  }

  sign(body: Record<string, unknown>): SignedReceipt {
    const withKey = { ...body, key_id: this.keyId };
    const digest = createHash("sha256").update(canonicalJson(withKey)).digest();
    const signature = sign(null, digest, this.privateKey).toString("base64url");
    return { body: withKey, sha256: digest.toString("hex"), signature, key_id: this.keyId };
  }
}

/** Verify a receipt against a PEM public key. Recomputes the digest from the body. */
export function verifyReceipt(r: SignedReceipt, publicKeyPem: string): boolean {
  const digest = createHash("sha256").update(canonicalJson(r.body)).digest();
  if (digest.toString("hex") !== r.sha256) return false;
  return verify(null, digest, createPublicKey(publicKeyPem), Buffer.from(r.signature, "base64url"));
}
