import { describe, expect, it } from 'vitest';
import { RoomRosters, noteRoomSenders, roomRoster } from '../../src/room-roster.ts';

describe('room rosters (ApplyContext.roster from senders seen)', () => {
  it('keeps every sender per room, latest name wins, sorted by member id, seats excluded', () => {
    const rosters = new RoomRosters();
    rosters.note('r1', [
      { member_id: 'i_bob', name: 'bob' },
      { member_id: 'i_alice', name: 'alice' },
      { member_id: 'i_seat', name: 'chorus' },
      { member_id: 'i_nameless', name: ' ' },
    ]);
    rosters.note('r1', [{ member_id: 'i_bob', name: 'robert' }]);
    rosters.note('r2', [{ member_id: 'i_carol', name: 'carol' }]);
    expect(rosters.get('r1', ['i_seat'])).toEqual([
      { member_id: 'i_alice', name: 'alice' },
      { member_id: 'i_bob', name: 'robert' },
    ]);
    expect(rosters.get('r2')).toEqual([{ member_id: 'i_carol', name: 'carol' }]);
    expect(rosters.get('unknown')).toEqual([]);
  });

  it('is bounded per room, evicting the least recently seen member', () => {
    const rosters = new RoomRosters(2);
    rosters.note('r', [
      { member_id: 'i_a', name: 'a' },
      { member_id: 'i_b', name: 'b' },
    ]);
    rosters.note('r', [{ member_id: 'i_a', name: 'a' }]); // a seen again
    rosters.note('r', [{ member_id: 'i_c', name: 'c' }]);
    expect(rosters.get('r').map((m) => m.member_id)).toEqual(['i_a', 'i_c']);
  });

  it('noteRoomSenders and roomRoster work on fetched SourceMessages', () => {
    const rosters = new RoomRosters();
    noteRoomSenders(
      'r',
      [
        {
          message_id: 'm1',
          sequence: 1,
          sender_member_id: 'i_dave',
          sender_principal_id: 'p_dave',
          sender_name: 'dave',
          content: 'hi',
          reply_to_message_id: null,
        },
      ],
      rosters,
    );
    expect(roomRoster('r', [], rosters)).toEqual([{ member_id: 'i_dave', name: 'dave' }]);
  });
});
