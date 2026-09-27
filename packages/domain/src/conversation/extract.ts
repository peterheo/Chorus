/**
 * CC-1a: deterministic, rule-based extraction of open questions and explicit commitments from a window of room
 * messages (`rules-v1`, CC-1 spec section 1). Pure: no I/O, no clock, no randomness, no mutation of its input.
 *
 * Message content is DATA. It is only matched against fixed patterns and never interpreted, so nothing a
 * message says can instruct Chorus to do anything. Every result is an inference (evidence, never authority):
 * it names its source message and sender, and it never assigns ownership, answers a question or creates work.
 */

export interface SourceMessage {
  readonly message_id: string;
  readonly sequence: number;
  readonly sender_member_id: string;
  readonly sender_principal_id: string;
  readonly sender_name: string;
  readonly content: string;
  readonly reply_to_message_id: string | null;
}

export type SuggestionKind = 'question' | 'commitment';

export interface ExtractedSuggestion {
  readonly kind: SuggestionKind;
  readonly fingerprint_input: string;
  readonly excerpt: string;
  readonly confidence: 'high' | 'medium';
  readonly source: {
    readonly message_id: string;
    readonly sequence: number;
    readonly sender_member_id: string;
    readonly sender_principal_id: string;
    readonly sender_name: string;
  };
  /** Informational only: some other member replied to this message. It never resolves anything. */
  readonly replied_by_other: boolean;
  readonly suggested_next_action: string;
}

export interface ExtractOptions {
  /** Members whose messages are never examined (the room's Chorus service seat). */
  readonly excludeMemberIds?: readonly string[];
}

export interface Extractor {
  readonly id: 'rules-v1';
  extract(messages: readonly SourceMessage[], options?: ExtractOptions): ExtractedSuggestion[];
}

const MAX_BYTES = 8 * 1024;
const MIN_SENTENCE = 8;
const MAX_EXCERPT = 280;
const MAX_SUGGESTIONS = 50;

const QUESTION_STARTS =
  /^(who|what|when|where|why|how|which|can|could|should|would|is|are|do|does|did|will|has|have|any)\b/i;
const NEGATION = /\b(won't|will not|can't|cannot|not going to|unable to)\b/i;
const VERBS =
  'look|check|investigate|handle|fix|take|review|write|prepare|test|follow up|draft|update|send|build|do';
const HIGH_COMMITMENTS: readonly RegExp[] = [
  new RegExp(`\\b(I'll|I will|I am going to|I'm going to|let me)\\s+(${VERBS})\\b`, 'i'),
  /\bI('ll| will) take (this|that|it)\b/i,
];
const MEDIUM_COMMITMENTS: readonly RegExp[] = [
  /\b(on it|I'm on it|leave it (with|to) me|we('ll| will)\s+(look|check|investigate|handle|fix|follow up))\b/i,
];

/** Applies the pre-processing of rule 1 and returns the message's sentences. */
function sentencesOf(content: string): string[] {
  const head = new TextDecoder().decode(new TextEncoder().encode(content).subarray(0, MAX_BYTES));
  return head
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => Array.from(sentence).length >= MIN_SENTENCE);
}

const truncate = (sentence: string): string => {
  const points = Array.from(sentence);
  return points.length <= MAX_EXCERPT ? sentence : `${points.slice(0, MAX_EXCERPT - 1).join('')}…`;
};

/** The stable core of an excerpt: lowercase, only [a-z0-9 ?], single spaces. */
const normalize = (excerpt: string): string =>
  excerpt
    .toLowerCase()
    .replace(/[^a-z0-9 ?\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

function commitmentConfidence(sentence: string): 'high' | 'medium' | undefined {
  // Curly apostrophes are matched like straight ones; the excerpt keeps the original text.
  const plain = sentence.replaceAll('’', "'");
  if (NEGATION.test(plain)) return undefined;
  if (HIGH_COMMITMENTS.some((pattern) => pattern.test(plain))) return 'high';
  if (MEDIUM_COMMITMENTS.some((pattern) => pattern.test(plain))) return 'medium';
  return undefined;
}

function extract(
  messages: readonly SourceMessage[],
  options: ExtractOptions = {},
): ExtractedSuggestion[] {
  const excluded = new Set(options.excludeMemberIds ?? []);
  const found: ExtractedSuggestion[] = [];

  for (const message of messages) {
    if (message.content.startsWith('chorus-verify ') || excluded.has(message.sender_member_id)) {
      continue;
    }
    const sentences = sentencesOf(message.content);
    const source = {
      message_id: message.message_id,
      sequence: message.sequence,
      sender_member_id: message.sender_member_id,
      sender_principal_id: message.sender_principal_id,
      sender_name: message.sender_name,
    };
    const repliedByOther = messages.some(
      (other) =>
        other.sequence > message.sequence &&
        other.reply_to_message_id === message.message_id &&
        other.sender_member_id !== message.sender_member_id,
    );
    const suggestion = (
      kind: SuggestionKind,
      sentence: string,
      confidence: 'high' | 'medium',
    ): ExtractedSuggestion => {
      const excerpt = truncate(sentence);
      const name = message.sender_name;
      const action =
        kind === 'commitment'
          ? `${name} said they will do this. Create a task and link this suggestion; ownership is set only when someone claims it.`
          : repliedByOther
            ? `Question from ${name} has a reply in the room; check whether it is answered, then dismiss or link.`
            : `Unanswered question from ${name}. Answer it in the room, or create a task and link this suggestion.`;
      return {
        kind,
        fingerprint_input: `${kind}|${message.message_id}|${normalize(excerpt)}`,
        excerpt,
        confidence,
        source,
        replied_by_other: repliedByOther,
        suggested_next_action: action,
      };
    };

    // At most one question (the first sentence ending in `?`) ...
    const questionAt = sentences.findIndex((sentence) => sentence.endsWith('?'));
    const asked = sentences[questionAt];
    if (asked !== undefined) {
      found.push(suggestion('question', asked, QUESTION_STARTS.test(asked) ? 'high' : 'medium'));
    }
    // ... and at most one commitment (the first matching sentence that was not taken as the question).
    for (const [index, sentence] of sentences.entries()) {
      if (index === questionAt) continue;
      const confidence = commitmentConfidence(sentence);
      if (confidence !== undefined) {
        found.push(suggestion('commitment', sentence, confidence));
        break;
      }
    }
  }

  return found
    .sort(
      (a, b) =>
        a.source.sequence - b.source.sequence || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    )
    .slice(0, MAX_SUGGESTIONS);
}

export const rulesV1: Extractor = { id: 'rules-v1', extract };
