import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Uuid } from '@chorus/domain';

export interface AuthContext {
  readonly actorId: Uuid;
  readonly workspaceId: Uuid;
  readonly kind: string;
  readonly instanceId: Uuid | null;
  readonly tokenExpiresAt: Date | null;
  /** Stable, non-secret handle for rate limiting and logging (a prefix of the token's sha256). */
  readonly tokenKey: string;
}

const BEARER = /^Bearer (cht_[A-Za-z0-9_-]{43})$/;

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** `cht_` + base64url(32 random bytes). Only its sha256 is ever stored. */
export function newChorusToken(): string {
  return `cht_${randomBytes(32).toString('base64url')}`;
}

export function extractBearer(header: string | undefined): string | undefined {
  const match = header === undefined ? null : BEARER.exec(header);
  return match?.[1];
}

/** Resolves a bearer token to its actor, or undefined for missing, unknown, revoked, expired or locked-out tokens. */
export async function resolveToken(pool: pg.Pool, token: string): Promise<AuthContext | undefined> {
  const hash = sha256Hex(token);
  const { rows } = await pool.query<{
    actor_id: Uuid;
    workspace_id: Uuid;
    actor_kind: string;
    instance_id: Uuid | null;
    token_expires_at: Date | null;
  }>('SELECT * FROM chorus_resolve_token($1)', [hash]);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    actorId: row.actor_id,
    workspaceId: row.workspace_id,
    kind: row.actor_kind,
    instanceId: row.instance_id,
    tokenExpiresAt: row.token_expires_at,
    tokenKey: hash.slice(0, 16),
  };
}
