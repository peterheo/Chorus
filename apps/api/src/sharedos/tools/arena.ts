import {
  ChorusError,
  coordinationModeOf,
  createSessionInTx,
  createTaskInTx,
  conversationDigest,
  findPurchase,
  parseCoordinationModeChange,
  parseCreateSession,
  parseCreateTask,
  roomPulse,
  setCoordinationMode,
  setCoordinationModeInTx,
  type CreateTaskParams,
  type JsonValue,
  type TaskSummary,
  type Uuid,
} from '@chorus/domain';
import { purchase, type ArenaDeps } from '../../arena/payments.ts';
import { PRICES, coordinationModePrice } from '../../arena/prices.ts';
import { B, I, S, SA, objectArray, type ChorusToolSpec, type ToolDeps } from './define.ts';

const room = (): string[] => ['room'];
const session = (a: Record<string, unknown>): string[] => ['sessions', String(a['session_id'])];

const arenaOf = (deps: ToolDeps): ArenaDeps => {
  if (deps.arena === undefined) {
    throw new ChorusError('internal_error', 'The Arena services are not configured.');
  }
  return deps.arena;
};

/** Drops undefined members so the domain validators see only what the caller actually sent. */
const defined = (record: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

const invalid = (message: string, field: string): ChorusError =>
  new ChorusError('invalid_request', message, { details: { field } });

/** The only keys a task of `create_tasks` may carry (the target session and board are the call's own). */
const TASK_KEYS: ReadonlySet<string> = new Set([
  'title',
  'body',
  'acceptance_criteria',
  'priority',
  'review_required',
  'shareable',
]);

/** Published inputSchema for one `tasks[]` item, mirroring `parseCreateTask`'s exact bounds (tasks.ts). */
const TASK_ITEM_SCHEMA = objectArray(
  {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    body: { type: 'string' },
    acceptance_criteria: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
    priority: { type: 'integer', minimum: 0, maximum: 4 },
    review_required: B,
    shareable: B,
  },
  ['title', 'acceptance_criteria'],
);

/** Validates task `index`, and prefixes every field error with `tasks[index].` so the caller can find it. */
function parseTaskAt(
  task: unknown,
  index: number,
  input: Record<string, unknown>,
): CreateTaskParams {
  const at = `tasks[${String(index)}]`;
  if (task === null || typeof task !== 'object' || Array.isArray(task)) {
    throw invalid(`${at} must be an object.`, at);
  }
  for (const key of Object.keys(task)) {
    if (!TASK_KEYS.has(key)) throw invalid(`${at}.${key} is not allowed.`, `${at}.${key}`);
  }
  try {
    return parseCreateTask({
      ...(task as Record<string, unknown>),
      session_id: input['session_id'],
      board_id: input['board_id'],
    });
  } catch (error) {
    if (error instanceof ChorusError && error.code === 'invalid_request') {
      const field = error.details['field'];
      throw new ChorusError('invalid_request', `${at}.${error.message}`, {
        details: { ...error.details, field: typeof field === 'string' ? `${at}.${field}` : at },
      });
    }
    throw error;
  }
}

const requestIdOf = (input: Record<string, unknown>): string => {
  const value = input['request_id'];
  if (typeof value !== 'string') throw invalid('request_id is required.', 'request_id');
  return value;
};
const txnOf = (input: Record<string, unknown>): string | undefined => {
  const value = input['payment_txn_id'];
  return typeof value === 'string' ? value : undefined;
};

/** The three Arena tools (WP5-min section 6, Arena rev 2). Paid tools take a `request_id`, never an `idempotency_key`. */
export const arenaTools: readonly ChorusToolSpec[] = [
  {
    name: 'chorus.room_pulse',
    description:
      'Free, read-only summary of the sessions you belong to: counts and the next actions the canonical state suggests. It covers Chorus state only and never reads room messages.',
    action: 'pulse',
    write: false,
    rateLimit: 'pulse',
    props: { session_id: S },
    required: [],
    path: room,
    run: async ({ read, input }) => {
      const filter =
        input['session_id'] === undefined ? {} : { session_id: input['session_id'] as Uuid };
      const [pulse, digest] = await Promise.all([
        roomPulse(read, filter),
        conversationDigest(read, filter),
      ]);
      return {
        ...pulse,
        conversation: digest.map((entry) => ({ ...entry, inferred: true })),
        coverage: 'chorus_state_and_stored_conversation_suggestions',
      };
    },
  },
  {
    name: 'chorus.create_action_board',
    description: `Paid (${String(PRICES.create_action_board)} credits): creates one session with its first board in your room and makes you its participant, manager and administrator. The first call answers payment_required with what to pay; call again with the same arguments plus payment_txn_id.`,
    action: 'create_session',
    write: true,
    idempotency: 'request_id',
    rateLimit: 'paid',
    props: {
      request_id: S,
      session_name: S,
      board_name: S,
      join_policy: S,
      discoverable: B,
      listed_principals: SA,
      payment_txn_id: S,
    },
    required: ['request_id', 'session_name', 'board_name'],
    path: room,
    run: ({ command, input, scope, deps }) => {
      // Shape and P1 limits are validated BEFORE anything is quoted.
      const params = parseCreateSession(
        scope,
        defined({
          name: input['session_name'],
          board_name: input['board_name'],
          join_policy: input['join_policy'],
          discoverable: input['discoverable'],
          listed_principals: input['listed_principals'],
        }),
      );
      return purchase(
        arenaOf(deps),
        command,
        'create_action_board',
        {
          requestId: requestIdOf(input),
          paymentTxnId: txnOf(input),
          target: {},
          input: {
            session_name: params.name,
            board_name: params.boardName,
            join_policy: params.policy,
            discoverable: params.discoverable,
            listed_principals: params.listed,
          },
          amount: PRICES.create_action_board,
        },
        (tx) => createSessionInTx(tx, params),
      );
    },
  },
  {
    name: 'chorus.create_tasks',
    description: `Paid (${String(PRICES.create_tasks_per_task)} credit per task, 1-${String(PRICES.create_tasks_max)} tasks): creates the tasks on a board of a session you belong to, all or nothing. The first call answers payment_required with what to pay; call again with the same arguments plus payment_txn_id.`,
    action: 'create_item',
    write: true,
    idempotency: 'request_id',
    rateLimit: 'paid',
    props: {
      request_id: S,
      session_id: S,
      board_id: S,
      tasks: TASK_ITEM_SCHEMA,
      payment_txn_id: S,
    },
    required: ['request_id', 'session_id', 'board_id', 'tasks'],
    path: session,
    run: ({ command, input, deps }) => {
      const list = input['tasks'];
      if (!Array.isArray(list) || list.length < 1 || list.length > PRICES.create_tasks_max) {
        throw invalid(`tasks must hold 1-${String(PRICES.create_tasks_max)} items.`, 'tasks');
      }
      const params: CreateTaskParams[] = (list as unknown[]).map((task, index) =>
        parseTaskAt(task, index, input),
      );
      const first = params[0];
      if (first === undefined) throw invalid('tasks must not be empty.', 'tasks');
      return purchase(
        arenaOf(deps),
        command,
        'create_tasks',
        {
          requestId: requestIdOf(input),
          paymentTxnId: txnOf(input),
          target: { sessionId: first.sessionId, boardId: first.boardId },
          input: {
            tasks: params.map((p): JsonValue => ({
              title: p.title,
              body: p.body,
              acceptance_criteria: p.criteria,
              priority: p.priority,
              review_required: p.requestedReview ?? null,
              shareable: p.shareable,
            })),
          },
          amount: PRICES.create_tasks_per_task * params.length,
        },
        // One transaction for all of them: any failure rolls every task back with the purchase.
        async (tx) => {
          const tasks: TaskSummary[] = [];
          const events = [];
          for (const p of params) {
            const created = await createTaskInTx(tx, p);
            tasks.push(created.result.task);
            events.push(...created.events);
          }
          return { result: { tasks: tasks as unknown as JsonValue }, events };
        },
      );
    },
  },
];

/**
 * With billing enabled, `chorus.set_coordination_mode` is paid when it RAISES the mode, priced from the session's
 * CURRENT mode at quote time: off → observe and off → assist cost their price, observe → assist the
 * difference. The same mode, lowering it, and `off` are free and run the ordinary command. It replaces the
 * free tool of the same name only when billing is enabled (tools/index.ts).
 *
 * The quote-vs-delivery race: delivery runs under a lock on the session row at the caller's expected
 * version and recomputes the price from the mode as it is then. If it differs from what was quoted and
 * paid, nothing is delivered (`invalid_transition`, reason `mode_changed`), so a mode is never delivered for
 * less than its price; the transaction rolls back, the purchase stays quoted and the payment unclaimed.
 */
export const paidCoordinationModeTool: ChorusToolSpec = {
  name: 'chorus.set_coordination_mode',
  description: `Sets a session's room-message coordination mode ('off', 'observe' or 'assist'). Requires an administrator and the latest session version. Paid when it raises the mode: off → observe ${String(PRICES.set_coordination_mode_observe)} credits, off → assist ${String(PRICES.set_coordination_mode_assist)}, observe → assist ${String(PRICES.set_coordination_mode_assist - PRICES.set_coordination_mode_observe)} (the difference); the same mode, lowering it, and 'off' are free. A raise answers payment_required with what to pay; call again with the same arguments plus payment_txn_id.`,
  action: 'administer',
  write: true,
  idempotency: 'request_id',
  rateLimit: 'paid',
  props: { request_id: S, session_id: S, mode: S, expected_version: I, payment_txn_id: S },
  required: ['request_id', 'session_id', 'mode', 'expected_version'],
  path: session,
  run: async ({ command, read, input, deps }) => {
    const change = parseCoordinationModeChange(
      defined({
        session_id: input['session_id'],
        expected_version: input['expected_version'],
        mode: input['mode'],
      }),
    );
    const requestId = requestIdOf(input);
    // Administrator only, before anything is quoted (a non-member learns nothing: not_found).
    const current = await coordinationModeOf(read, change.sessionId);
    const existing = await findPurchase(read, 'set_coordination_mode', requestId);
    const due = coordinationModePrice(current.mode, change.mode);
    if (existing === undefined && due === 0) {
      // Free (the same mode, lowering, off): the ordinary command, keyed by the caller's request_id.
      return setCoordinationMode(
        { ...command, idempotencyKey: `set_coordination_mode:${requestId}` },
        {
          session_id: change.sessionId,
          expected_version: change.expectedVersion,
          mode: change.mode,
        },
      );
    }
    if (existing === undefined && current.version !== change.expectedVersion) {
      // Refused before a quote, so nobody pays for a change that cannot be delivered at this version.
      throw new ChorusError('version_conflict', 'The session changed after the supplied version.', {
        details: { session_id: change.sessionId, current_version: current.version },
      });
    }
    // A stored purchase keeps the price it was quoted at (its replay never charges again).
    const amount = existing?.amount ?? due;
    return purchase(
      arenaOf(deps),
      command,
      'set_coordination_mode',
      {
        requestId,
        paymentTxnId: txnOf(input),
        target: { sessionId: change.sessionId },
        // What the purchase is FOR is the target mode. expected_version is checked at the quote (above) and
        // again under the lock at delivery, with the version THIS call passes: an unrelated policy change
        // after paying needs only a retry at the new version, not a new purchase.
        input: { mode: change.mode },
        amount,
        sessionLock: { expectedVersion: change.expectedVersion },
      },
      async (tx) => {
        const applied = await setCoordinationModeInTx(tx, {
          sessionId: change.sessionId,
          mode: change.mode,
          guard: (now) => {
            const price = coordinationModePrice(now, change.mode);
            if (price !== amount) {
              throw new ChorusError(
                'invalid_transition',
                `The coordination mode changed to '${now}' after the quote, so this change now costs ${String(price)}, not the ${String(amount)} quoted. Nothing was delivered and the payment was not used.`,
                {
                  details: {
                    reason: 'mode_changed',
                    current_mode: now,
                    quoted_amount: amount,
                    current_amount: price,
                  },
                },
              );
            }
          },
        });
        return { result: applied.result as unknown as JsonValue, events: applied.events };
      },
    );
  },
};
