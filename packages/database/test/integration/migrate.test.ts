import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationChecksumError, MigrationFailedError } from '../../src/errors.ts';
import { migrate } from '../../src/migrate.ts';
import { createEphemeralDatabase, type EphemeralDatabase } from '../helpers/ephemeral-database.ts';

const realMigrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url));

describe('migrate (real PostgreSQL)', () => {
  let db: EphemeralDatabase;
  let dir: string;

  // Each test owns a fresh database and migrations directory, so tests are order-independent.
  beforeEach(async () => {
    db = await createEphemeralDatabase();
    dir = await mkdtemp(join(tmpdir(), 'chorus-migrate-'));
  });
  afterEach(async () => {
    await db.drop();
    await rm(dir, { recursive: true, force: true });
  });

  const applied = async () =>
    (
      await db.query<{ version: number; name: string; checksum: string }>(
        'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
      )
    ).map((r) => r.version);

  it('applies the repository migrations and enables pgcrypto', async () => {
    const result = await migrate({ databaseUrl: db.url, migrationsDir: realMigrationsDir });
    expect(result.applied).toEqual([1]);
    const ext = await db.query('SELECT 1 FROM pg_extension WHERE extname = $1', ['pgcrypto']);
    expect(ext).toHaveLength(1);
  });

  it('applies migrations in order and is idempotent on re-run', async () => {
    await writeFile(join(dir, '0002_b.sql'), 'CREATE TABLE t_b (id int);');
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_a (id int);');
    const first = await migrate({ databaseUrl: db.url, migrationsDir: dir });
    expect(first.applied).toEqual([1, 2]);

    const second = await migrate({ databaseUrl: db.url, migrationsDir: dir });
    expect(second.applied).toEqual([]);
    expect(await applied()).toEqual([1, 2]);
  });

  it('rejects an edited, already-applied migration', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_edit (id int);');
    await migrate({ databaseUrl: db.url, migrationsDir: dir });

    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_edit (id int, extra int);');
    await expect(migrate({ databaseUrl: db.url, migrationsDir: dir })).rejects.toThrow(
      MigrationChecksumError,
    );
  });

  it('rolls back a failing migration and keeps earlier ones applied', async () => {
    await writeFile(join(dir, '0001_ok.sql'), 'CREATE TABLE t_ok (id int);');
    await writeFile(join(dir, '0002_bad.sql'), 'CREATE TABLE t_bad (id int); SELECT 1/0;');
    await writeFile(join(dir, '0003_never.sql'), 'CREATE TABLE t_never (id int);');

    await expect(migrate({ databaseUrl: db.url, migrationsDir: dir })).rejects.toThrow(
      MigrationFailedError,
    );

    expect(await applied()).toEqual([1]);
    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_name IN ('t_ok', 't_bad', 't_never')`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(['t_ok']);
  });

  it('serializes concurrent runners so each migration applies exactly once', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'CREATE TABLE t_c (id int);');
    await writeFile(join(dir, '0002_b.sql'), 'ALTER TABLE t_c ADD COLUMN extra int;');
    const runs = await Promise.all(
      Array.from({ length: 8 }, () => migrate({ databaseUrl: db.url, migrationsDir: dir })),
    );
    expect(runs.flatMap((r) => r.applied).sort()).toEqual([1, 2]);
    expect(await applied()).toEqual([1, 2]);
  });
});
