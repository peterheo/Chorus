import type { AuditEvent, AuditSink } from '@aicoo/sharedos';
import type pg from 'pg';

export interface AuditLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface PgAuditSink {
  readonly sink: AuditSink;
  /** How many batches failed to insert since start. */
  failures: () => number;
  /** Writes everything queued so far; resolves once the queue is empty (or the write failed and was counted). */
  flush: () => Promise<void>;
}

const FLUSH_MS = 250;
const BATCH = 100;

/**
 * Persists SharedOS audit events into `sharedos_audit_events`. Recording only enqueues, so it can never fail
 * or stall a tool call; a background timer writes batches, each in its own transaction with the workspace's
 * RLS context, and never inside a domain transaction. A failed insert is logged (without the event body)
 * and counted, and that batch is dropped.
 */
export function createPgAuditSink(pool: pg.Pool, logger: AuditLogger): PgAuditSink {
  let queue: AuditEvent[] = [];
  let failed = 0;
  let inFlight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;

  const writeBatch = async (workspaceId: string, events: readonly AuditEvent[]): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('chorus.workspace_id', $1, true)`, [workspaceId]);
      await client.query(
        `INSERT INTO sharedos_audit_events (workspace_id, event)
         SELECT $1, e FROM jsonb_array_elements($2::jsonb) AS e`,
        [workspaceId, JSON.stringify(events)],
      );
      await client.query('COMMIT');
      client.release();
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release(true);
      throw error;
    }
  };

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const taken = queue;
      queue = [];
      const byWorkspace = new Map<string, AuditEvent[]>();
      for (const event of taken) {
        const list = byWorkspace.get(event.namespaceId) ?? [];
        list.push(event);
        byWorkspace.set(event.namespaceId, list);
      }
      for (const [workspaceId, events] of byWorkspace) {
        for (let i = 0; i < events.length; i += BATCH) {
          try {
            await writeBatch(workspaceId, events.slice(i, i + BATCH));
          } catch (error) {
            failed += 1;
            logger.error(
              {
                code: (error as { code?: string }).code,
                events: events.slice(i, i + BATCH).length,
              },
              'audit insert failed',
            );
          }
        }
      }
    }
  };

  const schedule = (): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = inFlight.then(drain);
    }, FLUSH_MS);
    timer.unref();
  };

  return {
    sink: {
      record: (event) => {
        queue.push(event);
        schedule();
        return Promise.resolve();
      },
    },
    failures: () => failed,
    flush: async () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      inFlight = inFlight.then(drain);
      await inFlight;
    },
  };
}
