import type { AccessContext } from '@aicoo/sharedos';
import type { ChorusRequestScope } from './request-scope.ts';

export const CHORUS_PURPOSE = 'chorus.work';
export const CHORUS_SERVICE = { kind: 'service', serviceId: 'chorus' } as const;

/** Built server-side from the authenticated scope; nothing in it comes from client input. */
export function buildAccessContext(
  scope: ChorusRequestScope,
  traceId: string,
  now: Date,
): AccessContext {
  return {
    namespaceId: scope.workspaceId,
    actor: { kind: 'agent', agentId: scope.actorId },
    authority: CHORUS_SERVICE,
    owner: { kind: 'group', conversationId: scope.roomId },
    purpose: CHORUS_PURPOSE,
    traceId,
    enabledToolNamespaces: ['chorus'],
    now: now.toISOString(),
  };
}
