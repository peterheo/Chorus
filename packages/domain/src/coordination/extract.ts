/**
 * CC-2 §3: `rules-v2`, the deterministic per-sentence event detector. Pure pattern matching only: message
 * content is data, never interpreted as an instruction (CC-1a's injection-inertness guarantee carries over).
 *
 * This module only recognizes events in one message; it has no notion of session state, other messages, or
 * who the known members are. `engine.ts` folds these events into a `CoordState` across the whole window.
 */
import { sentencesOf, truncate } from '../conversation/extract.ts';
import type { SourceMessage } from '../conversation/extract.ts';

export type EventType =
  | 'question'
  | 'handoff'
  | 'commitment'
  | 'acknowledgement'
  | 'decline'
  | 'answer'
  | 'status_update'
  | 'completion'
  | 'withdrawal'
  | 'decision'
  | 'claim'
  | 'dependency';

/** A raw name candidate as written (`@name` or a leading `name,`), not yet resolved to a member. */
export interface RawTarget {
  readonly name: string;
}

export interface ExtractedEvent {
  readonly type: EventType;
  readonly message: SourceMessage;
  /** The matched sentence, already truncated to 280 code points (the CC-1a excerpt rule). */
  readonly text: string;
  /** `[QCHDKXP]\d+` tokens named in the sentence. */
  readonly refs: readonly string[];
  /** Name candidates addressed by the sentence (handoffs, targeted questions), unresolved. */
  readonly targets: readonly RawTarget[];
  readonly subject?: string;
  readonly predicate?: string;
  readonly value?: string;
  readonly polarity?: 'pos' | 'neg';
  readonly conditions?: readonly string[];
  readonly hedged?: boolean;
  readonly optional?: boolean;
}

const REF_TOKEN = /\b([QCHDKXP]\d+)\b/g;
const AT_NAME = /@([A-Za-z][\w-]{1,39})/;
const LEADING_NAME = /^([A-Za-z][\w-]{1,39}),\s/;
const NEGATION = /\b(won't|will not|can't|cannot|not going to|unable to)\b/i;
const REQUEST = /\b(can you|could you|would you|please|mind (taking|checking))\b/i;
const TAKE_OVER = /\btake over (my )?([QCHDKXP]\d+)\b/i;

const HIGH_COMMITMENTS: readonly RegExp[] = [
  /\b(I'll|I will|I am going to|I'm going to|let me)\s+(look|check|investigate|handle|fix|take|review|write|prepare|test|follow up|draft|update|send|build|do|own|cover)\b/i,
  /\bI('ll| will) take (this|that|it)\b/i,
  /\bI('ll| will) (own|cover)\b/i,
  /\bI've got (it|this|that)\b/i,
];
const MEDIUM_COMMITMENTS: readonly RegExp[] = [
  /\b(on it|I'm on it|leave it (with|to) me|we('ll| will)\s+(look|check|investigate|handle|fix|follow up))\b/i,
];
const CONDITION_WORD = /\b(if|once|when)\b/i;

const WHOLE_MESSAGE_ACK =
  /^(on it|will do|sure|got it|ok(ay)?,?\s*(i'?ll|will)?|ack(nowledged)?|accepted)[.!]*$/i;
const DECLINE = /\b(can't|cannot|won't) (take|do) (it|this|that)\b|no bandwidth|not me\b/i;
const ANSWER_REF = /^(re\s+)?(Q\d+)[:\s]/i;
const STATUS_UPDATE = /\b(working on|in progress|halfway|started on|still on)\b/i;
const COMPLETION = /\b(done|finished|completed|shipped|merged|resolved)\b|✅/i;
const WITHDRAWAL = /\b(never ?mind|scratch that|ignore (that|my last)|withdraw(n|ing)?)\b/i;
const DECISION = /\b(let's go with|we('ll| will) (use|go with)|decision:|decided:|agreed:)/i;
const DECISION_VALUE = /^(.*?)\s+(is|are|=)\s+(.+)$/i;
const CLAIM =
  /^(.*?)\s+(is not|are not|isn't|aren't|does not|do not|doesn't|don't|is|are|does|do|works|fails)\s+(.+)$/i;
const NEGATIVE_CLAIM_VERB = /^(is not|are not|isn't|aren't|does not|do not|doesn't|don't|fails)$/i;
const HEDGE = /\b(I think|maybe|probably|might|seems)\b/i;
const TRAILING_CONDITION = /\s+((?:if|when|within|after|before|unless)\s+.+)$/i;
const DEPENDENCY =
  /\b(?:blocked (?:on|by)|waiting (?:for|on)|can't (?:start|continue|move on) until|depends on)\b\s*(.*)$/i;
/** `bob's task` → the possessive name and what follows, so the dependency blocker can be that member's work. */
const POSSESSIVE_NAME = /^([A-Za-z][\w-]{1,39})'s\s+(.*)$/;

function refsIn(text: string): string[] {
  return [...text.matchAll(REF_TOKEN)].map((m) => m[1] ?? '');
}

function targetsIn(text: string): RawTarget[] {
  const targets: RawTarget[] = [];
  const at = AT_NAME.exec(text);
  if (at?.[1] !== undefined) targets.push({ name: at[1] });
  const leading = LEADING_NAME.exec(text);
  if (leading?.[1] !== undefined) targets.push({ name: leading[1] });
  return targets;
}

function conditionsIn(text: string): { rest: string; conditions: string[] } {
  const match = TRAILING_CONDITION.exec(text);
  if (match?.[1] === undefined) return { rest: text, conditions: [] };
  return { rest: text.slice(0, match.index).trim(), conditions: [match[1].trim()] };
}

function commitmentConfidence(sentence: string): boolean {
  const plain = sentence.replaceAll('’', "'");
  if (NEGATION.test(plain)) return false;
  return (
    HIGH_COMMITMENTS.some((pattern) => pattern.test(plain)) ||
    MEDIUM_COMMITMENTS.some((pattern) => pattern.test(plain))
  );
}

/** Matches one already-extracted sentence against the rules-v2 table, in the table's own precedence order. */
function matchSentence(sentence: string, message: SourceMessage): ExtractedEvent | undefined {
  const refs = refsIn(sentence);
  const base = { message, text: truncate(sentence), refs };

  if (sentence.endsWith('?')) {
    const targets = targetsIn(sentence);
    if (REQUEST.test(sentence)) {
      const takeOver = TAKE_OVER.exec(sentence);
      if (takeOver?.[2] !== undefined) {
        return { ...base, type: 'handoff', targets: [], refs: [...refs, takeOver[2]] };
      }
      if (targets.length === 1) return { ...base, type: 'handoff', targets };
    }
    return { ...base, type: 'question', targets };
  }

  const plain = sentence.replaceAll('’', "'");
  if (TAKE_OVER.test(plain)) {
    const takeOver = TAKE_OVER.exec(plain);
    return { ...base, type: 'handoff', targets: [], refs: [...refs, takeOver?.[2] ?? ''] };
  }
  if (commitmentConfidence(plain)) {
    const optional = CONDITION_WORD.test(plain) || /\bI can\b/i.test(plain);
    const { conditions } = conditionsIn(plain);
    return {
      ...base,
      type: 'commitment',
      targets: [],
      ...(optional ? { optional: true } : {}),
      ...(conditions.length > 0 ? { conditions } : {}),
    };
  }
  if (DECLINE.test(plain)) return { ...base, type: 'decline', targets: [] };
  if (ANSWER_REF.test(plain)) return { ...base, type: 'answer', targets: [] };
  if (STATUS_UPDATE.test(plain)) return { ...base, type: 'status_update', targets: [] };
  if (COMPLETION.test(plain)) return { ...base, type: 'completion', targets: [] };
  if (WITHDRAWAL.test(plain)) return { ...base, type: 'withdrawal', targets: [] };
  if (DECISION.test(plain)) {
    const afterMarker = plain.replace(DECISION, '').trim();
    const valueMatch = DECISION_VALUE.exec(afterMarker || plain);
    return {
      ...base,
      type: 'decision',
      targets: [],
      ...(valueMatch?.[1] !== undefined && valueMatch[3] !== undefined
        ? { subject: valueMatch[1].trim(), value: valueMatch[3].trim() }
        : {}),
    };
  }
  const dependency = DEPENDENCY.exec(plain);
  if (dependency !== null) {
    const rest = (dependency[1] ?? '').trim();
    const possessive = POSSESSIVE_NAME.exec(rest);
    return {
      ...base,
      type: 'dependency',
      targets: possessive?.[1] !== undefined ? [{ name: possessive[1] }] : [],
      predicate: possessive?.[2] !== undefined ? possessive[2].trim() : rest,
    };
  }
  const claim = CLAIM.exec(plain);
  if (claim?.[1] !== undefined && claim[2] !== undefined && claim[3] !== undefined) {
    const { rest: predicate, conditions } = conditionsIn(claim[3].trim());
    return {
      ...base,
      type: 'claim',
      targets: [],
      subject: claim[1].trim(),
      predicate,
      polarity: NEGATIVE_CLAIM_VERB.test(claim[2]) ? 'neg' : 'pos',
      ...(HEDGE.test(plain) ? { hedged: true } : {}),
      ...(conditions.length > 0 ? { conditions } : {}),
    };
  }
  return undefined;
}

/**
 * Extracts every rules-v2 event from one message: the whole-message acknowledgement check first (a bare "ok"
 * is shorter than the 8-character sentence floor and would otherwise be dropped), then one event per matched
 * sentence.
 */
export function extractEvents(message: SourceMessage): ExtractedEvent[] {
  const stripped = message.content
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .trim();
  if (WHOLE_MESSAGE_ACK.test(stripped)) {
    return [
      {
        type: 'acknowledgement',
        message,
        text: truncate(stripped),
        refs: refsIn(stripped),
        targets: [],
      },
    ];
  }
  const events: ExtractedEvent[] = [];
  for (const sentence of sentencesOf(message.content)) {
    const event = matchSentence(sentence, message);
    if (event !== undefined) events.push(event);
  }
  return events;
}
