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

/**
 * Returns the first top-level transaction-control statement (BEGIN, COMMIT, ROLLBACK, START
 * TRANSACTION), or undefined. The runner wraps every file in its own transaction, so such a
 * statement would silently break atomicity. Comments, quoted strings and dollar-quoted bodies
 * (where plpgsql legitimately uses BEGIN ... END) are ignored.
 */
export function findTransactionControl(sql: string): string | undefined {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)?\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, ' ');
  const match = /(?:^|;)\s*(begin|commit|rollback|start\s+transaction)\b/i.exec(stripped);
  return match?.[1]?.toLowerCase();
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
    const control = findTransactionControl(sql);
    if (control !== undefined) {
      throw new MigrationError(
        `${filename} contains a top-level "${control}"; the runner already wraps each file in a transaction.`,
      );
    }
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
