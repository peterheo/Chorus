/**
 * CC-2a (narrowed, spec rev 1.3, room seq 267/268): `extractEvents` against the checked-in labelled fixture
 * (`coordination-fixture.json`, ≥40 messages, members alice/bob/carol/dave). Each message carries
 * `expect_events`, the exact sequence of `CoordEventType`s `extractEvents` must produce for it, covering
 * every row of the events.ts precedence table plus the two named negative cases (spec: "I can't look at it"
 * → no commitment, an ambiguous name prefix → no target). The extractor is stateless, so these tests call it
 * directly with a fixed roster; ordering/state concerns are the engine's job, not this PR's.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractEvents } from '../../src/coordination/extract.ts';
import type { CoordEventType } from '../../src/index.ts';
import type { SourceMessage } from '../../src/index.ts';
import type { Member } from '../../src/index.ts';

type FixtureMessage = SourceMessage & { readonly expect_events: readonly CoordEventType[] };

const fixturePath = fileURLToPath(new URL('./coordination-fixture.json', import.meta.url));
const messages: FixtureMessage[] = JSON.parse(
  readFileSync(fixturePath, 'utf8'),
) as FixtureMessage[];

const ROSTER: readonly Member[] = [
  { member_id: 'i_alice', name: 'alice' },
  { member_id: 'i_bob', name: 'bob' },
  { member_id: 'i_carol', name: 'carol' },
  { member_id: 'i_dave', name: 'dave' },
];

describe('CC-2a extraction fixture (spec §3, rev 1.3)', () => {
  it('has at least 40 labelled messages across alice, bob, carol and dave', () => {
    expect(messages.length).toBeGreaterThanOrEqual(40);
    expect(new Set(messages.map((m) => m.sender_name))).toEqual(
      new Set(['alice', 'bob', 'carol', 'dave']),
    );
  });

  it.each(messages.map((message) => [message.message_id, message] as const))(
    '%s produces exactly its expected event types',
    (_id, message) => {
      const got = extractEvents(message, ROSTER).map((event) => event.type);
      expect(got).toEqual(message.expect_events);
    },
  );

  it('every row of the events.ts precedence table is covered at least once', () => {
    const seen = new Set(messages.flatMap((m) => m.expect_events));
    const required: CoordEventType[] = [
      'handoff',
      'question',
      'answer',
      'withdrawal',
      'decline',
      'dependency',
      'decision',
      'commitment',
      'completion',
      'status_update',
      'claim',
      'acknowledgement',
    ];
    for (const type of required)
      expect(seen.has(type), `missing coverage for "${type}"`).toBe(true);
  });

  it('"I can\'t look at it" produces no commitment - or any other event (§6 negative case)', () => {
    const message = messages.find((m) => m.content.includes("I can't look at it"));
    if (message === undefined)
      throw new Error('fixture must include the "I can\'t look at it" message');
    expect(extractEvents(message, ROSTER)).toEqual([]);
  });

  it('an ambiguous name prefix resolves to no target (§6 negative case)', () => {
    // alice and alina share the "ali" prefix, so a roster that includes both cannot resolve "Ali" to
    // either - this is a roster-shape property of resolveMember, independent of any specific message.
    const ambiguousRoster: readonly Member[] = [...ROSTER, { member_id: 'i_alina', name: 'alina' }];
    const message: SourceMessage = {
      message_id: 'amb1',
      sequence: 999,
      sender_member_id: 'i_dave',
      sender_principal_id: 'p_dave',
      sender_name: 'dave',
      content: 'Ali, could you check the logs?',
      reply_to_message_id: null,
    };
    const events = extractEvents(message, ambiguousRoster);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('question'); // degrades from handoff: no single resolvable target
    expect(events[0]?.targets).toEqual([]);
  });

  it('an unresolvable name (no roster match at all) also resolves to no target', () => {
    const message = messages.find((m) => m.content.startsWith('Frank,'));
    if (message === undefined) throw new Error('fixture must include a "Frank," message');
    const events = extractEvents(message, ROSTER);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('question');
    expect(events[0]?.targets).toEqual([]);
  });

  it('reply_to_message_id is passed through unchanged, uninterpreted (extractor is stateless)', () => {
    const reply = messages.find((m) => m.reply_to_message_id !== null);
    if (reply === undefined) throw new Error('fixture must include at least one reply');
    const [event] = extractEvents(reply, ROSTER);
    expect(event?.reply_to_message_id).toBe(reply.reply_to_message_id);
  });

  it("acknowledgement is whole-message only and is the message's only event", () => {
    for (const message of messages) {
      if (message.expect_events.includes('acknowledgement')) {
        expect(message.expect_events).toEqual(['acknowledgement']);
      }
    }
  });

  it('extractEvents is pure: a deep-frozen message and roster produce the correct result', () => {
    function deepFreeze<T>(value: T): T {
      if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        const record = value as Record<string, unknown>;
        for (const key of Object.keys(record)) deepFreeze(record[key]);
        Object.freeze(value);
      }
      return value;
    }
    const message = messages[3];
    if (message === undefined) throw new Error('fixture must have at least 4 messages');
    const frozenMessage = deepFreeze(JSON.parse(JSON.stringify(message)) as SourceMessage);
    const frozenRoster = deepFreeze(JSON.parse(JSON.stringify(ROSTER)) as Member[]);
    expect(() => extractEvents(frozenMessage, frozenRoster)).not.toThrow();
    expect(extractEvents(frozenMessage, frozenRoster).map((e) => e.type)).toEqual(
      message.expect_events,
    );
  });
});
