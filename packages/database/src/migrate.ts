import pg from 'pg';
import {
  MigrationChecksumError,
  MigrationError,
  MigrationFailedError,
  formatVersion,
} from './errors.ts';
import { loadMigrations, type Migration } from './migrations.ts';

// Arbitrary constant; every runner takes the same session-level lock so concurrent runs serialize.
const MIGRATION_LOCK_KEY = 7_262_026_001n;

export interface MigrateOptions {
  readonly databaseUrl: string;
  readonly migrationsDir: string;
}

export interface MigrateResult {
  /** Versions applied by this run, in order. */
  readonly applied: readonly number[];
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

/**
 * Applies pending `migrations/*.sql` in order, each in its own transaction, and refuses to run if an
 * already-applied file changed. Safe to run concurrently: runners serialize on an advisory lock.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const migrations = await loadMigrations(options.migrationsDir);
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    try {
      return await applyPending(client, migrations);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    }
  } finally {
    await client.end();
  }
}

async function applyPending(client: pg.Client, migrations: Migration[]): Promise<MigrateResult> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer     PRIMARY KEY,
      name       text        NOT NULL,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

  const { rows } = await client.query<AppliedRow>(
    'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
  );
  const appliedByVersion = new Map(rows.map((r) => [r.version, r]));
  const onDisk = new Map(migrations.map((m) => [m.version, m]));

  for (const row of rows) {
    const file = onDisk.get(row.version);
    if (file === undefined) {
      throw new MigrationError(
        `Applied migration ${formatVersion(row.version)}_${row.name} is missing from disk.`,
      );
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationChecksumError(row.version, row.name, row.checksum, file.checksum);
    }
  }

  const highestApplied = rows.at(-1)?.version ?? 0;
  const pending = migrations.filter((m) => !appliedByVersion.has(m.version));
  const outOfOrder = pending.find((m) => m.version < highestApplied);
  if (outOfOrder !== undefined) {
    throw new MigrationError(
      `Migration ${formatVersion(outOfOrder.version)}_${outOfOrder.name} is older than the newest applied migration ` +
        `(${formatVersion(highestApplied)}). Migrations are forward-only; renumber it after the latest one.`,
    );
  }

  const applied: number[] = [];
  for (const migration of pending) {
    await applyOne(client, migration);
    applied.push(migration.version);
  }
  return { applied };
}

async function applyOne(client: pg.Client, migration: Migration): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(migration.sql);
    await client.query(
      'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
      [migration.version, migration.name, migration.checksum],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new MigrationFailedError(migration.version, migration.name, error);
  }
}
