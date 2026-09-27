import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { keyIdOf, openSecret, sealSecret } from '../../src/secrets.ts';

describe('secrets.seat_token (unit)', () => {
  const key = randomBytes(32);
  const plaintext = 'sni_seat_super-secret-token';

  it('round-trips, and the ciphertext does not contain the plaintext', () => {
    const sealed = sealSecret(key, plaintext);
    expect(sealed.ciphertext.toString('utf8')).not.toContain(plaintext);
    expect(sealed.ciphertext.toString('base64')).not.toContain(
      Buffer.from(plaintext).toString('base64'),
    );
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.keyId).toBe(keyIdOf(key));
    expect(openSecret(key, sealed)).toBe(plaintext);
  });

  it('uses a fresh nonce per encryption', () => {
    const a = sealSecret(key, plaintext);
    const b = sealSecret(key, plaintext);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('refuses a wrong key (clearly) and a tampered ciphertext', () => {
    const sealed = sealSecret(key, plaintext);
    expect(() => openSecret(randomBytes(32), sealed)).toThrow(/sealed with key/);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(() => openSecret(key, { ...sealed, ciphertext: tampered })).toThrow();
    expect(() => openSecret(key, { ...sealed, nonce: randomBytes(12) })).toThrow();
    expect(() => openSecret(key, { ...sealed, ciphertext: Buffer.alloc(3) })).toThrow();
  });

  it('demands a 32-byte key', () => {
    expect(() => sealSecret(randomBytes(16), 'x')).toThrow(/32 bytes/);
    expect(() => openSecret(randomBytes(31), sealSecret(key, 'x'))).toThrow(/32 bytes/);
  });
});
