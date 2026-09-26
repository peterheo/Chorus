import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError } from '../../src/errors.ts';
import { assertTestDatabaseUrl } from '../../src/testing.ts';
import {
  checksumOf,
  findTransactionControl,
  loadMigrations,
  parseMigrationFilename,
} from '../../src/migrations.ts';

describe('parseMigrationFilename', () => {
  it('accepts NNNN_snake_case.sql', () => {
    expect(parseMigrationFilename('0001_init.sql')).toEqual({ version: 1, name: 'init' });
    expect(parseMigrationFilename('0042_add_lease_fence.sql')).toEqual({
      version: 42,
      name: 'add_lease_fence',
    });
  });

  it.each([
    '1_init.sql',
    '0001-init.sql',
    '0001_Init.sql',
    '0001_init.txt',
    '0001__init.sql',
    'x.sql',
  ])('rejects %s', (filename) => {
    expect(parseMigrationFilename(filename)).toBeUndefined();
  });
});

describe('checksumOf', () => {
  it('is a stable sha256 hex digest that changes with content', () => {
    expect(checksumOf('select 1;')).toBe(checksumOf('select 1;'));
    expect(checksumOf('select 1;')).not.toBe(checksumOf('select 2;'));
    expect(checksumOf('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('loadMigrations', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'chorus-migrations-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns migrations ordered by version with checksums', async () => {
    await writeFile(join(dir, '0002_second.sql'), 'select 2;');
    await writeFile(join(dir, '0001_first.sql'), 'select 1;');
    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => [m.version, m.name, m.checksum])).toEqual([
      [1, 'first', checksumOf('select 1;')],
      [2, 'second', checksumOf('select 2;')],
    ]);
  });

  it('rejects files that do not follow the naming convention', async () => {
    await writeFile(join(dir, 'notes.md'), 'hi');
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
  });

  it('rejects duplicate versions', async () => {
    await writeFile(join(dir, '0001_a.sql'), 'select 1;');
    await writeFile(join(dir, '0001_b.sql'), 'select 2;');
    await expect(loadMigrations(dir)).rejects.toThrow(/Duplicate migration version 0001/);
  });
});

describe('findTransactionControl', () => {
  it.each([
    ['BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;', 'begin'],
    ['CREATE TABLE t (id int);\ncommit;', 'commit'],
    ['create table t (id int);\n  ROLLBACK;', 'rollback'],
    ['START TRANSACTION;', 'start transaction'],
  ])('flags %j', (sql, expected) => {
    expect(findTransactionControl(sql)).toBe(expected);
  });

  it('ignores BEGIN inside dollar-quoted function bodies, strings and comments', () => {
    const sql = `
      -- BEGIN; COMMIT;
      /* ROLLBACK; */
      CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN
        RAISE EXCEPTION 'no; COMMIT; here';
      END;
      $body$;
      CREATE FUNCTION g() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END; $$;
      INSERT INTO t VALUES ('begin;');`;
    expect(findTransactionControl(sql)).toBeUndefined();
  });

  it('does not flag identifiers that merely start with the keyword', () => {
    expect(findTransactionControl('CREATE TABLE beginnings (id int);')).toBeUndefined();
  });
});

describe('assertTestDatabaseUrl', () => {
  it('accepts databases named *_test', () => {
    expect(() => {
      assertTestDatabaseUrl('postgres://u:p@localhost:5432/chorus_test');
    }).not.toThrow();
  });

  it.each(['chorus_dev', 'chorus', 'chorus_test_prod', 'production'])('refuses %s', (name) => {
    expect(() => {
      assertTestDatabaseUrl(`postgres://u:p@db.example.com:5432/${name}`);
    }).toThrow(/ends in "_test"/);
  });
});
