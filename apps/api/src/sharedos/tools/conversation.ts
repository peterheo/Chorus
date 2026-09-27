import {
  ChorusError,
  dismissSuggestion,
  linkSuggestion,
  listSuggestions,
  loadConversationSeat,
  recordScan,
  rulesV1,
  type Suggestion,
  type Uuid,
} from '@chorus/domain';
import { fetchConversationWindow } from '../../conversation/fetch.ts';
import { openSecret } from '../../secrets.ts';
import { I, S, SA, type ChorusToolSpec } from './define.ts';

const session = (args: Record<string, unknown>): string[] => [
  'sessions',
  String(args['session_id']),
];
const STATES = ['open', 'linked', 'dismissed'] as const;
const KINDS = ['question', 'commitment'] as const;

function invalid(field: string): never {
  throw new ChorusError('invalid_request', `${field} is invalid.`, { details: { field } });
}

function enumFilter<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): readonly T[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || !allowed.includes(entry as T))
  )
    invalid(field);
  return value as T[];
}

function toToolSuggestion(suggestion: Suggestion): Record<string, unknown> {
  const excerpt = Array.from(suggestion.excerpt).slice(0, 120).join('');
  const question = suggestion.kind === 'question';
  return {
    suggestion_id: suggestion.suggestion_id,
    kind: suggestion.kind,
    state: suggestion.state,
    excerpt: suggestion.excerpt,
    confidence: suggestion.confidence,
    inferred: true,
    source: {
      message_id: suggestion.source.message_id,
      sequence: suggestion.source.sequence,
      sender_member_id: suggestion.source.sender_member_id,
      sender_name: suggestion.source.sender_name,
    },
    replied_by_other: suggestion.replied_by_other,
    suggested_next_action: suggestion.suggested_next_action,
    suggested_task: {
      title: `${question ? 'Answer' : 'Follow up'}: ${excerpt}`,
      acceptance_criteria: [
        question
          ? `The question in message ${suggestion.source.message_id} is answered in the room and the answer is linked here`
          : `The work promised in message ${suggestion.source.message_id} is done and its result is submitted`,
      ],
    },
    recommended_request_id: `sugg-${suggestion.suggestion_id}`,
    linked_item_id: suggestion.linked_item_id,
    first_seen_scan_id: suggestion.first_scan_id,
    last_seen_scan_id: suggestion.last_scan_id,
  };
}

function validatedWindow(input: Record<string, unknown>): { from: number; to: number } {
  const from = input['from_sequence'];
  const to = input['to_sequence'];
  if (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 1) invalid('from_sequence');
  if (typeof to !== 'number' || !Number.isSafeInteger(to) || to < from || to - from >= 200)
    invalid('to_sequence');
  return { from, to };
}

export const conversationTools: readonly ChorusToolSpec[] = [
  {
    name: 'chorus.scan_conversation',
    description:
      'Infers suggestions from only the selected room messages. Suggestions are not commitments or answers; nothing is created automatically. Linking or dismissing is explicit.',
    action: 'link_message',
    write: true,
    rateLimit: 'conversation',
    props: { session_id: S, from_sequence: I, to_sequence: I },
    required: ['session_id', 'from_sequence', 'to_sequence'],
    path: session,
    run: async ({ input, read, command, deps }) => {
      const { from, to } = validatedWindow(input);
      const sharednet = deps.sharednet;
      if (sharednet === undefined) {
        throw new ChorusError(
          'temporarily_unavailable',
          'The conversation service is unavailable.',
          {
            details: { cause: 'configuration' },
          },
        );
      }
      const sessionId = input['session_id'] as Uuid;
      const seat = await loadConversationSeat(read, sessionId);
      const token = openSecret(sharednet.secretsKey, {
        ciphertext: seat.ciphertext,
        nonce: seat.nonce,
        keyId: seat.keyId,
      });
      const fetched = await fetchConversationWindow({
        sharednetBaseUrl: sharednet.baseUrl,
        externalRoomId: seat.externalRoomId,
        seatToken: token,
        fromSequence: from,
        toSequence: to,
      });
      const extracted = rulesV1.extract(fetched.messages, { excludeMemberIds: [seat.memberId] });
      const recorded = await recordScan(command, {
        session_id: sessionId,
        from_sequence: from,
        to_sequence: to,
        cutoff_sequence: fetched.cutoffSequence,
        messages: fetched.messages,
        extracted,
      });
      return {
        scan: recorded.scan,
        suggestions: recorded.suggestions.map(toToolSuggestion),
        source_boundary: `Only messages ${String(from)}–${String(to)} of this room were examined; nothing else was read.`,
        coverage: 'selected_conversation_window',
      };
    },
  },
  {
    name: 'chorus.list_suggestions',
    description:
      'Lists inferred suggestions in a session. Suggestions are not commitments or answers; nothing is created automatically. Linking or dismissing is explicit.',
    action: 'read',
    write: false,
    props: { session_id: S, states: SA, kinds: SA, limit: I, cursor: S },
    required: ['session_id'],
    path: session,
    run: async ({ input, read }) => {
      const limit = input['limit'];
      if (
        limit !== undefined &&
        (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)
      )
        invalid('limit');
      const states = enumFilter(input['states'], STATES, 'states');
      const kinds = enumFilter(input['kinds'], KINDS, 'kinds');
      const result = await listSuggestions(read, {
        session_id: input['session_id'] as Uuid,
        ...(states === undefined ? {} : { states }),
        ...(kinds === undefined ? {} : { kinds }),
        ...(limit === undefined ? {} : { limit }),
        ...(input['cursor'] === undefined ? {} : { cursor: input['cursor'] as string }),
      });
      return {
        suggestions: result.suggestions.map(toToolSuggestion),
        next_cursor: result.next_cursor,
      };
    },
  },
  {
    name: 'chorus.link_suggestion',
    description:
      'Explicitly links an inferred suggestion to an existing task and its source message. Suggestions are not commitments or answers; nothing is created automatically.',
    action: 'link_message',
    write: true,
    props: { session_id: S, suggestion_id: S, item_id: S },
    required: ['session_id', 'suggestion_id', 'item_id'],
    path: (args) => [...session(args), 'tasks', String(args['item_id'])],
    run: async ({ input, command }) => {
      const result = await linkSuggestion(command, {
        session_id: input['session_id'] as Uuid,
        suggestion_id: input['suggestion_id'] as Uuid,
        item_id: input['item_id'] as Uuid,
      });
      return { suggestion: toToolSuggestion(result.suggestion), item: result.item };
    },
  },
  {
    name: 'chorus.dismiss_suggestion',
    description:
      'Explicitly dismisses an inferred suggestion. Suggestions are not commitments or answers; nothing is created automatically.',
    action: 'link_message',
    write: true,
    props: { session_id: S, suggestion_id: S, reason: S },
    required: ['session_id', 'suggestion_id'],
    path: session,
    run: async ({ input, command }) => {
      const result = await dismissSuggestion(command, {
        session_id: input['session_id'] as Uuid,
        suggestion_id: input['suggestion_id'] as Uuid,
        ...(input['reason'] === undefined ? {} : { reason: input['reason'] as string }),
      });
      return { suggestion: toToolSuggestion(result.suggestion) };
    },
  },
];
