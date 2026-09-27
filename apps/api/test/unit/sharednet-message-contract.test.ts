import { describe, expect, it } from 'vitest';
import { fetchConversationWindow } from '../../src/conversation/fetch.ts';
import { parsePage, senderDisplayName } from '../../src/sharednet/client.ts';

/**
 * One SharedNet room message, field for field as the live API returns it (GET /rooms/{id}/messages and
 * /wait, observed 2026-09). SharedNet publishes no schema for it, so this fixture IS the contract Chorus
 * holds it to: every reader of SharedNet messages must accept every variant below. The nullable-name
 * variant is the one that broke conversation scanning in production.
 */
const observed = {
  id: 'msg_MNxAm2btQv',
  room_id: 'rom_cHisCTeJxI',
  sequence: 1,
  sender_principal_id: 'p_xsV69wVKNB',
  sender_agent_id: null,
  sender_instance_id: 'i_Bf9m7cs98l',
  sender: { member_id: 'i_Bf9m7cs98l', kind: 'guest', name: 'claude-code' },
  type: 'message',
  content: 'Hi, joined and listening.',
  reply_to_message_id: null,
  created_at: '2026-09-26T19:59:15.430Z',
};

type Variant = readonly [label: string, item: Record<string, unknown>, shownName: string];
const withSender = (sender: Record<string, unknown>) => ({ ...observed, sender });
const variants: readonly Variant[] = [
  ['as observed', observed, 'claude-code'],
  [
    'a null sender name',
    withSender({ member_id: 'i_Bf9m7cs98l', kind: 'guest', name: null }),
    'i_Bf9m7cs98l',
  ],
  ['no sender name', withSender({ member_id: 'i_Bf9m7cs98l', kind: 'guest' }), 'i_Bf9m7cs98l'],
  [
    'a blank sender name',
    withSender({ member_id: 'i_Bf9m7cs98l', kind: 'guest', name: '  ' }),
    'i_Bf9m7cs98l',
  ],
  ['a null sender kind', withSender({ member_id: 'i_Bf9m7cs98l', kind: null, name: 'x' }), 'x'],
  ['an agent tag', { ...observed, sender_agent_id: 'a_Tag12345' }, 'claude-code'],
  ['a reply', { ...observed, reply_to_message_id: 'msg_Earlier01' }, 'claude-code'],
  [
    'extra fields SharedNet may add',
    { ...observed, edited_at: null, reactions: [] },
    'claude-code',
  ],
];

describe('SharedNet message contract: every reader accepts every observed variant', () => {
  it.each(variants)('the watcher page parser accepts %s', (_label, item) => {
    const page = parsePage({ items: [item], next_cursor: 1, has_more: false }, 0);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]?.senderMemberId).toBe('i_Bf9m7cs98l');
  });

  it.each(variants)('the conversation scan accepts %s', async (_label, item, shownName) => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [item], next_cursor: '1', has_more: false }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const window = await fetchConversationWindow({
      sharednetBaseUrl: 'https://sharednet.example',
      externalRoomId: 'rom_cHisCTeJxI',
      seatToken: 'sni_test',
      fromSequence: 1,
      toSequence: 1,
      fetchImpl,
    });
    expect(window.messages.map((m) => m.sender_name)).toEqual([shownName]);
  });

  it.each(variants)('the coordination follow names the sender of %s', (_label, item, shownName) => {
    const [message] = parsePage({ items: [item], has_more: false }, 0).messages;
    if (message === undefined) throw new Error('expected one message');
    expect(senderDisplayName(message.senderName, message.senderMemberId)).toBe(shownName);
  });
});
