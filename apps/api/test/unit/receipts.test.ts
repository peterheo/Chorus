import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJcs, signReceipt, verifyReceiptEnvelope } from '../../src/receipts.ts';

describe('receipts JCS and Ed25519', () => {
  it('matches the RFC 8785 section 3.2.2 sample vector', () => {
    const value = {
      numbers: [Number('333333333.33333329'), 1e30, 4.5, 2e-3, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(canonicalJcs(value)).toBe(
      `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":${JSON.stringify(value.string)}}`,
    );
  });

  it('signs and verifies, and rejects tampering, another key, and a mismatched subject digest', () => {
    const pair = generateKeyPairSync('ed25519');
    const other = generateKeyPairSync('ed25519');
    const receipt = { task: { id: 'task-a' }, completed_at: '2026-09-27T00:00:00.000Z' };
    const envelope = signReceipt(receipt, pair.privateKey, 'key-a');
    expect(verifyReceiptEnvelope(envelope, pair.publicKey, 'key-a')).toBe(true);
    expect(verifyReceiptEnvelope(envelope, other.publicKey, 'key-a')).toBe(false);
    expect(
      verifyReceiptEnvelope(
        { ...envelope, receipt: { task: { id: 'task-b' } } },
        pair.publicKey,
        'key-a',
      ),
    ).toBe(false);
    expect(
      verifyReceiptEnvelope({ ...envelope, jcs_sha256: '0'.repeat(64) }, pair.publicKey, 'key-a'),
    ).toBe(false);
  });
});
