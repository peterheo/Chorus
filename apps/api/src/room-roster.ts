import type { Member, SourceMessage } from '@chorus/domain';

/**
 * Room rosters for the coordination engine's name resolution (`ApplyContext.roster`, spec rev 1.4): who can be
 * addressed as `@name` or `name,` in a room.
 *
 * SharedNet has no member-list endpoint (the client can only join, read the current seat, wait for messages and
 * post), so a room's roster is every sender this process has SEEN in that room: member id → latest display name.
 * The tradeoff: it starts empty after a restart and only knows members who have spoken since, so a member who
 * never spoke since then can be addressed by name only once they are on a coordination object. That is the
 * engine's own fallback, so nothing gets worse than without a roster. It never touches the database, so callers
 * refresh it outside any transaction.
 *
 * Keys are SharedNet (external) room ids, the id both the watcher and `scan_conversation` fetch by.
 */
export class RoomRosters {
  private readonly rooms = new Map<string, Map<string, string>>();
  private readonly maxPerRoom: number;

  constructor(maxPerRoom = 1000) {
    this.maxPerRoom = maxPerRoom;
  }

  /** Records senders (latest name wins). Senders without a display name are skipped. */
  note(roomId: string, senders: readonly Member[]): void {
    const room = this.rooms.get(roomId) ?? new Map<string, string>();
    this.rooms.set(roomId, room);
    for (const { member_id, name } of senders) {
      if (member_id === '' || name.trim() === '') continue;
      room.delete(member_id); // re-inserted last: the most recently seen member is evicted last
      room.set(member_id, name);
      if (room.size > this.maxPerRoom) room.delete(room.keys().next().value ?? '');
    }
  }

  /** The room's known members, sorted by member id, without the excluded seats (the Chorus seat). */
  get(roomId: string, excludeMemberIds: readonly string[] = []): Member[] {
    const excluded = new Set(excludeMemberIds);
    return [...(this.rooms.get(roomId) ?? new Map<string, string>())]
      .filter(([memberId]) => !excluded.has(memberId))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([member_id, name]) => ({ member_id, name }));
  }
}

/** The process-wide rosters the watcher feeds (every page it reads) and every caller can read. */
export const roomRosters = new RoomRosters();

/** Records the senders of fetched messages (e.g. a `scan_conversation` window) in the shared rosters. */
export function noteRoomSenders(
  roomId: string,
  messages: readonly SourceMessage[],
  rosters: RoomRosters = roomRosters,
): void {
  rosters.note(
    roomId,
    messages.map((m) => ({ member_id: m.sender_member_id, name: m.sender_name })),
  );
}

/** The roster to pass as `ApplyContext.roster` for a room, without the excluded seats (the Chorus seat). */
export function roomRoster(
  roomId: string,
  excludeMemberIds: readonly string[],
  rosters: RoomRosters = roomRosters,
): Member[] {
  return rosters.get(roomId, excludeMemberIds);
}
