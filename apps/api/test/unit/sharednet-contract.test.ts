import { describe, expect, it } from 'vitest';
import { parsePage, SharedNetContractError } from '../../src/sharednet/client.ts';
import { PROOF_MESSAGE } from '../../src/watcher.ts';

const item = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  sequence: 5,
  sender_principal_id: 'p_abcdef1234',
  sender_instance_id: 'i_abcdef1234',
  sender: { member_id: 'i_abcdef1234', kind: 'guest', name: 'n' },
  content: 'hi',
  ...over,
});

describe('SharedNet contract (unit)', () => {
  it('parses a well-formed page', () => {
    const page = parsePage(
      { items: [item(), item({ id: 'msg_2', sequence: 6 })], next_cursor: 6, has_more: false },
      4,
    );
    expect(
      page.messages.map((m) => [m.id, m.sequence, m.senderPrincipalId, m.senderMemberId]),
    ).toEqual([
      ['msg_1', 5, 'p_abcdef1234', 'i_abcdef1234'],
      ['msg_2', 6, 'p_abcdef1234', 'i_abcdef1234'],
    ]);
    expect(page.hasMore).toBe(false);
    expect(parsePage({ items: [], has_more: true }, 0)).toEqual({ messages: [], hasMore: true });
  });

  it.each([
    ['not an object', 'x'],
    ['items missing', {}],
    ['item without id', { items: [item({ id: undefined })] }],
    ['item without integer sequence', { items: [item({ sequence: '5' })] }],
    ['item without sender_principal_id', { items: [item({ sender_principal_id: undefined })] }],
    ['malformed principal', { items: [item({ sender_principal_id: 'bob' })] }],
    ['item without sender.member_id', { items: [item({ sender: {} })] }],
    ['malformed member id', { items: [item({ sender: { member_id: 'bob' } })] }],
    ['item without content', { items: [item({ content: 3 })] }],
    ['sequence not above the cursor', { items: [item({ sequence: 4 })] }],
    ['sequence not strictly increasing', { items: [item(), item({ id: 'msg_2', sequence: 5 })] }],
  ])('fails closed on %s', (_label, body) => {
    expect(() => parsePage(body, 4)).toThrow(SharedNetContractError);
  });

  it('matches exactly one challenge shape', () => {
    const nonce = `cvn_${'A'.repeat(22)}`;
    expect(PROOF_MESSAGE.exec(`chorus-verify ${nonce}`)?.[1]).toBe(nonce);
    for (const bad of [
      `Chorus-verify ${nonce}`,
      `chorus-verify  ${nonce}`,
      `please chorus-verify ${nonce}`,
      `chorus-verify ${nonce} extra`,
      `chorus-verify cvn_${'A'.repeat(21)}`,
      `chorus-verify cvn_${'A'.repeat(23)}`,
      `chorus-verify ${nonce}\nsecond line`,
      `chorus-verify ${nonce.replace('A', '!')}`,
    ]) {
      expect(PROOF_MESSAGE.exec(bad), bad).toBeNull();
    }
  });
});
