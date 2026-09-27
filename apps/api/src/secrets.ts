import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for the Chorus service seat's SharedNet token at rest. The stored ciphertext is
 * `encrypted || 16-byte tag`, with a random 12-byte nonce per encryption. `keyId` (first 8 hex chars
 * of sha256(key)) lets a wrong key be reported clearly instead of as a generic auth-tag failure.
 * Decryption happens only inside the watcher process; the plaintext is never logged.
 */
export interface SealedSecret {
  readonly ciphertext: Buffer;
  readonly nonce: Buffer;
  readonly keyId: string;
}

export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

export function sealSecret(key: Buffer, plaintext: string): SealedSecret {
  assertKey(key);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]),
    nonce,
    keyId: keyIdOf(key),
  };
}

export function openSecret(key: Buffer, sealed: SealedSecret): string {
  assertKey(key);
  if (sealed.keyId !== keyIdOf(key)) {
    throw new Error(
      `Secret was sealed with key ${sealed.keyId}, not the configured key ${keyIdOf(key)}.`,
    );
  }
  if (sealed.ciphertext.length < 17) throw new Error('Sealed secret is too short.');
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16);
  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('The secrets key must be 32 bytes.');
}
