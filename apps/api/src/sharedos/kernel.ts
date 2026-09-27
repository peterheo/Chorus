import { SharedOSKernel } from '@aicoo/sharedos';
import type pg from 'pg';
import { createPgAuditSink, type AuditLogger } from './audit-sink.ts';
import { createChorusGrantSource } from './grant-source.ts';
import type { ToolDeps } from './tools/define.ts';
import { chorusTools } from './tools/index.ts';

export interface ChorusKernelDeps {
  /** The chorus_app pool. */
  readonly pool: pg.Pool;
  readonly leaseDurationSeconds: number;
  readonly gitCommit: string;
  readonly arena?: ToolDeps['arena'];
  readonly limits?: ToolDeps['limits'];
  readonly billing?: ToolDeps['billing'];
  readonly sharednet?: ToolDeps['sharednet'];
  readonly receipts?: ToolDeps['receipts'];
  readonly logger: AuditLogger & { warn?: (obj: Record<string, unknown>, msg: string) => void };
}

/** The SharedOS host: Chorus grants, the durable audit sink, and every `chorus.*` tool. */
export function createChorusKernel(deps: ChorusKernelDeps): {
  readonly kernel: SharedOSKernel;
  readonly audit: { failures: () => number; flush: () => Promise<void> };
} {
  const audit = createPgAuditSink(deps.pool, deps.logger);
  const kernel = new SharedOSKernel({
    grantSource: createChorusGrantSource(deps.pool),
    audit: audit.sink,
    onAuditError: (error) => {
      deps.logger.error({ name: (error as Error).name }, 'audit sink rejected an event');
    },
  });
  for (const tool of chorusTools({
    pool: deps.pool,
    leaseDurationSeconds: deps.leaseDurationSeconds,
    gitCommit: deps.gitCommit,
    ...(deps.arena === undefined ? {} : { arena: deps.arena }),
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    ...(deps.billing === undefined ? {} : { billing: deps.billing }),
    ...(deps.sharednet === undefined ? {} : { sharednet: deps.sharednet }),
    ...(deps.receipts === undefined ? {} : { receipts: deps.receipts }),
    logger: deps.logger,
  })) {
    kernel.registerTool(tool);
  }
  return { kernel, audit: { failures: audit.failures, flush: audit.flush } };
}
