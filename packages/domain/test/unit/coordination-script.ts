/**
 * Test support for the CC-2a engine: a conversation script whose events are hand-built, served by a fake
 * extractor. The engine never sees message text through it, so each test pins exactly one §4 rule.
 */
import type { SourceMessage } from '../../src/index.ts';
import { EMPTY_STATE, type CoordState, type Member } from '../../src/index.ts';
import type { CoordEvent, CoordEventType } from '../../src/coordination/events.ts';
import { createEngine } from '../../src/coordination/engine.ts';

export const alice: Member = { member_id: 'm_alice', name: 'alice' };
export const bob: Member = { member_id: 'm_bob', name: 'bob' };
export const carol: Member = { member_id: 'm_carol', name: 'carol' };
export const dave: Member = { member_id: 'm_dave', name: 'dave' };
export const chorus: Member = { member_id: 'm_chorus', name: 'chorus' };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
export type EventSpec = { type: CoordEventType; mentions?: readonly string[] } & Partial<
  Mutable<Omit<CoordEvent, 'type' | 'message_id' | 'sequence' | 'author' | 'reply_to_message_id'>>
>;

/** §3 member resolution: exact id, then exact name, then a UNIQUE name prefix of 3+ characters. */
export function resolveMember(mention: string, roster: readonly Member[]): Member | undefined {
  const lower = mention.toLowerCase();
  const exact =
    roster.find((m) => m.member_id === mention) ??
    roster.find((m) => m.name.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const prefixed = roster.filter((m) => m.name.toLowerCase().startsWith(lower));
  return lower.length >= 3 && prefixed.length === 1 ? prefixed[0] : undefined;
}

export class Script {
  readonly messages: SourceMessage[] = [];
  readonly events = new Map<string, (CoordEvent & { mentions?: readonly string[] })[]>();
  /** Every roster the fake extractor was handed, by message id. */
  readonly rosters = new Map<string, readonly Member[]>();
  private seq: number;

  constructor(start = 0) {
    this.seq = start;
  }

  /** A message from `who` carrying `events` (none: a message that extracts nothing). */
  say(
    who: Member,
    events: EventSpec | readonly EventSpec[] = [],
    options: { reply?: SourceMessage; content?: string } = {},
  ): SourceMessage {
    this.seq += 1;
    const message: SourceMessage = {
      message_id: `msg_${String(this.seq).padStart(3, '0')}`,
      sequence: this.seq,
      sender_member_id: who.member_id,
      sender_principal_id: `p_${who.name}`,
      sender_name: who.name,
      content: options.content ?? `message ${String(this.seq)} from ${who.name}`,
      reply_to_message_id: options.reply?.message_id ?? null,
    };
    const list: readonly EventSpec[] = 'type' in events ? [events] : events;
    this.events.set(
      message.message_id,
      list.map((spec) => ({
        message_id: message.message_id,
        sequence: message.sequence,
        author: who,
        reply_to_message_id: message.reply_to_message_id,
        text: `${spec.type} ${String(this.seq)}`,
        refs: [],
        targets: [],
        ...spec,
      })),
    );
    this.messages.push(message);
    return message;
  }

  readonly engine = createEngine((message, roster) => {
    this.rosters.set(message.message_id, roster);
    // `mentions` are resolved against the roster the engine hands over, as the real extractor does.
    return (this.events.get(message.message_id) ?? []).map(({ mentions, ...event }) =>
      mentions === undefined
        ? event
        : {
            ...event,
            targets: mentions.flatMap((name) => resolveMember(name, roster) ?? []),
          },
    );
  });

  run(
    state: CoordState = EMPTY_STATE,
    messages: readonly SourceMessage[] = this.messages,
    excludeMemberIds: readonly string[] = [],
  ) {
    return this.engine(state, messages, { excludeMemberIds });
  }
}

/** ref → status, in object order. */
export const statuses = (state: CoordState): Record<string, string> =>
  Object.fromEntries(state.objects.map((object) => [object.ref, object.status]));

export const find = (state: CoordState, ref: string) => {
  const object = state.objects.find((o) => o.ref === ref);
  if (object === undefined) throw new Error(`no ${ref}`);
  return object;
};

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** A small seeded PRNG (mulberry32), so property runs are reproducible. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
