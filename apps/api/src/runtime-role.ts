import type pg from 'pg';
import { ConfigError } from './config.ts';

/**
 * The service must run as the non-owner runtime role so row-level security applies to it. Refuse to
 * start as anything else: a superuser or BYPASSRLS connection would silently skip tenant isolation.
 */
export async function assertRuntimeRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user`,
  );
  const row = rows[0];
  if (row?.current_user !== 'chorus_app' || row.rolsuper || row.rolbypassrls) {
    throw new ConfigError(
      'DATABASE_URL_APP must connect as the chorus_app role (not a superuser, no BYPASSRLS). Refusing to start.',
    );
  }
}
