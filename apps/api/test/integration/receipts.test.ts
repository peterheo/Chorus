import { generateKeyPairSync, createHash, createPublicKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiptVerifyUrl, signReceipt } from '../../src/receipts.ts';
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
      limits: { receiptVerifyPerMinute: 2 },
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

describe('shareable receipt verification link', () => {
  let stack: Stack;
  const pair = generateKeyPairSync('ed25519');
  const keyId = createHash('sha256')
    .update(createPublicKey(pair.privateKey).export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16);

  beforeAll(async () => {
    stack = await startStack({ watch: false, receiptKey: pair.privateKey });
  });
  afterAll(async () => stack.stop());

  const open = (envelope: unknown) =>
    fetch(
      stack.baseUrl +
        '/v1/receipts/verify?envelope=' +
        Buffer.from(JSON.stringify(envelope)).toString('base64url'),
    );

  it('shows a signed receipt to anyone who opens the link, without authentication', async () => {
    const envelope = signReceipt({ task: { id: 'task-1', title: 'Done' } }, pair.privateKey, keyId);
    const link = receiptVerifyUrl(stack.baseUrl, envelope);
    if (link === null) throw new Error('expected a link for a short envelope');
    const url = new URL(link);
    expect(url.pathname).toBe('/v1/receipts/verify');

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      valid: true,
      key_id: keyId,
      key_url: '/v1/keys/' + keyId,
      receipt: envelope.receipt,
      envelope,
    });
  });

  it('gives no link for an envelope too long to fit in a URL', () => {
    const long = signReceipt({ note: 'x'.repeat(8000) }, pair.privateKey, keyId);
    expect(receiptVerifyUrl(stack.baseUrl, long)).toBeNull();
  });

  it('never echoes a receipt whose signature does not verify', async () => {
    const envelope = signReceipt({ task: { id: 'task-1' } }, pair.privateKey, keyId);
    const forged = await (await open({ ...envelope, receipt: { task: { id: 'task-2' } } })).json();
    expect(forged).toEqual({ valid: false, key_id: keyId, reason: 'invalid_signature' });
    const otherKey = await (await open({ ...envelope, key_id: 'someone-else' })).json();
    expect(otherKey).toEqual({ valid: false, key_id: 'someone-else', reason: 'unknown_key' });
  });

  it('rejects a missing, non-base64url, non-JSON or oversized envelope with 400', async () => {
    for (const query of ['', '?envelope=', '?envelope=not%20base64', '?envelope=bm90IGpzb24']) {
      const response = await fetch(stack.baseUrl + '/v1/receipts/verify' + query);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_request' });
    }
    const huge = await fetch(stack.baseUrl + '/v1/receipts/verify?envelope=' + 'A'.repeat(8193));
    expect(huge.status).toBe(400);
  });
});
