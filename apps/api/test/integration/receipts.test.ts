import { generateKeyPairSync, createHash, createPublicKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signReceipt } from '../../src/receipts.ts';
import { startStack, type Stack } from '../helpers/stack.ts';

describe('signed receipt endpoints', () => {
  let stack: Stack;
  const pair = generateKeyPairSync('ed25519');
  const keyId = createHash('sha256')
    .update(createPublicKey(pair.privateKey).export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);

  beforeAll(async () => {
    stack = await startStack({
      watch: false,
      receiptKey: pair.privateKey,
      limits: { receiptVerifyPerIpPerMinute: 2 },
    });
  });
  afterAll(async () => stack.stop());

  it('publishes the public key and verifies an envelope while rejecting a modified subject', async () => {
    const keyResponse = await fetch(stack.baseUrl + '/v1/keys/' + keyId);
    expect(keyResponse.status).toBe(200);
    const key = (await keyResponse.json()) as Record<string, unknown>;
    expect(key).toMatchObject({ key_id: keyId, alg: 'Ed25519' });
    expect(key.public_key_raw_b64).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const envelope = signReceipt({ task: { id: 'task-1' } }, pair.privateKey, keyId);
    const verify = async (body: unknown) =>
      fetch(stack.baseUrl + '/v1/receipts/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const valid = await verify(envelope);
    expect(await valid.json()).toMatchObject({ valid: true, key_id: keyId });
    const tampered = await verify({ ...envelope, receipt: { task: { id: 'task-2' } } });
    expect(await tampered.json()).toMatchObject({ valid: false, reason: 'invalid_signature' });
    expect((await verify(envelope)).status).toBe(429);
  });
});
