import { AsyncLocalStorage } from 'node:async_hooks';
import { ChorusError, type Uuid } from '@chorus/domain';

/**
 * The authenticated caller of one request. It is set by the HTTP layer from the resolved token (never from
 * client input) and read by the tool handlers, which refuse to run without it.
 */
export interface ChorusRequestScope {
  readonly workspaceId: Uuid;
  readonly actorId: Uuid;
  readonly instanceId: Uuid | null;
  readonly roomId: Uuid;
  /** ISO timestamp. */
  readonly tokenExpiresAt: string;
}

const storage = new AsyncLocalStorage<ChorusRequestScope>();

export function runInRequestScope<T>(scope: ChorusRequestScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn);
}

export function requireRequestScope(): ChorusRequestScope {
  const scope = storage.getStore();
  if (scope === undefined) {
    throw new ChorusError('internal_error', 'No request scope is active.');
  }
  return scope;
}
