import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { MIGRATIONS_DIR } from './paths.ts';
import { APP_ROLE, setAppRolePassword } from './app-role.ts';
import { migrate } from './migrate.ts';

const DEFAULT_URL = 'postgres://chorus:chorus@localhost:5432/chorus_test';
// Local and CI only. The role is cluster-wide, so every test database shares this password.
const TEST_APP_PASSWORD = 'chorus_app_test_only';
const APP_ROLE_LOCK = 7_262_026_002;

/**
 * Test helpers create and drop databases and set the cluster-wide chorus_app password, so they refuse to
 * run against anything that is not clearly a test database (name ending in `_test`).
 */
export function assertTestDatabaseUrl(databaseUrl: string): void {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  if (!/_test$/.test(name)) {
    throw new Error(
      `Refusing to run test helpers against database "${name}": DATABASE_URL must point at a database whose name ends in "_test".`,
    );
  }
}

/** Test support: throwaway databases. Not for production code paths. */
export interface EphemeralDatabase {
  /** Owner connection: superuser locally and in CI. Use for seeding and assertions only. */
  readonly url: string;
  /** Connection as the non-owner runtime role (chorus_app), which RLS applies to. */
  readonly appUrl: string;
  query: <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;
  drop: () => Promise<void>;
}

/** Creates a throwaway database on the server named by DATABASE_URL so each test file owns its state. */
export async function createEphemeralDatabase(): Promise<EphemeralDatabase> {
  const adminUrl = process.env['DATABASE_URL'] ?? DEFAULT_URL;
  assertTestDatabaseUrl(adminUrl);
  const name = `chorus_t_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`); // name is generated above, never user input
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const appUrl = new URL(url);
  appUrl.username = APP_ROLE;
  appUrl.password = TEST_APP_PASSWORD;

  // One small pool per ephemeral database: parallel test files must not exhaust max_connections.
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  pool.on('error', () => undefined);

  return {
    url: url.toString(),
    appUrl: appUrl.toString(),
    async query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
      return (await pool.query<T>(sql, params)).rows;
    },
    async drop() {
      await pool.end();
      const dropper = new pg.Client({ connectionString: adminUrl });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}

/** An ephemeral database with every repository migration already applied. */
export async function createMigratedEphemeralDatabase(): Promise<EphemeralDatabase> {
  const db = await createEphemeralDatabase();
  try {
    await migrate({ databaseUrl: db.url, migrationsDir: MIGRATIONS_DIR });
    await configureAppRole();
  } catch (error) {
    await db.drop();
    throw error;
  }
  return db;
}

/** ALTER ROLE on a cluster-wide role must not run concurrently; lock on the shared admin database. */
async function configureAppRole(): Promise<void> {
  const adminUrl = process.env['DATABASE_URL'] ?? DEFAULT_URL;
  assertTestDatabaseUrl(adminUrl);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query('SELECT pg_advisory_lock($1)', [APP_ROLE_LOCK]);
    await setAppRolePassword(admin, TEST_APP_PASSWORD);
  } finally {
    await admin.end();
  }
}
