import { requireAction } from '../authz.ts';
import { runCommand, withReadTx, type CommandContext, type ReadContext } from '../command.ts';
import { ChorusError } from '../errors.ts';
import type { Uuid } from '../ids.ts';
import { insertTransitions, loadCoordState } from './store.ts';
import {
  OBJECT_STATUSES,
  RESOLVED_STATUS,
  UNSETTLED_STATUSES,
  type CoordObject,
  type Evaluate,
  type ObjectKind,
  type Signal,
} from './types.ts';

/**
 * CC-2c commands and queries over a session's inferred conversation state (spec §9). The signal evaluator is
 * injected (spec D6); nothing here interprets message text.
 */

const GROUP: Readonly<Record<ObjectKind, string>> = {
  question: 'questions',
  commitment: 'commitments',
  handoff: 'handoffs',
  decision: 'decisions',
  claim: 'claims',
  conflict: 'conflicts',
  dependency: 'dependencies',
};

/** Not terminal: still unsettled, or a live decision or claim. */
const isOpen = (o: CoordObject): boolean =>
  UNSETTLED_STATUSES[o.kind].includes(o.status) ||
  ((o.kind === 'decision' || o.kind === 'claim') && o.status === 'active');

export type CoordinationStatus = {
  readonly cursor: number;
  readonly objects: Readonly<Record<string, readonly CoordObject[]>>;
  readonly signals: readonly Signal[];
  readonly ready_to_close: boolean;
  readonly inferred: true;
  readonly coverage: 'scanned_windows_only';
};

async function requireMember(db: import('../authz.ts').Queryable, sessionId: Uuid): Promise<void> {
  const { rows } = await db.query<{ roles: string[] | null }>(
    'SELECT chorus_session_roles($1) AS roles',
    [sessionId],
  );
  if (rows[0]?.roles == null) throw new ChorusError('not_found', 'Not found.');
}

/**
 * `chorus.coordination_status` (spec §9). `ready_to_close` holds only when the engine says the conversation is
 * settled AND every canonical task in the session is done or cancelled.
 */
export async function coordinationStatus(
  read: ReadContext,
  input: { readonly session_id: Uuid; readonly include_closed?: boolean },
  evaluate: Evaluate,
): Promise<CoordinationStatus> {
  return withReadTx(read, async (db) => {
    await requireMember(db, input.session_id);
    const state = await loadCoordState(db, read.workspaceId, input.session_id);
    const { rows } = await db.query<{ unfinished: string }>(
      `SELECT count(*) AS unfinished FROM work_items
        WHERE workspace_id = $1 AND session_id = $2 AND kind = 'task' AND state NOT IN ('done', 'cancelled')`,
      [read.workspaceId, input.session_id],
    );
    const tasksSettled = Number(rows[0]?.unfinished ?? 0) === 0;
    const all = evaluate(state);
    const signals = all.filter((s) => s.kind !== 'ready_to_close' || tasksSettled);
    const objects: Record<string, CoordObject[]> = {};
    for (const group of Object.values(GROUP)) objects[group] = [];
    for (const o of state.objects) {
      if (input.include_closed === true || isOpen(o)) objects[GROUP[o.kind]]?.push(o);
    }
    return {
      cursor: state.cursor,
      objects,
      signals,
      ready_to_close: signals.some((s) => s.kind === 'ready_to_close'),
      inferred: true,
      coverage: 'scanned_windows_only',
    };
  });
}

export type UpdateAction = 'resolve' | 'ignore' | 'reopen';

export type UpdateConversationObjectResult = { readonly object: CoordObject };

/**
 * `chorus.update_conversation_object` (spec §9): a person corrects an inference. Allowed for the object's author,
 * owner or targets, or a session manager. `resolve` → the kind's success status, `ignore` → `dismissed`, and
 * `reopen` (only from a terminal status) → the kind's initial status. Every change appends a `command`
 * transition.
 */
export async function updateConversationObject(
  ctx: CommandContext,
  args: {
    readonly session_id: Uuid;
    readonly ref: string;
    readonly action: UpdateAction;
    readonly reason?: string;
  },
): Promise<UpdateConversationObjectResult> {
  if (!/^[QCHDKXP][1-9][0-9]{0,8}$/.test(args.ref)) {
    throw new ChorusError('invalid_request', 'ref is invalid.', { details: { field: 'ref' } });
  }
  if (!['resolve', 'ignore', 'reopen'].includes(args.action)) {
    throw new ChorusError('invalid_request', 'action is invalid.', {
      details: { field: 'action' },
    });
  }
  if (args.reason !== undefined && args.reason.length > 500) {
    throw new ChorusError('invalid_request', 'reason is too long.', {
      details: { field: 'reason' },
    });
  }
  return runCommand<UpdateConversationObjectResult>(ctx, {
    type: 'conversation.object_update',
    session: { id: args.session_id },
    input: { ref: args.ref, action: args.action, reason: args.reason ?? null },
    authorize: (tx) => {
      requireAction(tx, 'link_message');
      return Promise.resolve();
    },
    handle: async (tx) => {
      const { rows } = await tx.db.query<{ body: CoordObject }>(
        `SELECT body FROM conversation_objects
          WHERE workspace_id = $1 AND session_id = $2 AND ref = $3 FOR UPDATE`,
        [tx.workspaceId, args.session_id, args.ref],
      );
      const object = rows[0]?.body;
      if (object === undefined) throw new ChorusError('not_found', 'Not found.');

      const seat = await tx.db.query<{ member_id: string | null }>(
        'SELECT sharednet_member_id AS member_id FROM agent_instances WHERE workspace_id = $1 AND id = $2',
        [tx.workspaceId, tx.instanceId],
      );
      const me = seat.rows[0]?.member_id ?? null;
      const involved =
        me !== null &&
        (object.author.member_id === me ||
          object.owner?.member_id === me ||
          object.targets.some((t) => t.member_id === me));
      if (!involved && !tx.roles.includes('manager')) {
        throw new ChorusError(
          'action_forbidden',
          'Only someone involved in this item, or a manager, can change it.',
          {
            details: { reason: 'not_involved' },
          },
        );
      }

      let to: string;
      if (args.action === 'resolve') {
        const target = RESOLVED_STATUS[object.kind];
        if (target === undefined) {
          throw new ChorusError('invalid_transition', 'This kind of item cannot be resolved.', {
            details: { reason: 'not_resolvable', kind: object.kind },
          });
        }
        to = target;
      } else if (args.action === 'ignore') {
        to = 'dismissed';
      } else {
        if (isOpen(object)) {
          throw new ChorusError('invalid_transition', 'The item is still open.', {
            details: { reason: 'not_terminal', state: object.status },
          });
        }
        to = OBJECT_STATUSES[object.kind][0] ?? object.status;
      }
      if (to === object.status) {
        throw new ChorusError('invalid_transition', 'The item is already in that state.', {
          details: { reason: 'unchanged', state: object.status },
        });
      }

      const updated: CoordObject = { ...object, status: to };
      await tx.db.query(
        `UPDATE conversation_objects SET status = $4, body = $5::jsonb, updated_at = now()
          WHERE workspace_id = $1 AND session_id = $2 AND ref = $3`,
        [tx.workspaceId, args.session_id, args.ref, to, JSON.stringify(updated)],
      );
      await insertTransitions(
        tx.db,
        tx.workspaceId,
        args.session_id,
        [
          {
            ref: args.ref,
            from: object.status,
            to,
            cause: 'command',
            reason: `${args.action}${args.reason === undefined ? '' : `: ${args.reason}`}`,
          },
        ],
        tx.actorId,
      );
      return { result: { object: updated }, events: [], noop: true };
    },
  });
}
