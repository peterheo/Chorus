import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MigrationError, formatVersion } from './errors.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const FILENAME = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function parseMigrationFilename(
  filename: string,
): { version: number; name: string } | undefined {
  const match = FILENAME.exec(filename);
  const [, version, name] = match ?? [];
  if (version === undefined || name === undefined) return undefined;
  return { version: Number(version), name };
}

/** Reads `NNNN_name.sql` files from `dir`, ordered by version. Rejects stray files and duplicate versions. */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const filenames = (await readdir(dir)).filter((f) => !f.startsWith('.')).sort();
  const migrations: Migration[] = [];
  for (const filename of filenames) {
    const parsed = parseMigrationFilename(filename);
    if (parsed === undefined) {
      throw new MigrationError(`Unexpected file in migrations directory: ${filename}`);
    }
    const sql = await readFile(join(dir, filename), 'utf8');
    migrations.push({ ...parsed, sql, checksum: checksumOf(sql) });
  }
  migrations.sort((a, b) => a.version - b.version);
  for (const [i, m] of migrations.entries()) {
    if (m.version === migrations[i - 1]?.version) {
      throw new MigrationError(`Duplicate migration version ${formatVersion(m.version)}`);
    }
  }
  return migrations;
}
