/**
 * CC-2a (narrowed, spec rev 1.3): `rules-v2`, the deterministic per-sentence event detector. Pure pattern
 * matching only: message content is data, never interpreted as an instruction (CC-1a's injection-inertness
 * guarantee carries over). Stateless: it knows only the message and the roster it's given; everything that
 * needs coordination state (which object a reply answers or completes, blocker lookup by ref) is the
 * engine's job (`events.ts`'s contract comment).
 */
import { sentencesOf, truncate } from '../conversation/extract.ts';
import type { SourceMessage } from '../conversation/extract.ts';
import type { CoordEvent, CoordEventType, ExtractEvents } from './events.ts';
import type { Member } from './types.ts';

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
  /\bleave it (with|to) me\b/i,
];
const MEDIUM_COMMITMENTS: readonly RegExp[] = [
  /\b(on it|I'm on it|we('ll| will)\s+(look|check|investigate|handle|fix|follow up))\b/i,
];
const CONDITION_WORD = /\b(if|once|when)\b/i;

const WHOLE_MESSAGE_ACK =
  /^(on it|will do|sure|got it|ok(ay)?,?\s*(i'?ll|will)?|ack(nowledged)?|accepted)[.!]*$/i;
const DECLINE = /\b(can't|cannot|won't) (take|do) (it|this|that)\b|no bandwidth|not me\b/i;
const ANSWER_REF = /^(?:re\s+(Q\d+)\b|(Q\d+):)/i;
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
  return [...new Set([...text.matchAll(REF_TOKEN)].map((m) => (m[1] ?? '').toUpperCase()))];
}

/** Member resolution (spec §3): exact id, then exact display name, then a *unique* 3+ char name prefix. */
function resolveMember(name: string, roster: readonly Member[]): Member | undefined {
  const byId = roster.find((m) => m.member_id === name);
  if (byId !== undefined) return byId;
  const lower = name.toLowerCase();
  const byName = roster.find((m) => m.name.toLowerCase() === lower);
  if (byName !== undefined) return byName;
  if (lower.length < 3) return undefined;
  const matches = roster.filter((m) => m.name.toLowerCase().startsWith(lower));
  return matches.length === 1 ? matches[0] : undefined;
}

function rawNamesIn(text: string): string[] {
  const names: string[] = [];
  const at = AT_NAME.exec(text);
  if (at?.[1] !== undefined) names.push(at[1]);
  const leading = LEADING_NAME.exec(text);
  if (leading?.[1] !== undefined) names.push(leading[1]);
  return names;
}

function targetsIn(text: string, roster: readonly Member[]): Member[] {
  const resolved: Member[] = [];
  for (const name of rawNamesIn(text)) {
    const member = resolveMember(name, roster);
    if (member !== undefined) resolved.push(member);
  }
  return resolved;
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

type Base = Pick<
  CoordEvent,
  'message_id' | 'sequence' | 'author' | 'reply_to_message_id' | 'refs'
> & {
  text: string;
};

function buildBlocker(
  rest: string,
  roster: readonly Member[],
): { ref?: string; member?: Member; text?: string } {
  const refs = refsIn(rest);
  if (refs.length > 0 && refs[0] !== undefined) return { ref: refs[0] };
  const possessive = POSSESSIVE_NAME.exec(rest);
  if (possessive?.[1] !== undefined) {
    const member = resolveMember(possessive[1], roster);
    if (member !== undefined) return { member };
  }
  return { text: rest };
}

/** Matches one already-extracted sentence against the rules-v2 table, in events.ts's precedence order. */
function matchSentence(
  sentence: string,
  base: Base,
  roster: readonly Member[],
): CoordEvent | undefined {
  const withType = (type: CoordEventType, extra: Partial<CoordEvent> = {}): CoordEvent => ({
    type,
    ...base,
    text: truncate(base.text),
    targets: [],
    ...extra,
  });

  const plain = sentence.replaceAll('’', "'");
  const isRequest = REQUEST.test(plain);

  // handoff: checked before "?" branch, since a non-"?" request naming exactly one member is still a
  // handoff ("carol, please review C2 today."), not merely a statement.
  const takeOver = TAKE_OVER.exec(plain);
  if (takeOver?.[2] !== undefined) {
    return withType('handoff', {
      ...(isRequest ? { request: true } : {}),
      take_over: takeOver[2].toUpperCase(),
    });
  }
  if (isRequest) {
    const targets = targetsIn(plain, roster);
    if (targets.length === 1) return withType('handoff', { request: true, targets });
  }

  if (sentence.endsWith('?')) {
    const targets = targetsIn(plain, roster);
    return withType('question', { ...(isRequest ? { request: true } : {}), targets });
  }

  const answer = ANSWER_REF.exec(plain);
  const answeredRef = answer?.[1] ?? answer?.[2];
  if (answeredRef !== undefined) return withType('answer', { answers: answeredRef.toUpperCase() });
  if (WITHDRAWAL.test(plain)) return withType('withdrawal');
  if (DECLINE.test(plain)) return withType('decline');
  const dependency = DEPENDENCY.exec(plain);
  if (dependency !== null) {
    const rest = (dependency[1] ?? '').trim();
    return withType('dependency', { blocker: buildBlocker(rest, roster) });
  }
  if (DECISION.test(plain)) {
    const afterMarker = plain.replace(DECISION, '').trim();
    const valueMatch = DECISION_VALUE.exec(afterMarker || plain);
    return withType(
      'decision',
      valueMatch?.[1] !== undefined && valueMatch[3] !== undefined
        ? { subject: valueMatch[1].trim(), value: valueMatch[3].trim() }
        : {},
    );
  }
  if (commitmentConfidence(plain)) {
    const optional = CONDITION_WORD.test(plain) || /\bI can\b/i.test(plain);
    const { conditions } = conditionsIn(plain);
    return withType('commitment', {
      ...(optional ? { optional: true } : {}),
      ...(conditions.length > 0 ? { conditions } : {}),
    });
  }
  if (COMPLETION.test(plain)) return withType('completion');
  if (STATUS_UPDATE.test(plain)) return withType('status_update');
  const claim = CLAIM.exec(plain);
  if (claim?.[1] !== undefined && claim[2] !== undefined && claim[3] !== undefined) {
    const { rest: predicate, conditions } = conditionsIn(claim[3].trim());
    return withType('claim', {
      subject: claim[1].trim(),
      predicate,
      polarity: NEGATIVE_CLAIM_VERB.test(claim[2]) ? 'neg' : 'pos',
      ...(HEDGE.test(plain) ? { hedged: true } : {}),
      ...(conditions.length > 0 ? { conditions } : {}),
    });
  }
  return undefined;
}

/**
 * Extracts every rules-v2 event from one message: `[]` for `chorus-verify ` messages (excluded seats are the
 * engine's job); the whole-message acknowledgement check first (a bare "ok" is shorter than the 8-character
 * sentence floor and would otherwise be dropped), then one event per matched sentence.
 */
export const extractEvents: ExtractEvents = (message: SourceMessage, roster: readonly Member[]) => {
  if (message.content.startsWith('chorus-verify ')) return [];
  const stripped = message.content
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .trim();
  const author: Member = { member_id: message.sender_member_id, name: message.sender_name };
  const commonBase = {
    message_id: message.message_id,
    sequence: message.sequence,
    author,
    reply_to_message_id: message.reply_to_message_id,
  };
  if (WHOLE_MESSAGE_ACK.test(stripped)) {
    return [
      {
        type: 'acknowledgement',
        ...commonBase,
        text: truncate(stripped),
        refs: refsIn(stripped),
        targets: [],
      },
    ];
  }
  const events: CoordEvent[] = [];
  for (const sentence of sentencesOf(message.content)) {
    const base: Base = { ...commonBase, text: sentence, refs: refsIn(sentence) };
    const event = matchSentence(sentence, base, roster);
    if (event !== undefined) events.push(event);
  }
  return events;
};
