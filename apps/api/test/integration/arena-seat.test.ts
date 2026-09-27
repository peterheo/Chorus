import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from '../helpers/stack.ts';

describe('P13 arena.seat_binding: enrollment records the proven seat on the instance', () => {
  let s: Stack;
  beforeAll(async () => {
    s = await startStack();
  });
  afterAll(async () => {
    await s.stop();
  });

  it("a fresh enrollment's instance carries the member id the proof came from; a re-enrollment gets its own", async () => {
    const agent = s.agent('seated');
    const first = await s.enroll(agent);
    const seatOf = async (instanceId: string) =>
      (
        await s.owner<{ sharednet_member_id: string | null }>(
          'SELECT sharednet_member_id FROM agent_instances WHERE id = $1',
          [instanceId],
        )
      )[0]?.sharednet_member_id;
    expect(await seatOf(first.instanceId)).toBe(agent.memberId);

    // The same principal re-enrolls from another seat: the actor is reused, and the NEW instance is bound to
    // the NEW seat (a payment must come from the seat that proved this instance).
    const otherSeat = { ...agent, memberId: `i_${agent.memberId.slice(2, 30)}z` };
    const second = await s.enroll(otherSeat);
    expect(second.actorId).toBe(first.actorId);
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(await seatOf(second.instanceId)).toBe(otherSeat.memberId);
    expect(await seatOf(first.instanceId)).toBe(agent.memberId);
  });
});
