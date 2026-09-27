/**
 * CC-2 extraction contract (spec rev 1.3): what `extract.ts` (rules-v2) produces per message, and what
 * `engine.ts` consumes. The extractor is stateless: it knows the message and a member roster, never the
 * coordination state. Everything that needs state (a reply that answers a question, which commitment a
 * completion closes, blocker lookup by member) is the engine's job.
 */
import type { SourceMessage } from '../conversation/extract.ts';
import type { Member } from './types.ts';

/**
 * One event per sentence, except `acknowledgement`, which only fires on a whole message and then is the
 * message's only event. When several patterns match a sentence, the FIRST in this order wins:
 * handoff, question, answer, withdrawal, decline, dependency, decision, commitment, completion,
 * status_update, claim.
 */
export type CoordEventType =
  | 'handoff'
  | 'question'
  | 'answer'
  | 'withdrawal'
  | 'decline'
  | 'dependency'
  | 'decision'
  | 'commitment'
  | 'completion'
  | 'status_update'
  | 'claim'
  | 'acknowledgement';

export type CoordEvent = {
  readonly type: CoordEventType;
  readonly message_id: string;
  readonly sequence: number;
  /** The sender, as `{member_id: sender_member_id, name: sender_name}`. */
  readonly author: Member;
  /** The sentence (the whole message for `acknowledgement`), at most 280 code points. */
  readonly text: string;
  readonly reply_to_message_id: string | null;
  /** `\b[QCHDKXP]\d+\b` tokens in the sentence, uppercased, de-duplicated, in order of appearance. */
  readonly refs: readonly string[];
  /** Members the sentence names (`@name`, or a leading `name,`), resolved via the roster (§3). */
  readonly targets: readonly Member[];
  /** `question`: it is a request (`can you|could you|would you|please|mind (taking|checking)`). */
  readonly request?: boolean;
  /** `handoff`: the `Cn` in `take over (my )?Cn`. */
  readonly take_over?: string;
  /** `answer`: the `Qn` in a leading `Qn:` or `re Qn`. */
  readonly answers?: string;
  /** `commitment`: conditional (`if|once|when` + condition, or `I can`). */
  readonly optional?: boolean;
  /** `claim` and `decision` (`<subject> is <value>`). */
  readonly subject?: string;
  readonly predicate?: string;
  readonly polarity?: 'pos' | 'neg';
  readonly hedged?: boolean;
  readonly conditions?: readonly string[];
  readonly value?: string;
  /** `dependency`: what it waits on. Exactly one of the three is set. */
  readonly blocker?: {
    readonly ref?: string;
    readonly member?: Member;
    readonly text?: string;
  };
};

/**
 * The extractor's signature (implemented in CC-2a's `extract.ts` as `extractEvents`). It is pure. It returns
 * `[]` for `chorus-verify ` messages. Excluded seats are filtered by the engine, not here. The roster is
 * every member the engine knows at this message; resolution is exact member id, then exact display name,
 * then a unique display-name prefix of 3 or more characters (ambiguous → unresolved, so no target).
 */
export type ExtractEvents = (
  message: SourceMessage,
  roster: readonly Member[],
) => readonly CoordEvent[];

/** Content tokens (§4): lowercased `[a-z0-9]+`, stopwords removed, single digits kept. In `similarity.ts`. */
export type ContentTokens = (text: string) => readonly string[];

/** Jaccard similarity over two token lists (as sets); two empty lists → 0. In `similarity.ts`. */
export type Jaccard = (a: readonly string[], b: readonly string[]) => number;
