import { randomBytes } from 'node:crypto';
import pg from 'pg';

const DEFAULT_URL = 'postgres://chorus:chorus@localhost:5432/chorus_test';

export interface EphemeralDatabase {
  readonly url: string;
  query: <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;
  drop: () => Promise<void>;
}

/** Creates a throwaway database on the server named by DATABASE_URL so each test file owns its state. */
export async function createEphemeralDatabase(): Promise<EphemeralDatabase> {
  const adminUrl = process.env['DATABASE_URL'] ?? DEFAULT_URL;
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

  return {
    url: url.toString(),
    async query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      try {
        return (await client.query<T>(sql, params)).rows;
      } finally {
        await client.end();
      }
    },
    async drop() {
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
